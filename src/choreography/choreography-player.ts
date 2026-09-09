/**
 * Choreography player: executes a per-reply movement plan in time with the
 * spoken audio, through the existing robot safety controller.
 *
 * Priority (highest first): emergency STOP and sensor safety stops (motion
 * sequence token), addressed local commands and barge-in (explicit cancel),
 * camera attention owning the head channel (head beats skipped), then this
 * player, then ambient motion (held for the duration of the plan).
 *
 * Every body atom is net-zero on heading except spin, which is two calibrated
 * 180° turns and therefore also returns to heading. No atom starts continuous
 * motion.
 */

import { triggerCharacterReaction, type CharacterMood } from "../character/character-reaction";
import { holdAmbientMotionFor } from "../core/ambient-motion";
import { isMainScreenFocused } from "../core/main-screen-presence";
import { useSocialAttentionStore } from "../core/social-attention";
import {
  getLooiRobotRuntimeState,
  getMotionSequenceToken,
  performLooiChoreographyPivot,
  performLooiHeadGesture,
  performLooiHeadLean,
  setLooiHead,
  setLooiLight,
  stopLooiMotion,
  turnLooi,
} from "../device-tools/looi-robot";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { useUserStore, type ExpressiveMotionLevel } from "../store/user";
import { isDrivingControlSessionActive } from "../voice/driving-control-session";
import type { ChoreographyAtom, ChoreographyBeat, ChoreographyMood, ChoreographyPlan } from "./choreography-channel";
import {
  FALLBACK_DEFAULT_ENERGY,
  FALLBACK_DEFAULT_MOOD,
  buildFallbackPlan,
  buildOpenerBeat,
  decayMood,
} from "./choreography-fallback";
import {
  LATE_BEAT_TOLERANCE,
  MIN_ESTIMATE_MS,
  atomChannel,
  estimateSpeechDurationMs,
  filterPlanForLevel,
  type AtomChannel,
  type ChoreographyPlanSource,
} from "./choreography-plan";

/** Beats at or beyond this position wait for playback to finish. */
const END_BEAT_FROM = 0.9;
/** If no model plan has arrived by this fraction of the reply, the fallback plan takes over. */
const FALLBACK_TAKEOVER_FRACTION = 0.45;
const LOOP_TICK_MS = 50;
const AFTER_PLAYBACK_GRACE_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TurnState = {
  turn: string;
  generation: number;
  plan: ChoreographyPlan | null;
  source: ChoreographyPlanSource | null;
  planFailed: boolean;
  playbackStartedAt: number | null;
  playbackFinishedAt: number | null;
  playedDurationMs: number | null;
  transcriptChars: number;
  speed: number;
  nextBeatIndex: number;
  openerDone: boolean;
  beatsRun: number;
  beatsSkipped: number;
  headMoved: boolean;
  bodyInFlight: boolean;
  bodyDisabled: boolean;
  motionToken: number;
  loopRunning: boolean;
};

class ChoreographyPlayer {
  private generation = 0;
  private turnState: TurnState | null = null;
  private lastMood: ChoreographyMood = FALLBACK_DEFAULT_MOOD;
  private lastEnergy = FALLBACK_DEFAULT_ENERGY;

  get level(): ExpressiveMotionLevel {
    return useUserStore.getState().preferences.expressiveMotionLevel;
  }

  get isEnabled(): boolean {
    return this.level !== "off";
  }

  /** Called when the user's turn is committed; a plan may arrive later. */
  startTurn(turn: string): void {
    if (this.turnState) this.cancel("new-turn");
    this.generation += 1;
    this.turnState = {
      turn,
      generation: this.generation,
      plan: null,
      source: null,
      planFailed: false,
      playbackStartedAt: null,
      playbackFinishedAt: null,
      playedDurationMs: null,
      transcriptChars: 0,
      speed: useUserStore.getState().preferences.ttsSpeed,
      nextBeatIndex: 0,
      openerDone: false,
      beatsRun: 0,
      beatsSkipped: 0,
      headMoved: false,
      bodyInFlight: false,
      bodyDisabled: false,
      motionToken: getMotionSequenceToken(),
      loopRunning: false,
    };
  }

  /** Model plan arrived. Adopt it unless the reply is already mostly spoken. */
  setPlan(plan: ChoreographyPlan, source: ChoreographyPlanSource, turn?: string): void {
    const state = this.turnState;
    if (!state || (turn !== undefined && turn !== state.turn)) {
      recordDiagnosticEvent("character", "choreography-plan-ignored", { turn: turn ?? "", reason: "no-matching-turn" });
      return;
    }
    const elapsedFraction = this.elapsedFraction(state);
    if (source === "model" && state.source === "fallback" && elapsedFraction > 0.6) {
      recordDiagnosticEvent("character", "choreography-plan-ignored", { turn: state.turn, reason: "too-late", elapsedFraction });
      return;
    }
    const filtered = filterPlanForLevel(plan, this.level);
    state.plan = filtered.plan;
    state.source = source;
    state.nextBeatIndex = filtered.plan.beats.findIndex((beat) => beat.at >= elapsedFraction - LATE_BEAT_TOLERANCE);
    if (state.nextBeatIndex < 0) state.nextBeatIndex = filtered.plan.beats.length;
    if (source === "model") {
      this.lastMood = plan.mood;
      this.lastEnergy = plan.energy;
    }
    holdAmbientMotionFor(this.estimateMs(state) + 800, "choreography");
    recordDiagnosticEvent("character", "choreography-plan-adopted", {
      turn: state.turn,
      source,
      level: this.level,
      mood: plan.mood,
      energy: plan.energy,
      beats: filtered.plan.beats.map((beat) => `${beat.at}:${beat.do}${beat.n > 1 ? `x${beat.n}` : ""}`).join(" "),
      dropped: filtered.dropped.join(","),
      elapsedFraction,
      startIndex: state.nextBeatIndex,
    });
  }

  /** Model plan missing or invalid: let the fallback take over immediately. */
  notePlanFailed(turn?: string): void {
    const state = this.turnState;
    if (!state || (turn !== undefined && turn !== state.turn)) return;
    state.planFailed = true;
  }

  onPlaybackStarted(): void {
    const state = this.turnState;
    if (!state || !this.isEnabled) return;
    state.playbackStartedAt = Date.now();
    state.speed = useUserStore.getState().preferences.ttsSpeed;
    holdAmbientMotionFor(this.estimateMs(state) + 800, "choreography");
    if (!state.loopRunning) {
      state.loopRunning = true;
      void this.runLoop(state);
    }
  }

  onTranscriptDelta(fullTranscript: string): void {
    const state = this.turnState;
    if (!state) return;
    state.transcriptChars = fullTranscript.length;
  }

  onPlaybackFinished(playedDurationMs: number): void {
    const state = this.turnState;
    if (!state) return;
    state.playbackFinishedAt = Date.now();
    state.playedDurationMs = Math.max(0, Math.round(playedDurationMs));
  }

  /** Abort everything for this turn. Safe to call at any time. */
  cancel(reason: string): void {
    const state = this.turnState;
    this.generation += 1;
    this.turnState = null;
    if (!state) return;
    if (state.bodyInFlight) void stopLooiMotion(`choreography-${reason}`).catch(() => undefined);
    if (state.headMoved) void this.settleHead("cancel").catch(() => undefined);
    recordDiagnosticEvent("character", "choreography-cancelled", {
      turn: state.turn,
      reason,
      source: state.source ?? "none",
      beatsRun: state.beatsRun,
      beatsSkipped: state.beatsSkipped,
    });
  }

  private estimateMs(state: TurnState): number {
    if (state.playedDurationMs !== null) return Math.max(MIN_ESTIMATE_MS, state.playedDurationMs);
    return estimateSpeechDurationMs(state.transcriptChars, state.speed);
  }

  private elapsedFraction(state: TurnState): number {
    if (state.playbackStartedAt === null) return 0;
    const elapsed = Date.now() - state.playbackStartedAt;
    return Math.min(1.5, elapsed / this.estimateMs(state));
  }

  private isCurrent(state: TurnState): boolean {
    return this.turnState === state && state.generation === this.generation;
  }

  private async runLoop(state: TurnState): Promise<void> {
    try {
      while (this.isCurrent(state)) {
        if (state.playbackFinishedAt !== null && Date.now() - state.playbackFinishedAt > AFTER_PLAYBACK_GRACE_MS) break;
        if (!state.plan) {
          if (!state.openerDone) {
            state.openerDone = true;
            await this.executeBeat(state, buildOpenerBeat(this.lastMood, this.lastEnergy), this.lastEnergy);
            continue;
          }
          const fraction = this.elapsedFraction(state);
          if (state.planFailed || fraction >= FALLBACK_TAKEOVER_FRACTION || state.playbackFinishedAt !== null) {
            const decayed = decayMood(this.lastMood, this.lastEnergy);
            this.lastMood = decayed.mood;
            this.lastEnergy = decayed.energy;
            this.setPlan(buildFallbackPlan("", decayed.mood, decayed.energy), "fallback", state.turn);
            // Rebuild from the transcript so far once it exists; positions stay relative.
            if (state.transcriptChars > 0) {
              const transcript = "x".repeat(state.transcriptChars);
              this.setPlan(buildFallbackPlan(transcript, decayed.mood, decayed.energy), "fallback", state.turn);
            }
            continue;
          }
          await sleep(LOOP_TICK_MS);
          continue;
        }
        const beat = state.plan.beats[state.nextBeatIndex];
        if (!beat) {
          if (state.playbackFinishedAt !== null) break;
          await sleep(LOOP_TICK_MS);
          continue;
        }
        const fraction = this.elapsedFraction(state);
        if (beat.at >= END_BEAT_FROM) {
          if (state.playbackFinishedAt === null && fraction < 1) {
            await sleep(LOOP_TICK_MS);
            continue;
          }
        } else if (fraction < beat.at) {
          await sleep(LOOP_TICK_MS);
          continue;
        } else if (fraction - beat.at > LATE_BEAT_TOLERANCE) {
          state.nextBeatIndex += 1;
          state.beatsSkipped += 1;
          recordDiagnosticEvent("character", "choreography-beat-skipped", { turn: state.turn, atom: beat.do, at: beat.at, fraction, reason: "late" });
          continue;
        }
        state.nextBeatIndex += 1;
        await this.executeBeat(state, beat, state.plan.energy);
      }
    } finally {
      if (this.isCurrent(state)) {
        if (state.headMoved) await this.settleHead("finish").catch(() => undefined);
        recordDiagnosticEvent("character", "choreography-finished", {
          turn: state.turn,
          source: state.source ?? "none",
          beatsRun: state.beatsRun,
          beatsSkipped: state.beatsSkipped,
        });
        if (this.turnState === state) this.turnState = null;
      }
      state.loopRunning = false;
    }
  }

  private async settleHead(reason: string): Promise<void> {
    const robot = getLooiRobotRuntimeState();
    if (!robot.connected) return;
    try {
      await setLooiHead("center");
    } finally {
      recordDiagnosticEvent("character", "choreography-head-settled", { reason });
    }
  }

  private blockReason(state: TurnState, channel: AtomChannel): string | null {
    if (useUserStore.getState().robotSleeping) return "robot-sleeping";
    if (getMotionSequenceToken() !== state.motionToken) return "motion-abort";
    if (channel === "face") return null;
    const robot = getLooiRobotRuntimeState();
    if (!robot.connected) return "robot-disconnected";
    if (channel === "light") return null;
    if (!isMainScreenFocused()) return "main-not-focused";
    if (channel === "head") {
      const attention = useSocialAttentionStore.getState();
      if (attention.active && attention.faceVisible) return "camera-attention-owns-head";
      return null;
    }
    if (state.bodyDisabled) return "body-disabled";
    if (!robot.driveControlReady) return "drive-not-ready";
    if (robot.motionActive) return "motion-active";
    if (isDrivingControlSessionActive()) return "driving-control";
    return null;
  }

  private async executeBeat(state: TurnState, beat: ChoreographyBeat, energy: number): Promise<void> {
    const channel = atomChannel(beat.do);
    const reason = this.blockReason(state, channel);
    if (reason === "motion-abort" || reason === "robot-sleeping") {
      this.cancel(reason);
      return;
    }
    if (reason) {
      state.beatsSkipped += 1;
      recordDiagnosticEvent("character", "choreography-beat-skipped", { turn: state.turn, atom: beat.do, at: beat.at, reason });
      return;
    }
    const startedAt = Date.now();
    try {
      if (channel === "body") state.bodyInFlight = true;
      if (channel === "head") state.headMoved = beat.do !== "settle";
      await this.performAtom(beat.do, beat.n, energy);
      state.beatsRun += 1;
      recordDiagnosticEvent("character", "choreography-beat", { turn: state.turn, atom: beat.do, n: beat.n, at: beat.at, channel, durationMs: Date.now() - startedAt });
    } catch (error) {
      state.beatsSkipped += 1;
      if (channel === "body") state.bodyDisabled = true;
      recordDiagnosticEvent("character", "choreography-beat-failed", {
        turn: state.turn,
        atom: beat.do,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (channel === "body") state.bodyInFlight = false;
    }
  }

  private async performAtom(atom: ChoreographyAtom, repeat: number, energy: number): Promise<void> {
    // Lower energy → longer holds and slower pivots.
    const holdMs = Math.round(300 + (1 - Math.max(0, Math.min(1, energy))) * 500);
    const pivotMs = Math.round(100 + (1 - Math.max(0, Math.min(1, energy))) * 60);
    switch (atom) {
      case "nod":
        await performLooiHeadGesture("nod", repeat);
        return;
      case "bob":
        for (let i = 0; i < repeat; i += 1) await performLooiHeadGesture("happy_bob");
        return;
      case "peek_up":
        await performLooiHeadGesture("curious");
        return;
      case "peek_down":
        await performLooiHeadGesture("thinking");
        return;
      case "droop":
        await performLooiHeadLean(0.75, holdMs);
        return;
      case "lean_up":
        await performLooiHeadLean(-0.45, holdMs);
        return;
      case "lean_down":
        await performLooiHeadLean(0.45, holdMs);
        return;
      case "settle":
        await setLooiHead("center");
        return;
      case "wiggle":
        for (let i = 0; i < repeat; i += 1) await this.pivotPair(pivotMs, pivotMs * 2, 0);
        return;
      case "shake":
        for (let i = 0; i < repeat; i += 1) await this.pivotPair(Math.max(80, pivotMs - 20), Math.max(160, (pivotMs - 20) * 2), 0);
        return;
      case "sway":
        await this.pivotPair(pivotMs * 2, pivotMs * 4, holdMs);
        return;
      case "spin":
        await this.checkedTurn();
        await this.checkedTurn();
        return;
      case "blink_light":
        for (let i = 0; i < Math.max(1, repeat); i += 1) {
          await setLooiLight(true);
          await sleep(120);
          await setLooiLight(false);
          if (i + 1 < repeat) await sleep(120);
        }
        return;
      default: {
        if (atom.startsWith("face:")) {
          const mood = atom.slice("face:".length) as CharacterMood;
          triggerCharacterReaction(mood, { durationMs: 900, source: "choreography" });
          return;
        }
        throw new Error(`Unsupported choreography atom: ${atom}`);
      }
    }
  }

  /** Left, right (double), left: heading returns to where it started. */
  private async pivotPair(outMs: number, backMs: number, holdMs: number): Promise<void> {
    const token = getMotionSequenceToken();
    const a = await performLooiChoreographyPivot("left", outMs);
    if (a.completed === false || getMotionSequenceToken() !== token) throw new Error("pivot interrupted");
    if (holdMs > 0) await sleep(holdMs);
    const b = await performLooiChoreographyPivot("right", backMs);
    if (b.completed === false || getMotionSequenceToken() !== token) throw new Error("pivot interrupted");
    if (holdMs > 0) await sleep(holdMs);
    const c = await performLooiChoreographyPivot("left", outMs);
    if (c.completed === false) throw new Error("pivot interrupted");
  }

  private async checkedTurn(): Promise<void> {
    const token = getMotionSequenceToken();
    const result = await turnLooi("right", 180);
    if ((result as { completed?: boolean }).completed === false || getMotionSequenceToken() !== token) {
      throw new Error("turn interrupted");
    }
  }
}

export const choreographyPlayer = new ChoreographyPlayer();
