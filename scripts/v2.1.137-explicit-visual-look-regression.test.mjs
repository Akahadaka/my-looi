import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 137);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 137);

// Protected accepted v136 audio baseline must not drift in this visual feature release.
const realtimeConfig = read("src/voice/realtime-config.ts");
assert.match(realtimeConfig, /type: "server_vad"[\s\S]*threshold: 0\.15,[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtimeConfig, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtimeConfig, /REALTIME_UPLINK_GAIN = 2\.0/);

const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create/);
assert.doesNotMatch(nativePcm, /AutomaticGainControl\.create/);

// Visual action is explicitly addressed, deterministic, and separate from physical execution.
const visualParser = read("src/voice/realtime-visual-command.ts");
assert.match(visualParser, /getExplicitRobotAddressedCommand/);
assert.match(visualParser, /kind: "look-here"/);
assert.match(visualParser, /посмотри\|смотри\|глянь/);
assert.match(visualParser, /look(?:\\s\+)?/);
assert.match(visualParser, /customVoiceCommands\.look_here/);

const physicalParser = read("src/voice/explicit-robot-command.ts");
assert.match(physicalParser, /Exclude<CustomVoiceCommandAction, "emergency_stop" \| "look_here">/);
assert.match(physicalParser, /action === "emergency_stop" \|\| action === "look_here"/);

const realtime = read("src/voice/realtime-pcm-conversation.ts");
assert.match(realtime, /parseRealtimeVisualCommand/);
assert.match(realtime, /captureExplicitLookHereStill/);
assert.match(realtime, /type: "input_image"/);
assert.match(realtime, /image_url: `data:\$\{capture\.mimeType\};base64,\$\{capture\.base64\}`/);
assert.match(realtime, /detail: "high"/);
assert.match(realtime, /type: "response\.cancel"/);
assert.match(realtime, /type: "response\.create"/);
assert.match(realtime, /Do not pretend you saw an image/);

// Native camera adds a bounded in-memory JPEG still while preserving local YUV face analysis.
const nativeCamera = read("modules/local-face-attention/android/src/main/java/com/superlooi/localfaceattention/LocalFaceAttentionModule.kt");
assert.match(nativeCamera, /ImageFormat\.YUV_420_888/);
assert.match(nativeCamera, /ImageFormat\.JPEG/);
assert.match(nativeCamera, /CameraDevice\.TEMPLATE_STILL_CAPTURE/);
assert.match(nativeCamera, /CaptureRequest\.JPEG_QUALITY/);
assert.match(nativeCamera, /Base64\.encodeToString\(bytes, Base64\.NO_WRAP\)/);
assert.match(nativeCamera, /STILL_CAPTURE_TIMEOUT_MS = (?:6_000|8_000)L/);
assert.doesNotMatch(nativeCamera, /FileOutputStream|openFileOutput|MediaStore/);

const captureHelper = read("src/vision/look-here.ts");
assert.match(captureHelper, /PermissionsAndroid\.request/);
assert.match(captureHelper, /holdAmbientMotionFor/);
assert.match(captureHelper, /holdSocialAttentionMotionFor/);
assert.match(captureHelper, /inMemoryOnly: true/);

const social = read("src/core/social-attention.ts");
assert.match(social, /export function holdSocialAttentionMotionFor/);
assert.match(social, /Date\.now\(\) < externalMotionHoldUntil/);
assert.doesNotMatch(social, /moveLooi\("forward"|moveLooi\("back/);

const user = read("src/store/user.ts");
assert.match(user, /\| "look_here";/);
assert.match(user, /look_here: \[\]/);
assert.match(user, /version: [^;]*\b13\b[^;]*;/);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /"look_here"/);
assert.match(settings, /parseRealtimeVisualCommand\(testText, preferences\)/);
assert.match(settings, /settings\.voiceAction\.look_here/);

const strings = read("src/i18n/ui-strings.ts");
assert.equal((strings.match(/"settings\.voiceAction\.look_here":/g) ?? []).length, 3);

const privacy = read("PRIVACY.md");
assert.match(privacy, /## Explicit visual look/);
assert.match(privacy, /captures one (?:front-camera )?JPEG in memory and sends that snapshot to the active OpenAI Realtime conversation/);
assert.match(privacy, /Camera Attention face-analysis frames remain local and are not uploaded/);

console.log("v2.1.137 explicit addressed visual look + in-memory Realtime image input regression: PASS");
