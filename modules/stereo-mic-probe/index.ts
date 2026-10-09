import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type StereoProbeSource =
  | "VOICE_COMMUNICATION"
  | "UNPROCESSED"
  | "CAMCORDER"
  | "MIC"
  | "VOICE_RECOGNITION";

export type StereoProbeVector = { x: number; y: number; z: number };

export type StereoProbeMicrophone = {
  id: number;
  description: string;
  type: string;
  address: string;
  location: string;
  /** Metres relative to the device reference point; null when the platform reports POSITION_UNKNOWN. */
  position: StereoProbeVector | null;
  orientation: StereoProbeVector | null;
  directionality: string;
};

export type StereoProbeInputDevice = {
  type: string;
  productName: string | null;
  address: string | null;
  channelCounts: number[];
  sampleRates: number[];
};

export type StereoProbeCapabilities = {
  microphones: StereoProbeMicrophone[];
  inputDevices: StereoProbeInputDevice[];
  unprocessedSupported: boolean;
  estimatedMicSpacingM: number | null;
  sdkInt: number;
  manufacturer: string;
  model: string;
};

export type StereoProbeOptions = {
  source: StereoProbeSource;
  /** Defaults to 48000. */
  sampleRate?: number;
  /** Also run a VOICE_COMMUNICATION 16 kHz mono capture with AcousticEchoCanceler, as the conversation pipeline does. */
  simulateConversationCapture: boolean;
  /** Metres between the two microphones. Defaults to estimatedMicSpacingM, else 0.15. */
  micSpacingM?: number;
  /** Also save the raw stereo capture as a PCM16 WAV in the app's external files directory (max 30 s). */
  recordWavSeconds?: number;
};

export type StereoProbeAecInfo = {
  available: boolean;
  attached: boolean;
  enabled: boolean;
  error: string | null;
};

export type StereoProbeRoutedDevice = {
  type: string;
  productName: string | null;
  address: string | null;
  id: number;
};

export type StereoProbeStartedEvent = {
  source: StereoProbeSource;
  requestedSampleRate: number;
  /** Actual rate reported by AudioRecord.format. */
  sampleRate: number;
  requestedChannelCount: number;
  /** Actual channel count reported by AudioRecord.format. */
  channelCount: number;
  audioSessionId: number;
  micSpacingM: number;
  /** Display rotation at start in degrees. 90 and 270 are landscape; 0 and 180 have no robot frame. */
  displayRotation: 0 | 90 | 180 | 270;
  /** Channel 0 is assumed to be the bottom (USB-end) microphone; true on the tested Pixel 10 Pro XL. */
  channelOrderAssumed: "bottom-first";
  routedDevice: StereoProbeRoutedDevice | null;
  aec: StereoProbeAecInfo | null;
  simulateConversationCapture: boolean;
  /** Absolute path of the WAV being written, when `recordWavSeconds` was requested. */
  wavPath: string | null;
  conversation: {
    sampleRate: number;
    channelCount: number;
    routedDevice: StereoProbeRoutedDevice | null;
    aec: StereoProbeAecInfo | null;
  } | null;
};

/**
 * Raw sign convention: positive `instantBearingDeg` / `rawBearingDeg` /
 * `tdoaUs` / `voteTdoaUs` means sound reached channel 1 first.
 *
 * `robotBearingDeg` is that bearing in the robot frame: positive is the
 * ROBOT'S RIGHT, negative the robot's left. It equals `rawBearingDeg` in
 * ROTATION_90 and its negation in ROTATION_270, and is null in portrait.
 */
export type StereoProbeFrameEvent = {
  timestampMs: number;
  /** dBFS, -120 is digital silence. */
  rmsL: number;
  rmsR: number;
  /** dBFS of the simulated conversation capture; null when not simulating. */
  conversationRms: number | null;
  channelCorrelation: number;
  identicalChannels: boolean;
  voiceActive: boolean;
  /** Median bearing of this frame's voiced windows; a noisy per-frame diagnostic, not the answer. */
  instantBearingDeg: number | null;
  peakRatio: number;
  tdoaUs: number | null;
  /** Mode of the integer peak lags over the last ~1 s of voiced windows; null when none were voiced. */
  voteLagSamples: number | null;
  voteTdoaUs: number | null;
  /** Fraction of the voiced windows within +/-1 sample of the mode; 0 when none. */
  voteShare: number;
  /** Voiced windows counted by the vote. */
  voteCount: number;
  /** Bearing from the vote; null until it has enough agreeing voiced windows. */
  rawBearingDeg: number | null;
  /** Positive = robot's right. Null when the vote is not trusted or the robot frame is unavailable. */
  robotBearingDeg: number | null;
  /** False in portrait (ROTATION_0 / ROTATION_180), where the microphone axis is not left/right. */
  robotFrameAvailable: boolean;
  noiseFloorDb: number | null;
  channelCount: number;
  framesRead: number;
  readErrors: number;
  conversationFramesRead: number | null;
  stereoClientSilenced: boolean | null;
  conversationClientSilenced: boolean | null;
};

export type StereoProbeErrorEvent = {
  stage: string;
  message: string;
  fatal: boolean;
};

export type StereoProbeStoppedEvent = {
  reason: string;
  framesRead: number;
  readErrors: number;
};

export type StereoProbeStatus = {
  supported: boolean;
  running: boolean;
  permissionGranted: boolean;
  source: StereoProbeSource | null;
  sampleRate: number | null;
  channelCount: number | null;
  simulateConversationCapture: boolean;
  framesRead: number;
  readErrors: number;
};

type Events = {
  onProbeFrame(event: StereoProbeFrameEvent): void;
  onProbeError(event: StereoProbeErrorEvent): void;
  onProbeStarted(event: StereoProbeStartedEvent): void;
  onProbeStopped(event: StereoProbeStoppedEvent): void;
  onProbeWavSaved(event: { path: string; bytes: number }): void;
};

declare class StereoMicProbeNativeModule extends NativeModule<Events> {
  getCapabilities(): Promise<StereoProbeCapabilities>;
  start(options: StereoProbeOptions): Promise<StereoProbeStartedEvent>;
  stop(): Promise<StereoProbeStatus>;
  getStatus(): StereoProbeStatus;
}

let cached: StereoMicProbeNativeModule | null | undefined;

function getModule(): StereoMicProbeNativeModule | null {
  if (Platform.OS !== "android") return null;
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<StereoMicProbeNativeModule>("StereoMicProbe");
  } catch {
    cached = null;
  }
  return cached;
}

export function getStereoMicProbeModule(): StereoMicProbeNativeModule | null {
  return getModule();
}
