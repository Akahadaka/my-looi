import {
  getStereoMicProbeModule,
  type StereoProbeErrorEvent,
  type StereoProbeFrameEvent,
  type StereoProbeOptions,
  type StereoProbeStartedEvent,
} from "../../modules/stereo-mic-probe";

export type StereoProbeSession = {
  started: StereoProbeStartedEvent;
  stop: () => Promise<void>;
};

export type StereoProbeHandlers = {
  onFrame?: (frame: StereoProbeFrameEvent) => void;
  onError?: (error: StereoProbeErrorEvent) => void;
};

/** Starts the native probe and keeps the event subscriptions alive until `stop()`. */
export async function startStereoProbeSession(
  options: StereoProbeOptions,
  handlers: StereoProbeHandlers = {}
): Promise<StereoProbeSession> {
  const module = getStereoMicProbeModule();
  if (!module) throw new Error("Stereo microphone probe is unavailable in this build");

  const subscriptions = [
    module.addListener("onProbeFrame", (frame) => handlers.onFrame?.(frame)),
    module.addListener("onProbeError", (error) => handlers.onError?.(error)),
  ];
  const release = () => subscriptions.forEach((subscription) => subscription.remove());

  try {
    const started = await module.start(options);
    return {
      started,
      stop: async () => {
        release();
        await module.stop();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export type StereoProbeCaptureResult = {
  started: StereoProbeStartedEvent | null;
  frames: StereoProbeFrameEvent[];
  error: string | null;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one timed capture and always stops the native probe afterwards. Ends
 * early when `shouldAbort` returns true or the native side reports a fatal error.
 */
export async function runStereoProbeCapture(
  options: StereoProbeOptions,
  durationMs: number,
  hooks: StereoProbeHandlers & { shouldAbort?: () => boolean } = {}
): Promise<StereoProbeCaptureResult> {
  const frames: StereoProbeFrameEvent[] = [];
  let fatalError: string | null = null;
  let session: StereoProbeSession | null = null;
  try {
    session = await startStereoProbeSession(options, {
      onFrame: (frame) => {
        frames.push(frame);
        hooks.onFrame?.(frame);
      },
      onError: (error) => {
        if (error.fatal) fatalError = `${error.stage}: ${error.message}`;
        hooks.onError?.(error);
      },
    });
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline && !fatalError && !hooks.shouldAbort?.()) {
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    return { started: session.started, frames, error: fatalError };
  } catch (error) {
    return { started: session?.started ?? null, frames, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await session?.stop().catch(() => undefined);
  }
}
