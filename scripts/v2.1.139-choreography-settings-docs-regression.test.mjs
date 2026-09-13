import assert from "node:assert/strict";
import fs from "node:fs";

const settings = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
const strings = fs.readFileSync("src/i18n/ui-strings.ts", "utf8");
const player = fs.readFileSync("src/choreography/choreography-player.ts", "utf8");
const guide = fs.readFileSync("USER_GUIDE.md", "utf8");
const features = fs.readFileSync("FEATURES.md", "utf8");
const architecture = fs.readFileSync("docs/architecture.md", "utf8");
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");

// Settings exposes all four levels and both previews; previews need a connected robot and a non-off level.
for (const level of ["off", "head", "normal", "lively"]) {
  assert.ok(settings.includes(`updatePreferences({ expressiveMotionLevel: "${level}" })`), `settings offers expressive level ${level}`);
}
for (const kind of ["lively", "gentle"]) {
  assert.ok(settings.includes(`runChoreographyPreview("${kind}")`), `settings offers ${kind} preview`);
}
assert.ok(/disabled=\{choreographyPreviewBusy \|\| !robotRuntime\.connected \|\| preferences\.expressiveMotionLevel === "off"\}/.test(settings), "previews are gated on busy, connection and level");
assert.ok(settings.includes("choreographyPlayer.playPreview(kind)"), "preview goes through the player, so arbitration and cancel apply");

// Every new UI string exists in all three interface languages.
const keys = [
  "settings.expressiveMotion", "settings.expressiveMotionHelp", "settings.expressiveMotionOff", "settings.expressiveMotionHead",
  "settings.expressiveMotionNormal", "settings.expressiveMotionLively", "settings.expressivePreviewLively", "settings.expressivePreviewGentle",
];
for (const key of keys) {
  const count = strings.split(`"${key}":`).length - 1;
  assert.equal(count, 3, `${key} must be defined for uk, en and ru (found ${count})`);
}

// Preview plays fixed plans through the normal loop and never bypasses the level filter.
assert.ok(player.includes("async playPreview(kind"), "player has a preview entry point");
assert.ok(/playPreview[\s\S]*?this\.setPlan\(plan, "model", turn\)/.test(player), "preview uses setPlan, which applies filterPlanForLevel");
assert.equal(/playPreview[\s\S]*?performLooi/.test(player.slice(player.indexOf("async playPreview"), player.indexOf("cancel(reason: string)"))), false, "preview never calls primitives directly");

// Docs describe the feature and its safety rules.
assert.ok(guide.includes("### Expressive motion (reply choreography)"), "user guide has the expressive motion section");
assert.ok(guide.includes("Previews require the robot to be connected"), "user guide documents the preview gate");
assert.ok(features.includes("Expressive motion:"), "FEATURES lists expressive motion");
assert.ok(architecture.includes("Expressive choreography runs beside the conversation, not inside it."), "architecture explains the out-of-band channel");
assert.ok(architecture.includes("checks the motion sequence token before every beat"), "architecture states the STOP guarantee");
assert.ok(changelog.includes("## 2.1.137"), "changelog has the 2.1.137 entry");

console.log("Choreography settings/docs regression: PASS");
