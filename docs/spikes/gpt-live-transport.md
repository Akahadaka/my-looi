# Spike: GPT-Live-1 as a transport for My LOOI

Status: assessment written 2026-09-12 from the GPT-Live documentation and the app's
current Realtime PCM path; the spike scripts have been dry-run against a local mock of
the documented event shapes but **not yet against the real API** (no key in the
authoring environment). Every verdict below names the script output that confirms or
overturns it. Run the scripts first, then re-read the verdicts.

Branch: `spike/gpt-live-transport`. Scripts: `scripts/spikes/gpt-live-transport.mjs`,
`scripts/spikes/gpt-live-delegation.mjs`, helpers in `scripts/lib/gpt-live-spike.mjs`.

## How to run

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts

# 1. Transport: connect, persona, real user speech via TTS, barge-in, safety-command timing.
OPENAI_API_KEY=sk-... pnpm spike:gpt-live --tts
# Variants: --auth subprotocol (does Live accept the Realtime-style subprotocol?),
#           --voice quartz, --gap 500, --barge-in-delay 1500, --audio my-clip.wav,
#           no --tts = silence + 440 Hz tone only.

# 2. Delegation: responses mode (gpt-5.6-luna) then client mode, three tool utterances each.
OPENAI_API_KEY=sk-... pnpm spike:gpt-live-delegation --tts
# Variants: --mode responses --backend gpt-5.6-terra, --reasoning low, --mode client.
```

Both print every event with a timestamp relative to `session.started`, a per-phase
summary, the first full envelope of each server event type, and write a JSONL log under
`tmp/spikes/gpt-live/`. TTS clips are cached in `tmp/spikes/gpt-live/tts/`. Cost of one
full run is a few cents (about 1.5 minutes of Live session plus a handful of short TTS
and backend calls).

## What GPT-Live is, in this app's terms

| Realtime PCM today (`src/voice/realtime-pcm-conversation.ts`) | GPT-Live-1 |
| --- | --- |
| `wss://api.openai.com/v1/realtime?model=…`, ephemeral client secret minted from the SecureStore key, passed as `openai-insecure-api-key.<secret>` subprotocol | `wss://api.openai.com/v1/live/sessions`, `Authorization: Bearer <key>` header documented; no client-secret endpoint documented for Live |
| `session.update` with instructions, tools, VAD, transcription, noise reduction | `session.start` with `model`, `instructions`, `audio.format`/`audio.output.voice`, optional `delegation`, optional seeded `input` history. `model`, `instructions`, `input`, `audio` are immutable after start |
| `input_audio_buffer.append` (24 kHz PCM16), server VAD decides turns | `session.input_audio.append`, continuous; the model decides when to speak. No VAD config, no commit |
| `input_audio_buffer.speech_started/stopped` | none |
| `conversation.item.input_audio_transcription.completed` (item id, full text) | `session.input_transcript.delta` with `delta`, `start_ms`, `end_ms`; no item id, no completed event |
| `response.created` / `response.output_audio.delta` / `response.output_audio.done` / `response.done` | `session.output_audio.delta` only; no start/done/response envelope |
| `response.output_audio_transcript.delta` | `session.output_transcript.delta` (same shape as input transcript) |
| `conversation.item.truncate` after local playback stop | none; the model listens while speaking (full duplex). `session.input_audio.mute/unmute` exist but "muting input does not stop … generated speech" |
| `response.cancel` | none for speech; backend work is not cancelled by interruption either |
| in-session `tools` + `function_call_output` + `response.create` | `delegation.responses.tools`; calls arrive as `response.event` wrapping Responses stream events; results via `response.item.create` + `response.create`. Or `delegation: {type: "client"}` → `session.delegation.created` (metadata only) and `session.commentary.append` |
| out-of-band `response.create` with `conversation: "none"` (choreography) | none |
| `rate_limits.updated`, per-response usage tokens | `session.usage.updated` `{usage.seconds, context_window.usage_ratio}` snapshots; `session.closed` `{reason, usage}` |
| audio-token pricing | $0.05 per session minute, billed per second, plus backend model tokens |

## Verdicts

Legend: **works** – no app change beyond the transport; **workaround** – achievable with
extra client logic and an accepted degradation; **blocker** – not achievable with the
documented API; the test that decides it is named in each section.

### 1. Local safety commands (addressed-command parser, emergency "stop")

Verdict: **workaround** for addressed commands, **blocker-until-measured** for emergency
stop.

Today `parseRealtimePhysicalCommand` runs on the completed input transcription of a
whole user item, and a hit cancels the model response and truncates playback before
executing through the safety controller. GPT-Live gives neither a turn boundary nor an
item: only `session.input_transcript.delta` fragments with `start_ms`/`end_ms`, and the
docs say "do not … treat a fragment as a complete user turn".

Segmentation the app would need (implemented in the spike as `TranscriptSegmenter`):

- Accumulate deltas; close a turn after N ms without a new delta (spike default 700 ms).
  The `end_ms` field lets the gap be measured in audio time rather than wall time.
- Run the parser on the closed turn for addressed commands ("LOOI, turn around").
- Run `containsEmergencyStopWord` on every delta incrementally, not on the closed turn:
  STOP must not wait for the gap.
- Because the parser cannot pre-empt the model, the model will usually already be
  speaking ("Sure!") when the local command fires. The app must then stop local playback
  and, ideally, tell the model what happened with `session.commentary.append` or
  `session.instructions.append` ("the app executed: turn around; do not describe it").

What decides it (transport spike, phases B and C):

- Phase C prints `localCommandParsedAfterClipEnd` (parser time after the user stopped)
  and `modelFirstOutputAfterClipEnd`; `modelSpokeBeforeLocalParse: true` means every
  command will be preceded by the start of a spoken reply that the app must cut.
- Phase B prints `localStopDetectedAfterStopEnd` and its `source` (`incremental` means
  the transcript delta for "Stop" arrived before any gap; `never` means the transcript
  never contained the word, which would be the blocker).
- The far-field transcript quality of Live is unknown. Today the app sends a
  transcription `prompt` listing the robot's names and STT variants to
  `gpt-4o-mini-transcribe`; Live has no transcription configuration at all, so the
  address aliases in `explicit-robot-command.ts` (BUILTIN_ADDRESS_ALIASES) become the
  only defence against "Louie"/"Луи" variants. Compare the printed
  `user transcript` with what was said.

Acceptable emergency-stop latency: the current path already includes server VAD
`silence_duration_ms: 1000` plus transcription, so STOP today lands roughly 1.2–1.8 s
after the word is spoken; the incremental Live path could be faster (no silence wait),
provided Live's transcript deltas keep up during its own speech. If phase B shows deltas
only after the model finishes its sentence, STOP is a blocker for the PCM-only design and
the Vosk local STOP recogniser (`scripts/vosk-emergency-stop-behavior.test.mjs`) would
have to take the microphone back, which the PCM path was specifically built to avoid.

### 2. Barge-in and playback truncation without item ids

Verdict: **workaround**, with a conversational regression.

Today the app stops the AudioTrack on `input_audio_buffer.speech_started` and sends
`conversation.item.truncate` with the played duration so the model's context matches
what was heard. GPT-Live cannot be told what was heard. It streams audio faster than real
time (the spike prints wall-clock delivery versus audio length), so when the user
interrupts, the app has buffered speech the model believes it delivered.

Client design:

- The app keeps owning playback (it already does) and must detect user speech itself to
  stop playback: Live has no `speech_started`. Options are the existing Silero VAD
  (`src/voice/vad-service.ts`) on the AEC-cleaned capture, or the first
  `session.input_transcript.delta` after output started (later, but free). The transport
  spike measures the latter: phase B `localStopDetectedAfterStopStart`.
- Whether the model itself stops is measured by `outputAudioMsAfterStopStarted` and
  `lastOutputDeltaAfterStopStart` in phase B. The prompting guide's "Interruption policy:
  Stop speaking when the user interrupts" is a behavioural instruction, not a guarantee.
- The context mismatch (model thinks it said the whole sentence) can be softened with a
  `session.instructions.append` such as "The user interrupted you after: '<played
  transcript prefix>'", using the played duration and `session.output_transcript.delta`
  timestamps to estimate the prefix. That is a heuristic, not the exact truncation the
  Realtime path has.

### 3. Memory and language tools via delegation

Verdict: **works (responses mode)** with a latency and cost question; **workaround
(client mode)**; both only "when the model decides".

- `search_memory`, `remember`, `set_language_preferences` map directly onto
  `delegation.responses.tools`; the function-call round trip is
  `response.event{response.output_item.done, item.type=function_call}` →
  `response.item.create{function_call_output}` → `response.create`. The app already has
  this logic in `executeToolCall`; only the envelopes change. The spike prints the exact
  inner event types seen and whether `response.output_item.done` carries `call_id`,
  `name`, `arguments` as the docs promise.
- The catch is that the backend runs in OpenAI's cloud but the memory lives in the phone's
  SQLite, so every `search_memory` is: voice model decides to delegate → backend model
  starts → backend calls the function → phone answers → backend continues → voice model
  paraphrases. The spike's `firstSpokenResultAfterClipEnd` is the number to compare with
  today's single hop (typically 1.5–3 s for a tool turn on gpt-realtime-2.1-mini).
- `set_language_preferences` today also re-sends the session instructions with the new
  language. Live's `instructions` are immutable after `session.start`; the replacement is
  `session.instructions.append("Reply in Ukrainian from now on")` (≤ 500 tokens) plus
  updating `delegation.responses.instructions` via `session.update`. The delegation spike
  prints whether the voice model switches language after the tool result.
- Client mode avoids the backend model entirely: on `session.delegation.created` the app
  runs the memory lookup locally and answers with `session.commentary.append`. But the
  event carries no task text, so the app must decide from its own transcript segmentation
  what was asked, and the voice model will "paraphrase the appended text" rather than
  reason about it. It is cheaper and one hop shorter; the spike's client-mode summary shows
  `delegationCreatedAfterClipEnd` and `firstSpokenResultAfterClipEnd`.
- Which mode: responses with `gpt-5.6-luna` for correctness of `remember` (it needs a
  model to decide what to store, which today the Realtime model does inline); client mode
  for `search_memory` speed if the delegation event proves to arrive early enough. Both
  cannot be mixed: "Delegation mode cannot change mid-session".
- Delegation is also the only path to `remember` being invoked automatically for stated
  facts. If the voice model does not delegate for "my favourite colour is green", the
  natural-memory extraction has to move to a client-side pass over the transcript
  (`scripts/natural-memory-extraction-behavior.test.mjs` covers that older path).

### 4. Far-field behaviour

Verdict: **workaround / unknown** – the controls that exist are all on the phone.

Today: `turn_detection.threshold: 0.15`, `prefix_padding_ms: 500`,
`silence_duration_ms: 1000`, `noise_reduction: far_field`, plus `REALTIME_UPLINK_GAIN =
2.0` after Android AEC (`src/voice/realtime-config.ts`). Live exposes none of the server
side controls. What remains:

- Uplink gain and any local noise suppression before `session.input_audio.append`
  (the existing gain stage carries over unchanged).
- `session.input_audio.mute` while the robot's own motors or the choreography are loud,
  or while the app is executing a local command, so the model does not hear itself.
- Prompting ("Backchannel policy") to reduce the model reacting to noise.
- The transport spike's tone probe (phase D) reports whether pure tone produces output
  speech or transcript; if a 440 Hz tone makes LOOI talk, background noise on a desk
  will too, and the app would need local VAD gating (mute when no local speech
  detected), which reintroduces a local VAD threshold to tune.

### 5. Choreography source without out-of-band responses

Verdict: **workaround**; expected latency worse than today's ~400 ms after first audio.

The player (`src/choreography/choreography-player.ts`, feat/expressive-choreography) is
transport-agnostic: it needs `startTurn`, `setPlan`, `onPlaybackStarted`,
`onTranscriptDelta`, `onPlaybackFinished`, `cancel`. Only the plan source is lost.

- Sidecar Responses call per user turn: when the segmenter closes a user turn (or, better,
  on the first `session.output_transcript.delta`, which carries what LOOI is about to
  say), POST `/v1/responses` with `gpt-5.6-luna`, the choreography instructions, the user
  turn and the reply prefix, `max_output_tokens` ~120. Expected: 700–1500 ms end to end,
  so plans arrive at 25–50 % of a short reply instead of 0.07–0.18 measured today; the
  player's opener beat and fallback already cover this window
  (`FALLBACK_TAKEOVER_FRACTION = 0.45`). Cost ≈ $0.0005 per turn on luna.
- Backend tool: with responses delegation, add a `choreograph` tool the backend calls, or
  ask the backend to append a JSON plan to its text; but delegation only happens when the
  voice model decides, so most chit-chat turns would get no plan. Not a primary source.
- `startTurn` trigger: today it is the server VAD speech-stopped event; on Live it becomes
  the segmenter's closed turn or the first output transcript delta. `onPlaybackStarted`
  and `onPlaybackFinished` stay app-side (the app owns the AudioTrack) and are unaffected.

### 6. Cost per conversation minute

Reference: `estimateRealtimeConversationCost` in `src/openai/realtime-models.ts` assumes
30 s user + 30 s robot speech per minute, 10 input and 20 output audio tokens per second.

| Path | Speech minute (30 s + 30 s) | Idle listening minute | Notes |
| --- | ---: | ---: | --- |
| gpt-realtime-2.1-mini (app default) | $0.015 audio (+ ≈$0.002 transcription, + text tokens for instructions/tools) ≈ **$0.02** | ≈ $0 (VAD-trimmed silence is not committed) | matches the Settings label "≈ $0.02/min" |
| gpt-realtime-2.1 | $0.048 audio (+ same extras) ≈ **$0.05** | ≈ $0 | |
| gpt-live-1 | **$0.05** flat | **$0.05** flat | billed per second while the session is open |
| gpt-live-1 + luna backend | $0.05 + ≈$0.0005 per delegated turn | $0.05 | luna $0.20/M in, $1.20/M out; ~2k tokens context per delegation |
| gpt-live-1 + terra backend | $0.05 + ≈$0.005 per delegated turn | $0.05 | terra $2/M in, $12/M out |
| choreography sidecar (luna) | + ≈$0.0005 per user turn | – | today's out-of-band mini text tokens are of the same order |

Per speaking minute Live is ~2.5–3× the mini model and about equal to the full
gpt-realtime-2.1. The bigger difference is idle time: My LOOI keeps the session open while
listening after a wake, and Live bills every second of it. A ten-minute session with two
minutes of talk is ≈ $0.04 on mini and $0.50 on Live. `session.usage.updated` /
`session.closed.usage.seconds` (printed by both spikes) are the numbers to meter in the
diagnostics store if Live ships.

### 7. Migration size

Files that change or appear (Realtime PCM stays as a selectable mode throughout):

| Area | Files | Change |
| --- | --- | --- |
| Transport | new `src/voice/gpt-live-conversation.ts` (≈ 700–900 lines, modelled on `realtime-pcm-conversation.ts`) | session lifecycle, paced uplink reusing the native 16 kHz capture + resampler, AudioTrack playback, transcript segmentation, incremental STOP, delegation/tool handling, usage metering, mute during local commands |
| Config | new `src/voice/gpt-live-config.ts`; `src/voice/realtime-config.ts` (export `buildRealtimeTools`) | `session.start` builder; persona split into conversation instructions vs `delegation.responses.instructions`; tool schemas shared |
| Auth | `src/openai/openai-api-key.ts` | Bearer-header WebSocket (the retired `createOpenAiRealtimeWebSocket` already shows RN's `headers` option); note the standard key rides the long-lived socket because Live has no client-secret endpoint |
| Model list / pricing | `src/openai/realtime-models.ts` | `isRealtimeConversationModelId` currently excludes `gpt-live-1`; add flat per-minute pricing and name formatting |
| Mode plumbing | `src/store/user.ts` (`ConversationMode` = "realtime" \| "realtime_pcm" → add "live"; `isRealtimeConversationMode`, `isPcmRealtimeMode`), `src/perceivers/voice-perceiver.ts` (start/stop/interrupt routing at ~lines 269, 323, 373, 999), `src/core/app-bootstrap.ts`, `src/ui/RobotFace.tsx`, `src/ui/ConversationOverlay.tsx` | mostly via the two helpers; readiness states reused |
| Settings / i18n | `app/(tabs)/settings.tsx` (mode choices at ~470–478, model list 504–521), `src/i18n/ui-strings.ts` | third mode choice; hide the Realtime model selector and show the backend model selector for Live; voice list differs (quartz…cinder vs alloy…cedar) |
| Safety | `src/voice/realtime-physical-command.ts` (unchanged), new segmenter module | incremental STOP + gap-closed turns feeding the existing parser |
| Choreography | `src/choreography/choreography-channel.ts` (sidecar request builder), player unchanged | see §5 |
| Docs / tests | `docs/architecture.md`, `FEATURES.md`, one `v2.1.1xx-gpt-live-*-regression.test.mjs`, `scripts/anti-regression-check.mjs` guard list | |

Estimate (one engineer, device in hand):

| Phase | Scope | Days |
| --- | --- | ---: |
| 0 | Run both spikes, decide on §1 and §2 verdicts, pick delegation mode | 0.5 |
| 1 | `live` mode behind Settings: transport, playback, transcripts to the conversation store, usage metering; no tools, no commands | 3 |
| 2 | Safety: segmenter, incremental STOP, local command execution with playback cut and `instructions.append` acknowledgement; device tests with the robot at 1–2 m | 2–3 |
| 3 | Delegation: memory + language tools in responses mode, backend model selector, cost label | 1.5 |
| 4 | Barge-in: local speech detection to stop playback, interruption context append, mute during motor noise | 1.5 |
| 5 | Choreography sidecar source + player wiring | 1–1.5 |
| 6 | Regression test, docs, release notes | 1 |
| | **Total** | **≈ 10–12 days** |

Phases 1–3 are shippable as an experimental mode; phases 4–5 decide whether it can
become the default. Realtime PCM remains the default until §1 and §4 are proven on the
desk, and the `conversationMode` preference keeps both selectable indefinitely (the
WebRTC path shows the repo already tolerates three transports).

## Live results (2026-09-13, real API, `--tts`)

Runs: `pnpm spike:gpt-live --tts` (default 700 ms gap), the same with `--gap 1500`,
`--auth subprotocol`, and `spike:gpt-live-delegation --mode client --tts`. Responses-mode
delegation could not run: the key lacks the `api.responses.write` scope. Logs are under
`tmp/spikes/gpt-live/` (untracked).

| Measure | Result |
| --- | --- |
| Auth | `openai-insecure-api-key.*` subprotocol → HTTP 401 "provide Bearer auth". Header only. |
| First input transcript delta | ~1.3–1.4 s after the user starts speaking |
| Answer latency | output transcript ~0.7 s after the user's clip ends; the model also speaks *during* the user's utterance (backchannels ~5 s before clip end) |
| Transcripts while speaking | yes: "Stop" was transcribed mid-output |
| Emergency STOP (local parser, incremental) | fired 478–527 ms after the word ended (~1.9 s after it started) |
| Model output after "Stop!" | 3.8–5.5 s of audio kept arriving, last delta ~3.7 s after stop started. The model did **not** stop on its own; local playback flush is mandatory |
| "LOOI, turn around", 700 ms gap | split into "Louie, turn" + "around" (transcript deltas arrive with >700 ms wall-clock gaps mid-utterance); parser never fired |
| "LOOI, turn around", 1500 ms gap | parsed 969 ms after clip end; model had already started replying ("Turning around!") ~3 s earlier |
| Tone probe | model spoke in reply to a 440 Hz tone; no transcript |
| Mute round trip | ack 24 ms; unmute acked |
| Usage | per-second `session.usage.updated` every 15 s; 83 s session billed as 83 s; context usage ratio 0.02 after 83 s |
| Client delegation | **0 of 3** turns delegated (memory question, "remember", language switch). The model answered by itself with first audio 60–95 ms after clip end. No `session.delegation.created` ever arrived |

### What this changes in the verdicts

- **Safety commands: workaround confirmed, with conditions.** Segment on audio-time
  (`start_ms`/`end_ms`) or parse a sliding window on every delta rather than closing turns on
  wall-clock gaps; 700 ms wall-clock splits commands. Expect ~1 s from end of command to
  execution. STOP must flush local playback because the model keeps streaming.
- **Barge-in: workaround, weaker than Realtime.** No truncation and the server keeps sending
  audio for seconds after an interruption. The app must drop audio locally and accept that the
  conversation context still contains the unheard reply.
- **Full-duplex changes the command flow.** The model starts replying to "LOOI, turn around"
  before the command is fully spoken, so a local command always races a spoken reply. The
  parser wins on the robot (nothing moves from speech) but the user hears the model react
  first.
- **Memory/language tools via client delegation: blocker as tested.** With the delegation
  policy in `session.instructions`, the model never delegated. Either the prompt is wrong
  for this model, or client mode is meant for rarer, heavier tasks. Responses-mode delegation
  is untested (scope). Until one of them works, memory recall, remember, and language
  switching have no path on GPT-Live.
- **Cost: confirmed per-second billing of the whole session, including silence.**

### Found in passing (Realtime path, exists today)

The addressed-command parser matched "Louie, tell me a long story about a robot who learns
to dance" as `{kind: "dance"}`: verb regexes match anywhere in the command after the
address. Filed in the planning repo suggestions.

## Open questions the real run answers

1. Does Live's `session.input_transcript.delta` keep flowing while the model is speaking,
   and how many milliseconds after "Stop!" does the word appear? (transport phase B)
2. Does the Live WebSocket accept the `openai-insecure-api-key.*` subprotocol, or only the
   Bearer header? The phone has no backend, and a standard key on a long-lived socket is
   the alternative. (`--auth subprotocol`)
3. How often does the voice model delegate for memory questions and stated facts, and what
   is the first-spoken-result latency in responses mode with luna versus client mode?
   (delegation spike summaries)
4. Does a pure tone or desk noise make the model speak or transcribe? (phase D)
5. Is output audio delivered faster than real time, and by how much? That sets the size
   of the "already buffered but not heard" window on interruption. (phase A wall-clock
   versus audio length)
