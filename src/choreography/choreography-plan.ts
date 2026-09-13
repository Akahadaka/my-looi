/**
 * Pure plan shaping for reply choreography: channel classification, level and
 * energy filtering, per-plan caps, and speech-duration estimation. No React
 * Native or robot imports so Node tests can load it directly.
 */

import type { ExpressiveMotionLevel } from "../store/user";
import {
  CHOREOGRAPHY_BODY_ATOMS,
  CHOREOGRAPHY_MAX_BEATS,
  type ChoreographyAtom,
  type ChoreographyBeat,
  type ChoreographyPlan,
} from "./choreography-channel";
import { isLowEnergy } from "./choreography-fallback";

export type ChoreographyPlanSource = "model" | "fallback";
export type AtomChannel = "head" | "body" | "light" | "face";

const BODY_ATOMS: ReadonlySet<string> = new Set(CHOREOGRAPHY_BODY_ATOMS);

/** Beats whose position has passed by more than this fraction of the reply are skipped. */
export const LATE_BEAT_TOLERANCE = 0.25;
const MAX_BODY_ATOMS_PER_PLAN = 2;
const MAX_SPIN_PER_PLAN = 1;
const SPIN_MIN_ENERGY = 0.8;
const CHARS_PER_SECOND_AT_SPEED_1 = 14;
export const MIN_ESTIMATE_MS = 1_200;
const MAX_ESTIMATE_MS = 20_000;

export function atomChannel(atom: ChoreographyAtom): AtomChannel {
  if (atom.startsWith("face:")) return "face";
  if (atom === "blink_light") return "light";
  if (BODY_ATOMS.has(atom)) return "body";
  return "head";
}

/**
 * Apply the user's expressive-motion level, the mood's energy ceiling, and the
 * hard per-plan caps. Pure so it can be unit-tested without a robot.
 */
export function filterPlanForLevel(plan: ChoreographyPlan, level: ExpressiveMotionLevel): { plan: ChoreographyPlan; dropped: string[] } {
  const dropped: string[] = [];
  if (level === "off") return { plan: { ...plan, beats: [] }, dropped: plan.beats.map((beat) => `${beat.do}:off`) };
  const low = isLowEnergy(plan.energy);
  let bodyCount = 0;
  let spinCount = 0;
  const beats: ChoreographyBeat[] = [];
  for (const beat of plan.beats) {
    const channel = atomChannel(beat.do);
    let reason: string | null = null;
    if (channel === "body") {
      if (level === "head") reason = "level-head";
      else if (low) reason = "low-energy";
      else if (beat.do === "spin" && (level !== "lively" || plan.energy < SPIN_MIN_ENERGY)) reason = "spin-gated";
      else if (beat.do === "spin" && spinCount >= MAX_SPIN_PER_PLAN) reason = "spin-cap";
      else if (bodyCount >= MAX_BODY_ATOMS_PER_PLAN) reason = "body-cap";
    } else if (channel === "head" && low && beat.do === "bob") {
      reason = "low-energy";
    }
    if (reason) {
      dropped.push(`${beat.do}:${reason}`);
      continue;
    }
    if (channel === "body") bodyCount += 1;
    if (beat.do === "spin") spinCount += 1;
    beats.push(beat);
    if (beats.length >= CHOREOGRAPHY_MAX_BEATS) break;
  }
  return { plan: { ...plan, beats }, dropped };
}

export function estimateSpeechDurationMs(transcriptChars: number, speed: number): number {
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const estimate = (transcriptChars / (CHARS_PER_SECOND_AT_SPEED_1 * safeSpeed)) * 1000;
  return Math.max(MIN_ESTIMATE_MS, Math.min(MAX_ESTIMATE_MS, Math.round(estimate)));
}

