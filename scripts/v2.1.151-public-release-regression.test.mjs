import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const read = (path) => fs.readFileSync(path, "utf8");

const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

assert.equal(pkg.version, "2.1.151");
assert.equal(app.expo.version, "2.1.151");
assert.equal(app.expo.android.versionCode, 151);

assert.ok(fs.existsSync("modules/photo-picker-access"));
assert.ok(fs.existsSync("src/voice/realtime-visual-command.ts"));
assert.ok(fs.existsSync("src/diagnostics/performance-monitor.ts"));
assert.ok(fs.existsSync("ACKNOWLEDGEMENTS.md"));

assert.match(read("src/diagnostics/performance-monitor.ts"), /SNAPSHOT_INTERVAL_MS = 30_000/);
assert.match(read("src/diagnostics/performance-monitor.ts"), /EVENT_LOOP_WARN_MS = 500/);
assert.match(read("src/core/app-bootstrap.ts"), /const delayMs = 12_000/);
assert.match(read("src/voice/wakeword.ts"), /const delayMs = 8_000/);

assert.equal(
  crypto.createHash("sha256")
    .update(read("src/voice/realtime-pcm-conversation.ts"))
    .digest("hex"),
  "a22924f9c8e5da6e93bdf94e10a17a88bab43ccae732fb5fac82c19861313ced"
);

assert.equal(
  crypto.createHash("sha256")
    .update(read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt"))
    .digest("hex"),
  "667938b5ce3c8c2991b23f1d24661ef5db914a504482ded186f570c1614d77cc"
);

const ack = read("ACKNOWLEDGEMENTS.md");

console.log("v2.1.151 public release regression: PASS");
