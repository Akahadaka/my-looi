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

/** UNPROCESSED first: it gives near-full-range bearings, whereas CAMCORDER compresses and biases them. */
export const STEREO_PROBE_SOURCES: StereoProbeSource[] = [
  "UNPROCESSED",
  "CAMCORDER",
  "VOICE_COMMUNICATION",
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
  /** Median robot-frame bearing (positive = robot's right) of the vote over the settled frames. */
  medianRobotBearingDeg: number | null;
  /** Mean vote share, in percent, over the settled frames that had at least one voiced window. */
  voteSharePct: number | null;
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
  const voteFrames = frames.filter((frame) => frame.voteCount > 0);
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
    medianRobotBearingDeg: median(frames.map((frame) => frame.robotBearingDeg).filter((value): value is number => value !== null)),
    voteSharePct: mean(voteFrames.map((frame) => frame.voteShare * 100)),
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
    medianRobotBearingDeg: round(summary.medianRobotBearingDeg, 1),
    voteSharePct: round(summary.voteSharePct, 0),
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

export type SideCheckSide = "left" | "right";

export type SideCheckResult = {
  /** Median robot-frame bearing of the frames that had a trusted vote; null when there were none. */
  medianRobotBearingDeg: number | null;
  /** Number of frames with a trusted robot-frame bearing. */
  samples: number;
  /** True when LOOI's left read negative or LOOI's right read positive; null without a bearing. */
  passed: boolean | null;
};

/**
 * Judges one "Check sides" capture. The bearing is already in the robot frame
 * (positive = LOOI's right), so speaking from LOOI's left must read negative
 * and from LOOI's right positive. Warm-up frames are dropped.
 */
export function evaluateSideCheck(side: SideCheckSide, frames: StereoProbeFrameEvent[]): SideCheckResult {
  const firstTimestamp = frames.length > 0 ? frames[0].timestampMs : 0;
  const bearings = frames
    .filter((frame) => frame.timestampMs - firstTimestamp >= STEREO_PROBE_WARMUP_MS && frame.robotBearingDeg !== null)
    .map((frame) => frame.robotBearingDeg as number);
  const medianRobotBearingDeg = median(bearings);
  if (medianRobotBearingDeg === null) return { medianRobotBearingDeg, samples: 0, passed: null };
  return {
    medianRobotBearingDeg,
    samples: bearings.length,
    passed: side === "left" ? medianRobotBearingDeg < 0 : medianRobotBearingDeg > 0,
  };
}
