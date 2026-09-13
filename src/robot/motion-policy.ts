/**
 * Motion envelope derived from the robot's situation and the user's expressive
 * level. Today every consumer (choreography, ambient motion, camera attention)
 * hard-codes tiny desk-safe moves; this module is the single place that will
 * widen the envelope when LOOI is on the floor with freedom to explore, and
 * the interface future behaviours (explore, follow, flee) will read.
 *
 * Nothing here bypasses the robot safety controller: cliff, near-edge, TOF and
 * deadman interlocks always apply regardless of the envelope. Pure TypeScript.
 */

import type { ExpressiveMotionLevel } from "../store/user";
import type { RobotSituation } from "./robot-situation";

export type MotionEnvelope = {
  /** Continuous or repeated forward/backward driving. Never true yet; behaviours are future work. */
  translationAllowed: boolean;
  /** Longest single expressive pivot the choreography player may request. */
  pivotMaxMs: number;
  /** Full 360° spins in choreography. */
  spinAllowed: boolean;
  /** Camera-driven behaviours (follow / flee) may run. Reserved. */
  behavioursAllowed: boolean;
  reason: string;
};

const DESK_PIVOT_MAX_MS = 260;
const FLOOR_PIVOT_MAX_MS = 400;

export function getMotionEnvelope(situation: RobotSituation, level: ExpressiveMotionLevel): MotionEnvelope {
  const onFloor = situation.surface === "floor";
  const exploring = onFloor && situation.freedom === "explore";
  return {
    translationAllowed: false,
    pivotMaxMs: onFloor ? FLOOR_PIVOT_MAX_MS : DESK_PIVOT_MAX_MS,
    spinAllowed: level === "lively",
    behavioursAllowed: exploring,
    reason: exploring ? "floor-explore" : onFloor ? "floor-stay" : situation.surface === "desk" ? "desk" : "unknown-surface",
  };
}
