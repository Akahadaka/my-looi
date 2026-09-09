import assert from "node:assert/strict";
import fs from "node:fs";

const pcm = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");
const channel = fs.readFileSync("src/choreography/choreography-channel.ts", "utf8");
const config = fs.readFileSync("src/voice/realtime-config.ts", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

// The choreography request must be out of band so it never enters the default
// conversation and never competes with the server-VAD audio response.
assert.ok(channel.includes('conversation: "none"'), "choreography response must be out of band");
assert.ok(channel.includes('output_modalities: ["text"]'), "choreography response must be text only");
assert.ok(channel.includes('metadata: { topic: CHOREOGRAPHY_TOPIC, turn }'), "choreography response must carry routing metadata");

// Every event that belongs to a choreography response must be routed away
// before the audio handlers reset transcript/playback state or finalize a turn.
assert.ok(
  pcm.includes('if (this.routeChoreographyEvent(type, event)) return;'),
  "choreography events must be routed before any default-response handler"
);
assert.ok(pcm.includes('this.requestChoreography("speech-stopped")'), "choreography is requested when the user turn is committed");
assert.ok(pcm.includes('"pcm-choreography-response-done"'), "choreography timing/JSON must reach diagnostics");

// Phase 1 is a measurement spike: nothing may move from the choreography path yet.
assert.equal(channel.includes("looi-robot"), false, "channel module must stay free of robot primitives in phase 1");
assert.equal(/choreograph[\s\S]*?(moveLooi|turnLooi|performLooi|startLooiMotion)/i.test(channel), false, "channel must not drive the robot");
for (const primitive of ["moveLooi", "turnLooi", "startLooiMotion", "performLooiDance", "performLooiHeadGesture"]) {
  const routing = pcm.slice(pcm.indexOf("private requestChoreography"), pcm.indexOf("private markPlaybackStarted"));
  assert.equal(routing.includes(primitive), false, `choreography routing must not call ${primitive} in phase 1`);
}

// The safety stance for the default conversation is unchanged.
assert.ok(config.includes("You have no physical movement tool yourself"), "default Realtime session still has no movement tool");
assert.equal(config.includes("choreograph"), false, "default session tools are unchanged in phase 1");

// Parser must clamp and drop unknown atoms rather than fail.
const { parseChoreographyPlan } = await import("../src/choreography/choreography-channel.ts");
const parsed = parseChoreographyPlan('{"mood":"SAD","energy":9,"beats":[{"at":2,"do":"nod","n":7},{"at":0,"do":"rock"}]}');
assert.ok(parsed.ok, "clampable plan parses");
assert.equal(parsed.plan.mood, "sad");
assert.equal(parsed.plan.energy, 1);
assert.deepEqual(parsed.plan.beats, [{ at: 1, do: "nod", n: 3 }]);
assert.deepEqual(parsed.droppedAtoms, ["rock"]);
assert.equal(parseChoreographyPlan("I would nod here.").ok, false, "prose is rejected");

assert.ok(typeof pkg.scripts["spike:choreography"] === "string", "spike script is reachable via pnpm spike:choreography");

console.log("Choreography channel spike regression: PASS");
