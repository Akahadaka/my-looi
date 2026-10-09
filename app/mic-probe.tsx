import { useCallback, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";

import { looiTheme } from "@/src/ui/looi-theme";
import { useUiText } from "@/src/i18n/use-ui-text";
import type { UiStringKey } from "@/src/i18n/ui-strings";
import { voiceRuntime } from "@/src/perceivers/voice-runtime";
import { kwsAudioFeeder } from "@/src/voice/kws-audio-feeder";
import { useUserStore } from "@/src/store/user";
import { recordDiagnosticEvent } from "@/src/diagnostics/diagnostic-log";
import {
  capabilitiesToDiagnosticDetails,
  deriveStereoVerdict,
  evaluateSideCheck,
  runSummaryToDiagnosticDetails,
  STEREO_PROBE_SOURCES,
  STEREO_PROBE_VERDICT_FRAMES,
  STEREO_PROBE_WARMUP_MS,
  summariseProbeRun,
  type SideCheckResult,
  type SideCheckSide,
  type StereoProbeRunSummary,
} from "@/src/diagnostics/stereo-mic-probe-analysis";
import {
  runStereoProbeCapture,
  startStereoProbeSession,
  type StereoProbeSession,
} from "@/src/diagnostics/stereo-mic-probe-runner";
import {
  getStereoMicProbeModule,
  type StereoProbeCapabilities,
  type StereoProbeFrameEvent,
  type StereoProbeSource,
  type StereoProbeStartedEvent,
} from "../modules/stereo-mic-probe";

const SAMPLE_RATES = [48000, 44100, 16000] as const;
const MATRIX_RUN_MS = 4000;
const MATRIX_GAP_MS = 600;
const SIDE_CHECK_MS = 3000;
const WAV_SECONDS = 5;
const LEVEL_MIN_DB = -90;
const GAUGE_MAX_DEG = 90;

type ProbeMode = "idle" | "live" | "matrix" | "sideCheck" | "record";

/** What the app's own capture looked like before the probe took the microphone. */
type CapturePauseState = { appCaptureAllowed: boolean; feederWasRunning: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDb(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

function levelFraction(db: number): number {
  return Math.min(1, Math.max(0, (db - LEVEL_MIN_DB) / -LEVEL_MIN_DB));
}

export default function MicProbeScreen() {
  const { t } = useUiText();
  const [capabilities, setCapabilities] = useState<StereoProbeCapabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [source, setSource] = useState<StereoProbeSource>("UNPROCESSED");
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [simulateConversation, setSimulateConversation] = useState(false);
  const [mode, setMode] = useState<ProbeMode>("idle");
  const [started, setStarted] = useState<StereoProbeStartedEvent | null>(null);
  const [recentFrames, setRecentFrames] = useState<StereoProbeFrameEvent[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matrixRows, setMatrixRows] = useState<StereoProbeRunSummary[]>([]);
  const [sideChecks, setSideChecks] = useState<Record<SideCheckSide, SideCheckResult | undefined>>({ left: undefined, right: undefined });

  const liveSessionRef = useRef<StereoProbeSession | null>(null);
  const abortRef = useRef(false);
  const pauseRef = useRef<Promise<CapturePauseState> | null>(null);
  const modeRef = useRef<ProbeMode>("idle");
  const settingsRef = useRef({ source, sampleRate, simulateConversation });
  settingsRef.current = { source, sampleRate, simulateConversation };

  const changeMode = useCallback((next: ProbeMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const handleFrame = useCallback((frame: StereoProbeFrameEvent) => {
    setRecentFrames((frames) => [...frames.slice(-(STEREO_PROBE_VERDICT_FRAMES - 1)), frame]);
  }, []);

  /**
   * The conversation and wake-word capture would compete with the probe for
   * the microphone. Realtime is stopped the same way Settings does on focus;
   * the KWS feeder is stopped and its capture gate closed so nothing restarts
   * it until the previous state is restored on leave.
   */
  const pauseAppCapture = useCallback((): Promise<CapturePauseState> => {
    pauseRef.current ??= (async () => {
      await voiceRuntime.suspendMainScreenConversation("mic-probe-focused").catch((reason) => {
        recordDiagnosticEvent("audio", "stereo-mic-probe-suspend-failed", { error: errorMessage(reason) });
      });
      const previous: CapturePauseState = {
        appCaptureAllowed: kwsAudioFeeder.diagnosticStatus.appCaptureAllowed,
        feederWasRunning: kwsAudioFeeder.isRunning,
      };
      kwsAudioFeeder.setAppCaptureAllowed(false);
      await kwsAudioFeeder.stop().catch(() => undefined);
      recordDiagnosticEvent("audio", "stereo-mic-probe-app-capture-paused", { ...previous });
      return previous;
    })();
    return pauseRef.current;
  }, []);

  const restoreAppCapture = useCallback(async () => {
    const pending = pauseRef.current;
    pauseRef.current = null;
    if (!pending) return;
    const previous = await pending;
    kwsAudioFeeder.setAppCaptureAllowed(previous.appCaptureAllowed);
    const wakeWordEnabled = useUserStore.getState().preferences.wakeWordEnabled;
    if (previous.appCaptureAllowed && previous.feederWasRunning && wakeWordEnabled) {
      await kwsAudioFeeder.start().catch((reason) => {
        recordDiagnosticEvent("audio", "stereo-mic-probe-feeder-restore-failed", { error: errorMessage(reason) });
      });
    }
    recordDiagnosticEvent("audio", "stereo-mic-probe-app-capture-restored", { ...previous });
  }, []);

  const stopLive = useCallback(async () => {
    const session = liveSessionRef.current;
    liveSessionRef.current = null;
    await session?.stop().catch(() => undefined);
    if (modeRef.current === "live") changeMode("idle");
  }, [changeMode]);

  /** Stops whatever is running (live, matrix, side check) and waits for the native probe to release the microphone. */
  const stopEverything = useCallback(async () => {
    abortRef.current = true;
    await stopLive();
    await getStereoMicProbeModule()?.stop().catch(() => undefined);
  }, [stopLive]);

  useFocusEffect(useCallback(() => {
    abortRef.current = false;
    let cancelled = false;
    recordDiagnosticEvent("navigation", "mic-probe-focused");
    void pauseAppCapture();

    const module = getStereoMicProbeModule();
    if (module) {
      module.getCapabilities().then((next) => {
        if (cancelled) return;
        setCapabilities(next);
        setCapabilitiesError(null);
        recordDiagnosticEvent("audio", "stereo-mic-probe-capabilities", capabilitiesToDiagnosticDetails(next));
      }).catch((reason) => {
        if (!cancelled) setCapabilitiesError(errorMessage(reason));
      });
    }

    // A backgrounded app must not keep a capture running behind the system's back.
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") void stopEverything();
    });

    return () => {
      cancelled = true;
      appState.remove();
      recordDiagnosticEvent("navigation", "mic-probe-blurred");
      void stopEverything().finally(() => {
        setStarted(null);
        setRecentFrames([]);
        changeMode("idle");
        void restoreAppCapture();
      });
    };
  }, [changeMode, pauseAppCapture, restoreAppCapture, stopEverything]));

  /** Saves 5 s of raw stereo from the selected source for offline analysis (pulled with adb). */
  const recordWav = useCallback(async () => {
    if (modeRef.current !== "idle") return;
    changeMode("record");
    abortRef.current = false;
    setError(null);
    setRecentFrames([]);
    setMessage(t("micProbe.recordingWav", { seconds: WAV_SECONDS }));
    try {
      await pauseAppCapture();
      const current = settingsRef.current;
      const result = await runStereoProbeCapture(
        { source: current.source, sampleRate: current.sampleRate, simulateConversationCapture: false, recordWavSeconds: WAV_SECONDS },
        WAV_SECONDS * 1000 + 500,
        { onFrame: handleFrame, shouldAbort: () => abortRef.current }
      );
      setStarted(result.started);
      if (result.error) setError(t("common.error", { message: result.error }));
      else if (result.started?.wavPath) {
        recordDiagnosticEvent("audio", "stereo-mic-probe-wav-saved", { source: current.source, path: result.started.wavPath });
        setMessage(t("micProbe.wavSaved", { path: result.started.wavPath }));
      }
    } finally {
      changeMode("idle");
    }
  }, [changeMode, handleFrame, pauseAppCapture, t]);

  const startLive = useCallback(async () => {
    if (modeRef.current !== "idle") return;
    changeMode("live");
    setError(null);
    setMessage(null);
    setRecentFrames([]);
    setStarted(null);
    abortRef.current = false;
    try {
      await pauseAppCapture();
      const current = settingsRef.current;
      const session = await startStereoProbeSession(
        { source: current.source, sampleRate: current.sampleRate, simulateConversationCapture: current.simulateConversation },
        {
          onFrame: handleFrame,
          onError: (nativeError) => {
            setError(t("micProbe.errorStage", { stage: nativeError.stage, message: nativeError.message }));
            if (nativeError.fatal) void stopLive();
          },
        }
      );
      if (abortRef.current) {
        // Stop was pressed while the native probe was still opening.
        await session.stop().catch(() => undefined);
        changeMode("idle");
        return;
      }
      liveSessionRef.current = session;
      setStarted(session.started);
    } catch (reason) {
      setError(t("common.error", { message: errorMessage(reason) }));
      changeMode("idle");
    }
  }, [changeMode, handleFrame, pauseAppCapture, stopLive, t]);

  const runMatrix = useCallback(async () => {
    if (modeRef.current !== "idle") return;
    changeMode("matrix");
    abortRef.current = false;
    setError(null);
    setMatrixRows([]);
    setRecentFrames([]);
    setStarted(null);
    const rate = settingsRef.current.sampleRate;
    const plan = STEREO_PROBE_SOURCES.flatMap((planned) => [false, true].map((simulate) => ({ source: planned, simulate })));
    try {
      await pauseAppCapture();
      for (let index = 0; index < plan.length && !abortRef.current; index += 1) {
        const { source: runSource, simulate } = plan[index];
        setMessage(t("micProbe.matrixProgress", {
          index: index + 1,
          total: plan.length,
          source: runSource,
          conversation: simulate ? t("common.on") : t("common.off"),
        }));
        const options = { source: runSource, sampleRate: rate, simulateConversationCapture: simulate };
        const result = await runStereoProbeCapture(options, MATRIX_RUN_MS, {
          onFrame: handleFrame,
          shouldAbort: () => abortRef.current,
        });
        if (abortRef.current) break;
        const summary = summariseProbeRun(options, result.started, result.frames, result.error);
        setMatrixRows((rows) => [...rows, summary]);
        recordDiagnosticEvent("audio", "stereo-mic-probe-run", runSummaryToDiagnosticDetails(summary));
        await delay(MATRIX_GAP_MS);
      }
      setMessage(abortRef.current ? t("micProbe.matrixCancelled") : t("micProbe.matrixDone"));
    } catch (reason) {
      setError(t("common.error", { message: errorMessage(reason) }));
    } finally {
      changeMode("idle");
    }
  }, [changeMode, handleFrame, pauseAppCapture, t]);

  const checkSide = useCallback(async (side: SideCheckSide) => {
    if (modeRef.current !== "idle") return;
    changeMode("sideCheck");
    abortRef.current = false;
    setError(null);
    setRecentFrames([]);
    setStarted(null);
    const sideLabel = t(side === "left" ? "micProbe.sideLeft" : "micProbe.sideRight");
    setMessage(t("micProbe.sideChecking", { side: sideLabel }));
    try {
      await pauseAppCapture();
      const current = settingsRef.current;
      const options = { source: current.source, sampleRate: current.sampleRate, simulateConversationCapture: false };
      const result = await runStereoProbeCapture(options, SIDE_CHECK_MS, {
        onFrame: handleFrame,
        shouldAbort: () => abortRef.current,
      });
      if (abortRef.current) return;
      const check = evaluateSideCheck(side, result.frames);
      setSideChecks((previous) => ({ ...previous, [side]: check }));
      recordDiagnosticEvent("audio", "stereo-mic-probe-side-check", {
        side,
        source: options.source,
        sampleRate: options.sampleRate,
        opened: result.started !== null,
        channelCount: result.started?.channelCount ?? null,
        displayRotation: result.started?.displayRotation ?? null,
        medianRobotBearingDeg: check.medianRobotBearingDeg === null ? null : Math.round(check.medianRobotBearingDeg * 10) / 10,
        samples: check.samples,
        passed: check.passed,
        error: result.error,
      });
      if (result.error) setError(t("common.error", { message: result.error }));
      setMessage(check.medianRobotBearingDeg === null
        ? t("micProbe.sideCheckNoVoice", { side: sideLabel })
        : t("micProbe.sideCheckResult", { mark: check.passed ? "✓" : "✗", side: sideLabel, bearing: check.medianRobotBearingDeg.toFixed(1), samples: check.samples }));
    } catch (reason) {
      setError(t("common.error", { message: errorMessage(reason) }));
    } finally {
      changeMode("idle");
    }
  }, [changeMode, handleFrame, pauseAppCapture, t]);

  const latest = recentFrames[recentFrames.length - 1] ?? null;
  const verdict = started || mode !== "idle" ? deriveStereoVerdict(started?.channelCount ?? (latest?.channelCount ?? null), recentFrames) : null;
  const busy = mode !== "idle";
  const moduleAvailable = getStereoMicProbeModule() !== null;

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    <Stack.Screen options={{ title: t("micProbe.title") }} />
    <Text style={styles.help}>{t("micProbe.help")}</Text>
    {!moduleAvailable ? <Text style={[styles.result, styles.danger]}>{t("micProbe.unavailable")}</Text> : null}

    <Section title={t("micProbe.capabilities")}>
      {capabilities ? <CapabilitiesView capabilities={capabilities} /> : <Text style={styles.help}>{capabilitiesError ? t("common.error", { message: capabilitiesError }) : t("micProbe.loadingCapabilities")}</Text>}
    </Section>

    <Section title={t("micProbe.controls")}>
      <Text style={styles.label}>{t("micProbe.source")}</Text>
      <ButtonRow>{STEREO_PROBE_SOURCES.map((item) => <SmallChoice key={item} selected={source === item} label={item} onPress={() => setSource(item)} disabled={busy} />)}</ButtonRow>
      <Text style={styles.label}>{t("micProbe.sampleRate")}</Text>
      <ButtonRow>{SAMPLE_RATES.map((rate) => <SmallChoice key={rate} selected={sampleRate === rate} label={`${rate} Hz`} onPress={() => setSampleRate(rate)} disabled={busy} />)}</ButtonRow>
      <Pressable onPress={() => setSimulateConversation((value) => !value)} disabled={busy} style={[styles.switchRow, busy && styles.disabled]}>
        <Text style={styles.value}>{t("micProbe.simulateConversation")}</Text>
        <Text style={[styles.pill, simulateConversation && styles.pillOn]}>{simulateConversation ? t("common.on") : t("common.off")}</Text>
      </Pressable>
      <Text style={styles.help}>{t("micProbe.simulateHelp")}</Text>
      <ButtonRow>
        <Action label={t("micProbe.start")} onPress={() => void startLive()} disabled={busy || !moduleAvailable} />
        <Action label={t("micProbe.stop")} onPress={() => void stopEverything()} disabled={!busy} secondary />
        <Action label={t("micProbe.recordWav", { seconds: WAV_SECONDS })} onPress={() => void recordWav()} disabled={busy || !moduleAvailable} secondary />
      </ButtonRow>
    </Section>

    <Section title={t("micProbe.live")}>
      <LiveReadout t={t} started={started} latest={latest} verdict={verdict} running={busy} />
    </Section>

    {message ? <Text style={styles.result}>{message}</Text> : null}
    {error ? <Text style={[styles.result, styles.danger]}>{error}</Text> : null}

    <Section title={t("micProbe.matrix")}>
      <Text style={styles.help}>{t("micProbe.matrixHelp")}</Text>
      <ButtonRow>
        <Action label={t("micProbe.runMatrix")} onPress={() => void runMatrix()} disabled={busy || !moduleAvailable} />
        {mode === "matrix" ? <Action label={t("micProbe.cancelMatrix")} onPress={() => { abortRef.current = true; }} secondary /> : null}
      </ButtonRow>
      {matrixRows.length > 0 ? <MatrixTable t={t} rows={matrixRows} /> : null}
    </Section>

    <Section title={t("micProbe.sideCheck")}>
      <Text style={styles.help}>{t("micProbe.sideCheckHelp")}</Text>
      <ButtonRow>
        <Action label={t("micProbe.sideCheckLeft")} onPress={() => void checkSide("left")} disabled={busy || !moduleAvailable} />
        <Action label={t("micProbe.sideCheckRight")} onPress={() => void checkSide("right")} disabled={busy || !moduleAvailable} />
      </ButtonRow>
      {(["left", "right"] as const).map((side) => {
        const check = sideChecks[side];
        if (!check) return null;
        const label = t(side === "left" ? "micProbe.sideLeft" : "micProbe.sideRight");
        return <Text key={side} style={[styles.value, check.passed === false ? styles.danger : check.passed ? styles.ok : styles.muted]}>
          {check.medianRobotBearingDeg === null ? `${label}: ${t("micProbe.bearingNone")}` : t("micProbe.sideCheckResult", { mark: check.passed ? "✓" : "✗", side: label, bearing: check.medianRobotBearingDeg.toFixed(1), samples: check.samples })}
        </Text>;
      })}
    </Section>
  </ScrollView>;
}

type Translate = (key: UiStringKey, params?: Record<string, string | number>) => string;

function CapabilitiesView({ capabilities }: { capabilities: StereoProbeCapabilities }) {
  const { t } = useUiText();
  return <>
    <Text style={styles.value}>{t("micProbe.device", { manufacturer: capabilities.manufacturer, model: capabilities.model, sdk: capabilities.sdkInt })}</Text>
    <Text style={styles.help}>{capabilities.estimatedMicSpacingM === null ? t("micProbe.spacingUnknown") : t("micProbe.spacing", { value: capabilities.estimatedMicSpacingM.toFixed(3) })}</Text>
    <Text style={styles.help}>{capabilities.unprocessedSupported ? t("micProbe.unprocessedYes") : t("micProbe.unprocessedNo")}</Text>
    <Text style={styles.label}>{t("micProbe.microphones", { count: capabilities.microphones.length })}</Text>
    {capabilities.microphones.length === 0 ? <Text style={styles.help}>{t("micProbe.noMicrophones")}</Text> : null}
    {capabilities.microphones.map((mic) => <Text key={mic.id} style={styles.help}>{t("micProbe.micLine", {
      id: mic.id,
      type: mic.type,
      location: mic.location,
      position: mic.position ? `(${mic.position.x.toFixed(3)}, ${mic.position.y.toFixed(3)}, ${mic.position.z.toFixed(3)}) m` : t("micProbe.positionUnknown"),
    })}</Text>)}
    <Text style={styles.label}>{t("micProbe.inputDevices", { count: capabilities.inputDevices.length })}</Text>
    {capabilities.inputDevices.map((device, index) => <Text key={`${device.type}-${device.address ?? index}`} style={styles.help}>{t("micProbe.inputDeviceLine", {
      type: device.productName ? `${device.type} ${device.productName}` : device.type,
      channels: device.channelCounts.join("/") || "?",
    })}</Text>)}
  </>;
}

function LiveReadout({ t, started, latest, verdict, running }: { t: Translate; started: StereoProbeStartedEvent | null; latest: StereoProbeFrameEvent | null; verdict: ReturnType<typeof deriveStereoVerdict>; running: boolean }) {
  if (!running && !started) return <Text style={styles.help}>{t("micProbe.idle")}</Text>;
  const aec = started?.aec;
  const aecState = !aec || !aec.available ? t("micProbe.aecUnavailable") : aec.enabled ? t("micProbe.aecEnabled") : t("micProbe.aecDisabled");
  const route = started?.routedDevice ? [started.routedDevice.type, started.routedDevice.productName].filter(Boolean).join(" ") : t("micProbe.routeUnknown");
  const flag = (value: boolean | null | undefined) => value === null || value === undefined ? t("micProbe.unknown") : value ? t("micProbe.yes") : t("micProbe.no");
  return <>
    {started ? <>
      <Text style={styles.value}>{t("micProbe.format", { channels: started.channelCount, rate: started.sampleRate })}</Text>
      <Text style={styles.help}>{t("micProbe.route", { device: route })}</Text>
      <Text style={styles.help}>{t("micProbe.aecLine", { state: aecState })}</Text>
      <Text style={styles.help}>{t("micProbe.frameInfo", { rotation: started.displayRotation })}</Text>
    </> : null}
    <Text style={[styles.verdict, verdict === "TRUE_STEREO" ? styles.ok : verdict === "FAKE_STEREO" ? styles.warn : verdict ? styles.danger : styles.muted]}>
      {verdict ? t(`micProbe.verdict.${verdict}` as UiStringKey) : t("micProbe.waiting")}
    </Text>
    {latest ? <>
      <LevelBar label={t("micProbe.levelLeft")} db={latest.rmsL} />
      <LevelBar label={t("micProbe.levelRight")} db={latest.rmsR} />
      <Text style={styles.help}>{t("micProbe.correlation", { value: latest.channelCorrelation.toFixed(3) })}</Text>
      <Text style={styles.label}>{t("micProbe.bearing")}: {latest.robotBearingDeg !== null ? t("micProbe.bearingValue", { value: latest.robotBearingDeg.toFixed(0) }) : t("micProbe.bearingNone")}</Text>
      <BearingGauge t={t} bearingDeg={latest.robotBearingDeg} />
      <Text style={styles.help}>{t("micProbe.vote", { share: Math.round(latest.voteShare * 100), count: latest.voteCount })}</Text>
      {latest.robotFrameAvailable ? null : <Text style={[styles.help, styles.warn]}>{t("micProbe.robotFrameUnavailable")}</Text>}
      <Text style={styles.help}>{t("micProbe.gaugeHint")}</Text>
      <Text style={styles.help}>{t("micProbe.peakRatio", { value: latest.peakRatio.toFixed(1) })}</Text>
      <Text style={styles.help}>{latest.conversationRms === null ? t("micProbe.conversationOff") : t("micProbe.conversationRms", { value: formatDb(latest.conversationRms) })}</Text>
      <Text style={styles.help}>{t("micProbe.silenced", { stereo: flag(latest.stereoClientSilenced), conversation: flag(latest.conversationClientSilenced) })}</Text>
    </> : null}
  </>;
}

function LevelBar({ label, db }: { label: string; db: number }) {
  return <View style={styles.levelRow}>
    <Text style={styles.levelLabel}>{label}</Text>
    <View style={styles.levelTrack}><View style={[styles.levelFill, { width: `${Math.round(levelFraction(db) * 100)}%` }]} /></View>
    <Text style={styles.levelValue}>{formatDb(db)} dB</Text>
  </View>;
}

/**
 * Drawn from the viewer's side: the screen is LOOI's face looking at the user, so
 * LOOI's right (positive bearing) appears on the left of the screen, like a mirror.
 */
function BearingGauge({ t, bearingDeg }: { t: Translate; bearingDeg: number | null }) {
  const clamped = bearingDeg === null ? 0 : Math.max(-GAUGE_MAX_DEG, Math.min(GAUGE_MAX_DEG, bearingDeg));
  const markerPct = ((GAUGE_MAX_DEG - clamped) / (2 * GAUGE_MAX_DEG)) * 100;
  return <View>
    <View style={styles.gaugeTrack}>
      <View style={styles.gaugeCentre} />
      {bearingDeg !== null ? <View style={[styles.gaugeMarker, { left: `${markerPct}%` }]} /> : null}
    </View>
    <View style={styles.gaugeScale}>
      <Text style={[styles.help, styles.gaugeEnd]}>{t("micProbe.sideRight")}</Text>
      <Text style={styles.help}>0°</Text>
      <Text style={[styles.help, styles.gaugeEnd, styles.gaugeEndRight]}>{t("micProbe.sideLeft")}</Text>
    </View>
  </View>;
}

function MatrixTable({ t, rows }: { t: Translate; rows: StereoProbeRunSummary[] }) {
  const flag = (value: boolean | null) => value === null ? "–" : value ? t("micProbe.yes") : t("micProbe.no");
  const columns: Array<{ key: string; title: string; width: number; cell: (row: StereoProbeRunSummary) => string }> = [
    { key: "source", title: t("micProbe.col.source"), width: 150, cell: (row) => row.source },
    { key: "conversation", title: t("micProbe.col.conversation"), width: 56, cell: (row) => row.simulateConversationCapture ? t("common.on") : t("common.off") },
    { key: "opened", title: t("micProbe.col.opened"), width: 56, cell: (row) => row.opened ? t("micProbe.yes") : (row.error ?? t("micProbe.no")) },
    { key: "channels", title: t("micProbe.col.channels"), width: 40, cell: (row) => row.channelCount === null ? "–" : String(row.channelCount) },
    { key: "verdict", title: t("micProbe.col.verdict"), width: 150, cell: (row) => row.verdict ? t(`micProbe.verdict.${row.verdict}` as UiStringKey) : "–" },
    { key: "aec", title: t("micProbe.col.aec"), width: 60, cell: (row) => row.aecAvailable === null ? "–" : `${flag(row.aecAvailable)}/${flag(row.aecEnabled)}` },
    { key: "bearing", title: t("micProbe.col.bearing"), width: 70, cell: (row) => row.medianRobotBearingDeg === null ? "—" : `${row.medianRobotBearingDeg.toFixed(0)}°` },
    { key: "vote", title: t("micProbe.col.vote"), width: 50, cell: (row) => row.voteSharePct === null ? "—" : `${Math.round(row.voteSharePct)}%` },
    { key: "peak", title: t("micProbe.col.peak"), width: 50, cell: (row) => row.meanPeakRatio === null ? "—" : row.meanPeakRatio.toFixed(1) },
    { key: "voice", title: t("micProbe.col.voice"), width: 56, cell: (row) => row.voiceActivePct === null ? "–" : `${row.voiceActivePct}%` },
    { key: "convAlive", title: t("micProbe.col.convAlive"), width: 80, cell: (row) => flag(row.conversationAlive) },
    { key: "silenced", title: t("micProbe.col.silenced"), width: 90, cell: (row) => `${flag(row.stereoClientSilenced)}/${flag(row.conversationClientSilenced)}` },
  ];
  return <ScrollView horizontal>
    <View>
      <View style={styles.tableRow}>{columns.map((column) => <Text key={column.key} style={[styles.tableCell, styles.tableHead, { width: column.width }]}>{column.title}</Text>)}</View>
      {rows.map((row, index) => <View key={index} style={styles.tableRow}>{columns.map((column) => <Text key={column.key} style={[styles.tableCell, { width: column.width }]}>{column.cell(row)}</Text>)}</View>)}
    </View>
  </ScrollView>;
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><View style={styles.card}>{children}</View></View>; }
function ButtonRow({ children }: { children: ReactNode }) { return <View style={styles.buttonRow}>{children}</View>; }
function SmallChoice({ selected, label, onPress, disabled }: { selected: boolean; label: string; onPress: () => void; disabled?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.smallChoice, selected && styles.smallChoiceSelected, disabled && styles.disabled]}><Text style={styles.value}>{selected ? `✓ ${label}` : label}</Text></Pressable>; }
function Action({ label, onPress, disabled, secondary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={secondary ? styles.actionSecondaryText : styles.actionText}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: looiTheme.bg },
  content: { padding: 16, paddingBottom: 48 },
  section: { marginBottom: 14 },
  sectionTitle: { color: looiTheme.text, fontSize: 17, fontWeight: "800", marginBottom: 8 },
  card: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 20, backgroundColor: looiTheme.rail, padding: 14, gap: 10 },
  help: { color: looiTheme.muted, fontSize: 12, lineHeight: 17, marginBottom: 6 },
  label: { color: looiTheme.muted, fontSize: 12, fontWeight: "700", marginTop: 4 },
  value: { color: looiTheme.text, fontSize: 13, fontWeight: "700" },
  result: { color: looiTheme.text, fontSize: 12, marginBottom: 12 },
  danger: { color: looiTheme.danger },
  ok: { color: looiTheme.ok },
  warn: { color: looiTheme.warn },
  muted: { color: looiTheme.muted },
  verdict: { fontSize: 20, fontWeight: "900" },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  smallChoice: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  smallChoiceSelected: { borderColor: looiTheme.cyan, backgroundColor: "rgba(40,213,255,0.07)" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  pill: { color: looiTheme.muted, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, overflow: "hidden" },
  pillOn: { color: looiTheme.cyan, borderColor: looiTheme.cyan },
  action: { borderRadius: 12, backgroundColor: looiTheme.cyan, paddingHorizontal: 13, paddingVertical: 9 },
  actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: looiTheme.line },
  actionText: { color: "#041319", fontWeight: "800", fontSize: 12 },
  actionSecondaryText: { color: looiTheme.text, fontWeight: "700", fontSize: 12 },
  disabled: { opacity: 0.35 },
  levelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  levelLabel: { color: looiTheme.text, fontSize: 13, fontWeight: "800", width: 18 },
  levelTrack: { flex: 1, height: 12, borderRadius: 6, backgroundColor: looiTheme.whiteSoft, overflow: "hidden" },
  levelFill: { height: 12, borderRadius: 6, backgroundColor: looiTheme.cyan },
  levelValue: { color: looiTheme.muted, fontSize: 11, width: 64, textAlign: "right" },
  gaugeTrack: { height: 28, borderRadius: 14, backgroundColor: looiTheme.whiteSoft, borderWidth: 1, borderColor: looiTheme.line, justifyContent: "center" },
  gaugeCentre: { position: "absolute", left: "50%", top: 4, bottom: 4, width: 1, backgroundColor: looiTheme.muted },
  gaugeMarker: { position: "absolute", top: 3, width: 16, height: 20, marginLeft: -8, borderRadius: 8, backgroundColor: looiTheme.ok },
  gaugeScale: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  gaugeEnd: { flex: 1 },
  gaugeEndRight: { textAlign: "right" },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: looiTheme.line },
  tableCell: { color: looiTheme.text, fontSize: 11, paddingVertical: 6, paddingRight: 6 },
  tableHead: { color: looiTheme.muted, fontWeight: "800", textTransform: "uppercase", fontSize: 10 },
});
