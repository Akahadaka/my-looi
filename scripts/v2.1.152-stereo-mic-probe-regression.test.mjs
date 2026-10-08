import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

// Module registration and build configuration.
const config = JSON.parse(read("modules/stereo-mic-probe/expo-module.config.json"));
assert.deepEqual(config.platforms, ["android"]);
assert.deepEqual(config.android.modules, ["com.superlooi.stereomicprobe.StereoMicProbeModule"]);
const modulePackage = JSON.parse(read("modules/stereo-mic-probe/package.json"));
assert.equal(modulePackage.name, "stereo-mic-probe");
assert.equal(modulePackage.main, "index.ts");
const gradle = read("modules/stereo-mic-probe/android/build.gradle");
assert.match(gradle, /namespace 'com\.superlooi\.stereomicprobe'/);
assert.match(gradle, /minSdkVersion 24/);
assert.doesNotMatch(gradle, /^\s*(implementation|api)\s/m, "the probe must not add native dependencies");
assert.match(read("modules/stereo-mic-probe/android/src/main/AndroidManifest.xml"), /android\.permission\.RECORD_AUDIO/);

const binding = read("modules/stereo-mic-probe/index.ts");
assert.match(binding, /requireNativeModule<StereoMicProbeNativeModule>\("StereoMicProbe"\)/);
assert.match(binding, /Platform\.OS !== "android"\) return null/);

// Native capture, GCC-PHAT and sign convention.
const kotlinDir = "modules/stereo-mic-probe/android/src/main/java/com/superlooi/stereomicprobe/";
const kotlin = read(`${kotlinDir}StereoMicProbeModule.kt`);
const gcc = read(`${kotlinDir}GccPhat.kt`);
assert.match(kotlin, /Name\("StereoMicProbe"\)/);
assert.match(kotlin, /Events\("onProbeFrame", "onProbeError", "onProbeStarted", "onProbeStopped"\)/);
assert.match(kotlin, /AsyncFunction\("getCapabilities"\)/);
assert.match(kotlin, /AsyncFunction\("start"\) \{ options: Map<String, Any\?> ->/);
assert.match(kotlin, /AsyncFunction\("stop"\)/);
assert.match(kotlin, /Function\("getStatus"\)/);
assert.match(kotlin, /AudioFormat\.CHANNEL_IN_STEREO/);
assert.match(kotlin, /ENCODING_PCM_16BIT/);
assert.match(kotlin, /THREAD_PRIORITY_URGENT_AUDIO/);
assert.match(kotlin, /WINDOW_FRAMES = 2048/);
assert.match(kotlin, /HOP_FRAMES = WINDOW_FRAMES \/ 2/);
assert.match(kotlin, /FFT_SIZE = 4096/);
assert.match(kotlin, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(kotlin, /CONVERSATION_RATE = 16_000/);
assert.match(kotlin, /AcousticEchoCanceler\.create/);
assert.match(kotlin, /isClientSilenced/);
assert.match(kotlin, /RECORD_AUDIO permission is required/);
assert.match(kotlin, /OnDestroy \{\s*stopProbe\(/);
assert.match(kotlin, /ceil\(config\.micSpacingM \/ SPEED_OF_SOUND_MPS \* rate\)\.toInt\(\) \+ 2/);
assert.match(kotlin, /asin\(sine\)/);
// Sign convention is documented where the bearing is defined.
assert.match(kotlin, /\/\*\*[\s\S]*POSITIVE tdoa\/bearing means sound reached the[\s\S]*RIGHT channel first[\s\S]*\*\/\s*class StereoMicProbeModule/);
for (const field of ["rmsL", "rmsR", "conversationRms", "channelCorrelation", "identicalChannels", "voiceActive", "bearingDeg", "peakRatio", "tdoaUs", "framesRead", "readErrors", "stereoClientSilenced", "conversationClientSilenced"]) {
  assert.match(kotlin, new RegExp(`"${field}" to`), `frame event field ${field}`);
}

assert.match(gcc, /class ComplexFft/);
assert.match(gcc, /Integer\.reverse/);
assert.match(gcc, /class GccPhatEstimator/);
assert.match(gcc, /sqrt\(re \* re \+ im \* im\) \+ 1e-12/);
assert.match(gcc, /transform\(leftRe, leftIm, inverse = true\)/);
assert.match(gcc, /denominator/);
// Cross-spectrum is X_L * conj(X_R): real part L.re*R.re + L.im*R.im, imaginary L.im*R.re - L.re*R.im.
assert.match(gcc, /leftRe\[bin\] \* rightRe\[bin\] \+ leftIm\[bin\] \* rightIm\[bin\]/);
assert.match(gcc, /leftIm\[bin\] \* rightRe\[bin\] - leftRe\[bin\] \* rightIm\[bin\]/);

// Screen: route, entry point, pause/restore and stop on blur.
const screen = read("app/mic-probe.tsx");
assert.match(screen, /useFocusEffect\(useCallback\(\(\) => \{/);
assert.match(screen, /return \(\) => \{[\s\S]*void stopEverything\(\)\.finally\(\(\) => \{[\s\S]*void restoreAppCapture\(\);/);
assert.match(screen, /AppState\.addEventListener\("change"/);
assert.match(screen, /voiceRuntime\.suspendMainScreenConversation\("mic-probe-focused"\)/);
assert.match(screen, /kwsAudioFeeder\.setAppCaptureAllowed\(false\)/);
assert.match(screen, /kwsAudioFeeder\.setAppCaptureAllowed\(previous\.appCaptureAllowed\)/);
assert.match(screen, /kwsAudioFeeder\.start\(\)/);
assert.match(screen, /recordDiagnosticEvent\("audio", "stereo-mic-probe-run"/);
assert.match(screen, /recordDiagnosticEvent\("audio", "stereo-mic-probe-capabilities"/);
assert.match(screen, /recordDiagnosticEvent\("audio", "stereo-mic-probe-calibration"/);
assert.match(screen, /STEREO_PROBE_SOURCES\.flatMap/);
assert.match(screen, /\[false, true\]/);
assert.match(screen, /MATRIX_RUN_MS = 4000/);

const analysis = read("src/diagnostics/stereo-mic-probe-analysis.ts");
for (const verdict of ["TRUE_STEREO", "FAKE_STEREO", "MONO_ONLY", "SILENCED"]) {
  assert.match(analysis, new RegExp(`"${verdict}"`));
}

const layout = read("app/_layout.tsx");
assert.match(layout, /<Stack\.Screen\s+name="mic-probe"/);
const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /router\.push\("\/mic-probe"\)/);
const diagnosticsSection = settings.slice(settings.indexOf('<Section title={t("settings.diagnostics")}>'));
assert.ok(diagnosticsSection.indexOf('t("micProbe.title")') > 0 && diagnosticsSection.indexOf('t("micProbe.title")') < diagnosticsSection.indexOf("</Section>"));

// Every micProbe string key exists in all three locales (the type system enforces it; this keeps the intent explicit).
const strings = read("src/i18n/ui-strings.ts");
const tables = strings.split(/\nconst (?:uk|ru): TranslationTable = \{/);
assert.equal(tables.length, 3);
const keyset = (text) => new Set([...text.matchAll(/"(micProbe\.[A-Za-z_.]+)":/g)].map((match) => match[1]));
const [enKeys, ukKeys, ruKeys] = tables.map(keyset);
assert.ok(enKeys.size > 40);
assert.deepEqual([...ukKeys].sort(), [...enKeys].sort());
assert.deepEqual([...ruKeys].sort(), [...enKeys].sort());
for (const key of ["micProbe.verdict.TRUE_STEREO", "micProbe.verdict.FAKE_STEREO", "micProbe.verdict.MONO_ONLY", "micProbe.verdict.SILENCED"]) {
  assert.ok(enKeys.has(key), key);
}

// The suite must run this test.
assert.match(JSON.parse(read("package.json")).scripts.test, /v2\.1\.152-stereo-mic-probe-regression\.test\.mjs/);

console.log("v2.1.152 stereo microphone probe regression: PASS");
