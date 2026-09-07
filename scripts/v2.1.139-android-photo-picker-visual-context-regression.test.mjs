import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 139);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 139);

// Protected accepted audio path is not part of Photo Picker work.
const realtimeConfig = read("src/voice/realtime-config.ts");
assert.match(realtimeConfig, /type: "server_vad"[\s\S]*threshold: 0\.15,[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtimeConfig, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtimeConfig, /REALTIME_UPLINK_GAIN = 2\.0/);
const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create/);
assert.doesNotMatch(nativePcm, /AutomaticGainControl\.create/);

// Android Photo Picker only: image-only, multi-select, scoped to the current selection.
assert.ok(fs.existsSync("modules/photo-picker-access/expo-module.config.json"));
const pickerNative = read("modules/photo-picker-access/android/src/main/java/com/superlooi/photopickeraccess/PhotoPickerAccessModule.kt");
assert.match(pickerNative, /ActivityResultContracts\.PickMultipleVisualMedia/);
assert.match(pickerNative, /PickVisualMedia\.ImageOnly/);
assert.match(pickerNative, /setMaxItems\(maxItems\)/);
assert.match(pickerNative, /setOrderedSelection\(true\)/);
assert.match(pickerNative, /MAX_SELECTABLE_PHOTOS = 4/);
assert.match(pickerNative, /selectedUris = LinkedHashSet/);
assert.match(pickerNative, /selectedUris\.contains\(uriString\)/);
assert.match(pickerNative, /clearSelection/);
assert.match(pickerNative, /Base64\.encodeToString\(encoded, Base64\.NO_WRAP\)/);
assert.match(pickerNative, /ExifInterface/);
assert.match(pickerNative, /MAX_OUTPUT_PIXELS = 10_000_000L/);
assert.match(pickerNative, /Bitmap\.CompressFormat\.JPEG/);
assert.doesNotMatch(pickerNative, /FileOutputStream|openFileOutput|MediaStore\.Images\.Media\.insertImage/);

// No broad gallery permission should be added just to choose explicit photos.
const appJsonText = read("app.json");
assert.doesNotMatch(appJsonText, /READ_MEDIA_IMAGES|READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);

const pickerTs = read("modules/photo-picker-access/index.ts");
assert.match(pickerTs, /selectPhotos\(maxItems: number\)/);
assert.match(pickerTs, /readSelectedPhotoForRealtime/);
assert.match(pickerTs, /clearSelection/);

// External activity lease prevents the five-second process kill while the system picker owns foreground.
const pickerFlow = read("src/vision/photo-picker-context.ts");
assert.match(pickerFlow, /withExternalActivityLease\("visual-photo-picker"/);
assert.match(pickerFlow, /PHOTO_PICKER_MAX_ITEMS = 4/);
assert.match(pickerFlow, /resumeAppRuntime\(\)/);
assert.match(pickerFlow, /resumeMainScreenConversation\("foreground-resume"\)/);
assert.match(pickerFlow, /waitForRealtimeReady/);
assert.match(pickerFlow, /CONTINUATION_MAX_CHARS = 5_500/);
assert.match(pickerFlow, /buildRecentConversationContinuation/);
assert.match(pickerFlow, /module\.clearSelection/);
assert.match(pickerFlow, /payload\.base64 = ""/);
assert.doesNotMatch(pickerFlow, /writeFile|copyAsync|FileSystem/);

// Realtime gets numbered images in selection order plus a bounded transcript reseed.
const pcm = read("src/voice/realtime-pcm-conversation.ts");
assert.match(pcm, /PHOTO PICKER CONTINUATION/);
assert.match(pcm, /SELECTED PHOTO \$\{safeIndex\} OF \$\{safeTotal\}/);
assert.match(pcm, /type: "input_image"/);
assert.match(pcm, /detail: "high"/);
assert.match(pcm, /finishSelectedPhotoContext/);
assert.match(pcm, /type: "response\.create"/);
const realtimeRouter = read("src/voice/realtime-conversation.ts");
assert.match(realtimeRouter, /beginSelectedPhotoContext/);
assert.match(realtimeRouter, /addSelectedPhotoToContext/);
assert.match(realtimeRouter, /finishSelectedPhotoContext/);

// The main face exposes one small picker affordance; no in-app camera preview or Share target was added.
const home = read("app/(tabs)/index.tsx");
assert.match(home, /selectPhotosIntoCurrentDiscussion/);
assert.match(home, /home\.choosePhotosA11y/);
assert.match(home, /photoPickerButton/);
assert.doesNotMatch(home, /CameraView|launchCamera|ShareIntent/);

const strings = read("src/i18n/ui-strings.ts");
for (const key of ["home.choosePhotosA11y", "home.photoPickerErrorTitle", "home.photoPickerErrorBody"]) {
  assert.equal((strings.match(new RegExp(`"${key.replaceAll(".", "\\.")}":`, "g")) ?? []).length, 3, `${key} must exist in all UI languages`);
}

const privacy = read("PRIVACY.md");
assert.match(privacy, /Android Photo Picker/);
assert.match(privacy, /only to the photos you explicitly select/);
assert.match(privacy, /not copied into My LOOI's durable storage/);
const guide = read("USER_GUIDE.md");
assert.match(guide, /Choose photos/);
assert.match(guide, /up to four/);

console.log("v2.1.139 Android Photo Picker scoped visual context + conversation reseed regression: PASS");
