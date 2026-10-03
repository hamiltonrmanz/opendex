// Partial-transcript reflex scheduler. Pure (injectable timers/classifier) so
// the debounce + cancellation rules are unit-testable.
//
// Flow: interim STT text → wait until it's been quiet for `debounceMs` →
// send a *bounded* slice to Jev for a closed-set label → if the label is on the
// reversible allowlist and the text hasn't changed, dispatch once. The host
// (main) still maps the label to a fixed tool call and runs it through the
// permission gate; nothing here can name a tool or an argument.
//
// Cancellation: any change to the words while a classification is pending drops
// it (generation counter). After dispatch nothing can be un-started, so a later
// material change is only *reported* (onSuperseded) and blocks further dispatch.

export type ReflexMode = "off" | "observe" | "act";

/** Labels the scheduler may dispatch. `type_text` is deliberately absent. */
export const REFLEX_ALLOWLIST: ReadonlySet<string> = new Set(["open_app", "search"]);

export interface ReflexDecisionLike {
  choice: string;
  source?: string;
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ReflexSchedulerDeps {
  classify(boundedText: string): Promise<ReflexDecisionLike>;
  /** Act mode only: an allowlisted label was decided for stable text. */
  dispatch(choice: string, text: string): void;
  /** Any decision (observe + act) — for telemetry. */
  onDecision?(decision: ReflexDecisionLike, text: string): void;
  /** Words changed after a dispatch; the started action can't be undone. */
  onSuperseded?(dispatchedText: string, newText: string): void;
  timers?: TimerApi;
  debounceMs?: number;
  minChars?: number;
  /** Max characters ever sent to Jev for a partial. */
  maxChars?: number;
}

export interface FinalizeResult {
  dispatched: boolean;
  superseded: boolean;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Case/punctuation-insensitive word form, used to define a "material" change. */
export function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export class ReflexScheduler {
  private mode: ReflexMode = "observe";
  private gen = 0;
  private timer: unknown = null;
  private lastSeen = "";
  private dispatchedText: string | null = null;
  private superseded = false;
  private readonly timers: TimerApi;
  private readonly debounceMs: number;
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(private readonly deps: ReflexSchedulerDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.debounceMs = deps.debounceMs ?? 350;
    this.minChars = deps.minChars ?? 8;
    this.maxChars = deps.maxChars ?? 200;
  }

  setMode(mode: ReflexMode): void {
    this.mode = mode;
    if (mode === "off") this.reset();
  }

  /** Feed the latest interim transcript. */
  onPartial(raw: string): void {
    if (this.mode === "off") return;
    const text = normalizeWords(raw);

    if (this.dispatchedText !== null) {
      if (text !== this.dispatchedText && !this.superseded) {
        this.superseded = true;
        this.deps.onSuperseded?.(this.dispatchedText, text);
      }
      return;
    }

    if (text.length < this.minChars) {
      this.cancelPending();
      this.lastSeen = text;
      return;
    }
    if (text === this.lastSeen) return;

    this.lastSeen = text;
    this.cancelPending();
    this.timer = this.timers.set(() => this.run(text), this.debounceMs);
  }

  /** The utterance is final. Returns what happened, then resets for the next. */
  finalize(finalRaw: string): FinalizeResult {
    const final = normalizeWords(finalRaw);
    const dispatched = this.dispatchedText !== null;
    const superseded =
      this.superseded || (dispatched && final !== this.dispatchedText);
    this.reset();
    return { dispatched, superseded };
  }

  /** Start of a new capture. */
  reset(): void {
    this.cancelPending();
    this.lastSeen = "";
    this.dispatchedText = null;
    this.superseded = false;
  }

  private cancelPending(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.gen++; // invalidates any in-flight classification
  }

  private run(text: string): void {
    this.timer = null;
    const myGen = this.gen;
    // Bounded: only the tail of a long partial is ever sent.
    const bounded = text.length > this.maxChars ? text.slice(-this.maxChars) : text;
    this.deps
      .classify(bounded)
      .then((decision) => {
        // Words changed (or utterance ended / mode flipped) while we waited.
        if (myGen !== this.gen || this.dispatchedText !== null) return;
        this.deps.onDecision?.(decision, text);
        if (this.mode === "act" && REFLEX_ALLOWLIST.has(decision.choice)) {
          this.dispatchedText = text;
          this.deps.dispatch(decision.choice, text);
        }
      })
      .catch(() => {
        // Jev failing must never affect the normal pipeline.
      });
  }
}
