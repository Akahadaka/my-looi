import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import * as Battery from "expo-battery";

import { looiTheme } from "@/src/ui/looi-theme";
import { useUiText } from "@/src/i18n/use-ui-text";
import type { UiStringKey } from "@/src/i18n/ui-strings";
import { recordDiagnosticEvent } from "@/src/diagnostics/diagnostic-log";
import { dominantUpAxis, integrateDeg, robotYawRatesDegS } from "@/src/diagnostics/pivot-calibration-analysis";
import {
  buildPivotCalibrationPlan,
  PIVOT_CALIBRATION_DEFAULT_REPEATS,
  runCalibrationPivot,
  type PivotTrialResult,
} from "@/src/diagnostics/pivot-calibration-runner";
import { getLooiRobotRuntimeState, subscribeLooiRobotRuntimeState, stopLooiMotion } from "@/src/device-tools/looi-robot";
import { fitPivotDirection, type PivotDirection, type PivotDirectionModel } from "@/src/device-tools/pivot-model";
import {
  clearPivotCalibration,
  loadPivotCalibration,
  pivotDurationForDegrees,
  pivotSegmentsForDegrees,
  savePivotCalibration,
  type PivotCalibration,
  type PivotSurface,
} from "@/src/device-tools/pivot-calibration";
import { getGyroYawRecorderModule, type GyroRecorderInfo, type GyroVector } from "../modules/gyro-yaw-recorder";

const LIVE_POLL_MS = 100;
const SURFACES: PivotSurface[] = ["desk", "carpet", "other"];
const REPEAT_CHOICES = [1, 3, 5] as const;
const PREVIEW_DEGREES = [20, 45, 90, 180] as const;
const TEST_TURN_DEGREES = 90;

type Mode = "idle" | "live" | "calibrating" | "testTurn";
type Translate = (key: UiStringKey, params?: Record<string, string | number>) => string;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDeg(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}°`;
}

async function readPhoneBatteryPercent(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level >= 0 ? Math.round(level * 100) : null;
  } catch {
    return null;
  }
}

export default function PivotCalibrationScreen() {
  const { t } = useUiText();
  const [info, setInfo] = useState<GyroRecorderInfo | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [liveYawDeg, setLiveYawDeg] = useState(0);
  const [liveRateDegS, setLiveRateDegS] = useState(0);
  const [up, setUp] = useState<GyroVector | null>(null);
  const [surface, setSurface] = useState<PivotSurface>("desk");
  const [repeats, setRepeats] = useState<number>(PIVOT_CALIBRATION_DEFAULT_REPEATS);
  const [trials, setTrials] = useState<PivotTrialResult[]>([]);
  const [saved, setSaved] = useState<PivotCalibration | null>(() => loadPivotCalibration());
  const [robotConnected, setRobotConnected] = useState(() => getLooiRobotRuntimeState().connected);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modeRef = useRef<Mode>("idle");
  const abortRef = useRef(false);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batteryRef = useRef<number | null>(null);

  const changeMode = useCallback((next: Mode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  useEffect(() => subscribeLooiRobotRuntimeState(() => setRobotConnected(getLooiRobotRuntimeState().connected)), []);

  const stopLive = useCallback(() => {
    if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    liveTimerRef.current = null;
  }, []);

  /** Cancels everything, stops the wheels if a pivot is in flight and releases the sensors. */
  const stopEverything = useCallback(async () => {
    abortRef.current = true;
    stopLive();
    if (modeRef.current === "calibrating" || modeRef.current === "testTurn") {
      await stopLooiMotion("pivot-calibration-cancelled").catch(() => undefined);
    }
    await getGyroYawRecorderModule()?.stop().catch(() => undefined);
    if (modeRef.current === "live") changeMode("idle");
  }, [changeMode, stopLive]);

  useFocusEffect(useCallback(() => {
    abortRef.current = false;
    let cancelled = false;
    recordDiagnosticEvent("navigation", "pivot-calibration-focused");
    getGyroYawRecorderModule()?.getInfo().then((next) => {
      if (cancelled) return;
      setInfo(next);
      recordDiagnosticEvent("robot", "pivot-calibration-gyro-info", {
        gyroscopeAvailable: next.gyroscopeAvailable,
        gyroscopeName: next.gyroscopeName,
        gravityAvailable: next.gravityAvailable,
        displayRotation: next.displayRotation,
        model: next.model,
      });
    }).catch((reason) => {
      if (!cancelled) setError(t("common.error", { message: errorMessage(reason) }));
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") void stopEverything();
    });
    return () => {
      cancelled = true;
      appState.remove();
      recordDiagnosticEvent("navigation", "pivot-calibration-blurred");
      void stopEverything().finally(() => changeMode("idle"));
    };
  }, [changeMode, stopEverything, t]));

  /** Hand check: integrates yaw continuously so turning LOOI by hand shows which way is positive. */
  const startLive = useCallback(async () => {
    const gyro = getGyroYawRecorderModule();
    if (!gyro || modeRef.current !== "idle") return;
    changeMode("live");
    setError(null);
    setLiveYawDeg(0);
    setLiveRateDegS(0);
    abortRef.current = false;
    try {
      await gyro.start({});
      let lastUp: GyroVector | null = null;
      liveTimerRef.current = setInterval(() => {
        const capture = gyro.drain();
        lastUp = capture.up ?? lastUp;
        setUp(lastUp);
        const rates = robotYawRatesDegS(capture, lastUp);
        if (!rates || rates.length < 2) return;
        const { tMs } = capture;
        setLiveYawDeg((total) => total + integrateDeg(tMs, rates, tMs[0], tMs[tMs.length - 1]));
        setLiveRateDegS(rates[rates.length - 1]);
      }, LIVE_POLL_MS);
    } catch (reason) {
      setError(t("common.error", { message: errorMessage(reason) }));
      changeMode("idle");
    }
  }, [changeMode, t]);

  const finishLive = useCallback(async () => {
    stopLive();
    await getGyroYawRecorderModule()?.stop().catch(() => undefined);
    recordDiagnosticEvent("robot", "pivot-calibration-hand-check", {
      yawDeg: Math.round(liveYawDeg * 10) / 10,
      upAxis: dominantUpAxis(up) ?? "none",
    });
    changeMode("idle");
  }, [changeMode, liveYawDeg, stopLive, up]);

  const runCalibration = useCallback(async () => {
    const gyro = getGyroYawRecorderModule();
    if (!gyro || modeRef.current !== "idle") return;
    changeMode("calibrating");
    abortRef.current = false;
    setError(null);
    setTrials([]);
    const plan = buildPivotCalibrationPlan(undefined, repeats);
    const results: PivotTrialResult[] = [];
    batteryRef.current = await readPhoneBatteryPercent();
    recordDiagnosticEvent("robot", "pivot-calibration-started", {
      surface,
      repeats,
      steps: plan.length,
      phoneBatteryPercent: batteryRef.current,
    });
    try {
      await gyro.start({});
      for (let index = 0; index < plan.length && !abortRef.current; index += 1) {
        const step = plan[index];
        setMessage(t("pivotCalibration.progress", {
          index: index + 1,
          total: plan.length,
          direction: t(step.direction === "left" ? "pivotCalibration.left" : "pivotCalibration.right"),
          duration: step.durationMs,
        }));
        const trial = await runCalibrationPivot(step);
        results.push(trial);
        setTrials([...results]);
        if (trial.error) {
          // A blocked or failed drive (cliff, lost BLE…) ends the run rather than hammering the robot.
          setError(t("common.error", { message: trial.error }));
          break;
        }
      }
      const finished = !abortRef.current && results.length === plan.length;
      setMessage(finished ? t("pivotCalibration.done") : t("pivotCalibration.stopped"));
      const left = fitPivotDirection(results, "left");
      const right = fitPivotDirection(results, "right");
      recordDiagnosticEvent("robot", "pivot-calibration-finished", {
        surface,
        finished,
        trials: results.length,
        phoneBatteryPercent: batteryRef.current,
        ...fitToDiagnostic("left", left),
        ...fitToDiagnostic("right", right),
      });
    } catch (reason) {
      setError(t("common.error", { message: errorMessage(reason) }));
    } finally {
      await gyro.stop().catch(() => undefined);
      changeMode("idle");
    }
  }, [changeMode, repeats, surface, t]);

  const saveRun = useCallback(() => {
    const calibration: PivotCalibration = {
      version: 1,
      createdAt: new Date().toISOString(),
      surface,
      phoneBatteryPercent: batteryRef.current,
      left: fitPivotDirection(trials, "left"),
      right: fitPivotDirection(trials, "right"),
      trials: trials.map(({ direction, durationMs, degrees, completed, settled }) => ({ direction, durationMs, degrees, completed, settled })),
    };
    savePivotCalibration(calibration);
    setSaved(calibration);
    recordDiagnosticEvent("robot", "pivot-calibration-saved", {
      surface,
      ...fitToDiagnostic("left", calibration.left),
      ...fitToDiagnostic("right", calibration.right),
    });
    setMessage(t("pivotCalibration.saved"));
  }, [surface, t, trials]);

  const clearSaved = useCallback(() => {
    clearPivotCalibration();
    setSaved(null);
    recordDiagnosticEvent("robot", "pivot-calibration-cleared");
  }, []);

  /** Turns 90 degrees with the saved model and measures what actually happened. */
  const testTurn = useCallback(async (direction: PivotDirection) => {
    const gyro = getGyroYawRecorderModule();
    if (!gyro || modeRef.current !== "idle") return;
    changeMode("testTurn");
    abortRef.current = false;
    setError(null);
    const durationMs = pivotDurationForDegrees(direction, TEST_TURN_DEGREES);
    try {
      await gyro.start({});
      const trial = await runCalibrationPivot({ direction, durationMs, repeat: 0 });
      if (trial.error) setError(t("common.error", { message: trial.error }));
      setMessage(t("pivotCalibration.testResult", {
        direction: t(direction === "left" ? "pivotCalibration.left" : "pivotCalibration.right"),
        target: TEST_TURN_DEGREES,
        duration: durationMs,
        measured: Number.isFinite(trial.degrees) ? trial.degrees.toFixed(1) : "—",
      }));
      recordDiagnosticEvent("robot", "pivot-calibration-test-turn", {
        direction,
        targetDeg: TEST_TURN_DEGREES,
        durationMs,
        measuredDeg: Number.isFinite(trial.degrees) ? Math.round(trial.degrees * 10) / 10 : "none",
        calibrated: Boolean(saved?.[direction]),
      });
    } catch (reason) {
      setError(t("common.error", { message: errorMessage(reason) }));
    } finally {
      await gyro.stop().catch(() => undefined);
      changeMode("idle");
    }
  }, [changeMode, saved, t]);

  const gyroAvailable = getGyroYawRecorderModule() !== null && info?.gyroscopeAvailable !== false;
  const busy = mode !== "idle";
  const runFits = trials.length > 0
    ? { left: fitPivotDirection(trials, "left"), right: fitPivotDirection(trials, "right") }
    : null;

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    <Stack.Screen options={{ title: t("pivotCalibration.title") }} />
    <Text style={styles.help}>{t("pivotCalibration.help")}</Text>
    {!gyroAvailable ? <Text style={[styles.result, styles.danger]}>{t("pivotCalibration.unavailable")}</Text> : null}

    <Section title={t("pivotCalibration.sensor")}>
      {info ? <>
        <Text style={styles.value}>{info.gyroscopeName ?? t("pivotCalibration.noGyro")}</Text>
        <Text style={styles.help}>{t("pivotCalibration.sensorLine", {
          rotation: info.displayRotation,
          up: info.gravityAvailable ? "TYPE_GRAVITY" : info.accelerometerAvailable ? "TYPE_ACCELEROMETER" : "—",
        })}</Text>
        {info.displayRotation === 0 || info.displayRotation === 180 ? <Text style={[styles.help, styles.warn]}>{t("pivotCalibration.portraitWarning")}</Text> : null}
      </> : <Text style={styles.help}>{t("pivotCalibration.loading")}</Text>}
    </Section>

    <Section title={t("pivotCalibration.handCheck")}>
      <Text style={styles.help}>{t("pivotCalibration.handCheckHelp")}</Text>
      <Text style={styles.reading}>{formatDeg(liveYawDeg)}</Text>
      <Text style={styles.help}>{t("pivotCalibration.liveRate", { rate: liveRateDegS.toFixed(0), axis: dominantUpAxis(up) ?? "—" })}</Text>
      <ButtonRow>
        {mode === "live"
          ? <>
            <Action label={t("pivotCalibration.reset")} onPress={() => setLiveYawDeg(0)} secondary />
            <Action label={t("pivotCalibration.stop")} onPress={() => void finishLive()} />
          </>
          : <Action label={t("pivotCalibration.startHandCheck")} onPress={() => void startLive()} disabled={busy || !gyroAvailable} />}
      </ButtonRow>
    </Section>

    <Section title={t("pivotCalibration.run")}>
      <Text style={styles.help}>{t("pivotCalibration.runHelp")}</Text>
      <Text style={[styles.value, robotConnected ? styles.ok : styles.warn]}>{robotConnected ? t("pivotCalibration.robotConnected") : t("pivotCalibration.robotNotConnected")}</Text>
      <Text style={styles.label}>{t("pivotCalibration.surface")}</Text>
      <ButtonRow>{SURFACES.map((item) => <SmallChoice key={item} selected={surface === item} label={t(`pivotCalibration.surface.${item}` as UiStringKey)} onPress={() => setSurface(item)} disabled={busy} />)}</ButtonRow>
      <Text style={styles.label}>{t("pivotCalibration.repeats")}</Text>
      <ButtonRow>{REPEAT_CHOICES.map((item) => <SmallChoice key={item} selected={repeats === item} label={String(item)} onPress={() => setRepeats(item)} disabled={busy} />)}</ButtonRow>
      <ButtonRow>
        <Action label={t("pivotCalibration.start")} onPress={() => void runCalibration()} disabled={busy || !gyroAvailable} />
        <Action label={t("pivotCalibration.stop")} onPress={() => void stopEverything()} disabled={mode !== "calibrating" && mode !== "testTurn"} secondary />
      </ButtonRow>
    </Section>

    {message ? <Text style={styles.result}>{message}</Text> : null}
    {error ? <Text style={[styles.result, styles.danger]}>{error}</Text> : null}

    {trials.length > 0 ? <Section title={t("pivotCalibration.results")}>
      <TrialTable t={t} trials={trials} />
      {runFits ? <>
        <FitSummary t={t} direction="left" model={runFits.left} />
        <FitSummary t={t} direction="right" model={runFits.right} />
      </> : null}
      <ButtonRow>
        <Action label={t("pivotCalibration.save")} onPress={saveRun} disabled={busy || !runFits || (!runFits.left && !runFits.right)} />
      </ButtonRow>
    </Section> : null}

    <Section title={t("pivotCalibration.savedTitle")}>
      {saved ? <>
        <Text style={styles.help}>{t("pivotCalibration.savedLine", {
          date: saved.createdAt.replace("T", " ").slice(0, 16),
          surface: t(`pivotCalibration.surface.${saved.surface}` as UiStringKey),
          battery: saved.phoneBatteryPercent ?? "—",
          trials: saved.trials.length,
        })}</Text>
        <FitSummary t={t} direction="left" model={saved.left} />
        <FitSummary t={t} direction="right" model={saved.right} />
      </> : <Text style={styles.help}>{t("pivotCalibration.noneSaved")}</Text>}
      <Text style={styles.label}>{t("pivotCalibration.preview")}</Text>
      {PREVIEW_DEGREES.map((degrees) => <Text key={degrees} style={styles.help}>{t("pivotCalibration.previewLine", {
        degrees,
        left: formatTurnPlan("left", degrees),
        right: formatTurnPlan("right", degrees),
      })}</Text>)}
      <ButtonRow>
        <Action label={t("pivotCalibration.testLeft", { degrees: TEST_TURN_DEGREES })} onPress={() => void testTurn("left")} disabled={busy || !gyroAvailable} secondary />
        <Action label={t("pivotCalibration.testRight", { degrees: TEST_TURN_DEGREES })} onPress={() => void testTurn("right")} disabled={busy || !gyroAvailable} secondary />
        {saved ? <Action label={t("pivotCalibration.clear")} onPress={clearSaved} disabled={busy} secondary /> : null}
      </ButtonRow>
    </Section>
  </ScrollView>;
}

/** "1167 ms", or "2 × 1172 ms" when the turn is split into several bounded pivots. */
function formatTurnPlan(direction: PivotDirection, degrees: number): string {
  const segments = pivotSegmentsForDegrees(direction, degrees) ?? [pivotDurationForDegrees(direction, degrees)];
  return segments.length > 1 ? `${segments.length} × ${segments[0]} ms` : `${segments[0]} ms`;
}

function fitToDiagnostic(direction: PivotDirection, model: PivotDirectionModel | null) {
  return {
    [`${direction}DegPerMs`]: model ? Math.round(model.degPerMs * 10_000) / 10_000 : null,
    [`${direction}DeadTimeMs`]: model ? Math.round(model.deadTimeMs) : null,
    [`${direction}R2`]: model ? Math.round(model.r2 * 1000) / 1000 : null,
    [`${direction}Table`]: model ? model.table.map((row) => `${row.durationMs}:${row.medianDegrees.toFixed(1)}`).join(",") : null,
  };
}

function FitSummary({ t, direction, model }: { t: Translate; direction: PivotDirection; model: PivotDirectionModel | null }) {
  const label = t(direction === "left" ? "pivotCalibration.left" : "pivotCalibration.right");
  if (!model) return <Text style={[styles.help, styles.warn]}>{t("pivotCalibration.fitNone", { direction: label })}</Text>;
  return <View>
    <Text style={styles.value}>{t("pivotCalibration.fitLine", {
      direction: label,
      degPerS: (model.degPerMs * 1000).toFixed(0),
      deadTime: model.deadTimeMs.toFixed(0),
      r2: model.r2.toFixed(3),
      n: model.trialCount,
    })}</Text>
    <Text style={styles.help}>{model.table.map((row) =>
      `${row.durationMs} ms → ${row.medianDegrees.toFixed(1)}° (${row.minDegrees.toFixed(0)}…${row.maxDegrees.toFixed(0)}, n=${row.count}; line ${Math.max(0, (row.durationMs - model.deadTimeMs) * model.degPerMs).toFixed(0)}°)`
    ).join("\n")}</Text>
  </View>;
}

function TrialTable({ t, trials }: { t: Translate; trials: PivotTrialResult[] }) {
  const columns: Array<{ key: string; title: string; width: number; cell: (trial: PivotTrialResult) => string }> = [
    { key: "dir", title: t("pivotCalibration.col.direction"), width: 50, cell: (trial) => trial.direction === "left" ? "L" : "R" },
    { key: "ms", title: t("pivotCalibration.col.duration"), width: 50, cell: (trial) => String(trial.durationMs) },
    { key: "deg", title: t("pivotCalibration.col.degrees"), width: 64, cell: (trial) => Number.isFinite(trial.degrees) ? trial.degrees.toFixed(1) : "—" },
    { key: "peak", title: t("pivotCalibration.col.peak"), width: 60, cell: (trial) => trial.measurement ? trial.measurement.peakRateDegS.toFixed(0) : "—" },
    { key: "onset", title: t("pivotCalibration.col.onset"), width: 56, cell: (trial) => trial.measurement?.onsetLatencyMs == null ? "—" : trial.measurement.onsetLatencyMs.toFixed(0) },
    { key: "coast", title: t("pivotCalibration.col.coast"), width: 56, cell: (trial) => trial.measurement?.coastAfterStopMs == null ? "—" : trial.measurement.coastAfterStopMs.toFixed(0) },
    { key: "ok", title: t("pivotCalibration.col.ok"), width: 40, cell: (trial) => trial.completed && trial.settled ? "✓" : "✗" },
  ];
  return <ScrollView horizontal>
    <View>
      <View style={styles.tableRow}>{columns.map((column) => <Text key={column.key} style={[styles.tableCell, styles.tableHead, { width: column.width }]}>{column.title}</Text>)}</View>
      {trials.map((trial, index) => <View key={index} style={styles.tableRow}>{columns.map((column) => <Text key={column.key} style={[styles.tableCell, { width: column.width }]}>{column.cell(trial)}</Text>)}</View>)}
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
  reading: { color: looiTheme.text, fontSize: 34, fontWeight: "900" },
  result: { color: looiTheme.text, fontSize: 12, marginBottom: 12 },
  danger: { color: looiTheme.danger },
  ok: { color: looiTheme.ok },
  warn: { color: looiTheme.warn },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  smallChoice: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  smallChoiceSelected: { borderColor: looiTheme.cyan, backgroundColor: "rgba(40,213,255,0.07)" },
  action: { borderRadius: 12, backgroundColor: looiTheme.cyan, paddingHorizontal: 13, paddingVertical: 9 },
  actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: looiTheme.line },
  actionText: { color: "#041319", fontWeight: "800", fontSize: 12 },
  actionSecondaryText: { color: looiTheme.text, fontWeight: "700", fontSize: 12 },
  disabled: { opacity: 0.35 },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: looiTheme.line },
  tableCell: { color: looiTheme.text, fontSize: 11, paddingVertical: 6, paddingRight: 6 },
  tableHead: { color: looiTheme.muted, fontWeight: "800", textTransform: "uppercase", fontSize: 10 },
});
