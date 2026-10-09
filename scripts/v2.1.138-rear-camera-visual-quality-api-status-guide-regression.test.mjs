import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 138);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 138);

// Accepted v136+ audio path must remain untouched by camera/status/UI work.
const realtimeConfig = read("src/voice/realtime-config.ts");
assert.match(realtimeConfig, /type: "server_vad"[\s\S]*threshold: 0\.15,[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtimeConfig, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtimeConfig, /REALTIME_UPLINK_GAIN = 2\.0/);
const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create/);
assert.doesNotMatch(nativePcm, /AutomaticGainControl\.create/);

// Natural visual intent stays explicitly addressed but allows natural tails.
const visual = read("src/voice/realtime-visual-command.ts");
assert.match(visual, /getExplicitRobotAddressedCommand/);
assert.match(visual, /cameraFacing: VisualCameraFacing/);
assert.match(visual, /BACK_CAMERA_RE/);
assert.match(visual, /rear\\s\+camera\|back\\s\+camera/);
assert.match(visual, /посмотри\|смотри\|глянь\|взгляни\|рассмотри/);
assert.match(visual, /сфотографируй/);
assert.match(visual, /looksLikeVisualIntent/);
assert.match(visual, /return "front"/);

// Native Camera2 rear selection, AF-aware quality capture and privacy properties.
const camera = read("modules/local-face-attention/android/src/main/java/com/superlooi/localfaceattention/LocalFaceAttentionModule.kt");
assert.match(camera, /selectCamera\(manager: CameraManager, requestedFacing: String\)/);
assert.match(camera, /CameraCharacteristics\.LENS_FACING_BACK/);
assert.match(camera, /REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA/);
assert.match(camera, /CONTROL_AF_MODE_CONTINUOUS_PICTURE/);
assert.match(camera, /BACK_STILL_TARGET_WIDTH = 3264/);
assert.match(camera, /BACK_STILL_TARGET_HEIGHT = 2448/);
assert.match(camera, /BACK_STILL_MAX_AREA = 8_500_000L/);
assert.match(camera, /FRONT_STILL_TARGET_WIDTH = 2592/);
assert.match(camera, /STILL_JPEG_QUALITY = 95/);
assert.match(camera, /STILL_CAMERA_MIN_WARMUP_MS = 450L/);
assert.match(camera, /STILL_CAMERA_CONVERGENCE_TIMEOUT_MS = 1_600L/);
assert.match(camera, /exposureReadyForStill/);
assert.match(camera, /CONTROL_AE_STATE_CONVERGED/);
assert.match(camera, /CONTROL_AWB_STATE_CONVERGED/);
assert.match(camera, /pendingStillCaptureIssued/);
assert.match(camera, /CONTROL_AE_MODE_ON_AUTO_FLASH/);
assert.match(camera, /latestExposureTimeNs/);
assert.match(camera, /latestSensitivityIso/);
assert.match(camera, /lowLightLikely/);
assert.match(camera, /pendingCaptureRestoreFacing/);
assert.match(camera, /switchCameraForExplicitCapture/);
assert.match(camera, /detector = if \(lensFacingName == "front"\) createDetector\(\) else null/);
assert.doesNotMatch(camera, /FileOutputStream|openFileOutput|MediaStore/);

const cameraIndex = read("modules/local-face-attention/index.ts");
assert.match(cameraIndex, /LocalCameraFacing = "front" \| "back"/);
assert.match(cameraIndex, /captureStill\(cameraFacing: LocalCameraFacing\)/);

const look = read("src/vision/look-here.ts");
assert.match(look, /captureExplicitLookHereStill\(cameraFacing: LocalCameraFacing = "front"\)/);
assert.match(look, /module\.captureStill\(cameraFacing\)/);
assert.match(look, /lowLightLikely/);
assert.doesNotMatch(look, /base64:/);

const realtime = read("src/voice/realtime-pcm-conversation.ts");
assert.match(realtime, /captureExplicitLookHereStill\(visualCommand\.cameraFacing\)/);
assert.match(realtime, /type: "input_image"/);
assert.match(realtime, /detail: "high"/);
assert.match(realtime, /capture\.lowLightLikely/);
assert.match(realtime, /cameraFacing: capture\.cameraFacing/);

// Quota/key errors must become visible and persist as status UX.
const status = read("src/openai/openai-api-status.ts");
assert.match(status, /"no_credits"/);
assert.match(status, /credit_balance_exhausted/);
assert.match(status, /insufficient_quota/);
assert.match(status, /"invalid_key"/);
const conversationStore = read("src/store/conversation.ts");
assert.match(conversationStore, /RealtimeIssue/);
assert.match(conversationStore, /setRealtimeIssue/);
const overlay = read("src/ui/ConversationOverlay.tsx");
assert.match(overlay, /overlay\.openAiNoCreditsTitle/);
assert.match(overlay, /overlay\.openAiNoCreditsBody/);
const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /settings\.openAiBalanceStatus/);
assert.match(settings, /settings\.openAiBilling/);
assert.match(settings, /OPENAI_BILLING_URL/);
assert.match(settings, /MY_LOOI_USER_GUIDE_URL/);
assert.match(settings, /settings\.openUserGuide/);

const strings = read("src/i18n/ui-strings.ts");
for (const key of [
  "overlay.openAiNoCreditsTitle",
  "settings.openAiBalanceStatus",
  "settings.openAiStatus.no_credits",
  "settings.openAiBilling",
  "settings.openUserGuide",
]) {
  assert.equal((strings.match(new RegExp(`"${key.replaceAll(".", "\\.")}":`, "g")) ?? []).length, 3, `${key} must exist in all UI languages`);
}

assert.ok(fs.existsSync("USER_GUIDE.md"));
const guide = read("USER_GUIDE.md");
assert.match(guide, /## 8\. Explicit visual look/);
assert.match(guide, /Front and rear camera/);
assert.match(guide, /OpenAI API status and billing/);
const readme = read("README.md");
assert.match(readme, /\[USER_GUIDE\.md\]\(USER_GUIDE\.md\)/);

console.log("v2.1.138 rear-camera visual quality + natural visual intent + API status + user guide regression: PASS");
