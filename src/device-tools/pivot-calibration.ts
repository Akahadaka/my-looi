import { createMMKV } from "react-native-mmkv";

import {
  clampPivotDuration,
  durationForDegrees,
  FALLBACK_DEG_PER_MS,
  planPivotSegments,
  type PivotDirection,
  type PivotDirectionModel,
  type PivotTrial,
} from "./pivot-model";

const storage = createMMKV({ id: "looi.pivot-calibration.v1" });
const CALIBRATION_KEY = "calibration";

export type PivotSurface = "desk" | "carpet" | "other";

export type PivotCalibration = {
  version: 1;
  createdAt: string;
  surface: PivotSurface;
  /** 0..100, or null when the phone did not report it. This is the PHONE's battery; LOOI's is not readable. */
  phoneBatteryPercent: number | null;
  left: PivotDirectionModel | null;
  right: PivotDirectionModel | null;
  trials: PivotTrial[];
};

export function loadPivotCalibration(): PivotCalibration | null {
  const raw = storage.getString(CALIBRATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PivotCalibration;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function savePivotCalibration(calibration: PivotCalibration): void {
  storage.set(CALIBRATION_KEY, JSON.stringify(calibration));
}

export function clearPivotCalibration(): void {
  storage.remove(CALIBRATION_KEY);
}

/**
 * Drive duration (ms) expected to pivot LOOI `degrees` towards `direction`,
 * from the saved calibration, or the old 90-degrees-in-650-ms guess when that
 * direction is uncalibrated. Always within the bounded drive primitive's
 * 80-1800 ms, so angles smaller than an 80 ms pivot come back as 80 ms:
 * callers wanting a deadzone must apply it themselves.
 */
export function pivotDurationForDegrees(direction: PivotDirection, degrees: number): number {
  const model = loadPivotCalibration()?.[direction] ?? null;
  const durationMs = model ? durationForDegrees(model, degrees) : degrees / FALLBACK_DEG_PER_MS;
  return clampPivotDuration(durationMs);
}

/**
 * Bounded pivot durations (ms) that together turn LOOI `degrees` towards
 * `direction`, or null when that direction has no saved calibration. Turns
 * longer than one bounded pivot allows (e.g. 180 degrees) come back as several
 * equal segments.
 */
export function pivotSegmentsForDegrees(direction: PivotDirection, degrees: number): number[] | null {
  const model = loadPivotCalibration()?.[direction] ?? null;
  return model ? planPivotSegments(model, degrees) : null;
}
