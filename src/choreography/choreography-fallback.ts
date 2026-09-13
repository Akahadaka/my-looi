/**
 * Local fallback choreography. Guarantees that every reply moves even when the
 * model's plan is late, empty, or invalid. Beats are derived from punctuation in
 * the streaming transcript and shaped by the mood carried over from the last
 * good plan. Pure TypeScript: no React Native or robot imports.
 */

import { CHOREOGRAPHY_MAX_BEATS, type ChoreographyBeat, type ChoreographyMood, type ChoreographyPlan } from "./choreography-channel";

export const FALLBACK_DEFAULT_MOOD: ChoreographyMood = "warm";
export const FALLBACK_DEFAULT_ENERGY = 0.5;

const LOW_ENERGY_MOODS: ReadonlySet<ChoreographyMood> = new Set(["sad", "gentle", "calm", "serious"]);

export function isLowEnergy(energy: number): boolean {
  return energy < 0.35;
}

/** Pull mood/energy halfway back toward neutral between turns without a model plan. */
export function decayMood(mood: ChoreographyMood, energy: number): { mood: ChoreographyMood; energy: number } {
  const nextEnergy = energy + (FALLBACK_DEFAULT_ENERGY - energy) * 0.5;
  const nextMood = Math.abs(nextEnergy - FALLBACK_DEFAULT_ENERGY) < 0.12 ? FALLBACK_DEFAULT_MOOD : mood;
  return { mood: nextMood, energy: Math.round(nextEnergy * 100) / 100 };
}

/** First movement of a reply, played before any plan is known. */
export function buildOpenerBeat(mood: ChoreographyMood, energy: number): ChoreographyBeat {
  if (isLowEnergy(energy) || LOW_ENERGY_MOODS.has(mood)) return { at: 0, do: "lean_down", n: 1 };
  if (energy >= 0.75) return { at: 0, do: "bob", n: 1 };
  return { at: 0, do: "peek_up", n: 1 };
}

/**
 * Punctuation-driven beats positioned by character offset. Questions peek up,
 * exclamations bob (nod when low energy), sentence ends nod, and the reply
 * always settles at the end.
 */
export function buildFallbackPlan(transcript: string, mood: ChoreographyMood, energy: number): ChoreographyPlan {
  const text = transcript.trim();
  const low = isLowEnergy(energy) || LOW_ENERGY_MOODS.has(mood);
  const beats: ChoreographyBeat[] = [];
  if (text.length > 0) {
    const marks = /[.!?…]+(?=\s|$)/gu;
    let match: RegExpExecArray | null;
    while ((match = marks.exec(text)) !== null && beats.length < CHOREOGRAPHY_MAX_BEATS - 1) {
      const at = Math.round(Math.min(0.85, match.index / text.length) * 100) / 100;
      const mark = match[0];
      if (mark.includes("?")) beats.push({ at, do: "peek_up", n: 1 });
      else if (mark.includes("!")) beats.push({ at, do: low ? "nod" : "bob", n: 1 });
      else beats.push({ at, do: "nod", n: 1 });
    }
  }
  if (beats.length === 0) beats.push({ at: 0.4, do: low ? "lean_down" : "nod", n: 1 });
  // Never two identical beats back to back at nearly the same position.
  const deduped = beats.filter((beat, index) => index === 0 || beat.do !== beats[index - 1].do || beat.at - beats[index - 1].at > 0.15);
  deduped.push({ at: 1, do: "settle", n: 1 });
  return { mood, energy, beats: deduped.slice(0, CHOREOGRAPHY_MAX_BEATS) };
}
