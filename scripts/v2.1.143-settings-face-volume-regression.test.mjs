import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 143);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 143);

const user = read("src/store/user.ts");
assert.match(user, /export type VoiceOutputGain = 1 \| 1\.15 \| 1\.3 \| 1\.45/);
assert.match(user, /voiceOutputGain: 1,/);
assert.match(user, /wakeWordEnabled: true,/);
assert.match(user, /version: (?:15|16|17)/);

const settings = read("app/(tabs)/settings.tsx");
assert.doesNotMatch(settings, /<Section title=\{t\("settings\.conversation"\)\}>/);
assert.doesNotMatch(settings, /<SwitchRow/);
assert.match(settings, /previousModelsExpanded/);
assert.match(settings, /VOICE_OUTPUT_GAIN_OPTIONS/);
assert.match(settings, /Boolean\(modelStatus\) && !sharedReady/);
const advancedAt = settings.indexOf('t("settings.advanced")');
const memoryAt = settings.lastIndexOf('t("settings.memoryBackup")');
const diagnosticsAt = settings.lastIndexOf('t("settings.diagnostics")');
assert.ok(advancedAt >= 0 && memoryAt > advancedAt && diagnosticsAt > advancedAt, "memory/diagnostics must live under Advanced");

const realtime = read("src/voice/realtime-pcm-conversation.ts");
assert.match(realtime, /applyPlaybackGainToPcm16Base64/);
assert.match(realtime, /preferences\.voiceOutputGain/);
assert.match(realtime, /pcm-output-gain-summary/);
assert.match(realtime, /Math\.max\(-32768, Math\.min\(32767, amplified\)\)/);

const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create|AutomaticGainControl\.create/);
const nativeHash = crypto.createHash("sha256").update(nativePcm).digest("hex");
assert.equal(nativeHash, "667938b5ce3c8c2991b23f1d24661ef5db914a504482ded186f570c1614d77cc");

console.log("v2.1.143 settings/face/voice-volume regression: PASS");
