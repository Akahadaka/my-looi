import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type LocalFaceRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
};

export type LocalFaceFrameEvent = {
  timestampMs: number;
  faceCount: number;
  primary: LocalFaceRect | null;
};


export type LocalCameraFacing = "front" | "back";

export type LocalStillCapture = {
  mimeType: "image/jpeg";
  base64: string;
  width: number;
  height: number;
  timestampMs: number;
  cameraFacing: LocalCameraFacing;
  cameraId: string | null;
  autofocusMode: number;
  flashAvailable: boolean;
  aeState: number | null;
  awbState: number | null;
  afState: number | null;
  exposureTimeMs: number | null;
  sensitivityIso: number | null;
  lowLightLikely: boolean;
};

export type LocalFaceAttentionErrorEvent = {
  stage: string;
  message: string;
};

export type LocalFaceAttentionStatus = {
  supported: boolean;
  running: boolean;
  permissionGranted: boolean;
  cameraId: string | null;
  lensFacing: string;
  framesAnalyzed: number;
  stillWidth?: number | null;
  stillHeight?: number | null;
  autofocusMode?: number;
  flashAvailable?: boolean;
};

type Events = {
  onFaceFrame(event: LocalFaceFrameEvent): void;
  onFaceAttentionError(event: LocalFaceAttentionErrorEvent): void;
};

declare class LocalFaceAttentionNativeModule extends NativeModule<Events> {
  start(): Promise<LocalFaceAttentionStatus>;
  stop(): Promise<LocalFaceAttentionStatus>;
  getStatus(): Promise<LocalFaceAttentionStatus>;
  captureStill(cameraFacing: LocalCameraFacing): Promise<LocalStillCapture>;
}

let cached: LocalFaceAttentionNativeModule | null | undefined;

function getModule(): LocalFaceAttentionNativeModule | null {
  if (Platform.OS !== "android") return null;
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<LocalFaceAttentionNativeModule>("LocalFaceAttention");
  } catch {
    cached = null;
  }
  return cached;
}

const unsupportedStatus: LocalFaceAttentionStatus = {
  supported: false,
  running: false,
  permissionGranted: false,
  cameraId: null,
  lensFacing: "unsupported",
  framesAnalyzed: 0,
};

export function getLocalFaceAttentionModule(): LocalFaceAttentionNativeModule | null {
  return getModule();
}

export async function getLocalFaceAttentionStatus(): Promise<LocalFaceAttentionStatus> {
  return (await getModule()?.getStatus()) ?? unsupportedStatus;
}
