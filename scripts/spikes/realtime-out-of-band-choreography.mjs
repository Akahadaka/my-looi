// Spike: can an out-of-band "choreography" response run concurrently with the
// default audio response on the OpenAI Realtime API, and how fast is it?
//
// Usage:
//   OPENAI_API_KEY=sk-... pnpm spike:choreography [model]
//
// Sends text user turns (no microphone needed), creates the default audio
// response and the out-of-band text response back to back, and prints timing
// plus the parsed choreography JSON for each scenario. Nothing is persisted.

import {
  CHOREOGRAPHY_TOPIC,
  buildChoreographyResponseCreate,
  parseChoreographyPlan,
  readChoreographyResponseTopic,
} from "../../src/choreography/choreography-channel.ts";

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}
const model = process.argv[2] ?? "gpt-realtime-2.1-mini";

const SCENARIOS = [
  "Tell me a joke!",
  "My dog died this morning.",
  "Looi, what's the capital of France?",
  "I got the job!!",
  "Why do you keep looking at me like that?",
];

const PERSONALITY = [
  "You are LOOI, a palm-sized tracked desktop robot. Your head is a phone showing your face.",
  "Short, quirky, warm replies. One sentence by default, two at most. Never narrate movements.",
].join(" ");

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, [
  "realtime",
  `openai-insecure-api-key.${apiKey}`,
]);

const send = (payload) => ws.send(JSON.stringify(payload));
const now = () => Date.now();
const results = [];
let current = null;
let scenarioIndex = 0;
let sessionReady = false;

function startScenario() {
  if (scenarioIndex >= SCENARIOS.length) return finish();
  const text = SCENARIOS[scenarioIndex];
  const turn = String(scenarioIndex + 1);
  scenarioIndex += 1;
  current = {
    text, turn, sentAt: 0, errors: [],
    audio: { created: null, firstDelta: null, done: null, transcript: "" },
    oob: { created: null, done: null, text: "", status: null, statusDetails: null, outputTypes: [], retried: false, retryDone: null },
  };
  send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  current.sentAt = now();
  send({ type: "response.create" });
  send(buildChoreographyResponseCreate(turn));
  console.log(`\n▶ turn ${turn}: "${text}"`);
}

function maybeCompleteScenario() {
  if (!current || !current.audio.done || !current.oob.done) return;
  const c = current;
  const t = (value) => (value === null ? "   n/a" : `${String(value - c.sentAt).padStart(5)}ms`);
  const parsed = parseChoreographyPlan(c.oob.text);
  console.log(`  audio: created ${t(c.audio.created)}  first delta ${t(c.audio.firstDelta)}  done ${t(c.audio.done)}`);
  console.log(`  oob:   created ${t(c.oob.created)}  done ${t(c.oob.done)}  status=${c.oob.status}${c.oob.statusDetails ? ` (${c.oob.statusDetails})` : ""}  output=[${c.oob.outputTypes.join(",")}]${c.oob.retried ? "  RETRIED after empty" : ""}`);
  console.log(`  oob done ${c.audio.firstDelta && c.oob.done ? c.oob.done - c.audio.firstDelta : "n/a"}ms after first audio delta`);
  console.log(`  reply: ${c.audio.transcript.trim() || "(no transcript)"}`);
  console.log(`  json:  ${c.oob.text.trim().replace(/\s+/g, " ")}`);
  console.log(`  parse: ${parsed.ok ? `${parsed.repaired ? "REPAIRED " : ""}${parsed.plan.mood} energy=${parsed.plan.energy} beats=${parsed.plan.beats.map((b) => `${b.at}:${b.do}${b.n > 1 ? `x${b.n}` : ""}`).join(" ")}${parsed.droppedAtoms.length ? ` dropped=${parsed.droppedAtoms.join(",")}` : ""}` : `INVALID ${parsed.error}`}`);
  if (c.errors.length) console.log(`  errors: ${c.errors.join(" | ")}`);
  results.push({ ...c, parsed });
  current = null;
  setTimeout(startScenario, 400);
}

function finish() {
  const valid = results.filter((r) => r.parsed.ok).length;
  const repaired = results.filter((r) => r.parsed.ok && r.parsed.repaired).length;
  const retried = results.filter((r) => r.oob.retried).length;
  const rescued = results.filter((r) => r.oob.retried && r.parsed.ok).length;
  const concurrent = results.filter((r) => r.oob.created && r.audio.created).length;
  const beforeAudio = results.filter((r) => r.oob.done && r.audio.firstDelta && r.oob.done <= r.audio.firstDelta).length;
  console.log("\n=== summary ===");
  console.log(`model: ${model}`);
  console.log(`scenarios: ${results.length}, both responses created: ${concurrent}, valid JSON: ${valid} (${repaired} repaired), JSON before first audio: ${beforeAudio}`);
  const lags = results.filter((r) => r.oob.done && r.audio.firstDelta).map((r) => r.oob.done - r.audio.firstDelta);
  if (lags.length) console.log(`oob done after first audio: min ${Math.min(...lags)}ms, max ${Math.max(...lags)}ms, mean ${Math.round(lags.reduce((a, b) => a + b, 0) / lags.length)}ms`);
  console.log(`empty first attempts: ${retried}, rescued by one retry: ${rescued}`);
  console.log(`errors: ${results.reduce((n, r) => n + r.errors.length, 0)}`);
  ws.close();
}

ws.onopen = () => {
  send({
    type: "session.update",
    session: {
      type: "realtime",
      model,
      output_modalities: ["audio"],
      instructions: PERSONALITY,
      max_output_tokens: 256,
      audio: {
        input: { format: { type: "audio/pcm", rate: 24_000 }, turn_detection: null },
        output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "cedar" },
      },
    },
  });
};

ws.onmessage = (message) => {
  const event = JSON.parse(String(message.data));
  const type = String(event.type ?? "");
  if (type === "session.updated" && !sessionReady) {
    sessionReady = true;
    startScenario();
    return;
  }
  if (type === "error") {
    const detail = `${event.error?.code ?? "unknown"}: ${event.error?.message ?? ""}`;
    if (current) current.errors.push(detail); else console.error("error", detail);
    // If the API refuses the second response we would never see its done event.
    if (current && /active response|already/i.test(detail)) {
      current.oob.done = now();
      current.oob.status = "refused";
      maybeCompleteScenario();
    }
    return;
  }
  if (!current) return;
  const isChoreography = readChoreographyResponseTopic(event) === CHOREOGRAPHY_TOPIC;
  if (type === "response.created") {
    if (isChoreography) current.oob.created = now();
    else current.audio.created = now();
    if (isChoreography) { current.oobId = event.response?.id; if (current.oob.retried) current.oob.created = current.oob.created ?? now(); }
    else current.audioId = event.response?.id;
    return;
  }
  const responseId = event.response_id ?? event.response?.id;
  const forOob = responseId && responseId === current.oobId;
  if (type === "response.output_audio.delta" && !forOob) {
    if (!current.audio.firstDelta) current.audio.firstDelta = now();
    return;
  }
  if (type === "response.output_audio_transcript.delta" && !forOob) {
    current.audio.transcript += String(event.delta ?? "");
    return;
  }
  if (type === "response.output_text.delta" && forOob) {
    current.oob.text += String(event.delta ?? "");
    return;
  }
  if (type === "response.done") {
    if (isChoreography || forOob) {
      const emptyText = !current.oob.text && !(event.response?.output ?? []).some((o) => o.content?.some((c) => c.text));
      if (emptyText && !current.oob.retried) {
        // Measure whether a single retry rescues an empty plan and how late it lands.
        current.oob.retried = true;
        current.oob.outputTypes = (event.response?.output ?? []).map((o) => `${o.type}${o.content ? ":" + o.content.map((c) => c.type).join("+") : ""}`);
        send(buildChoreographyResponseCreate(`${current.turn}-retry`));
        return;
      }
      current.oob.done = now();
      if (current.oob.retried) current.oob.retryDone = current.oob.done;
      current.oob.status = event.response?.status ?? "unknown";
      current.oob.statusDetails = event.response?.status_details ? JSON.stringify(event.response.status_details) : null;
      current.oob.outputTypes = (event.response?.output ?? []).map((o) => `${o.type}${o.content ? ":" + o.content.map((c) => c.type).join("+") : ""}`);
      if (!current.oob.text) {
        const item = (event.response?.output ?? []).find((o) => o.type === "message");
        const part = item?.content?.find((c) => c.type === "output_text" || c.type === "text");
        if (part?.text) current.oob.text = part.text;
      }
    } else {
      current.audio.done = now();
    }
    maybeCompleteScenario();
  }
};

ws.onerror = (event) => console.error("websocket error", event?.message ?? event);
ws.onclose = (event) => {
  if (scenarioIndex < SCENARIOS.length) console.error(`socket closed early: ${event.code} ${event.reason}`);
  process.exit(0);
};
