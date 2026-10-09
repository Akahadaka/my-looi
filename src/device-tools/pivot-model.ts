/**
 * Pure pivot duration <-> degrees model, fitted from gyroscope-measured
 * calibration pivots. No React Native imports so it can be unit tested in Node.
 *
 * Degrees are always magnitudes in the commanded direction: a "left" pivot
 * that turned LOOI 30 degrees to its left is +30 here, whatever the robot-frame
 * sign convention (positive = LOOI's right) says elsewhere.
 */

export type PivotDirection = "left" | "right";

/** Shortest and longest pivot the bounded drive primitive accepts (see clampDuration in looi-robot.ts). */
export const PIVOT_MIN_DURATION_MS = 80;
export const PIVOT_MAX_DURATION_MS = 1_800;

/** Uncalibrated guess carried over from TURN_90_MS: 90 degrees in 650 ms, no dead time. */
export const FALLBACK_DEG_PER_MS = 90 / 650;

export type PivotTrial = {
  direction: PivotDirection;
  /** Commanded drive duration in ms. */
  durationMs: number;
  /** Measured rotation in the commanded direction (negative if it went the other way). */
  degrees: number;
  /** The bounded motion ran to its STOP rather than being replaced or failing. */
  completed: boolean;
  /** Rotation had stopped before the measurement window closed. */
  settled: boolean;
};

export type PivotTableRow = {
  durationMs: number;
  medianDegrees: number;
  minDegrees: number;
  maxDegrees: number;
  count: number;
};

export type PivotDirectionModel = {
  /** Median degrees per commanded duration, ascending by duration. */
  table: PivotTableRow[];
  /** Least-squares line over every usable trial: degrees = degPerMs * (durationMs - deadTimeMs). */
  degPerMs: number;
  deadTimeMs: number;
  /** Coefficient of determination of that line, 0..1. */
  r2: number;
  trialCount: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Fits one direction; null when there are too few usable trials or the line does not rise. */
export function fitPivotDirection(trials: PivotTrial[], direction: PivotDirection): PivotDirectionModel | null {
  const usable = trials.filter((trial) =>
    trial.direction === direction && trial.completed && trial.settled && Number.isFinite(trial.degrees)
  );
  const durations = [...new Set(usable.map((trial) => trial.durationMs))].sort((a, b) => a - b);
  if (durations.length < 2) return null;

  const table = durations.map((durationMs) => {
    const degrees = usable.filter((trial) => trial.durationMs === durationMs).map((trial) => trial.degrees);
    return {
      durationMs,
      medianDegrees: median(degrees),
      minDegrees: Math.min(...degrees),
      maxDegrees: Math.max(...degrees),
      count: degrees.length,
    };
  });

  const n = usable.length;
  const meanX = usable.reduce((sum, trial) => sum + trial.durationMs, 0) / n;
  const meanY = usable.reduce((sum, trial) => sum + trial.degrees, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const trial of usable) {
    const dx = trial.durationMs - meanX;
    const dy = trial.degrees - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  if (!(slope > 0)) return null;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);

  return {
    table,
    degPerMs: slope,
    deadTimeMs: Math.max(0, -intercept / slope),
    r2,
    trialCount: n,
  };
}

/** (deadTimeMs, 0) then the table medians, skipping points that do not rise so the curve stays invertible. */
function curvePoints(model: PivotDirectionModel): Array<{ ms: number; deg: number }> {
  const points = [{ ms: model.deadTimeMs, deg: 0 }];
  for (const row of model.table) {
    const last = points[points.length - 1];
    if (row.durationMs > last.ms && row.medianDegrees > last.deg) points.push({ ms: row.durationMs, deg: row.medianDegrees });
  }
  return points;
}

/**
 * Inverse of the model: the drive duration expected to turn `degrees`.
 * Piecewise-linear through (deadTimeMs, 0) and the table medians, which keeps
 * the short-pivot non-linearity (motor spin-up); beyond the longest measured
 * pivot it extrapolates with the fitted slope. Unclamped; returns 0 for <= 0 degrees.
 */
export function durationForDegrees(model: PivotDirectionModel, degrees: number): number {
  if (!(degrees > 0)) return 0;
  const points = curvePoints(model);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (degrees <= to.deg) return from.ms + ((degrees - from.deg) / (to.deg - from.deg)) * (to.ms - from.ms);
  }
  const last = points[points.length - 1];
  return last.ms + (degrees - last.deg) / model.degPerMs;
}

export function clampPivotDuration(durationMs: number): number {
  return Math.max(PIVOT_MIN_DURATION_MS, Math.min(PIVOT_MAX_DURATION_MS, Math.round(durationMs)));
}

/** More segments than this means the model is nonsense for the request; it is capped rather than trusted. */
export const MAX_PIVOT_SEGMENTS = 4;

/**
 * Splits a turn into the fewest equal bounded pivots that each fit within
 * PIVOT_MAX_DURATION_MS. Each segment is sized from the model for its share of
 * the angle, so every segment pays its own dead time, as it does on the robot
 * when each pivot starts from rest. Empty for <= 0 degrees.
 */
export function planPivotSegments(model: PivotDirectionModel, degrees: number): number[] {
  if (!(degrees > 0)) return [];
  let count = 1;
  while (count < MAX_PIVOT_SEGMENTS && durationForDegrees(model, degrees / count) > PIVOT_MAX_DURATION_MS) count += 1;
  return Array.from({ length: count }, () => clampPivotDuration(durationForDegrees(model, degrees / count)));
}
