// Shared helpers for the GPT-Live spike scripts (scripts/spikes/gpt-live-*.mjs).
//
// Nothing here is used by the app. It exists so both spikes can talk to
// wss://api.openai.com/v1/live/sessions from plain Node 22 without adding a
// dependency: the Live WebSocket docs only document `Authorization: Bearer`
// header auth, which Node's built-in WebSocket cannot send, and `ws` is not
// resolvable from the repo root. The client below is a deliberately small
// RFC 6455 implementation (text frames, ping/pong, close) over node:tls.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { dirname, join } from "node:path";
import { connect as connectTls } from "node:tls";
import { fileURLToPath } from "node:url";

/** Override with GPT_LIVE_URL / OPENAI_SPEECH_URL to dry-run against a local mock. */
export const LIVE_WS_URL = process.env.GPT_LIVE_URL?.trim() || "wss://api.openai.com/v1/live/sessions";
export const SPEECH_URL = process.env.OPENAI_SPEECH_URL?.trim() || "https://api.openai.com/v1/audio/speech";
export const LIVE_MODEL = "gpt-live-1";
export const PCM_RATE = 24_000;
/** 100 ms of 24 kHz mono PCM16 per append, paced in real time like the app would. */
export const CHUNK_MS = 100;
export const CHUNK_BYTES = (PCM_RATE * CHUNK_MS / 1000) * 2;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SPIKE_TMP_DIR = join(REPO_ROOT, "tmp", "spikes", "gpt-live");

// ---------------------------------------------------------------------------
// CLI helpers

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { args._.push(arg); continue; }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inlineValue !== undefined) args[key] = inlineValue;
    else if (rawKey.startsWith("no-")) args[rawKey.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { args[key] = argv[i + 1]; i += 1; }
    else args[key] = true;
  }
  return args;
}

export function requireApiKey() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required");
    process.exit(2);
  }
  return apiKey;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Minimal WebSocket client (RFC 6455) with header and subprotocol support.

export class MinimalWebSocket {
  /**
   * @param {string} url
   * @param {{ headers?: Record<string,string>, protocols?: string[] }} options
   */
  constructor(url, options = {}) {
    this.url = new URL(url);
    this.headers = options.headers ?? {};
    this.protocols = options.protocols ?? [];
    this.listeners = { open: [], message: [], close: [], error: [] };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.open = false;
    this.closed = false;
    this.acceptedProtocol = null;
    this.handshakeStatus = null;
  }

  on(event, listener) {
    this.listeners[event].push(listener);
    return this;
  }

  emit(event, ...args) {
    for (const listener of this.listeners[event]) listener(...args);
  }

  connect() {
    const secure = this.url.protocol === "wss:";
    const port = Number(this.url.port) || (secure ? 443 : 80);
    const host = this.url.hostname;
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const path = `${this.url.pathname}${this.url.search}`;
    const headerLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}${Number(this.url.port) ? `:${this.url.port}` : ""}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "User-Agent: my-looi-gpt-live-spike/1.0 (node)",
    ];
    if (this.protocols.length) headerLines.push(`Sec-WebSocket-Protocol: ${this.protocols.join(", ")}`);
    for (const [name, value] of Object.entries(this.headers)) headerLines.push(`${name}: ${value}`);
    const request = `${headerLines.join("\r\n")}\r\n\r\n`;

    const onConnect = () => { this.socket.write(request); };
    this.socket = secure
      ? connectTls({ host, port, servername: host, ALPNProtocols: ["http/1.1"] }, onConnect)
      : connectTcp({ host, port }, onConnect);
    this.socket.setNoDelay(true);

    let handshakeDone = false;
    let raw = Buffer.alloc(0);
    this.socket.on("data", (data) => {
      if (handshakeDone) { this.consume(data); return; }
      raw = Buffer.concat([raw, data]);
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = raw.subarray(0, end).toString("latin1");
      const rest = raw.subarray(end + 4);
      const [statusLine, ...lines] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      this.handshakeStatus = status;
      const headers = Object.fromEntries(lines.map((line) => {
        const idx = line.indexOf(":");
        return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
      }));
      if (status !== 101 || headers["sec-websocket-accept"] !== expectedAccept) {
        const body = rest.toString("utf8").slice(0, 600);
        handshakeDone = true;
        this.closed = true;
        this.emit("error", new Error(`WebSocket handshake failed: HTTP ${status} ${body ? `body=${body}` : ""}`.trim()));
        this.socket.destroy();
        return;
      }
      this.acceptedProtocol = headers["sec-websocket-protocol"] ?? null;
      handshakeDone = true;
      this.open = true;
      this.emit("open", { protocol: this.acceptedProtocol });
      if (rest.length) this.consume(rest);
    });
    this.socket.on("error", (error) => { if (!this.closed) this.emit("error", error); });
    this.socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      this.emit("close", { code: 1006, reason: "connection closed" });
    });
    return this;
  }

  consume(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      if (!this.closed) {
        this.closed = true;
        this.open = false;
        try { this.sendFrame(0x8, payload); } catch {}
        this.socket.end();
        this.emit("close", { code, reason });
      }
      return;
    }
    if (opcode === 0x9) { this.sendFrame(0xa, payload); return; }
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const whole = Buffer.concat(this.fragments);
      const type = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;
      this.emit("message", type === 0x1 ? whole.toString("utf8") : whole);
      return;
    }
    if (!fin) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
      return;
    }
    this.emit("message", opcode === 0x1 ? payload.toString("utf8") : payload);
  }

  sendFrame(opcode, payload) {
    const mask = randomBytes(4);
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 0x10000) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i += 1) maskedPayload[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  send(text) {
    if (!this.open) throw new Error("WebSocket is not open");
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(code = 1000, reason = "") {
    if (this.closed || !this.socket) return;
    this.closed = true;
    this.open = false;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try { this.sendFrame(0x8, payload); } catch {}
    this.socket.end();
    this.emit("close", { code, reason });
  }

  destroy() {
    this.closed = true;
    this.open = false;
    this.socket?.destroy();
  }
}

/**
 * Open a Live session socket. `auth` is "header" (documented for Live) or
 * "subprotocol" (documented for Realtime only; the spike probes whether Live
 * accepts it, because the phone cannot keep a backend and the app currently
 * uses this form with an ephemeral secret).
 */
export function openLiveSocket({ apiKey, auth = "header", url = LIVE_WS_URL }) {
  const options = auth === "subprotocol"
    ? { protocols: ["realtime", `openai-insecure-api-key.${apiKey}`] }
    : { headers: { Authorization: `Bearer ${apiKey}` } };
  return new MinimalWebSocket(url, options).connect();
}

// ---------------------------------------------------------------------------
// Event logging: every event type with a timestamp, audio deltas summarised.

export class EventLog {
  constructor(label) {
    this.label = label;
    this.t0 = Date.now();
    this.entries = [];
    this.firstOfType = new Map();
    this.counts = new Map();
    this.audioOutBytes = 0;
  }

  /** ms since log creation (session.started resets t0 via mark()). */
  now() {
    return Date.now() - this.t0;
  }

  mark() {
    this.t0 = Date.now();
  }

  stamp(ms = this.now()) {
    return `${String(ms).padStart(6)}ms`;
  }

  record(direction, event) {
    const type = String(event?.type ?? "?");
    const at = this.now();
    this.counts.set(`${direction} ${type}`, (this.counts.get(`${direction} ${type}`) ?? 0) + 1);
    const entry = { at, direction, type, event: summariseEvent(event) };
    this.entries.push(entry);
    if (direction === "in" && !this.firstOfType.has(type)) this.firstOfType.set(type, event);
    if (type === "session.output_audio.delta") this.audioOutBytes += Buffer.from(String(event.delta ?? ""), "base64").length;
    return entry;
  }

  print(direction, event, extra = "") {
    const entry = this.record(direction, event);
    const arrow = direction === "in" ? "<-" : "->";
    const type = entry.type;
    if (type === "session.input_audio.append") return; // paced 10x/s; summarised at the end
    const detail = describeEvent(event);
    console.log(`${this.stamp(entry.at)} ${arrow} ${type}${detail ? `  ${detail}` : ""}${extra ? `  ${extra}` : ""}`);
  }

  summary() {
    const lines = [];
    for (const [key, count] of [...this.counts.entries()].sort()) lines.push(`  ${String(count).padStart(5)}  ${key}`);
    return lines.join("\n");
  }

  save(fileName) {
    mkdirSync(SPIKE_TMP_DIR, { recursive: true });
    const path = join(SPIKE_TMP_DIR, fileName);
    const jsonl = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(path, `${jsonl}\n`);
    return path;
  }

  /** Full JSON of the first server event of each type; audio/base64 fields shortened. */
  envelopes() {
    return [...this.firstOfType.entries()].map(([type, event]) => `--- first ${type}\n${JSON.stringify(summariseEvent(event), null, 2)}`).join("\n");
  }
}

function summariseEvent(event) {
  if (!event || typeof event !== "object") return event;
  const copy = Array.isArray(event) ? [] : {};
  for (const [key, value] of Object.entries(event)) {
    if ((key === "audio" || key === "delta") && typeof value === "string" && value.length > 96 && /^[A-Za-z0-9+/=]+$/.test(value)) {
      copy[key] = `<base64 ${Buffer.from(value, "base64").length} bytes>`;
    } else if (value && typeof value === "object") {
      copy[key] = summariseEvent(value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

function describeEvent(event) {
  const type = String(event?.type ?? "");
  if (type === "session.output_audio.delta") return `${Buffer.from(String(event.delta ?? ""), "base64").length} bytes`;
  if (type === "session.input_transcript.delta" || type === "session.output_transcript.delta") {
    return `${JSON.stringify(event.delta ?? "")} start_ms=${event.start_ms ?? "-"} end_ms=${event.end_ms ?? "-"}`;
  }
  if (type === "response.event") {
    const inner = event.event ?? {};
    const innerType = String(inner.type ?? "?");
    if (innerType === "response.output_text.delta") return `${innerType} ${JSON.stringify(inner.delta ?? "")}`;
    if (innerType === "response.output_item.done" || innerType === "response.output_item.added") {
      const item = inner.item ?? {};
      return `${innerType} item.type=${item.type ?? "?"}${item.name ? ` name=${item.name}` : ""}${item.call_id ? ` call_id=${item.call_id}` : ""}${item.arguments ? ` args=${item.arguments}` : ""}`;
    }
    return `${innerType}${inner.item_id ? ` item_id=${inner.item_id}` : ""}`;
  }
  if (type === "session.delegation.created") return JSON.stringify(event.delegation ?? {});
  if (type === "session.usage.updated") return JSON.stringify({ usage: event.usage, context_window: event.context_window });
  if (type === "session.closed") return JSON.stringify({ reason: event.reason, usage: event.usage });
  if (type === "session.started") return `session.id=${event.session?.id ?? "?"} model=${event.session?.model ?? "?"}`;
  if (type === "error") return JSON.stringify(event.error ?? event);
  if (type.endsWith(".appended") || type.endsWith(".muted") || type.endsWith(".unmuted")) {
    return JSON.stringify({ client_event_id: event.client_event_id, start_ms: event.start_ms, end_ms: event.end_ms });
  }
  if (type === "session.start" || type === "session.update") return JSON.stringify(summariseEvent(event.session ?? {})).slice(0, 200);
  return "";
}

// ---------------------------------------------------------------------------
// Audio sources: synthesised silence + tone, raw PCM/WAV files, and TTS clips.

export function silence(ms) {
  return Buffer.alloc(Math.round(PCM_RATE * ms / 1000) * 2);
}

/** Mono PCM16 sine with 20 ms fade in/out so it does not click. */
export function tone(ms, frequencyHz = 440, amplitude = 0.3) {
  const frames = Math.round(PCM_RATE * ms / 1000);
  const fade = Math.round(PCM_RATE * 0.02);
  const buffer = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const envelope = Math.min(1, i / fade, (frames - 1 - i) / fade);
    const sample = Math.sin(2 * Math.PI * frequencyHz * i / PCM_RATE) * amplitude * envelope;
    buffer.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return buffer;
}

/** Load a .wav (PCM16 mono, any rate; resampled linearly) or raw 24 kHz PCM16 mono file. */
export function loadPcmFile(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    let offset = 12;
    let rate = PCM_RATE;
    let channels = 1;
    let bits = 16;
    while (offset + 8 <= bytes.length) {
      const id = bytes.subarray(offset, offset + 4).toString("ascii");
      const size = bytes.readUInt32LE(offset + 4);
      if (id === "fmt ") {
        channels = bytes.readUInt16LE(offset + 10);
        rate = bytes.readUInt32LE(offset + 12);
        bits = bytes.readUInt16LE(offset + 22);
      } else if (id === "data") {
        if (bits !== 16) throw new Error(`Only PCM16 WAV is supported (got ${bits}-bit)`);
        let pcm = bytes.subarray(offset + 8, offset + 8 + size);
        if (channels > 1) pcm = downmix(pcm, channels);
        return rate === PCM_RATE ? pcm : resamplePcm16(pcm, rate, PCM_RATE);
      }
      offset += 8 + size + (size % 2);
    }
    throw new Error("WAV file has no data chunk");
  }
  return bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes;
}

function downmix(pcm, channels) {
  const frames = Math.floor(pcm.length / 2 / channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

export function resamplePcm16(pcm, fromRate, toRate) {
  const frames = Math.floor(pcm.length / 2);
  const outFrames = Math.max(1, Math.round(frames * toRate / fromRate));
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * fromRate / toRate;
    const left = Math.min(frames - 1, Math.floor(pos));
    const right = Math.min(frames - 1, left + 1);
    const frac = pos - left;
    const a = pcm.readInt16LE(left * 2);
    const b = pcm.readInt16LE(right * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}

/**
 * Synthesise a user utterance with the OpenAI speech endpoint (PCM 24 kHz
 * mono, no header) so the spikes can exercise real speech without a
 * microphone. Cached under tmp/spikes/gpt-live/tts/ (gitignored scratch).
 */
export async function ttsClip(apiKey, text, { voice = "alloy", model = "gpt-4o-mini-tts", instructions } = {}) {
  const cacheDir = join(SPIKE_TMP_DIR, "tts");
  mkdirSync(cacheDir, { recursive: true });
  const cacheKey = createHash("sha1").update(`${model}|${voice}|${instructions ?? ""}|${text}`).digest("hex").slice(0, 16);
  const cachePath = join(cacheDir, `${cacheKey}.pcm`);
  if (existsSync(cachePath)) return { pcm: readFileSync(cachePath), cached: true, path: cachePath };
  const response = await fetch(SPEECH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "pcm", ...(instructions ? { instructions } : {}) }),
  });
  if (!response.ok) throw new Error(`TTS failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const pcm = Buffer.from(await response.arrayBuffer());
  writeFileSync(cachePath, pcm);
  return { pcm, cached: false, path: cachePath };
}

export function pcmDurationMs(pcm) {
  return Math.round((pcm.length / 2) / PCM_RATE * 1000);
}

/**
 * Real-time paced uplink. Sends CHUNK_MS of audio every CHUNK_MS: silence when
 * nothing is queued, otherwise the queued clip bytes. `queue(pcm, label)`
 * resolves with {startedAt, endedAt} (log-relative ms) when the clip's last
 * byte has been sent, which is the reference point for every latency below.
 */
export class PacedUplink {
  constructor(ws, log, { onSent } = {}) {
    this.ws = ws;
    this.log = log;
    this.onSent = onSent;
    this.pending = [];
    this.current = null;
    this.timer = null;
    this.sentChunks = 0;
    this.silentChunks = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick(), CHUNK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  queue(pcm, label) {
    return new Promise((resolve) => {
      this.pending.push({ pcm, label, offset: 0, startedAt: null, resolve });
    });
  }

  get busy() {
    return Boolean(this.current || this.pending.length);
  }

  tick() {
    if (!this.ws.open) return;
    let chunk;
    if (!this.current && this.pending.length) this.current = this.pending.shift();
    if (this.current) {
      const clip = this.current;
      if (clip.startedAt === null) clip.startedAt = this.log.now();
      chunk = Buffer.alloc(CHUNK_BYTES);
      const remaining = clip.pcm.subarray(clip.offset, clip.offset + CHUNK_BYTES);
      remaining.copy(chunk);
      clip.offset += CHUNK_BYTES;
      if (clip.offset >= clip.pcm.length) {
        this.current = null;
        clip.endedAt = this.log.now() + CHUNK_MS;
        clip.resolve({ startedAt: clip.startedAt, endedAt: clip.endedAt, label: clip.label });
      }
    } else {
      chunk = silence(CHUNK_MS);
      this.silentChunks += 1;
    }
    const event = { type: "session.input_audio.append", audio: chunk.toString("base64") };
    this.ws.send(JSON.stringify(event));
    this.log.record("out", event);
    this.sentChunks += 1;
    this.onSent?.(chunk, this.current?.label ?? null);
  }
}

// ---------------------------------------------------------------------------
// Turn segmentation from session.input_transcript.delta (no item ids, no
// completed event). Mirrors what the app would have to do for the addressed
// command parser: accumulate deltas and cut a turn after `gapMs` of silence.

export class TranscriptSegmenter {
  constructor(log, { gapMs = 700, onTurn } = {}) {
    this.log = log;
    this.gapMs = gapMs;
    this.onTurn = onTurn;
    this.text = "";
    this.firstDeltaAt = null;
    this.lastDeltaAt = null;
    this.lastEndMs = null;
    this.timer = null;
    this.turns = [];
  }

  push(event) {
    const at = this.log.now();
    if (this.firstDeltaAt === null) this.firstDeltaAt = at;
    this.lastDeltaAt = at;
    if (typeof event.end_ms === "number") this.lastEndMs = event.end_ms;
    this.text += String(event.delta ?? "");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush("gap"), this.gapMs);
  }

  flush(reason) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.text.trim()) return null;
    const turn = {
      text: this.text.trim(),
      firstDeltaAt: this.firstDeltaAt,
      lastDeltaAt: this.lastDeltaAt,
      lastEndMs: this.lastEndMs,
      segmentedAt: this.log.now(),
      reason,
    };
    this.text = "";
    this.firstDeltaAt = null;
    this.lastDeltaAt = null;
    this.turns.push(turn);
    this.onTurn?.(turn);
    return turn;
  }
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function fmt(ms) {
  return ms === null || ms === undefined ? "n/a" : `${Math.round(ms)}ms`;
}
