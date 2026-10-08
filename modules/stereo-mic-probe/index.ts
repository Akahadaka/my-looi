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
  routedDevice: StereoProbeRoutedDevice | null;
  aec: StereoProbeAecInfo | null;
  simulateConversationCapture: boolean;
  conversation: {
    sampleRate: number;
    channelCount: number;
    routedDevice: StereoProbeRoutedDevice | null;
    aec: StereoProbeAecInfo | null;
  } | null;
};

/**
 * Sign convention: positive `bearingDeg` / `tdoaUs` means sound reached the
 * RIGHT channel (channel 1) first, i.e. the source is on the right-channel side.
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
  bearingDeg: number | null;
  peakRatio: number;
  tdoaUs: number | null;
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
