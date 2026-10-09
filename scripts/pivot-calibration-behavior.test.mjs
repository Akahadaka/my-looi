import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const read = (file) => fs.readFileSync(file, "utf8");

function compileTs(file, customRequire = require) {
  const output = ts.transpileModule(read(file), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    customRequire,
    module,
    file,
    path.dirname(file)
  );
  return module.exports;
}

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
const DEG = Math.PI / 180;

const model = compileTs("src/device-tools/pivot-model.ts");
const analysis = compileTs("src/diagnostics/pivot-calibration-analysis.ts");

// --- Gyro analysis: yaw about the measured up vector, robot frame positive = LOOI's right.
// Phone in landscape: the device +x axis points up. Turning to LOOI's right is clockwise
// seen from above, i.e. a NEGATIVE right-hand-rule rate about up.
function syntheticCapture({ up, rateAboutUpDegS, biasDegS = 0, startMs = 1_000, preRollMs = 400, driveMs = 500, tailMs = 700 }) {
  const capture = { tMs: [], x: [], y: [], z: [], up, droppedSamples: 0, recording: true };
  const length = Math.hypot(up.x, up.y, up.z);
  const axis = { x: up.x / length, y: up.y / length, z: up.z / length };
  for (let t = startMs; t <= startMs + preRollMs + driveMs + tailMs; t += 5) {
    const moving = t >= startMs + preRollMs && t < startMs + preRollMs + driveMs;
    const rate = ((moving ? rateAboutUpDegS : 0) + biasDegS) * DEG;
    capture.tMs.push(t);
    capture.x.push(rate * axis.x);
    capture.y.push(rate * axis.y);
    capture.z.push(rate * axis.z);
  }
  return { capture, marks: { driveStartMs: startMs + preRollMs, driveStopMs: startMs + preRollMs + driveMs } };
}

{
  const { capture, marks } = syntheticCapture({ up: { x: 9.81, y: 0, z: 0 }, rateAboutUpDegS: -100, biasDegS: 0.8 });
  const result = analysis.measurePivot(capture, marks);
  near(result.robotYawDeg, 50, 1, "clockwise from above is LOOI's right (+)");
  near(result.biasDegS, -0.8, 0.01, "bias is taken from the still pre-roll");
  assert.equal(result.settled, true);
  near(result.onsetLatencyMs, 0, 5, "onset");
  near(result.sampleRateHz, 200, 1, "sample rate");
}
{
  // ROTATION_270 and a tilted head: up along -x with some z. Same physical turn to LOOI's left.
  const { capture, marks } = syntheticCapture({ up: { x: -9.0, y: 0, z: 3.9 }, rateAboutUpDegS: 80 });
  near(analysis.measurePivot(capture, marks).robotYawDeg, -40, 1, "counter-clockwise from above is LOOI's left (-), any mounting");
}
{
  const { capture, marks } = syntheticCapture({ up: { x: 9.81, y: 0, z: 0 }, rateAboutUpDegS: -100, tailMs: 100 });
  assert.equal(analysis.measurePivot(capture, marks).settled, false, "still turning when the window closes");
  assert.equal(analysis.measurePivot({ ...capture, up: null }, marks), null, "no up vector, no measurement");
}
assert.match(analysis.dominantUpAxis({ x: 0.2, y: -9.7, z: 0.5 }), /^-y/);

// --- Model fit and inverse.
const DEAD_MS = 60;
const DEG_PER_MS = 0.15;
const DURATIONS = [80, 120, 180, 250, 400, 650];
const trials = [];
for (const direction of ["left", "right"]) {
  for (const durationMs of DURATIONS) {
    for (const wobble of [-1.5, 0, 1.5]) {
      trials.push({ direction, durationMs, degrees: DEG_PER_MS * (durationMs - DEAD_MS) + wobble, completed: true, settled: true });
    }
  }
}
trials.push({ direction: "left", durationMs: 650, degrees: 400, completed: false, settled: true });
trials.push({ direction: "left", durationMs: 650, degrees: 400, completed: true, settled: false });

const left = model.fitPivotDirection(trials, "left");
near(left.degPerMs, DEG_PER_MS, 1e-6, "slope");
near(left.deadTimeMs, DEAD_MS, 1e-3, "dead time");
assert.equal(left.trialCount, 18, "replaced or unsettled pivots are excluded");
assert.deepEqual(left.table.map((row) => row.durationMs), DURATIONS);
assert.equal(left.table[0].count, 3);
near(left.table[0].maxDegrees - left.table[0].minDegrees, 3, 1e-9, "spread");
assert.ok(left.r2 > 0.99);

near(model.durationForDegrees(left, DEG_PER_MS * (180 - DEAD_MS)), 180, 1e-6, "inverse hits a table point");
near(model.durationForDegrees(left, 45), DEAD_MS + 45 / DEG_PER_MS, 1e-6, "inverse between points");
near(model.durationForDegrees(left, 180), DEAD_MS + 180 / DEG_PER_MS, 1e-6, "extrapolates past the longest pivot");
near(model.durationForDegrees(left, 1), DEAD_MS + 1 / DEG_PER_MS, 1e-6, "below the first point goes towards the dead time");
assert.equal(model.durationForDegrees(left, 0), 0);
assert.equal(model.clampPivotDuration(10), model.PIVOT_MIN_DURATION_MS);
assert.equal(model.clampPivotDuration(5_000), model.PIVOT_MAX_DURATION_MS);

// A non-monotone table (noise at short pivots) stays invertible and increasing.
const bumpy = { table: [
  { durationMs: 80, medianDegrees: 6 }, { durationMs: 120, medianDegrees: 5 }, { durationMs: 180, medianDegrees: 18 },
], degPerMs: 0.15, deadTimeMs: 40, r2: 0.9, trialCount: 9 };
let previous = 0;
for (let degrees = 1; degrees <= 40; degrees += 1) {
  const durationMs = model.durationForDegrees(bumpy, degrees);
  assert.ok(durationMs > previous, `monotone at ${degrees}°`);
  previous = durationMs;
}

assert.equal(model.fitPivotDirection(trials.filter((trial) => trial.durationMs === 80), "left"), null, "one duration cannot fit");
assert.equal(model.fitPivotDirection(
  [80, 120].map((durationMs) => ({ direction: "right", durationMs, degrees: 10 - durationMs / 100, completed: true, settled: true })),
  "right"
), null, "a falling line is rejected");

// --- Splitting turns that do not fit in one bounded pivot (2026-10-09 desk numbers for LOOI's left).
const measuredLeft = { table: [], degPerMs: 0.078, deadTimeMs: 18, r2: 0.995, trialCount: 18 };
assert.deepEqual(model.planPivotSegments(measuredLeft, 90), [Math.round(18 + 90 / 0.078)], "90 degrees fits one pivot");
const half = Math.round(18 + 90 / 0.078);
assert.deepEqual(model.planPivotSegments(measuredLeft, 180), [half, half], "180 degrees is two equal pivots, each paying the dead time");
assert.ok(model.planPivotSegments(measuredLeft, 180).every((ms) => ms <= model.PIVOT_MAX_DURATION_MS));
assert.equal(model.planPivotSegments(measuredLeft, 10_000).length, model.MAX_PIVOT_SEGMENTS, "segment count is capped");
assert.deepEqual(model.planPivotSegments(measuredLeft, 0), []);

// --- Runner: plan shape, and an end-to-end pivot with a fake gyro and robot.
const diagnostics = [];
let driving = null;
const fakeGyro = {
  recording: true,
  lastDrainMs: performance.now(),
  isRecording() { return this.recording; },
  nowMs() { return performance.now(); },
  drain() {
    const capture = { tMs: [], x: [], y: [], z: [], up: { x: 9.81, y: 0, z: 0 }, droppedSamples: 0, recording: true };
    const now = performance.now();
    for (let t = this.lastDrainMs; t < now; t += 5) {
      // LOOI's right = clockwise from above = negative rate about up (+x here).
      const turning = driving && t >= driving.from && t < driving.to;
      const rateAboutUp = turning ? (driving.direction === "right" ? -120 : 120) : 0;
      capture.tMs.push(t);
      capture.x.push(rateAboutUp * DEG);
      capture.y.push(0);
      capture.z.push(0);
    }
    this.lastDrainMs = now;
    return capture;
  },
};
const runner = compileTs("src/diagnostics/pivot-calibration-runner.ts", (id) => {
  if (id === "../../modules/gyro-yaw-recorder") return { getGyroYawRecorderModule: () => fakeGyro };
  if (id === "../device-tools/looi-robot") {
    return {
      performLooiCalibrationPivot: async (direction, durationMs) => {
        const from = performance.now() + 40;
        driving = { direction, from, to: from + durationMs };
        await new Promise((resolve) => setTimeout(resolve, durationMs + 60));
        return { ok: true, completed: true };
      },
    };
  }
  if (id === "./diagnostic-log") return { recordDiagnosticEvent: (category, event, details) => diagnostics.push({ category, event, details }) };
  if (id === "./pivot-calibration-analysis") return analysis;
  return require(id);
});

const plan = runner.buildPivotCalibrationPlan();
assert.equal(plan.length, 6 * 3 * 2);
assert.deepEqual(plan.slice(0, 4).map((step) => `${step.direction}${step.durationMs}`), ["left80", "right80", "left120", "right120"]);
assert.deepEqual(runner.PIVOT_CALIBRATION_DURATIONS_MS, DURATIONS);

for (const direction of ["right", "left"]) {
  const trial = await runner.runCalibrationPivot({ direction, durationMs: 250, repeat: 1 });
  near(trial.degrees, 30, 2, `${direction} pivot measured in the commanded direction`);
  assert.equal(trial.completed, true);
  assert.equal(trial.settled, true);
  assert.equal(trial.error, null);
}
assert.equal(diagnostics.filter((entry) => entry.event === "pivot-calibration-trial").length, 2);
fakeGyro.recording = false;
await assert.rejects(runner.runCalibrationPivot(plan[0]), /recorder is not running/);

// --- turnLooi: calibrated segments, each through the full safety path, cancellable between segments.
{
  const sdk = compileTs("packages/looi-sdk/src/index.ts");
  const fed9 = compileTs("src/device-tools/fed9-sensors.ts");
  const events = [];
  let segmentsFor = () => null;
  let notifyFed9 = null;
  const robotSource = read("src/device-tools/looi-robot.ts").replace(
    "export const TURN_SEGMENT_REST_MS = 250;",
    "export const TURN_SEGMENT_REST_MS = 40;"
  );
  const robotFile = "src/device-tools/looi-robot.ts";
  const output = ts.transpileModule(robotSource, {
    fileName: robotFile,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const robotModule = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(robotModule.exports, (id) => {
    if (id === "@sourcebug/looi-sdk") return sdk;
    if (id === "./fed9-sensors") return fed9;
    if (id === "./pivot-calibration") return { pivotSegmentsForDegrees: (...args) => segmentsFor(...args) };
    if (id === "../diagnostics/diagnostic-log") return { recordDiagnosticEvent: (category, event, details = {}) => events.push({ event, details }) };
    return require(id);
  }, robotModule, robotFile, path.dirname(robotFile));
  const robot = robotModule.exports;
  robot.configureLooiRobotTransport({
    async connect() {},
    async disconnect() {},
    hasCharacteristic: (key) => key === "dockNotify" || key === "drive",
    async startNotifications(key, callback) { if (key === "dockNotify") notifyFed9 = callback; },
    async write() {},
  });
  await robot.connectLooiRobot();
  const feed = (bytes) => notifyFed9({ characteristic: "dockNotify", hex: "", bytes: new Uint8Array(bytes) });
  feed([0x0e, 0xe8, 0x03]);
  feed([1, 1, 1, 1, 1]);
  await new Promise((resolve) => setTimeout(resolve, 280));
  const turnStarts = () => events.filter((entry) => entry.event === "move-start" && entry.details.mode === "calibrated-turn");

  segmentsFor = (direction, degrees) => (direction === "right" && degrees === 180 ? [120, 120] : null);
  const split = await robot.turnLooi("right", 180);
  assert.equal(split.completed, true);
  assert.equal(split.calibrated, true);
  assert.deepEqual(split.segments, [120, 120]);
  assert.equal(split.durationMs, 240);
  assert.deepEqual(turnStarts().map((entry) => `${entry.details.segment}/${entry.details.segments}:${entry.details.durationMs}`), ["1/2:120", "2/2:120"]);

  events.length = 0;
  const fallback = await robot.turnLooi("left", 90);
  assert.equal(fallback.calibrated, false, "no saved calibration falls back to the guesses");
  assert.deepEqual(fallback.segments, [robot.TURN_90_MS]);

  events.length = 0;
  segmentsFor = () => [200, 200];
  const pending = robot.turnLooi("right", 180);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await robot.stopLooiMotion("test-stop");
  const stopped = await pending;
  assert.equal(stopped.completed, false, "STOP during the first segment cancels the turn");
  assert.equal(turnStarts().length, 1, "the second segment never starts after STOP");

  events.length = 0;
  segmentsFor = () => [100, 100];
  feed([1, 0, 1, 1, 1]); // Front-left cliff: turns are blocked.
  await assert.rejects(robot.turnLooi("right", 180), /Движение заблокировано/);
  assert.equal(turnStarts().length, 0, "a blocked turn emits no segment");
}

// --- Wiring: safety path, native module, screen.
const robot = read("src/device-tools/looi-robot.ts");
assert.match(robot, /export async function performLooiCalibrationPivot\([\s\S]*?return runBoundedMotion\(direction, durationMs, "manual-bounded"/,
  "calibration pivots must use the bounded, safety-gated primitive");
const config = JSON.parse(read("modules/gyro-yaw-recorder/expo-module.config.json"));
assert.deepEqual(config.android.modules, ["com.superlooi.gyroyawrecorder.GyroYawRecorderModule"]);
assert.doesNotMatch(read("modules/gyro-yaw-recorder/android/build.gradle"), /^\s*(implementation|api)\s/m, "no native dependencies");
const kotlin = read("modules/gyro-yaw-recorder/android/src/main/java/com/superlooi/gyroyawrecorder/GyroYawRecorderModule.kt");
assert.match(kotlin, /Name\("GyroYawRecorder"\)/);
assert.match(kotlin, /Sensor\.TYPE_GYROSCOPE/);
assert.match(kotlin, /Sensor\.TYPE_GRAVITY/);
assert.match(kotlin, /DEFAULT_SAMPLING_PERIOD_US = 5_000/, "200 Hz needs no HIGH_SAMPLING_RATE_SENSORS permission");
assert.match(kotlin, /event\.timestamp \/ NANOS_PER_MS/);
assert.match(kotlin, /SystemClock\.elapsedRealtimeNanos\(\) \/ NANOS_PER_MS/, "nowMs shares the sensor clock");
assert.match(kotlin, /OnDestroy \{\s*stop\(\)/);
assert.match(read("app/_layout.tsx"), /name="pivot-calibration"/);
assert.match(read("app/(tabs)/settings.tsx"), /router\.push\("\/pivot-calibration"\)/);
const screen = read("app/pivot-calibration.tsx");
assert.match(screen, /stopLooiMotion\("pivot-calibration-cancelled"\)/, "Stop must stop the wheels");
assert.match(screen, /AppState\.addEventListener/);

console.log("pivot calibration behaviour test passed");
