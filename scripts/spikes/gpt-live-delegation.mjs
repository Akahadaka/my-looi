// Spike: GPT-Live-1 delegation for My LOOI's memory and language tools.
//
// Usage:
//   OPENAI_API_KEY=sk-... pnpm spike:gpt-live-delegation [options]
//
// Options:
//   --mode responses|client|both   Which delegation mode(s) to run (default both;
//                                  each mode is a separate session because the
//                                  delegation type is immutable per session).
//   --backend <model>              Responses backend model (default gpt-5.6-luna;
//                                  try gpt-5.6-terra).
//   --tts                          Speak the test utterances via /v1/audio/speech
//                                  (recommended). Without it the questions are
//                                  seeded as session.start `input` history, which
//                                  only exercises the first turn.
//   --auth header|subprotocol      As in gpt-live-transport.mjs.
//   --voice <name>                 Output voice (default marin).
//   --reasoning <effort>           Set delegation.responses.reasoning.effort.
//
// Utterances (the app's three in-session tools):
//   1. "LOOI, what's my dog's name?"                  -> search_memory round trip
//   2. "LOOI, remember that my favourite colour is green." -> remember
//   3. "LOOI, from now on let's speak Ukrainian."     -> set_language_preferences
//
// For each utterance it logs the exact event envelopes (first of each type in
// full), whether the voice model delegated at all, the latency from the end of
// the user's speech to: delegation start, the function call, our tool output,
// and the first output audio after the tool output ("first spoken result"). In
// client mode the "agent" is a local stub that answers from a fake memory store
// via session.commentary.append. Nothing is persisted except a JSONL event log
// under tmp/spikes/gpt-live/.

import {
  EventLog,
  LIVE_MODEL,
  PCM_RATE,
  PacedUplink,
  TranscriptSegmenter,
  fmt,
  openLiveSocket,
  parseArgs,
  pcmDurationMs,
  requireApiKey,
  sleep,
  ttsClip,
} from "../lib/gpt-live-spike.mjs";

const args = parseArgs(process.argv.slice(2), {
  mode: "both",
  backend: "gpt-5.6-luna",
  auth: "header",
  voice: "marin",
  tts: false,
  reasoning: null,
});
const apiKey = requireApiKey();
const modes = args.mode === "both" ? ["responses", "client"] : [String(args.mode)];
const QUIET_MS = 1_200;
const PHASE_TIMEOUT_MS = 25_000;

const UTTERANCES = [
  { text: "LOOI, what's my dog's name?", expectTool: "search_memory" },
  { text: "LOOI, remember that my favourite colour is green.", expectTool: "remember" },
  { text: "LOOI, from now on let's speak Ukrainian.", expectTool: "set_language_preferences" },
];

const FAKE_MEMORY = [
  { memory: "The user's dog is called Biscuit; a small brown terrier.", score: 0.91, category: "pets" },
  { memory: "The user drinks black coffee in the morning.", score: 0.42, category: "routine" },
];

// Same tool schemas as src/voice/realtime-config.ts (buildRealtimeTools), copied
// because that function is not exported and the spike must not change src/.
const TOOLS = [
  {
    type: "function",
    name: "search_memory",
    description: "Search LOOI's long-term memory for facts relevant to the user's question.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Short semantic search query." } }, required: ["query"], additionalProperties: false },
  },
  {
    type: "function",
    name: "remember",
    description: "Store one concise durable personal fact, preference, relationship, routine, or long-lived project detail learned directly from the user. Always use it when the user explicitly asks LOOI to remember something.",
    parameters: { type: "object", properties: { note: { type: "string", description: "The concise fact to remember." } }, required: ["note"], additionalProperties: false },
  },
  {
    type: "function",
    name: "set_language_preferences",
    description: "Persistently change LOOI's language preferences only when the user explicitly asks to switch future replies or the ongoing conversation. For a full conversation switch set both response_language and listening_language.",
    parameters: {
      type: "object",
      properties: {
        response_language: { type: "string", enum: ["ru", "uk", "en"], description: "Persistent language for LOOI's future replies." },
        listening_language: { type: "string", enum: ["ru", "uk", "en"], description: "Optional expected language for the user's future speech." },
      },
      required: ["response_language"],
      additionalProperties: false,
    },
  },
];

const PERSONA = [
  "You are LOOI, a palm-sized tracked desktop robot with long-term memory. Speak English unless a language change has been confirmed by the backend.",
  "Short, warm, quirky replies: one sentence by default, two at most.",
  "Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.",
  "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
  "Delegation policy:",
  "Backend tools:",
  "- memory: search the user's long-term memory and store new durable facts about the user.",
  "- language settings: persistently switch the conversation language.",
  "Delegate to the backend when:",
  "- The user asks about their own personal facts, preferences, pets, relationships, routines, or plans.",
  "- The user asks you to remember something, or states a durable personal fact.",
  "- The user asks to switch the conversation language from now on.",
  "Do not delegate to the backend when:",
  "- You can answer from the conversation or general knowledge.",
  "- You need a brief clarification to understand the request.",
  "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.",
  "Never claim a setting changed or a fact was stored unless the backend confirmed it.",
].join("\n");

const BACKEND_INSTRUCTIONS = [
  "You are the reasoning backend for LOOI, a small desktop robot. Use the tools to answer questions about the user's personal facts (search_memory), store durable facts (remember), and change language settings (set_language_preferences).",
  "Reply with one short sentence the voice model can say. Do not mention tools.",
].join(" ");

function localToolResult(name, argumentsJson) {
  const parsed = argumentsJson ? JSON.parse(argumentsJson) : {};
  if (name === "search_memory") return { ok: true, results: FAKE_MEMORY };
  if (name === "remember") return { ok: true, remembered: String(parsed.note ?? "") };
  if (name === "set_language_preferences") {
    return { ok: true, response_language: parsed.response_language, listening_language: parsed.listening_language ?? null, next_reply_language: parsed.response_language === "uk" ? "Ukrainian" : parsed.response_language === "ru" ? "Russian" : "English", instruction: "Acknowledge the change and continue in next_reply_language.", persistent: true };
  }
  return { ok: false, error: `Unsupported tool: ${name}` };
}

/** Client-mode stand-in for the app's sidecar agent: answer from the transcript so far. */
function localAgentAnswer(transcript) {
  const text = transcript.toLowerCase();
  if (/dog|pet/.test(text)) return { content: "Your dog is called Biscuit, the small brown terrier.", tool: "search_memory" };
  if (/remember/.test(text)) return { content: "Stored: the user's favourite colour is green.", tool: "remember" };
  if (/ukrainian|russian|english/.test(text)) return { content: "Language preference switched to Ukrainian; reply in Ukrainian from now on.", tool: "set_language_preferences" };
  return { content: "I found nothing relevant in memory.", tool: null };
}

async function waitFor(predicate, timeoutMs = PHASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

async function runMode(mode) {
  console.log(`\n\n########## delegation mode: ${mode}${mode === "responses" ? ` (backend ${args.backend})` : ""} ##########`);
  const log = new EventLog(`gpt-live-delegation-${mode}`);
  const ws = openLiveSocket({ apiKey, auth: args.auth });
  const send = (event) => { ws.send(JSON.stringify(event)); log.print("out", event); };
  const state = {
    started: false,
    closedEvent: null,
    errors: [],
    outputDeltas: [],
    outputBytes: 0,
    outputTranscript: "",
    inputTranscript: "",
    delegations: [],          // { at, id, target, mode }
    responseEvents: [],       // { at, innerType, delegationId }
    functionCalls: [],        // { at, name, callId, arguments, answeredAt }
    commentaries: [],         // { at, delegationId, content, ackAt }
    usageSnapshots: [],
  };
  const uplink = new PacedUplink(ws, log);
  const segmenter = new TranscriptSegmenter(log, { gapMs: 700 });

  const seededInput = !args.tts
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: UTTERANCES[0].text }] }]
    : null;

  ws.on("error", (error) => { console.error(`websocket error: ${error.message}`); if (!state.started) throw error; });
  ws.on("close", ({ code, reason }) => console.log(`${log.stamp()} socket closed ${code} ${reason}`));
  ws.on("open", ({ protocol }) => {
    console.log(`${log.stamp()} connected (auth=${args.auth}, subprotocol=${protocol ?? "none"}, HTTP ${ws.handshakeStatus})`);
    const delegation = mode === "responses"
      ? {
        type: "responses",
        responses: {
          model: String(args.backend),
          instructions: BACKEND_INSTRUCTIONS,
          tools: TOOLS,
          tool_choice: "auto",
          ...(args.reasoning ? { reasoning: { effort: String(args.reasoning) } } : {}),
        },
      }
      : { type: "client" };
    send({
      type: "session.start",
      event_id: "start_1",
      session: {
        model: LIVE_MODEL,
        instructions: PERSONA,
        audio: { format: { type: "audio/pcm", rate: PCM_RATE }, output: { voice: args.voice } },
        delegation,
        ...(seededInput ? { input: seededInput } : {}),
      },
    });
  });
  ws.on("message", (raw) => {
    let event;
    try { event = JSON.parse(String(raw)); } catch { return; }
    const type = String(event.type ?? "");
    if (type === "session.started" && !state.started) {
      state.started = true;
      log.mark();
      log.print("in", event);
      console.log(`  session.delegation snapshot: ${JSON.stringify(event.session?.delegation ?? null).slice(0, 400)}`);
      return;
    }
    if (type === "session.output_audio.delta") {
      const at = log.now();
      const previous = state.outputDeltas[state.outputDeltas.length - 1];
      state.outputDeltas.push(at);
      state.outputBytes += Buffer.from(String(event.delta ?? ""), "base64").length;
      if (previous === undefined || at - previous > QUIET_MS) log.print("in", event, "(burst start)");
      else log.record("in", event);
      return;
    }
    log.print("in", event);
    if (type === "session.input_transcript.delta") {
      state.inputTranscript += String(event.delta ?? "");
      segmenter.push(event);
    } else if (type === "session.output_transcript.delta") {
      state.outputTranscript += String(event.delta ?? "");
    } else if (type === "session.delegation.created") {
      state.delegations.push({ at: log.now(), id: event.delegation?.id ?? null, target: event.delegation?.target ?? null, offsetMs: event.offset_ms ?? null });
      if (mode === "client" || event.delegation?.target === "client") void handleClientDelegation(event);
    } else if (type === "response.event") {
      const inner = event.event ?? {};
      state.responseEvents.push({ at: log.now(), innerType: String(inner.type ?? "?"), delegationId: event.delegation_id ?? null });
      if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
        void handleFunctionCall(inner.item, event.delegation_id ?? null);
      }
    } else if (type === "session.usage.updated") {
      state.usageSnapshots.push({ at: log.now(), usage: event.usage, context_window: event.context_window });
    } else if (type === "error") {
      state.errors.push(event.error ?? event);
    } else if (type === "session.closed") {
      state.closedEvent = event;
    } else if (type === "session.commentary.appended") {
      const entry = state.commentaries.find((c) => c.eventId === event.client_event_id);
      if (entry) entry.ackAt = log.now();
    }
  });

  async function handleFunctionCall(item, delegationId) {
    const call = { at: log.now(), name: String(item.name ?? ""), callId: String(item.call_id ?? ""), arguments: String(item.arguments ?? ""), delegationId, answeredAt: null };
    state.functionCalls.push(call);
    console.log(`${log.stamp()}    [tool] ${call.name}(${call.arguments}) call_id=${call.callId}`);
    await sleep(120); // stand-in for the local SQLite memory search
    const output = localToolResult(call.name, call.arguments);
    send({ type: "response.item.create", event_id: `tool_result_${state.functionCalls.length}`, item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(output) } });
    send({ type: "response.create", event_id: `continue_${state.functionCalls.length}` });
    call.answeredAt = log.now();
  }

  async function handleClientDelegation(event) {
    const delegationId = event.delegation?.id ?? null;
    console.log(`${log.stamp()}    [client-delegation] id=${delegationId} transcript so far: ${JSON.stringify(state.inputTranscript.trim())}`);
    await sleep(150); // stand-in for the local agent / sidecar
    const answer = localAgentAnswer(state.inputTranscript);
    const eventId = `commentary_${state.commentaries.length + 1}`;
    state.commentaries.push({ at: log.now(), eventId, delegationId, content: answer.content, tool: answer.tool, ackAt: null });
    send({ type: "session.commentary.append", event_id: eventId, delegation_id: delegationId, content: answer.content });
  }

  const opened = await waitFor(() => state.started, 15_000);
  if (!opened) {
    console.error(`session.started never arrived for mode ${mode}; errors: ${JSON.stringify(state.errors)}`);
    ws.destroy();
    return { mode, failed: true, errors: state.errors };
  }
  uplink.start();
  const turns = [];

  async function observeTurn(label, startedAt, endedAt) {
    const before = {
      delegations: state.delegations.length,
      functionCalls: state.functionCalls.length,
      commentaries: state.commentaries.length,
      responseEvents: state.responseEvents.length,
    };
    // Wait for the reply to finish: output audio then QUIET_MS of nothing. A
    // delegation started in this turn is "settled" only once the backend's
    // response lifecycle completed after every function call was answered
    // (responses mode) or our commentary was acknowledged (client mode); the
    // voice model may speak filler before that, so quiet alone is not enough.
    const gotOutput = await waitFor(() => state.outputDeltas.some((at) => at >= endedAt), PHASE_TIMEOUT_MS);
    const delegationSettled = () => {
      const delegation = state.delegations.slice(before.delegations)[0];
      if (!delegation) return true;
      if (delegation.target === "client" || mode === "client") {
        const commentary = state.commentaries.slice(before.commentaries)[0];
        return Boolean(commentary && commentary.ackAt !== null);
      }
      const calls = state.functionCalls.slice(before.functionCalls);
      if (calls.some((call) => call.answeredAt === null)) return false;
      const lastAnswer = calls.length ? Math.max(...calls.map((call) => call.answeredAt)) : delegation.at;
      return state.responseEvents.some((e) => e.at >= lastAnswer && /^response\.(completed|done|failed|incomplete|cancelled)$/.test(e.innerType));
    };
    let settledAt = null;
    await waitFor(() => {
      if (!gotOutput) return false;
      if (settledAt === null && delegationSettled()) settledAt = log.now();
      if (settledAt === null) return false;
      const last = state.outputDeltas[state.outputDeltas.length - 1] ?? 0;
      // Quiet is measured from the later of the last audio and the settle moment,
      // because the spoken result can only start after the backend finished.
      return log.now() - Math.max(last, settledAt) >= QUIET_MS;
    }, PHASE_TIMEOUT_MS);
    const delegation = state.delegations.slice(before.delegations)[0] ?? null;
    const call = state.functionCalls.slice(before.functionCalls)[0] ?? null;
    const commentary = state.commentaries.slice(before.commentaries)[0] ?? null;
    const innerTypes = [...new Set(state.responseEvents.slice(before.responseEvents).map((e) => e.innerType))];
    const firstOutput = state.outputDeltas.find((at) => at >= endedAt) ?? null;
    const resultAt = call?.answeredAt ?? commentary?.at ?? null;
    const firstOutputAfterResult = resultAt === null ? null : (state.outputDeltas.find((at) => at >= resultAt) ?? null);
    const summary = {
      label,
      delegated: Boolean(delegation) || Boolean(call),
      delegationCreatedAfterClipEnd: delegation ? delegation.at - endedAt : null,
      delegationTarget: delegation?.target ?? null,
      responseEventInnerTypes: innerTypes,
      functionCall: call ? { name: call.name, arguments: call.arguments, receivedAfterClipEnd: call.at - endedAt } : null,
      commentary: commentary ? { content: commentary.content, sentAfterClipEnd: commentary.at - endedAt, ackAfterSend: commentary.ackAt === null ? null : commentary.ackAt - commentary.at } : null,
      firstOutputAudioAfterClipEnd: firstOutput === null ? null : firstOutput - endedAt,
      modelSpokeBeforeResult: resultAt !== null && firstOutput !== null ? firstOutput < resultAt : null,
      firstSpokenResultAfterToolOutput: firstOutputAfterResult === null ? null : firstOutputAfterResult - resultAt,
      firstSpokenResultAfterClipEnd: firstOutputAfterResult === null ? null : firstOutputAfterResult - endedAt,
    };
    turns.push(summary);
    console.log(`${log.stamp()}    turn: ${JSON.stringify(summary)}`);
  }

  if (args.tts) {
    for (const utterance of UTTERANCES) {
      const clip = await ttsClip(apiKey, utterance.text, { instructions: "Speak like a person talking to a small robot on a desk, from about a metre away." });
      console.log(`\n${log.stamp()} ## uplink: ${JSON.stringify(utterance.text)} (${pcmDurationMs(clip.pcm)}ms${clip.cached ? ", cached" : ""}); expecting ${utterance.expectTool}`);
      const sent = await uplink.queue(clip.pcm, utterance.text);
      console.log(`${log.stamp()}    clip fully sent (ended ${fmt(sent.endedAt)})`);
      await observeTurn(utterance.text, sent.startedAt, sent.endedAt);
      segmenter.flush("turn-end");
      await sleep(800);
    }
  } else {
    console.log(`\n${log.stamp()} ## seeded input history: ${JSON.stringify(UTTERANCES[0].text)} (no --tts: only the first utterance can be exercised)`);
    await observeTurn(`${UTTERANCES[0].text} (seeded)`, 0, 0);
  }

  await sleep(1_000);
  uplink.stop();
  send({ type: "session.close", event_id: "close_1" });
  await waitFor(() => state.closedEvent !== null, 15_000);

  console.log(`\n=== ${mode} summary ===`);
  for (const turn of turns) {
    console.log(`- ${JSON.stringify(turn.label)}: delegated=${turn.delegated}; delegation.created ${fmt(turn.delegationCreatedAfterClipEnd)} after user stopped; ${turn.functionCall ? `function ${turn.functionCall.name}(${turn.functionCall.arguments}) ${fmt(turn.functionCall.receivedAfterClipEnd)} after user stopped; ` : ""}${turn.commentary ? `commentary sent ${fmt(turn.commentary.sentAfterClipEnd)}, acked ${fmt(turn.commentary.ackAfterSend)} later; ` : ""}first audio ${fmt(turn.firstOutputAudioAfterClipEnd)} (spoke before result: ${turn.modelSpokeBeforeResult}); first spoken result ${fmt(turn.firstSpokenResultAfterToolOutput)} after tool output = ${fmt(turn.firstSpokenResultAfterClipEnd)} after user stopped; response.event inner types: ${turn.responseEventInnerTypes.join(",") || "none"}`);
  }
  console.log(`user transcript: ${JSON.stringify(state.inputTranscript.trim())}`);
  console.log(`assistant transcript: ${JSON.stringify(state.outputTranscript.trim())}`);
  console.log(`output audio: ${fmt(state.outputBytes / 2 / PCM_RATE * 1000)}; usage snapshots: ${JSON.stringify(state.usageSnapshots)}; session.closed: ${JSON.stringify(state.closedEvent ? { reason: state.closedEvent.reason, usage: state.closedEvent.usage } : null)}`);
  console.log(`errors: ${JSON.stringify(state.errors)}`);
  console.log("event counts:\n" + log.summary());
  console.log("first envelope of each server event type:\n" + log.envelopes());
  const path = log.save(`delegation-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(`event log: ${path}`);
  ws.close();
  await sleep(200);
  return { mode, turns, errors: state.errors };
}

const all = [];
for (const mode of modes) {
  try {
    all.push(await runMode(mode));
  } catch (error) {
    console.error(`mode ${mode} failed: ${error.message}`);
    all.push({ mode, failed: true, error: error.message });
  }
}
console.log("\n=== cross-mode ===");
for (const result of all) {
  if (result.failed) { console.log(`${result.mode}: FAILED ${result.error ?? JSON.stringify(result.errors)}`); continue; }
  const delegated = result.turns.filter((t) => t.delegated).length;
  const spoken = result.turns.map((t) => t.firstSpokenResultAfterClipEnd).filter((v) => v !== null);
  console.log(`${result.mode}: delegated ${delegated}/${result.turns.length} turns; first spoken result after user stopped: ${spoken.map(fmt).join(", ") || "n/a"}; errors: ${result.errors.length}`);
}
process.exit(0);
