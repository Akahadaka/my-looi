# GPT-Live-1 transport: handover (on ice, 2026-09-13)

**Decision (Andrew, 2026-09-13):** GPT-Live-1 becomes a selectable model option next to
Realtime PCM, with the expressive choreography feature working on it, but only after the
choreography plan on `feat/expressive-choreography` (PR #2) is finished. Until then this
work is parked. Nothing here is merged or wired into the app.

## Where everything is

| Thing | Location |
| --- | --- |
| Branch / PR | `spike/gpt-live-transport`, draft PR #3 against `develop` |
| Worktree | `../my-looi.worktrees/spike-gpt-live-transport` (leave in place while the PR is open) |
| Assessment with live numbers | `docs/spikes/gpt-live-transport.md` |
| Transport spike | `pnpm spike:gpt-live [--tts] [--gap 1500] [--auth header\|subprotocol] [--audio file]` |
| Delegation spike | `pnpm spike:gpt-live-delegation --mode responses\|client\|both --tts [--backend gpt-5.6-terra]` |
| Spike library (WS client, TTS cache, segmenter, event log) | `scripts/lib/gpt-live-spike.mjs` |
| Event logs from the real runs | `tmp/spikes/gpt-live/*.jsonl` (untracked, in the worktree) |
| Session notes | `../my-looi.planning/spike/gpt-live-transport/` (PLANNING, SUMMARY, SUGGESTIONS, PROMPT) |
| API key for spikes | `../my-looi/.openai-api-key` (local exclude, never committed; needs `api.responses.write` for responses-mode delegation) |

## What is proven on the real API

- Bearer header auth only; the Realtime subprotocol form returns 401. React Native's
  WebSocket can send headers; the standard key will ride the long-lived socket.
- Answer latency: output transcript ~0.7 s after the user stops. Input transcript deltas
  lag ~1.3 s and keep flowing while the model speaks.
- Emergency STOP via the local parser fires ~0.5 s after the word ends. The model keeps
  streaming 4–5 s of audio afterwards: **local playback flush is mandatory** and there is
  no server-side truncation.
- Addressed commands: closing turns on a 700 ms wall-clock gap splits "LOOI, turn around";
  1.5 s works (~1 s to execution). Use the `start_ms`/`end_ms` on transcript deltas
  (audio time) or a sliding-window parse instead of wall-clock gaps.
- Full duplex: the model starts replying to a command before it is finished ("Turning
  around!" ~3 s before the parser fires). Only the parser moves the robot; the user hears
  the model react first.
- Delegation works in both modes, 3/3 tool utterances each, with correct arguments.
  Responses mode (`gpt-5.6-terra`): first spoken result 1.3–1.6 s after the user stops.
  Client mode: 0.7–0.9 s, request reconstructed from transcript deltas. The model speaks a
  filler before the result in both modes.
- Usage: `session.usage.updated` every 15 s and `session.closed.usage.seconds`; billed per
  second for the whole session, silence included (≈ $0.50 for a 10-minute session with 2
  minutes of talk, vs ≈ $0.04 on gpt-realtime-2.1-mini).
- The model replies to a bare 440 Hz tone; mute/unmute round trip ~25 ms.

## What is not proven

- Far-field behaviour at 1–2 m with the robot's motors running (no VAD threshold exists;
  only mute and prompt policy).
- Barge-in by a real person over loudspeaker playback with the phone's AEC.
- Delegation reliability beyond three canonical utterances, and behaviour when the
  backend is slow (>2 s).
- Ukrainian/Russian recognition quality (all runs were English TTS).
- Any on-device behaviour: nothing has run on the phone.

## Design decisions to carry into the implementation

1. **Mode plumbing:** `conversationMode` gains `"live"`; Realtime PCM stays default.
   Settings hides the Realtime model picker for Live and shows a backend-model choice.
2. **Delegation mode:** client mode. It keeps memory on the phone (local database), is
   faster to first spoken result, and needs no backend model billing. Reconstruct the
   request from the last closed user turn plus recent transcript.
3. **Safety:** segment user speech on audio time; run the incremental STOP check on every
   delta; on any local command, flush local playback, mute input for the motion duration,
   and append a one-line `session.instructions.append` acknowledgement so the model does
   not re-answer.
4. **Barge-in:** local speech detection (the existing capture RMS window) stops playback;
   the model's context will still contain the unheard reply. Accept it.
5. **Choreography source:** no out-of-band responses exist. Per closed user turn, make a
   sidecar Responses call from the phone with the last few transcript lines and the same
   choreography instructions (`buildChoreographyInstructions`) to a cheap text model, and
   hand the parsed plan to the unchanged player. Expected latency similar to today's
   ~400 ms after first audio; the fallback generator covers the rest. `onPlaybackStarted`
   and `onPlaybackFinished` come from the local PCM player, `onTranscriptDelta` from
   `session.output_transcript.delta`, `startTurn` from the segmenter.
6. **Metering:** store `usage.seconds` per session in diagnostics and show a per-minute
   label in Settings; Live's idle billing is the main cost risk.
7. **Prompt:** keep the short persona plus the three-label delegation policy from the
   spike; keep the full tool descriptions on the phone side (client mode).

## Plan when resumed (from the assessment, ≈ 10–12 days)

0. Re-run both spikes to confirm nothing changed in the API. 0.5 d
1. `live` mode behind Settings: transport, playback, transcripts, usage. 3 d
2. Safety: segmenter, incremental STOP, local commands with playback cut. 2–3 d
3. Client delegation: memory + language tools. 1.5 d
4. Barge-in and motor-noise muting. 1.5 d
5. Choreography sidecar + player wiring. 1–1.5 d
6. Regression test, docs, release notes. 1 d

## Gotchas found the hard way

- The spike TTS cache once replayed 0.7–0.9 s mock-server clips against the real API and
  produced a false "never delegates" result. The cache key now includes the speech
  endpoint; if in doubt, delete `tmp/spikes/gpt-live/tts/`.
- The public-repository audit fails when a local `.env` exists; run
  `MY_LOOI_BUILD_ALLOW_LOCAL_ENV=1 pnpm test`.
- The existing addressed-command parser matches verbs anywhere after the address ("tell me
  a story about a robot who learns to dance" → dance). Fix on the Realtime path first; see
  planning SUGGESTIONS.md item 5.
- `isRealtimeConversationModelId` in `src/openai/realtime-models.ts` rejects `gpt-live-1`;
  the model list and pricing need a Live family before the picker can offer it.
