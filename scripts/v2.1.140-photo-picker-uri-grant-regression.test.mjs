import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 140);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 140);

// The accepted Realtime PCM/AEC/VAD/gain path is outside this picker fix.
const realtimeConfig = read("src/voice/realtime-config.ts");
assert.match(realtimeConfig, /type: "server_vad"[\s\S]*threshold: 0\.15,[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtimeConfig, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtimeConfig, /REALTIME_UPLINK_GAIN = 2\.0/);
const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create/);
assert.doesNotMatch(nativePcm, /AutomaticGainControl\.create/);

// Persist only the explicitly selected picker URIs, and release them after the flow.
const pickerNative = read("modules/photo-picker-access/android/src/main/java/com/superlooi/photopickeraccess/PhotoPickerAccessModule.kt");
assert.match(pickerNative, /takePersistableUriPermission/);
assert.match(pickerNative, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
assert.match(pickerNative, /persistedUris = LinkedHashSet/);
assert.match(pickerNative, /releasePersistableUriPermission/);
assert.match(pickerNative, /persistReadGrant/);
assert.match(pickerNative, /"persistedGrant" to persistedGrant/);
assert.match(pickerNative, /selectedUris\.contains\(uriString\)/);
assert.match(pickerNative, /clearSelectionState/);

// Prefer file-descriptor reads for picker/cloud-provider URIs, with stream fallback.
assert.match(pickerNative, /openFileDescriptor\(uri, "r"\)/);
assert.match(pickerNative, /BitmapFactory\.decodeFileDescriptor/);
assert.match(pickerNative, /ExifInterface\(descriptor\.fileDescriptor\)/);
assert.match(pickerNative, /openInputStream\(uri\)/);
assert.doesNotMatch(pickerNative, /FileOutputStream|openFileOutput|MediaStore\.Images\.Media\.insertImage/);

// No broad gallery/media permission is introduced.
const appJsonText = read("app.json");
assert.doesNotMatch(appJsonText, /READ_MEDIA_IMAGES|READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);

const pickerTs = read("modules/photo-picker-access/index.ts");
assert.match(pickerTs, /persistedGrant\?: boolean/);

// Selected images are read immediately after the picker returns, before the
// slower protected runtime/Realtime restoration, then scoped grants are cleared.
const flow = read("src/vision/photo-picker-context.ts");
assert.match(flow, /persistedGrantCount/);
assert.match(flow, /temporaryGrantCount/);
const readIndex = flow.indexOf("module.readSelectedPhotoForRealtime(photo.uri)");
const resumeIndex = flow.indexOf("await resumeAppRuntime()");
assert.ok(readIndex >= 0 && resumeIndex >= 0 && readIndex < resumeIndex, "picker images must be prepared before runtime restoration");
assert.match(flow, /await module\.clearSelection\(\)/);
assert.match(flow, /payload\.base64 = ""/);
assert.doesNotMatch(flow, /writeFile|copyAsync|FileSystem/);

const privacy = read("PRIVACY.md");
assert.match(privacy, /persistable read grant/);
assert.match(privacy, /released after the selected images are prepared\/sent/);

console.log("v2.1.140 Photo Picker selected-URI grant + file-descriptor read regression: PASS");
