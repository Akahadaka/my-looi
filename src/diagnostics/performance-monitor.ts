import { AppState, Platform } from "react-native";
import {
  getDiagnosticPerformanceSnapshot,
  getPreviousProcessExitReasons,
  type DiagnosticPerformanceSnapshot,
} from "../../modules/diagnostic-archive";
import { recordDiagnosticEvent } from "./diagnostic-log";

const SNAPSHOT_INTERVAL_MS = 30_000;
const EVENT_LOOP_PROBE_MS = 250;
const EVENT_LOOP_WARN_MS = 500;
const EVENT_LOOP_LOG_THROTTLE_MS = 5_000;

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let eventLoopTimer: ReturnType<typeof setInterval> | null = null;
let previousProbeAt = 0;
let lastEventLoopLogAt = 0;
let started = false;

function mb(bytes: number | null | undefined): number | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function snapshotDetails(snapshot: DiagnosticPerformanceSnapshot) {
  return {
    pid: snapshot.pid,
    pssMb: Math.round((snapshot.pssKb / 1024) * 10) / 10,
    rssMb: snapshot.rssKb == null ? null : Math.round((snapshot.rssKb / 1024) * 10) / 10,
    javaHeapUsedMb: mb(snapshot.javaHeapUsedBytes),
    javaHeapTotalMb: mb(snapshot.javaHeapTotalBytes),
    javaHeapMaxMb: mb(snapshot.javaHeapMaxBytes),
    nativeHeapMb: mb(snapshot.nativeHeapBytes),
    systemAvailMb: mb(snapshot.systemAvailMemBytes),
    systemTotalMb: mb(snapshot.systemTotalMemBytes),
    systemLowMemory: snapshot.systemLowMemory,
    systemLowMemoryThresholdMb: mb(snapshot.systemLowMemoryThresholdBytes),
  };
}

export async function recordPerformanceSnapshot(reason: string): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const snapshot = await getDiagnosticPerformanceSnapshot();
    if (!snapshot) return;
    recordDiagnosticEvent("performance", "memory-snapshot", {
      reason,
      ...snapshotDetails(snapshot),
    });
  } catch (error) {
    recordDiagnosticEvent("performance", "memory-snapshot-failed", {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordPreviousExitReasons(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const exits = await getPreviousProcessExitReasons(3);
    for (let index = 0; index < exits.length; index += 1) {
      const exit = exits[index];
      recordDiagnosticEvent("performance", "previous-process-exit", {
        index,
        reason: exit.reasonName,
        reasonCode: exit.reason,
        status: exit.status,
        importance: exit.importance,
        pssMb: Math.round((exit.pssKb / 1024) * 10) / 10,
        rssMb: Math.round((exit.rssKb / 1024) * 10) / 10,
        timestampMs: exit.timestampMs,
        description: exit.description,
      });
    }
  } catch (error) {
    recordDiagnosticEvent("performance", "previous-process-exit-query-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startPerformanceMonitor(): void {
  if (started || Platform.OS !== "android") return;
  started = true;
  previousProbeAt = Date.now();

  void recordPreviousExitReasons();
  void recordPerformanceSnapshot("monitor-start");

  snapshotTimer = setInterval(() => {
    if (AppState.currentState !== "active") return;
    void recordPerformanceSnapshot("periodic-active");
  }, SNAPSHOT_INTERVAL_MS);

  eventLoopTimer = setInterval(() => {
    const now = Date.now();
    const expected = previousProbeAt + EVENT_LOOP_PROBE_MS;
    const lagMs = Math.max(0, now - expected);
    previousProbeAt = now;
    if (lagMs < EVENT_LOOP_WARN_MS) return;
    if (now - lastEventLoopLogAt < EVENT_LOOP_LOG_THROTTLE_MS) return;
    lastEventLoopLogAt = now;
    recordDiagnosticEvent("performance", "js-event-loop-stall", {
      lagMs,
      appState: AppState.currentState,
    });
    void recordPerformanceSnapshot(`js-stall-${lagMs}ms`);
  }, EVENT_LOOP_PROBE_MS);
}

export function stopPerformanceMonitor(): void {
  if (!started) return;
  started = false;
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  snapshotTimer = null;
  eventLoopTimer = null;
}
