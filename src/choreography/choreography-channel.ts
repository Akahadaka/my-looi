/**
 * Choreography channel: an out-of-band OpenAI Realtime response that asks the
 * model how LOOI should move while it speaks. It runs in parallel with the
 * default audio response and never adds to the conversation.
 *
 * Phase 1 (spike): request + parse + diagnostics only. Nothing moves yet.
 * This module is pure TypeScript so the Node spike script can import it.
 */

export const CHOREOGRAPHY_TOPIC = "choreography";
export const CHOREOGRAPHY_MAX_OUTPUT_TOKENS = 160;
export const CHOREOGRAPHY_MAX_BEATS = 5;

export const CHOREOGRAPHY_MOODS = [
  "lively", "playful", "warm", "curious", "calm", "gentle", "sad", "serious", "surprised", "proud",
] as const;
export type ChoreographyMood = (typeof CHOREOGRAPHY_MOODS)[number];

export const CHOREOGRAPHY_HEAD_ATOMS = ["nod", "bob", "peek_up", "peek_down", "droop", "lean_up", "lean_down", "settle"] as const;
export const CHOREOGRAPHY_BODY_ATOMS = ["wiggle", "shake", "sway", "spin"] as const;
export const CHOREOGRAPHY_ACCENT_ATOMS = ["blink_light"] as const;
export const CHOREOGRAPHY_FACE_MOODS = ["pleased", "startled", "annoyed", "angry", "victory"] as const;

export type ChoreographyAtom =
  | (typeof CHOREOGRAPHY_HEAD_ATOMS)[number]
  | (typeof CHOREOGRAPHY_BODY_ATOMS)[number]
  | (typeof CHOREOGRAPHY_ACCENT_ATOMS)[number]
  | `face:${(typeof CHOREOGRAPHY_FACE_MOODS)[number]}`;

export type ChoreographyBeat = { at: number; do: ChoreographyAtom; n: number };
export type ChoreographyPlan = { mood: ChoreographyMood; energy: number; beats: ChoreographyBeat[] };

export type ChoreographyParseResult =
  | { ok: true; plan: ChoreographyPlan; droppedAtoms: string[] }
  | { ok: false; error: string };

const ALL_ATOMS: ReadonlySet<string> = new Set<string>([
  ...CHOREOGRAPHY_HEAD_ATOMS,
  ...CHOREOGRAPHY_BODY_ATOMS,
  ...CHOREOGRAPHY_ACCENT_ATOMS,
  ...CHOREOGRAPHY_FACE_MOODS.map((mood) => `face:${mood}`),
]);

export function buildChoreographyInstructions(): string {
  return [
    "You are the body of LOOI, a palm-sized tracked desktop robot whose head is a phone showing its face.",
    "The human just finished speaking. Decide how LOOI moves while it answers them. Do not write the answer.",
    "Reply with exactly one JSON object and nothing else, no prose, no code fence:",
    '{"mood":<mood>,"energy":<0..1>,"beats":[{"at":<0..1>,"do":<atom>,"n":<1..3>}]}',
    `mood is one of: ${CHOREOGRAPHY_MOODS.join(", ")}.`,
    "energy: 0 means almost still, 1 means bouncing with excitement.",
    "Sad, consoling, or serious replies: energy at most 0.3 and only slow head atoms (lean_down, droop, settle, nod).",
    "Jokes, wins, surprises, excitement: energy at least 0.7; body atoms are welcome.",
    `Use 2 to ${CHOREOGRAPHY_MAX_BEATS} beats. "at" is the position within the spoken reply: 0 is the start, 1 is the end. "n" is optional repeat count.`,
    `Head atoms: ${CHOREOGRAPHY_HEAD_ATOMS.join(", ")}. Body atoms: ${CHOREOGRAPHY_BODY_ATOMS.join(", ")} (spin is a full turn, use it rarely). Accent: blink_light.`,
    `Face atoms: ${CHOREOGRAPHY_FACE_MOODS.map((mood) => `face:${mood}`).join(", ")}.`,
    "Be expressive and varied, like someone talking with their hands.",
  ].join(" ");
}

/** Build the out-of-band response request for one user turn. */
export function buildChoreographyResponseCreate(turn: string): Record<string, unknown> {
  return {
    type: "response.create",
    response: {
      conversation: "none",
      metadata: { topic: CHOREOGRAPHY_TOPIC, turn },
      output_modalities: ["text"],
      max_output_tokens: CHOREOGRAPHY_MAX_OUTPUT_TOKENS,
      instructions: buildChoreographyInstructions(),
    },
  };
}

/** Topic from a response.created / response.done event, or null. */
export function readChoreographyResponseTopic(event: Record<string, unknown>): string | null {
  const response = event.response;
  if (!response || typeof response !== "object") return null;
  const metadata = (response as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const topic = (metadata as { topic?: unknown }).topic;
  return typeof topic === "string" ? topic : null;
}

function clamp01(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Parse and clamp the model's JSON. Unknown atoms are dropped, not fatal. */
export function parseChoreographyPlan(text: string): ChoreographyParseResult {
  const json = extractJsonObject(text.trim());
  if (!json) return { ok: false, error: "no-json-object" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `invalid-json: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: "not-an-object" };
  const record = raw as Record<string, unknown>;

  const moodText = typeof record.mood === "string" ? record.mood.trim().toLowerCase() : "";
  const mood = (CHOREOGRAPHY_MOODS as readonly string[]).includes(moodText) ? (moodText as ChoreographyMood) : "warm";
  const energy = clamp01(record.energy, 0.5);

  const droppedAtoms: string[] = [];
  const beats: ChoreographyBeat[] = [];
  if (Array.isArray(record.beats)) {
    for (const entry of record.beats) {
      if (!entry || typeof entry !== "object") continue;
      const beat = entry as Record<string, unknown>;
      const atom = typeof beat.do === "string" ? beat.do.trim().toLowerCase() : "";
      if (!ALL_ATOMS.has(atom)) {
        if (atom) droppedAtoms.push(atom);
        continue;
      }
      const repeat = Math.max(1, Math.min(3, Math.round(Number(beat.n) || 1)));
      beats.push({ at: clamp01(beat.at, 0.5), do: atom as ChoreographyAtom, n: repeat });
      if (beats.length >= CHOREOGRAPHY_MAX_BEATS) break;
    }
  }
  if (beats.length === 0) return { ok: false, error: droppedAtoms.length ? `no-known-atoms: ${droppedAtoms.join(",")}` : "no-beats" };
  beats.sort((a, b) => a.at - b.at);
  return { ok: true, plan: { mood, energy, beats }, droppedAtoms };
}
