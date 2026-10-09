import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type GyroVector = { x: number; y: number; z: number };

export type GyroRecorderInfo = {
  gyroscopeAvailable: boolean;
  gyroscopeName: string | null;
  gyroscopeVendor: string | null;
  gyroscopeMinDelayUs: number | null;
  gyroscopeMaxRangeRadS: number | null;
  gyroscopeResolutionRadS: number | null;
  gravityAvailable: boolean;
  accelerometerAvailable: boolean;
  /** Display rotation in degrees; 90 and 270 are the landscape mountings in LOOI. */
  displayRotation: 0 | 90 | 180 | 270;
  sdkInt: number;
  manufacturer: string;
  model: string;
};

export type GyroRecorderOptions = {
  /** Defaults to 5000 (200 Hz); faster rates need HIGH_SAMPLING_RATE_SENSORS and are clamped. */
  samplingPeriodUs?: number;
};

export type GyroRecorderStarted = {
  samplingPeriodUs: number;
  gyroscopeName: string;
  upSensor: "gravity" | "accelerometer" | null;
  upSensorName: string | null;
  displayRotation: 0 | 90 | 180 | 270;
  startedAtMs: number;
};

/**
 * Gyroscope samples since the previous drain. `tMs` is on the same
 * elapsedRealtime clock as `nowMs()`; x/y/z are raw device-axis rates in rad/s.
 * `up` is the mean gravity (or accelerometer) vector over the same span and
 * points UP when the phone is still.
 */
export type GyroCapture = {
  tMs: number[];
  x: number[];
  y: number[];
  z: number[];
  up: GyroVector | null;
  droppedSamples: number;
  recording: boolean;
};

declare class GyroYawRecorderNativeModule extends NativeModule {
  getInfo(): Promise<GyroRecorderInfo>;
  start(options: GyroRecorderOptions): Promise<GyroRecorderStarted>;
  stop(): Promise<void>;
  drain(): GyroCapture;
  nowMs(): number;
  isRecording(): boolean;
}

let cached: GyroYawRecorderNativeModule | null | undefined;

export function getGyroYawRecorderModule(): GyroYawRecorderNativeModule | null {
  if (Platform.OS !== "android") return null;
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<GyroYawRecorderNativeModule>("GyroYawRecorder");
  } catch {
    cached = null;
  }
  return cached;
}
