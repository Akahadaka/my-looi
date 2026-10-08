import type { DiagnosticDetails } from "./diagnostic-log";
import type {
  StereoProbeCapabilities,
  StereoProbeFrameEvent,
  StereoProbeOptions,
  StereoProbeSource,
  StereoProbeStartedEvent,
} from "../../modules/stereo-mic-probe";

/** Levels at or below this are treated as the digital floor (all-zero PCM reads as -120 dBFS). */
export const STEREO_PROBE_DIGITAL_FLOOR_DB = -100;
/** Frames in the first moments after start are ignored when summarising a run (AEC and noise floor settling). */
export const STEREO_PROBE_WARMUP_MS = 400;
/** Recent frames (about 1.2 s at 10 Hz) used for the live verdict. */
export const STEREO_PROBE_VERDICT_FRAMES = 12;

export const STEREO_PROBE_SOURCES: StereoProbeSource[] = [
  "VOICE_COMMUNICATION",
  "UNPROCESSED",
  "CAMCORDER",
  "MIC",
  "VOICE_RECOGNITION",
];

export type StereoProbeVerdict = "TRUE_STEREO" | "FAKE_STEREO" | "MONO_ONLY" | "SILENCED";

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxChannelLevel(frame: StereoProbeFrameEvent): number {
  return Math.max(frame.rmsL, frame.rmsR);
}

/**
 * Classifies the stereo capture from the actual channel count and a window of
 * frames. Returns null until at least one frame has arrived.
 */
export function deriveStereoVerdict(
  channelCount: number | null,
  frames: StereoProbeFrameEvent[]
): StereoProbeVerdict | null {
  if (frames.length === 0) return null;
  const silenced = frames.some((frame) => frame.stereoClientSilenced === true);
  const atDigitalFloor = frames.every((frame) => maxChannelLevel(frame) <= STEREO_PROBE_DIGITAL_FLOOR_DB);
  if (silenced || atDigitalFloor) return "SILENCED";
  if (channelCount !== null && channelCount < 2) return "MONO_ONLY";
  const identicalShare = frames.filter((frame) => frame.identicalChannels).length / frames.length;
  return identicalShare >= 0.5 ? "FAKE_STEREO" : "TRUE_STEREO";
}

export type StereoProbeRunSummary = {
  source: StereoProbeSource;
  requestedSampleRate: number;
  simulateConversationCapture: boolean;
  opened: boolean;
  error: string | null;
  channelCount: number | null;
  sampleRate: number | null;
  verdict: StereoProbeVerdict | null;
  aecAvailable: boolean | null;
  aecEnabled: boolean | null;
  routedDevice: string | null;
  medianBearingDeg: number | null;
  meanPeakRatio: number | null;
  meanCorrelation: number | null;
  voiceActivePct: number | null;
  conversationRmsDb: number | null;
  conversationAlive: boolean | null;
  conversationAecEnabled: boolean | null;
  stereoClientSilenced: boolean | null;
  conversationClientSilenced: boolean | null;
  frames: number;
};

function anyFlag(frames: StereoProbeFrameEvent[], pick: (frame: StereoProbeFrameEvent) => boolean | null): boolean | null {
  const reported = frames.map(pick).filter((value): value is boolean => value !== null);
  if (reported.length === 0) return null;
  return reported.some(Boolean);
}

function describeRoute(started: StereoProbeStartedEvent | null): string | null {
  const route = started?.routedDevice;
  if (!route) return null;
  return [route.type, route.productName].filter(Boolean).join(" ");
}

/** Drops the warm-up frames, then reduces one capture to the per-run record that is logged. */
export function summariseProbeRun(
  options: StereoProbeOptions,
  started: StereoProbeStartedEvent | null,
  allFrames: StereoProbeFrameEvent[],
  error: string | null
): StereoProbeRunSummary {
  const firstTimestamp = allFrames.length > 0 ? allFrames[0].timestampMs : 0;
  const settled = allFrames.filter((frame) => frame.timestampMs - firstTimestamp >= STEREO_PROBE_WARMUP_MS);
  const frames = settled.length > 0 ? settled : allFrames;
  const voiced = frames.filter((frame) => frame.voiceActive);
  const conversationLevels = frames
    .map((frame) => frame.conversationRms)
    .filter((value): value is number => value !== null);
  const conversationRmsDb = conversationLevels.length > 0 ? Math.max(...conversationLevels) : null;

  return {
    source: options.source,
    requestedSampleRate: options.sampleRate ?? 48000,
    simulateConversationCapture: options.simulateConversationCapture,
    opened: started !== null,
    error,
    channelCount: started?.channelCount ?? null,
    sampleRate: started?.sampleRate ?? null,
    verdict: started ? deriveStereoVerdict(started.channelCount, frames) : null,
    aecAvailable: started?.aec?.available ?? null,
    aecEnabled: started?.aec?.enabled ?? null,
    routedDevice: describeRoute(started),
    medianBearingDeg: median(voiced.map((frame) => frame.bearingDeg).filter((value): value is number => value !== null)),
    meanPeakRatio: mean(voiced.map((frame) => frame.peakRatio)),
    meanCorrelation: mean(frames.map((frame) => frame.channelCorrelation)),
    voiceActivePct: frames.length > 0 ? Math.round((voiced.length / frames.length) * 100) : null,
    conversationRmsDb,
    conversationAlive: options.simulateConversationCapture
      ? conversationRmsDb !== null && conversationRmsDb > STEREO_PROBE_DIGITAL_FLOOR_DB
      : null,
    conversationAecEnabled: started?.conversation?.aec?.enabled ?? null,
    stereoClientSilenced: anyFlag(frames, (frame) => frame.stereoClientSilenced),
    conversationClientSilenced: anyFlag(frames, (frame) => frame.conversationClientSilenced),
    frames: frames.length,
  };
}

function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Flat primitives only, as the diagnostic log requires. Carries no audio content. */
export function runSummaryToDiagnosticDetails(summary: StereoProbeRunSummary): DiagnosticDetails {
  return {
    source: summary.source,
    requestedSampleRate: summary.requestedSampleRate,
    simulateConversationCapture: summary.simulateConversationCapture,
    opened: summary.opened,
    error: summary.error,
    channelCount: summary.channelCount,
    sampleRate: summary.sampleRate,
    verdict: summary.verdict,
    aecAvailable: summary.aecAvailable,
    aecEnabled: summary.aecEnabled,
    routedDevice: summary.routedDevice,
    medianBearingDeg: round(summary.medianBearingDeg, 1),
    meanPeakRatio: round(summary.meanPeakRatio, 2),
    meanCorrelation: round(summary.meanCorrelation, 4),
    voiceActivePct: summary.voiceActivePct,
    conversationRmsDb: round(summary.conversationRmsDb, 1),
    conversationAlive: summary.conversationAlive,
    conversationAecEnabled: summary.conversationAecEnabled,
    stereoClientSilenced: summary.stereoClientSilenced,
    conversationClientSilenced: summary.conversationClientSilenced,
    frames: summary.frames,
  };
}

export function capabilitiesToDiagnosticDetails(capabilities: StereoProbeCapabilities): DiagnosticDetails {
  const microphones = capabilities.microphones
    .map((mic) => {
      const position = mic.position
        ? `(${mic.position.x.toFixed(3)},${mic.position.y.toFixed(3)},${mic.position.z.toFixed(3)})`
        : "pos?";
      return `#${mic.id} ${mic.type} ${mic.location} ${position}`;
    })
    .join(" | ");
  const inputDevices = capabilities.inputDevices
    .map((device) => `${device.type} ch[${device.channelCounts.join(",")}] hz[${device.sampleRates.join(",")}]`)
    .join(" | ");
  return {
    manufacturer: capabilities.manufacturer,
    model: capabilities.model,
    sdkInt: capabilities.sdkInt,
    microphoneCount: capabilities.microphones.length,
    unprocessedSupported: capabilities.unprocessedSupported,
    estimatedMicSpacingM: round(capabilities.estimatedMicSpacingM, 4),
    microphones,
    inputDevices,
  };
}

export type SideCalibrationMapping = "negative-is-left" | "positive-is-left" | "inconclusive";

/**
 * Reads the bearing sign convention (positive = right channel first) against
 * what the user did. Speaking on the robot's LEFT that yields a negative
 * bearing means channel 0 sits on the robot's left, so negative = LEFT.
 */
export function deriveSideMapping(
  leftBearingDeg: number | null,
  rightBearingDeg: number | null
): SideCalibrationMapping {
  const votes: Array<"negative-is-left" | "positive-is-left"> = [];
  if (leftBearingDeg !== null && Math.abs(leftBearingDeg) >= 5) {
    votes.push(leftBearingDeg < 0 ? "negative-is-left" : "positive-is-left");
  }
  if (rightBearingDeg !== null && Math.abs(rightBearingDeg) >= 5) {
    votes.push(rightBearingDeg > 0 ? "negative-is-left" : "positive-is-left");
  }
  if (votes.length === 0) return "inconclusive";
  return votes.every((vote) => vote === votes[0]) ? votes[0] : "inconclusive";
}
