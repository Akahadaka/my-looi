import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 144);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 144);

const user = read("src/store/user.ts");
assert.match(user, /export type SpeechGender = "masculine" \| "feminine"/);
assert.match(user, /speechGender: "masculine"/);
assert.match(user, /version: (?:16|17)/);
assert.match(user, /normalizeSpeechGender/);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /settings\.speechGender/);
assert.match(settings, /speechGender === "masculine"/);
assert.match(settings, /speechGender === "feminine"/);

const strings = read("src/i18n/ui-strings.ts");
for (const key of [
  "settings.speechGender",
  "settings.speechGenderHelp",
  "settings.speechGenderMasculine",
  "settings.speechGenderFeminine",
]) assert.match(strings, new RegExp(key.replaceAll(".", "\\.")));

const realtimeConfig = read("src/voice/realtime-config.ts");
assert.match(realtimeConfig, /speechGender/);
assert.match(realtimeConfig, /я увидела/);
assert.match(realtimeConfig, /я увидел/);
assert.match(realtimeConfig, /я побачила/);
assert.match(realtimeConfig, /я побачив/);
// Protected audio behavior must remain unchanged.
assert.match(realtimeConfig, /type: "server_vad"[\s\S]*threshold: 0\.15,[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtimeConfig, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtimeConfig, /REALTIME_UPLINK_GAIN = 2\.0/);

const pcm = read("src/voice/realtime-pcm-conversation.ts");
const pcmHash = crypto.createHash("sha256").update(pcm).digest("hex");
assert.equal(pcmHash, "a22924f9c8e5da6e93bdf94e10a17a88bab43ccae732fb5fac82c19861313ced");
const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
const nativeHash = crypto.createHash("sha256").update(nativePcm).digest("hex");
assert.equal(nativeHash, "667938b5ce3c8c2991b23f1d24661ef5db914a504482ded186f570c1614d77cc");

console.log("v2.1.144 character frame / speech gender regression: PASS");
