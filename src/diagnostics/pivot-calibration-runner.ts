import { getGyroYawRecorderModule } from "../../modules/gyro-yaw-recorder";
import { performLooiCalibrationPivot } from "../device-tools/looi-robot";
import type { PivotDirection, PivotTrial } from "../device-tools/pivot-model";
import { recordDiagnosticEvent } from "./diagnostic-log";
import { measurePivot, type PivotMeasurement } from "./pivot-calibration-analysis";

export const PIVOT_CALIBRATION_DURATIONS_MS = [80, 120, 180, 250, 400, 650] as const;
export const PIVOT_CALIBRATION_DEFAULT_REPEATS = 3;
/** Still time before each drive command; the gyroscope bias is taken from it. */
const PRE_ROLL_MS = 400;
/** Time after the STOP write for coasting to finish before the window closes. */
const SETTLE_MS = 700;

export type PivotPlanStep = { direction: PivotDirection; durationMs: number; repeat: number };

export type PivotTrialResult = PivotTrial & {
  repeat: number;
  measurement: PivotMeasurement | null;
  error: string | null;
};

/**
 * Durations ascending within each repeat, each one left then right, so LOOI
 * ends every pair roughly where it started instead of walking round in circles.
 */
export function buildPivotCalibrationPlan(
  durations: readonly number[] = PIVOT_CALIBRATION_DURATIONS_MS,
  repeats = PIVOT_CALIBRATION_DEFAULT_REPEATS
): PivotPlanStep[] {
  const plan: PivotPlanStep[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const durationMs of durations) {
      for (const direction of ["left", "right"] as const) plan.push({ direction, durationMs, repeat });
    }
  }
  return plan;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one calibration pivot with the gyroscope recording around it. The
 * recorder must already be started; this drains it before the pre-roll so the
 * capture holds exactly pre-roll + drive + settle.
 */
export async function runCalibrationPivot(step: PivotPlanStep): Promise<PivotTrialResult> {
  const gyro = getGyroYawRecorderModule();
  if (!gyro?.isRecording()) throw new Error("Gyroscope recorder is not running");
  gyro.drain();
  await delay(PRE_ROLL_MS);
  const driveStartMs = gyro.nowMs();
  let completed = false;
  let error: string | null = null;
  try {
    const result = await performLooiCalibrationPivot(step.direction, step.durationMs);
    completed = result.completed;
  } catch (reason) {
    error = errorMessage(reason);
  }
  const driveStopMs = gyro.nowMs();
  await delay(SETTLE_MS);
  const capture = gyro.drain();
  const measurement = measurePivot(capture, { driveStartMs, driveStopMs });
  // Robot frame is positive to LOOI's right; the trial wants degrees in the commanded direction.
  const degrees = measurement ? (step.direction === "right" ? measurement.robotYawDeg : -measurement.robotYawDeg) : Number.NaN;
  const trial: PivotTrialResult = {
    ...step,
    degrees,
    completed: completed && error === null,
    settled: measurement?.settled ?? false,
    measurement,
    error,
  };
  recordDiagnosticEvent("robot", "pivot-calibration-trial", {
    direction: step.direction,
    durationMs: step.durationMs,
    repeat: step.repeat,
    degrees: Number.isFinite(degrees) ? Math.round(degrees * 10) / 10 : "none",
    completed: trial.completed,
    settled: trial.settled,
    peakRateDegS: measurement ? Math.round(measurement.peakRateDegS) : "none",
    onsetLatencyMs: measurement?.onsetLatencyMs ?? "none",
    coastAfterStopMs: measurement?.coastAfterStopMs ?? "none",
    commandMs: Math.round(driveStopMs - driveStartMs),
    biasDegS: measurement ? Math.round(measurement.biasDegS * 100) / 100 : "none",
    sampleRateHz: measurement?.sampleRateHz ? Math.round(measurement.sampleRateHz) : "none",
    droppedSamples: capture.droppedSamples,
    error: error ?? "none",
  });
  return trial;
}
