// Spike: can GPT-Live-1 replace the Realtime PCM transport in My LOOI?
//
// Usage:
//   OPENAI_API_KEY=sk-... pnpm spike:gpt-live [options]
//
// Options:
//   --tts                 Synthesise real user utterances with /v1/audio/speech
//                         (PCM 24 kHz, cached in tmp/spikes/gpt-live/tts/). Without
//                         it the uplink is silence + a 440 Hz tone only (see
//                         "What it sends" below). Strongly recommended.
//   --audio <file>        Send a .wav (PCM16, any rate) or raw 24 kHz PCM16 mono
//                         file as the first utterance instead of TTS/tone.
//   --auth header|subprotocol
//                         header (default): Authorization: Bearer, as documented
//                         for Live. subprotocol: the Realtime-style
//                         openai-insecure-api-key.<key> subprotocol, which the
//                         phone would need (no backend). Probe only.
//   --voice <name>        Output voice (default marin, as in the Live WS docs).
//   --gap <ms>            Silence gap that closes a user turn for the local
//                         addressed-command parser (default 700).
//   --barge-in-delay <ms> How long after LOOI starts speaking to say "Stop"
//                         (default 900).
//   --delegation client   Also enable client delegation (default: none), to see
//                         whether the transport-only session is accepted.
//
// What it sends (24 kHz mono PCM16, base64, 100 ms appends paced in real time,
// silence whenever no clip is queued):
//   phase A  question:   "Hello LOOI. In one sentence, what is the capital of France?"
//   phase B  long ask:   "LOOI, tell me a long story about a robot who learns to dance."
//            barge-in:   "Stop!"  (queued --barge-in-delay ms after first output audio)
//   phase C  command:    "LOOI, turn around."
//   phase D  tone probe: 600 ms silence, 1200 ms 440 Hz tone, 600 ms silence
//   phase E  mute/unmute round trip, then session.close
// Without --tts, phases A-C send the tone probe instead of speech.
//
// What it measures: time to first output audio after the user stops talking,
// whether any turn-boundary signal exists in practice (largest inter-delta gap
// and quiet detection), transcript event shapes, what happens to output audio
// when the user speaks over it, when the app's local safety parser could have
// fired, and session.usage.updated / session.closed contents. Nothing is
// persisted except a JSONL event log under tmp/spikes/gpt-live/.

import {
  EventLog,
  LIVE_MODEL,
  PCM_RATE,
  PacedUplink,
  TranscriptSegmenter,
  fmt,
  loadPcmFile,
  openLiveSocket,
  parseArgs,
  pcmDurationMs,
  requireApiKey,
  silence,
  sleep,
  tone,
  ttsClip,
} from "../lib/gpt-live-spike.mjs";

const args = parseArgs(process.argv.slice(2), {
  auth: "header",
  voice: "marin",
  gap: "700",
  bargeInDelay: "900",
  tts: false,
  delegation: null,
});
const apiKey = requireApiKey();
const GAP_MS = Number(args.gap);
const BARGE_IN_DELAY_MS = Number(args.bargeInDelay);
const QUIET_MS = 1_200; // no output audio for this long => "response ended" (heuristic)
const PHASE_TIMEOUT_MS = 20_000;

const PERSONA = [
  "You are LOOI, a palm-sized tracked desktop robot. Your head is a phone showing your face.",
  "Speak English. Short, quirky, warm replies: one sentence by default, two at most. Never narrate movements.",
  "Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.",
  "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
  "Never claim you moved, turned, or entered sleep. The app executes addressed physical commands deterministically.",
].join(" ");

// Local safety parser from the app (needs --experimental-strip-types + resolver).
let parseExplicitRobotCommand = null;
let containsEmergencyStopWord = null;
try {
  const parser = await import("../../src/voice/explicit-robot-command.ts");
  parseExplicitRobotCommand = parser.parseExplicitRobotCommand;
  containsEmergencyStopWord = parser.containsEmergencyStopWord;
} catch (error) {
  console.error(`Local command parser unavailable (${error.message}); run via pnpm spike:gpt-live so the TS resolver is registered.`);
}
const PARSER_CONFIG = { robotName: "LOOI", robotAddressAliases: ["LOOI", "Looi", "Louie"], listeningLanguage: "en" };

const log = new EventLog("gpt-live-transport");
const ws = openLiveSocket({ apiKey, auth: args.auth });
const send = (event) => { ws.send(JSON.stringify(event)); log.print("out", event); };

const state = {
  started: false,
  outputDeltas: [],        // log-relative ms of every session.output_audio.delta
  outputBytes: 0,
  outputTranscript: "",
  inputTranscript: "",
  usageSnapshots: [],
  errors: [],
  closedEvent: null,
  acks: [],
  parserHits: [],          // { text, kind, at, source }
};
const uplink = new PacedUplink(ws, log);
const segmenter = new TranscriptSegmenter(log, {
  gapMs: GAP_MS,
  onTurn: (turn) => {
    const parsed = runParser(turn.text);
    console.log(`${log.stamp()}    [turn] ${JSON.stringify(turn.text)} closed by ${turn.reason} (${GAP_MS}ms gap); first delta ${fmt(turn.firstDeltaAt)}, last delta ${fmt(turn.lastDeltaAt)}, end_ms=${turn.lastEndMs ?? "-"}; parser => ${parsed ?? "none"}`);
    if (parsed) state.parserHits.push({ text: turn.text, kind: parsed, at: log.now(), source: "segmented" });
  },
});

function runParser(text) {
  if (!parseExplicitRobotCommand) return null;
  if (containsEmergencyStopWord(text, PARSER_CONFIG)) return "emergency-stop";
  const command = parseExplicitRobotCommand(text, PARSER_CONFIG);
  return command ? JSON.stringify(command) : null;
}

ws.on("error", (error) => {
  console.error(`websocket error: ${error.message}`);
  if (!state.started) process.exit(1);
});
ws.on("close", ({ code, reason }) => {
  console.log(`${log.stamp()} socket closed ${code} ${reason}`);
});
ws.on("open", ({ protocol }) => {
  console.log(`${log.stamp()} connected (auth=${args.auth}, negotiated subprotocol=${protocol ?? "none"}, HTTP ${ws.handshakeStatus})`);
  send({
    type: "session.start",
    event_id: "start_1",
    session: {
      model: LIVE_MODEL,
      instructions: PERSONA,
      audio: { format: { type: "audio/pcm", rate: PCM_RATE }, output: { voice: args.voice } },
      ...(args.delegation ? { delegation: { type: String(args.delegation) } } : {}),
    },
  });
});
ws.on("message", (raw) => {
  let event;
  try { event = JSON.parse(String(raw)); } catch { console.log(`${log.stamp()} <- non-JSON message (${String(raw).length} chars)`); return; }
  const type = String(event.type ?? "");
  if (type === "session.started" && !state.started) {
    state.started = true;
    log.mark();
    log.print("in", event);
    console.log(`  session snapshot: ${JSON.stringify(event.session ?? {}).slice(0, 600)}`);
    return;
  }
  if (type === "session.output_audio.delta") {
    const at = log.now();
    state.outputDeltas.push(at);
    state.outputBytes += Buffer.from(String(event.delta ?? ""), "base64").length;
    // Print the first delta of every burst and then one line per 500 ms.
    const previous = state.outputDeltas[state.outputDeltas.length - 2];
    if (previous === undefined || at - previous > QUIET_MS || state.outputDeltas.length % 5 === 0) log.print("in", event);
    else log.record("in", event);
    return;
  }
  log.print("in", event);
  if (type === "session.input_transcript.delta") {
    state.inputTranscript += String(event.delta ?? "");
    segmenter.push(event);
    // Incremental emergency check: the app would not wait for a gap for STOP.
    if (containsEmergencyStopWord && containsEmergencyStopWord(segmenter.text, PARSER_CONFIG)) {
      state.parserHits.push({ text: segmenter.text.trim(), kind: "emergency-stop", at: log.now(), source: "incremental" });
      console.log(`${log.stamp()}    [parser] incremental emergency STOP on ${JSON.stringify(segmenter.text.trim())}`);
    }
  } else if (type === "session.output_transcript.delta") {
    state.outputTranscript += String(event.delta ?? "");
  } else if (type === "session.usage.updated") {
    state.usageSnapshots.push({ at: log.now(), usage: event.usage, context_window: event.context_window });
  } else if (type === "error") {
    state.errors.push(event.error ?? event);
  } else if (type === "session.closed") {
    state.closedEvent = event;
  } else if (type.endsWith(".appended") || type.endsWith(".muted") || type.endsWith(".unmuted")) {
    state.acks.push({ at: log.now(), event });
  }
});

async function waitFor(predicate, timeoutMs = PHASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

function lastOutputAt() {
  return state.outputDeltas.length ? state.outputDeltas[state.outputDeltas.length - 1] : null;
}

function firstOutputAfter(ms) {
  return state.outputDeltas.find((at) => at >= ms) ?? null;
}

/** Wait until output audio has been quiet for QUIET_MS after some output happened since `sinceMs`. */
async function waitForQuiet(sinceMs, timeoutMs = PHASE_TIMEOUT_MS) {
  const gotOutput = await waitFor(() => firstOutputAfter(sinceMs) !== null, timeoutMs);
  if (!gotOutput) return { spoke: false };
  await waitFor(() => log.now() - lastOutputAt() >= QUIET_MS, timeoutMs);
  const deltas = state.outputDeltas.filter((at) => at >= sinceMs);
  const gaps = deltas.slice(1).map((at, i) => at - deltas[i]);
  return {
    spoke: true,
    firstAt: deltas[0],
    lastAt: deltas[deltas.length - 1],
    deltas: deltas.length,
    maxGapMs: gaps.length ? Math.max(...gaps) : 0,
  };
}

async function clipFor(text, ttsInstructions) {
  if (args.tts) {
    const clip = await ttsClip(apiKey, text, { instructions: ttsInstructions ?? "Speak like a person talking to a small robot on a desk, from about a metre away." });
    return { pcm: clip.pcm, label: text, cached: clip.cached };
  }
  return { pcm: Buffer.concat([silence(600), tone(1_200), silence(600)]), label: `tone probe (standing in for ${JSON.stringify(text)})`, cached: true };
}

async function speak(text, ttsInstructions) {
  const clip = await clipFor(text, ttsInstructions);
  console.log(`\n${log.stamp()} ## uplink: ${clip.label} (${pcmDurationMs(clip.pcm)}ms${clip.cached ? ", cached" : ""})`);
  const sent = await uplink.queue(clip.pcm, clip.label);
  console.log(`${log.stamp()}    clip fully sent (started ${fmt(sent.startedAt)}, ended ${fmt(sent.endedAt)})`);
  return sent;
}

const results = {};

async function run() {
  const opened = await waitFor(() => state.started, 15_000);
  if (!opened) {
    console.error("session.started never arrived (see errors above)");
    ws.destroy();
    process.exit(1);
  }
  uplink.start();
  await sleep(1_000); // observe idle behaviour on pure silence
  console.log(`${log.stamp()}    1 s of silence streamed; output deltas so far: ${state.outputDeltas.length}`);

  // Phase A: simple question -> time to first output audio.
  const a = args.audio
    ? await (async () => {
      const pcm = loadPcmFile(String(args.audio));
      console.log(`\n${log.stamp()} ## uplink: file ${args.audio} (${pcmDurationMs(pcm)}ms)`);
      return uplink.queue(pcm, `file ${args.audio}`);
    })()
    : await speak("Hello LOOI. In one sentence, what is the capital of France?");
  const aQuiet = await waitForQuiet(a.startedAt);
  const aFirstInputDelta = log.entries.find((e) => e.direction === "in" && e.type === "session.input_transcript.delta" && e.at >= a.startedAt)?.at ?? null;
  const aFirstOutputTranscript = log.entries.find((e) => e.direction === "in" && e.type === "session.output_transcript.delta" && e.at >= a.startedAt)?.at ?? null;
  results.phaseA = {
    clipEndedAt: a.endedAt,
    firstInputTranscriptDeltaAfterClipStart: aFirstInputDelta === null ? null : aFirstInputDelta - a.startedAt,
    firstOutputAudioAfterClipEnd: aQuiet.spoke ? aQuiet.firstAt - a.endedAt : null,
    firstOutputTranscriptAfterClipEnd: aFirstOutputTranscript === null ? null : aFirstOutputTranscript - a.endedAt,
    outputDeltas: aQuiet.deltas ?? 0,
    maxInterDeltaGapMs: aQuiet.maxGapMs ?? null,
    outputWallMs: aQuiet.spoke ? aQuiet.lastAt - aQuiet.firstAt : null,
  };
  segmenter.flush("phase-end");
  console.log(`${log.stamp()}    phase A: ${JSON.stringify(results.phaseA)}`);

  // Phase B: long reply, then barge in with "Stop!".
  const b = await speak("LOOI, tell me a long story about a robot who learns to dance, with lots of detail.");
  const bSpoke = await waitFor(() => firstOutputAfter(b.endedAt) !== null);
  const bFirstOutput = bSpoke ? firstOutputAfter(b.endedAt) : null;
  let bargeIn = null;
  if (bSpoke) {
    await sleep(BARGE_IN_DELAY_MS);
    const bytesBeforeStop = state.outputBytes;
    const stop = await speak("Stop!", "Say it as an urgent, clear command to a robot.");
    bargeIn = { stopStartedAt: stop.startedAt, stopEndedAt: stop.endedAt, bytesBeforeStop };
    // Give the model a chance to stop, then see whether audio keeps flowing.
    await sleep(2_500);
    const deltasAfterStopStart = state.outputDeltas.filter((at) => at >= stop.startedAt);
    const lastBeforeQuiet = deltasAfterStopStart.length ? deltasAfterStopStart[deltasAfterStopStart.length - 1] : null;
    bargeIn.outputDeltasAfterStopStarted = deltasAfterStopStart.length;
    bargeIn.outputBytesAfterStopStarted = state.outputBytes - bytesBeforeStop;
    bargeIn.outputAudioMsAfterStopStarted = Math.round((state.outputBytes - bytesBeforeStop) / 2 / PCM_RATE * 1000);
    bargeIn.lastOutputDeltaAfterStopStart = lastBeforeQuiet === null ? null : lastBeforeQuiet - stop.startedAt;
    const stopHit = state.parserHits.find((hit) => hit.kind === "emergency-stop" && hit.at >= stop.startedAt);
    bargeIn.localStopDetectedAfterStopStart = stopHit ? stopHit.at - stop.startedAt : null;
    bargeIn.localStopDetectedAfterStopEnd = stopHit ? stopHit.at - stop.endedAt : null;
    bargeIn.localStopSource = stopHit?.source ?? null;
  }
  const bQuiet = await waitForQuiet(b.startedAt);
  results.phaseB = {
    firstOutputAudioAfterClipEnd: bFirstOutput === null ? null : bFirstOutput - b.endedAt,
    bargeIn,
    totalOutputDeltas: bQuiet.deltas ?? 0,
    maxInterDeltaGapMs: bQuiet.maxGapMs ?? null,
  };
  segmenter.flush("phase-end");
  console.log(`${log.stamp()}    phase B: ${JSON.stringify(results.phaseB)}`);

  // Phase C: addressed physical command. Does the model start talking before the
  // app could have intercepted the command locally?
  const c = await speak("LOOI, turn around.");
  const cQuiet = await waitForQuiet(c.startedAt, 8_000);
  await waitFor(() => segmenter.turns.some((turn) => turn.segmentedAt >= c.startedAt), GAP_MS + 4_000);
  const cHit = state.parserHits.find((hit) => hit.source === "segmented" && hit.at >= c.startedAt);
  results.phaseC = {
    localCommandParsedAfterClipEnd: cHit ? cHit.at - c.endedAt : null,
    localCommand: cHit?.kind ?? null,
    modelFirstOutputAfterClipEnd: cQuiet.spoke ? cQuiet.firstAt - c.endedAt : null,
    modelSpokeBeforeLocalParse: cQuiet.spoke && cHit ? cQuiet.firstAt < cHit.at : null,
  };
  segmenter.flush("phase-end");
  console.log(`${log.stamp()}    phase C: ${JSON.stringify(results.phaseC)}`);

  // Phase D: non-speech noise. Does a tone provoke output or transcript?
  const toneClip = Buffer.concat([silence(600), tone(1_200), silence(600)]);
  console.log(`\n${log.stamp()} ## uplink: tone probe (600ms silence, 1200ms 440Hz, 600ms silence)`);
  const d = await uplink.queue(toneClip, "tone probe");
  const dQuiet = await waitForQuiet(d.startedAt, 6_000);
  const dTranscript = log.entries.filter((e) => e.direction === "in" && e.type === "session.input_transcript.delta" && e.at >= d.startedAt).length;
  results.phaseD = { modelSpokeAfterTone: dQuiet.spoke, inputTranscriptDeltasDuringTone: dTranscript };
  segmenter.flush("phase-end");
  console.log(`${log.stamp()}    phase D: ${JSON.stringify(results.phaseD)}`);

  // Phase E: mute round trip, then close.
  const muteAt = log.now();
  send({ type: "session.input_audio.mute", event_id: "mute_1" });
  const muted = await waitFor(() => state.acks.some((ack) => ack.event.type === "session.input_audio.muted"), 5_000);
  send({ type: "session.input_audio.unmute", event_id: "unmute_1" });
  const unmuted = await waitFor(() => state.acks.some((ack) => ack.event.type === "session.input_audio.unmuted"), 5_000);
  results.phaseE = {
    muteAckMs: muted ? state.acks.find((ack) => ack.event.type === "session.input_audio.muted").at - muteAt : null,
    unmuteAcked: unmuted,
  };
  console.log(`${log.stamp()}    phase E: ${JSON.stringify(results.phaseE)}`);

  await sleep(1_500);
  uplink.stop();
  send({ type: "session.close", event_id: "close_1" });
  await waitFor(() => state.closedEvent !== null, 15_000);
  finish();
}

function finish() {
  const wall = log.now();
  console.log("\n=== summary ===");
  console.log(`auth: ${args.auth}; tts: ${args.tts ? "yes" : "no (tone only)"}; voice: ${args.voice}; wall: ${fmt(wall)}`);
  console.log(`uplink appends: ${uplink.sentChunks} (${uplink.silentChunks} silent); output audio: ${state.outputBytes} bytes = ${fmt(state.outputBytes / 2 / PCM_RATE * 1000)} of speech`);
  console.log(`phase A (question): first output audio ${fmt(results.phaseA?.firstOutputAudioAfterClipEnd)} after user stopped; first input transcript delta ${fmt(results.phaseA?.firstInputTranscriptDeltaAfterClipStart)} after user started`);
  console.log(`phase B (barge-in): output after "Stop!" started: ${results.phaseB?.bargeIn?.outputAudioMsAfterStopStarted ?? "n/a"}ms of audio in ${results.phaseB?.bargeIn?.outputDeltasAfterStopStarted ?? "n/a"} deltas; last delta ${fmt(results.phaseB?.bargeIn?.lastOutputDeltaAfterStopStart)} after stop started; local STOP parser fired ${fmt(results.phaseB?.bargeIn?.localStopDetectedAfterStopEnd)} after stop ended (${results.phaseB?.bargeIn?.localStopSource ?? "never"})`);
  console.log(`phase C (LOOI, turn around): local parser ${results.phaseC?.localCommand ?? "did not fire"} ${fmt(results.phaseC?.localCommandParsedAfterClipEnd)} after clip end; model first audio ${fmt(results.phaseC?.modelFirstOutputAfterClipEnd)}; model spoke before local parse: ${results.phaseC?.modelSpokeBeforeLocalParse}`);
  console.log(`phase D (tone): model spoke: ${results.phaseD?.modelSpokeAfterTone}; transcript deltas: ${results.phaseD?.inputTranscriptDeltasDuringTone}`);
  console.log(`phase E (mute): ack ${fmt(results.phaseE?.muteAckMs)}; unmute acked: ${results.phaseE?.unmuteAcked}`);
  console.log(`turn boundary signal: max inter-delta gap inside a reply A=${fmt(results.phaseA?.maxInterDeltaGapMs)} B=${fmt(results.phaseB?.maxInterDeltaGapMs)}; wall-clock delivery of reply A ${fmt(results.phaseA?.outputWallMs)} for ${results.phaseA?.outputDeltas} deltas (compare with audio length above: faster-than-real-time delivery means the app must own playback timing and truncation)`);
  console.log(`user transcript: ${JSON.stringify(state.inputTranscript.trim())}`);
  console.log(`assistant transcript: ${JSON.stringify(state.outputTranscript.trim())}`);
  console.log(`usage snapshots: ${JSON.stringify(state.usageSnapshots)}`);
  console.log(`session.closed: ${JSON.stringify(state.closedEvent ? { reason: state.closedEvent.reason, usage: state.closedEvent.usage } : null)}`);
  console.log(`errors: ${JSON.stringify(state.errors)}`);
  console.log("\nevent counts:\n" + log.summary());
  console.log("\nfirst envelope of each server event type:\n" + log.envelopes());
  const path = log.save(`transport-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(`\nevent log: ${path}`);
  ws.close();
  setTimeout(() => process.exit(0), 200);
}

run().catch((error) => {
  console.error(error);
  ws.destroy();
  process.exit(1);
});
