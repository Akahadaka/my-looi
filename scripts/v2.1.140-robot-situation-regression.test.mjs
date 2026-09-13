import assert from "node:assert/strict";
import fs from "node:fs";

const config = fs.readFileSync("src/voice/realtime-config.ts", "utf8");
const pcm = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");
const player = fs.readFileSync("src/choreography/choreography-player.ts", "utf8");
const strings = fs.readFileSync("src/i18n/ui-strings.ts", "utf8");
const settings = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");

// The persona no longer hard-codes a belief about its surroundings.
assert.equal(config.includes("you cannot leave it"), false, "persona must not insist it cannot leave the desk");
assert.ok(config.includes("describeRobotSituationForPersona("), "persona line comes from the situation model");
assert.ok(config.includes('name: "set_situation"'), "model can record the situation the user describes");
assert.ok(config.includes('enum: ["desk", "floor", "unknown"]'), "surface enum");
assert.ok(config.includes('enum: ["stay", "explore"]'), "freedom enum");
assert.ok(pcm.includes('name === "set_situation"'), "session handles the tool");
assert.ok(pcm.includes('this.applySessionPreferences("realtime-situation-tool")'), "situation change re-applies the persona live");

// Pure modules: normalisation, persona text, envelope.
const { normalizeRobotSituation, describeRobotSituationForPersona, DEFAULT_ROBOT_SITUATION } = await import("../src/robot/robot-situation.ts");
assert.deepEqual(DEFAULT_ROBOT_SITUATION, { surface: "desk", freedom: "stay" });
assert.deepEqual(normalizeRobotSituation({ surface: "floor", freedom: "explore" }), { surface: "floor", freedom: "explore" });
assert.deepEqual(normalizeRobotSituation({ surface: "lawn" }), { surface: "desk", freedom: "stay" }, "unknown values fall back");
assert.ok(describeRobotSituationForPersona({ surface: "floor", freedom: "explore" }).includes("on the floor"), "persona says floor");
assert.ok(describeRobotSituationForPersona({ surface: "floor", freedom: "explore" }).includes("never argue"), "persona forbids arguing");

const { getMotionEnvelope } = await import("../src/robot/motion-policy.ts");
const desk = getMotionEnvelope({ surface: "desk", freedom: "stay" }, "normal");
const floor = getMotionEnvelope({ surface: "floor", freedom: "explore" }, "lively");
assert.equal(desk.translationAllowed, false, "no translation on the desk");
assert.equal(floor.translationAllowed, false, "no translation yet even on the floor; behaviours are future work");
assert.ok(floor.pivotMaxMs > desk.pivotMaxMs, "floor allows a wider pivot than the desk");
assert.equal(desk.spinAllowed, false);
assert.equal(floor.spinAllowed, true);
assert.equal(floor.behavioursAllowed, true);
assert.equal(desk.behavioursAllowed, false);

// Choreography pivots are clamped by the envelope, and the primitive keeps a hard ceiling.
assert.ok(player.includes("getMotionEnvelope(preferences.robotSituation, preferences.expressiveMotionLevel)"), "player consults the motion policy");
const robot = fs.readFileSync("src/device-tools/looi-robot.ts", "utf8");
assert.ok(/performLooiChoreographyPivot[\s\S]*?Math\.min\(400, Math\.round\(maxDurationMs\)\)/.test(robot), "pivot ceiling never exceeds 400 ms");

// Settings and strings.
for (const key of ["settings.robotSituation", "settings.robotSituationHelp", "settings.robotSurfaceDesk", "settings.robotSurfaceFloor", "settings.robotFreedomStay", "settings.robotFreedomExplore"]) {
  assert.equal(strings.split(`"${key}":`).length - 1, 3, `${key} in uk, en and ru`);
}
assert.ok(settings.includes('surface: "floor"') && settings.includes('freedom: "explore"'), "settings can set floor and explore");
assert.ok(fs.existsSync("docs/embodiment-roadmap.md"), "roadmap documented");

console.log("Robot situation regression: PASS");
