// Adaptive end-of-utterance detector for frame-based capture (WVP 16kHz frames).
// Pure: feed it one RMS value per frame, read the phase. No timers, no DOM.
//
// Replaces "fixed 1s of silence" with:
//  - a noise floor (calibrated from the opening frames, then tracked slowly), so
//    quiet speakers are heard and noisy rooms don't trigger;
//  - a speech-rate estimate (voiced bursts per second): fast talkers get a short
//    trailing silence, slow/hesitant ones a longer one;
//  - pause awareness: the trailing silence is never less than 1.4x the longest
//    mid-utterance pause already heard, so a thinking pause isn't mistaken for
//    the end;
//  - phases, so the UI can show "finalizing" before the turn is committed, and
//    speech resuming while finalizing is treated as an interruption (back to
//    speaking, not ended).
//
// The rate→silence mapping is a heuristic tuned by feel, not a trained VAD; the
// unit tests pin the *properties* (monotonic in rate, never below the
// pause floor, never above the cap), not magic numbers.

export type EndpointPhase = "waiting" | "speaking" | "finalizing" | "ended";

export interface EndpointerConfig {
  /** false = legacy behaviour: fixed RMS threshold, fixed trailing silence. */
  adaptive: boolean;
  /** Duration of one input frame (512 samples @ 16kHz = 32ms). */
  frameMs: number;
  /** Fixed speech threshold (legacy mode, and during calibration). */
  fixedSpeechRms: number;
  /** Legacy trailing silence; also the hard cap's lower bound in adaptive mode. */
  fixedSilenceMs: number;
  /** Voiced audio required before this counts as an utterance at all. */
  minSpeechMs: number;
  minSilenceMs: number;
  maxSilenceMs: number;
  /** Trailing silence for a median-rate talker. */
  baseSilenceMs: number;
  calibrationMs: number;
  /** Silence before the phase flips speaking → finalizing. */
  finalizingAfterMs: number;
}

export const DEFAULT_ENDPOINTER: EndpointerConfig = {
  adaptive: true,
  frameMs: 32,
  fixedSpeechRms: 0.025,
  fixedSilenceMs: 1000,
  minSpeechMs: 384,
  minSilenceMs: 450,
  maxSilenceMs: 1400,
  baseSilenceMs: 750,
  calibrationMs: 320,
  finalizingAfterMs: 200,
};

const MIN_THRESHOLD = 0.018;
const MAX_THRESHOLD = 0.05;
/** Unvoiced gaps shorter than this are articulation, not pauses. */
const MIN_GAP_FRAMES = 3;
const MIN_PAUSE_MS = 150;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class Endpointer {
  private readonly cfg: EndpointerConfig;
  private t = 0;
  private floor: number | null = null;
  private calibMin = Infinity;
  private voicedMs = 0;
  private silenceRunMs = 0;
  private unvoicedFrames = 0;
  private bursts = 0;
  private firstVoicedAt: number | null = null;
  private longestPauseMs = 0;
  private everVoiced = false;
  private _phase: EndpointPhase = "waiting";

  constructor(cfg: Partial<EndpointerConfig> = {}) {
    this.cfg = { ...DEFAULT_ENDPOINTER, ...cfg };
  }

  get phase(): EndpointPhase {
    return this._phase;
  }
  get ended(): boolean {
    return this._phase === "ended";
  }
  /** Any voiced frame at all has been heard (for the "speech started" mark). */
  get heardVoice(): boolean {
    return this.everVoiced;
  }
  get speechMs(): number {
    return this.voicedMs;
  }
  /** Enough voiced audio to count as a real utterance. */
  get hasSpeech(): boolean {
    return this.voicedMs >= this.cfg.minSpeechMs;
  }
  get speechRmsThreshold(): number {
    if (!this.cfg.adaptive || this.floor === null) return this.cfg.fixedSpeechRms;
    return clamp(this.floor * 3 + 0.006, MIN_THRESHOLD, MAX_THRESHOLD);
  }
  /** Voiced bursts per second of speech so far; null until there's enough. */
  get speechRate(): number | null {
    if (this.firstVoicedAt === null) return null;
    const span = this.t - this.firstVoicedAt;
    if (!this.hasSpeech || span < 800) return null;
    return this.bursts / (span / 1000);
  }
  /** Trailing silence currently required to end the utterance. */
  get targetSilenceMs(): number {
    const c = this.cfg;
    if (!c.adaptive) return c.fixedSilenceMs;
    const rate = this.speechRate;
    const factor = rate === null ? 1 : clamp(1.6 - 0.15 * rate, 0.7, 1.4);
    let target = clamp(c.baseSilenceMs * factor, c.minSilenceMs, c.maxSilenceMs);
    target = clamp(Math.max(target, this.longestPauseMs * 1.4), c.minSilenceMs, c.maxSilenceMs);
    return target;
  }

  /** Feed one frame's RMS (0..1). Returns the resulting phase. */
  push(rms: number): EndpointPhase {
    if (this._phase === "ended") return this._phase;
    const c = this.cfg;
    this.t += c.frameMs;

    // --- noise floor ------------------------------------------------------
    let thr = c.fixedSpeechRms;
    if (c.adaptive) {
      if (this.floor === null) {
        // Calibrating: classify with the fixed threshold so speech that starts
        // immediately isn't absorbed into the floor.
        if (rms < c.fixedSpeechRms) this.calibMin = Math.min(this.calibMin, rms);
        if (this.t >= c.calibrationMs) {
          const seed = Number.isFinite(this.calibMin) ? this.calibMin : 0.005;
          this.floor = clamp(seed, 0.002, 0.02);
        }
      } else {
        thr = this.speechRmsThreshold;
      }
    }

    const voiced = rms > thr;
    if (c.adaptive && this.floor !== null && !voiced) {
      this.floor = clamp(this.floor * 0.95 + rms * 0.05, 0.002, 0.02);
    }

    // --- voiced / silence bookkeeping --------------------------------------
    if (voiced) {
      if (this.unvoicedFrames >= MIN_GAP_FRAMES || !this.everVoiced) {
        this.bursts += 1;
        const gapMs = this.unvoicedFrames * c.frameMs;
        if (this.everVoiced && gapMs >= MIN_PAUSE_MS) {
          this.longestPauseMs = Math.max(this.longestPauseMs, gapMs);
        }
      }
      if (this.firstVoicedAt === null) this.firstVoicedAt = this.t;
      this.everVoiced = true;
      this.voicedMs += c.frameMs;
      this.unvoicedFrames = 0;
      this.silenceRunMs = 0;
    } else {
      this.unvoicedFrames += 1;
      if (this.everVoiced) this.silenceRunMs += c.frameMs;
    }

    // --- phase -----------------------------------------------------------
    if (!this.hasSpeech) {
      this._phase = "waiting";
    } else if (this.silenceRunMs >= this.targetSilenceMs) {
      this._phase = "ended";
    } else if (this.silenceRunMs >= c.finalizingAfterMs) {
      this._phase = "finalizing";
    } else {
      this._phase = "speaking";
    }
    return this._phase;
  }
}
