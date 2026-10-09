import { PermissionsAndroid, Platform } from "react-native";

import { getLocalFaceAttentionModule, type LocalCameraFacing, type LocalStillCapture } from "../../modules/local-face-attention";
import { holdAmbientMotionFor } from "../core/ambient-motion";
import { holdSocialAttentionMotionFor } from "../core/social-attention";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

const LOOK_CAPTURE_MOTION_HOLD_MS = 2_500;
const LOOK_CAPTURE_SETTLE_MS = 260;

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function ensureCameraPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const permission = PermissionsAndroid.PERMISSIONS.CAMERA;
  if (await PermissionsAndroid.check(permission)) return true;
  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Capture one explicit user-requested still from the requested camera in memory. No raw
 * frame is written to a file; the caller owns the returned base64 only long
 * enough to send it to the active Realtime conversation.
 */
export async function captureExplicitLookHereStill(cameraFacing: LocalCameraFacing = "front"): Promise<LocalStillCapture> {
  if (Platform.OS !== "android") throw new Error("Visual look is Android-only");
  if (!await ensureCameraPermission()) throw new Error("Camera permission was not granted");

  const module = getLocalFaceAttentionModule();
  if (!module) throw new Error("Local camera module is unavailable");

  holdAmbientMotionFor(LOOK_CAPTURE_MOTION_HOLD_MS, "look-here-capture");
  holdSocialAttentionMotionFor(LOOK_CAPTURE_MOTION_HOLD_MS, "look-here-capture");
  await waitMs(LOOK_CAPTURE_SETTLE_MS);

  recordDiagnosticEvent("vision", "look-here-capture-started", {
    inMemoryOnly: true,
    requestedDetail: "high",
    requestedCameraFacing: cameraFacing,
  });
  const capture = await module.captureStill(cameraFacing);
  if (!capture.base64 || capture.mimeType !== "image/jpeg") {
    throw new Error("Camera returned an invalid visual snapshot");
  }
  recordDiagnosticEvent("vision", "look-here-capture-finished", {
    width: capture.width,
    height: capture.height,
    encodedChars: capture.base64.length,
    cameraFacing: capture.cameraFacing,
    cameraId: capture.cameraId,
    autofocusMode: capture.autofocusMode,
    flashAvailable: capture.flashAvailable,
    aeState: capture.aeState,
    awbState: capture.awbState,
    afState: capture.afState,
    exposureTimeMs: capture.exposureTimeMs,
    sensitivityIso: capture.sensitivityIso,
    lowLightLikely: capture.lowLightLikely,
    inMemoryOnly: true,
  });
  return capture;
}
