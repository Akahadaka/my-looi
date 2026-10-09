import type { GyroCapture, GyroVector } from "../../modules/gyro-yaw-recorder";

/**
 * Pure gyroscope maths for pivot calibration (no React Native imports, so it
 * can be unit tested in Node).
 *
 * Robot yaw convention matches robotBearingDeg: POSITIVE = LOOI turning to
 * its RIGHT. The yaw axis is the measured "up" vector, not a guessed device
 * axis. The gyroscope follows the right-hand rule, so a positive rate about
 * "up" is counter-clockwise seen from above, i.e. LOOI turning to its LEFT;
 * hence robot yaw rate = -(omega . up).
 */

const RAD_TO_DEG = 180 / Math.PI;
/** Rate above which LOOI counts as turning, after bias removal. */
export const MOTION_RATE_THRESHOLD_DEG_S = 15;
/** Max residual rate over the last [SETTLE_WINDOW_MS] for a pivot to count as settled. */
export const SETTLED_RATE_DEG_S = 5;
export const SETTLE_WINDOW_MS = 200;
/** Bias is only trusted from at least this many still samples. */
const MIN_BIAS_SAMPLES = 20;

export type PivotMarks = {
  /** elapsedRealtime ms just before the drive command was issued. */
  driveStartMs: number;
  /** elapsedRealtime ms when the bounded motion (including its STOP write) returned. */
  driveStopMs: number;
};

export type PivotMeasurement = {
  /** Integrated robot-frame yaw from driveStartMs to the last sample; positive = LOOI's right. */
  robotYawDeg: number;
  biasDegS: number;
  biasSamples: number;
  /** Highest absolute bias-corrected rate. */
  peakRateDegS: number;
  /** From driveStartMs to the first sample above the motion threshold; null if it never moved. */
  onsetLatencyMs: number | null;
  /** From driveStopMs to the last sample above the motion threshold (negative if it stopped before the STOP returned). */
  coastAfterStopMs: number | null;
  settled: boolean;
  samples: number;
  sampleRateHz: number | null;
};

function unit(vector: GyroVector): GyroVector | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > 1)) return null; // A still phone reads ~9.8 m/s^2; anything near zero is not a usable gravity vector.
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

/** Robot-frame yaw rates in deg/s (positive = LOOI's right), or null when there is no up vector. */
export function robotYawRatesDegS(capture: GyroCapture, up: GyroVector | null = capture.up): number[] | null {
  const axis = up ? unit(up) : null;
  if (!axis) return null;
  return capture.tMs.map((_, index) =>
    -(capture.x[index] * axis.x + capture.y[index] * axis.y + capture.z[index] * axis.z) * RAD_TO_DEG
  );
}

/** Which device axis the up vector lies along, for the screen's sanity readout. */
export function dominantUpAxis(up: GyroVector | null): string | null {
  const axis = up ? unit(up) : null;
  if (!axis) return null;
  const entries = [["x", axis.x], ["y", axis.y], ["z", axis.z]] as const;
  const [name, value] = entries.reduce((best, entry) => Math.abs(entry[1]) > Math.abs(best[1]) ? entry : best);
  return `${value >= 0 ? "+" : "-"}${name} (${Math.round(Math.abs(value) * 100)}%)`;
}

/** Trapezoidal integral of (rate - bias) over [fromMs, toMs], in degrees. */
export function integrateDeg(tMs: number[], ratesDegS: number[], fromMs: number, toMs: number, biasDegS = 0): number {
  let total = 0;
  for (let index = 1; index < tMs.length; index += 1) {
    const start = Math.max(tMs[index - 1], fromMs);
    const end = Math.min(tMs[index], toMs);
    if (end <= start) continue;
    total += ((ratesDegS[index - 1] + ratesDegS[index]) / 2 - biasDegS) * (end - start) / 1000;
  }
  return total;
}

/**
 * Measures one pivot from a capture that starts with a still pre-roll before
 * `driveStartMs` (gyro bias) and ends after the robot has settled.
 */
export function measurePivot(capture: GyroCapture, marks: PivotMarks): PivotMeasurement | null {
  const rates = robotYawRatesDegS(capture);
  if (!rates || capture.tMs.length < 2) return null;
  const { tMs } = capture;

  const stillRates = rates.filter((_, index) => tMs[index] < marks.driveStartMs);
  const biasDegS = stillRates.length >= MIN_BIAS_SAMPLES ? stillRates.reduce((sum, rate) => sum + rate, 0) / stillRates.length : 0;
  const endMs = tMs[tMs.length - 1];
  const robotYawDeg = integrateDeg(tMs, rates, marks.driveStartMs, endMs, biasDegS);

  let peakRateDegS = 0;
  let firstMovingMs: number | null = null;
  let lastMovingMs: number | null = null;
  let settled = true;
  for (let index = 0; index < tMs.length; index += 1) {
    if (tMs[index] < marks.driveStartMs) continue;
    const rate = Math.abs(rates[index] - biasDegS);
    peakRateDegS = Math.max(peakRateDegS, rate);
    if (rate > MOTION_RATE_THRESHOLD_DEG_S) {
      firstMovingMs ??= tMs[index];
      lastMovingMs = tMs[index];
    }
    if (tMs[index] >= endMs - SETTLE_WINDOW_MS && rate > SETTLED_RATE_DEG_S) settled = false;
  }

  const span = endMs - tMs[0];
  return {
    robotYawDeg,
    biasDegS,
    biasSamples: stillRates.length,
    peakRateDegS,
    onsetLatencyMs: firstMovingMs === null ? null : firstMovingMs - marks.driveStartMs,
    coastAfterStopMs: lastMovingMs === null ? null : lastMovingMs - marks.driveStopMs,
    settled,
    samples: tMs.length,
    sampleRateHz: span > 0 ? ((tMs.length - 1) * 1000) / span : null,
  };
}
