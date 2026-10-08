import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type DiagnosticArchiveResult = {
  outputUri: string;
  entries: number;
  uncompressedBytes: number;
};

export type DiagnosticPerformanceSnapshot = {
  pid: number;
  elapsedRealtimeMs: number;
  pssKb: number;
  rssKb: number | null;
  javaHeapUsedBytes: number;
  javaHeapTotalBytes: number;
  javaHeapMaxBytes: number;
  nativeHeapBytes: number;
  systemAvailMemBytes: number;
  systemTotalMemBytes: number;
  systemLowMemory: boolean;
  systemLowMemoryThresholdBytes: number;
};

export type DiagnosticProcessExitReason = {
  reason: number;
  reasonName: string;
  status: number;
  importance: number;
  pssKb: number;
  rssKb: number;
  timestampMs: number;
  description: string;
};

declare class DiagnosticArchiveNativeModule extends NativeModule {
  createZip(sourceDirectoryUri: string, outputFileUri: string): Promise<DiagnosticArchiveResult>;
  getPerformanceSnapshot(): Promise<DiagnosticPerformanceSnapshot>;
  getPreviousProcessExitReasons(maxCount: number): Promise<DiagnosticProcessExitReason[]>;
}

let cached: DiagnosticArchiveNativeModule | null = null;

function getModule(): DiagnosticArchiveNativeModule {
  if (Platform.OS !== "android") throw new Error("Diagnostic native helpers are available on Android only");
  cached ??= requireNativeModule<DiagnosticArchiveNativeModule>("DiagnosticArchive");
  return cached;
}

export async function createDiagnosticZip(
  sourceDirectoryUri: string,
  outputFileUri: string
): Promise<DiagnosticArchiveResult> {
  return getModule().createZip(sourceDirectoryUri, outputFileUri);
}

export async function getDiagnosticPerformanceSnapshot(): Promise<DiagnosticPerformanceSnapshot | null> {
  if (Platform.OS !== "android") return null;
  return getModule().getPerformanceSnapshot();
}

export async function getPreviousProcessExitReasons(maxCount = 3): Promise<DiagnosticProcessExitReason[]> {
  if (Platform.OS !== "android") return [];
  return getModule().getPreviousProcessExitReasons(maxCount);
}
