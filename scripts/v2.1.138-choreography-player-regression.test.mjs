import assert from "node:assert/strict";
import fs from "node:fs";

const player = fs.readFileSync("src/choreography/choreography-player.ts", "utf8");
const fallback = fs.readFileSync("src/choreography/choreography-fallback.ts", "utf8");
const pcm = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");
const robot = fs.readFileSync("src/device-tools/looi-robot.ts", "utf8");
const config = fs.readFileSync("src/voice/realtime-config.ts", "utf8");
const user = fs.readFileSync("src/store/user.ts", "utf8");

// Priority: STOP/safety token, local commands, barge-in and session stop all beat choreography.
assert.ok(player.includes("getMotionSequenceToken() !== state.motionToken"), "player must abandon the plan when STOP or a sensor stop bumps the sequence token");
assert.ok(pcm.includes('choreographyPlayer.cancel("barge-in")'), "barge-in cancels choreography");
assert.ok(pcm.includes('choreographyPlayer.cancel("local-physical-command")'), "addressed local commands cancel choreography");
assert.ok(pcm.includes("choreographyPlayer.cancel(`session-stop:${reason}`)"), "session stop cancels choreography");
assert.ok(player.includes('return "camera-attention-owns-head"'), "head beats yield to Camera Attention while a face is tracked");
assert.ok(player.includes('holdAmbientMotionFor('), "ambient motion is held while a plan plays");

// Motion is bounded: no continuous drive, and every wheel primitive is the safety-controlled one.
assert.equal(player.includes("startLooiMotion"), false, "player must never start continuous motion");
assert.equal(player.includes("moveLooi("), false, "player must never translate forward/backward");
assert.ok(player.includes("performLooiChoreographyPivot"), "body atoms use the bounded pivot primitive");
assert.ok(robot.includes("export async function performLooiChoreographyPivot"), "bounded choreography pivot exists");
assert.ok(/performLooiChoreographyPivot[\s\S]*?runBoundedMotion\(direction, boundedDurationMs, "manual-bounded"/.test(robot), "choreography pivot goes through runBoundedMotion");
assert.ok(robot.includes("export function getMotionSequenceToken"), "sequence token is exported for the player");
assert.ok(robot.includes("export async function performLooiHeadLean"), "partial head lean primitive exists");
assert.ok(/performLooiHeadLean[\s\S]*?wheelsUsed: false/.test(robot), "head lean is head-only");

// Pure plan filtering: level, energy ceiling, caps.
const { filterPlanForLevel, estimateSpeechDurationMs, LATE_BEAT_TOLERANCE } = await import("../src/choreography/choreography-plan.ts");
const lively = { mood: "lively", energy: 0.85, beats: [
  { at: 0, do: "bob", n: 1 }, { at: 0.2, do: "wiggle", n: 1 }, { at: 0.4, do: "spin", n: 1 }, { at: 0.6, do: "sway", n: 1 }, { at: 0.8, do: "shake", n: 1 },
] };
assert.deepEqual(filterPlanForLevel(lively, "off").plan.beats, [], "off plays nothing");
assert.deepEqual(filterPlanForLevel(lively, "head").plan.beats.map((b) => b.do), ["bob"], "head level drops every body atom");
assert.deepEqual(filterPlanForLevel(lively, "normal").plan.beats.map((b) => b.do), ["bob", "wiggle", "sway"], "normal drops spin and caps body atoms at two");
assert.deepEqual(filterPlanForLevel(lively, "lively").plan.beats.map((b) => b.do), ["bob", "wiggle", "spin"], "lively allows one spin at energy >= 0.8");
const lowSpin = filterPlanForLevel({ ...lively, energy: 0.7 }, "lively");
assert.ok(!lowSpin.plan.beats.some((b) => b.do === "spin"), "spin needs energy >= 0.8 even at lively");
const sad = filterPlanForLevel({ mood: "sad", energy: 0.2, beats: [{ at: 0, do: "lean_down", n: 1 }, { at: 0.3, do: "wiggle", n: 1 }, { at: 0.5, do: "bob", n: 1 }, { at: 1, do: "settle", n: 1 }] }, "lively");
assert.deepEqual(sad.plan.beats.map((b) => b.do), ["lean_down", "settle"], "low energy keeps only slow head atoms");
assert.ok(estimateSpeechDurationMs(140, 1) >= 9_000 && estimateSpeechDurationMs(140, 1) <= 11_000, "duration estimate ~14 chars/s");
assert.ok(LATE_BEAT_TOLERANCE > 0 && LATE_BEAT_TOLERANCE <= 0.3, "late beats are skipped beyond a quarter of the reply");

// Fallback guarantees movement and follows mood.
const { buildFallbackPlan, buildOpenerBeat, decayMood } = await import("../src/choreography/choreography-fallback.ts");
const fb = buildFallbackPlan("Oh wow! Really? Yes.", "playful", 0.8);
assert.deepEqual(fb.beats.map((b) => b.do), ["bob", "peek_up", "nod", "settle"], "punctuation drives fallback beats");
assert.equal(buildFallbackPlan("", "warm", 0.5).beats.length, 2, "empty transcript still yields a beat plus settle");
assert.equal(buildOpenerBeat("sad", 0.2).do, "lean_down", "sad opener is slow");
assert.equal(buildOpenerBeat("lively", 0.9).do, "bob", "lively opener bobs");
assert.equal(decayMood("sad", 0.2).energy, 0.35, "mood decays halfway toward neutral");
assert.ok(fallback.includes("settle"), "fallback always settles the head");

// Personality: short, quirky, embodied; safety lines intact.
assert.ok(config.includes("palm-sized tracked desktop robot"), "persona describes the body");
assert.ok(config.includes("One short sentence by default, two at most"), "persona enforces short replies");
assert.ok(config.includes("never narrate or describe your own movements"), "persona forbids narrating movement");
assert.ok(config.includes("You have no physical movement tool yourself"), "default session still has no movement tool");
assert.ok(config.includes("intercepted and executed deterministically by the local app"), "local command handoff still described");

// Preference exists with a safe default and is skipped entirely when off.
assert.ok(user.includes('expressiveMotionLevel: "normal"'), "expressive motion defaults to normal");
assert.ok(pcm.includes('reason: "expressive-motion-off"'), "channel request is skipped when expressive motion is off");

console.log("Choreography player regression: PASS");
