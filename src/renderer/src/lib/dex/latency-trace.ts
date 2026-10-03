// Per-turn voice latency trace. Pure (no DOM / electron) so it's unit-testable.
//
// Marks are epoch-millisecond timestamps (renderer `nowMs()` and main
// `Date.now()` share a timeline), first-write-wins within a turn. Only numbers
// and mark names are stored — never transcript text or audio — so a snapshot is
// always safe to log or send to analytics.

export const LATENCY_MARKS = [
  "speech_start",
  "first_partial",
  "jev_decision",
  "permission_resolved",
  "action_start",
  "session_ready",
  "model_first_token",
  "tts_enqueue",
  "first_audio",
] as const;

export type LatencyMark = (typeof LATENCY_MARKS)[number];

export interface LatencySnapshot {
  /** Offset in ms from the turn's first mark, per mark seen. */
  marks: Partial<Record<LatencyMark, number>>;
  /** The most recent mark seen, in pipeline order. */
  stage: LatencyMark | null;
  /** Headline: session_ready (agent terminal is up, hit the hotkey) if the turn
   *  launched one, else first_audio; relative to the turn start, null until then. */
  totalMs: number | null;
  /** Gap between consecutive seen marks (pipeline order) — where time went. */
  segments: Array<{ from: LatencyMark; to: LatencyMark; ms: number }>;
}

export const EMPTY_LATENCY: LatencySnapshot = {
  marks: {},
  stage: null,
  totalMs: null,
  segments: [],
};

export const nowMs = (): number => performance.timeOrigin + performance.now();

export class LatencyTrace {
  private at: Partial<Record<LatencyMark, number>> = {};
  private listeners = new Set<(s: LatencySnapshot) => void>();
  private cached: LatencySnapshot = EMPTY_LATENCY;

  /** Record a mark. Ignored if already seen this turn. */
  mark(name: LatencyMark, at: number = nowMs()): void {
    if (this.at[name] !== undefined) return;
    this.at[name] = at;
    this.publish();
  }

  /** Start a fresh turn (drops all marks). */
  reset(): void {
    if (Object.keys(this.at).length === 0) return;
    this.at = {};
    this.publish();
  }

  /** True once the turn has landed (session up or audio started) — the next
   *  mark is a new turn. */
  get complete(): boolean {
    return this.at.first_audio !== undefined || this.at.session_ready !== undefined;
  }

  snapshot(): LatencySnapshot {
    return this.cached;
  }

  subscribe(fn: (s: LatencySnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish(): void {
    this.cached = compute(this.at);
    for (const fn of this.listeners) fn(this.cached);
  }
}

function compute(at: Partial<Record<LatencyMark, number>>): LatencySnapshot {
  const seen = LATENCY_MARKS.filter((m) => at[m] !== undefined);
  if (seen.length === 0) return EMPTY_LATENCY;
  // Anchor on the earliest timestamp (marks can arrive out of pipeline order,
  // e.g. a permission notice from main racing a renderer mark).
  const t0 = Math.min(...seen.map((m) => at[m] as number));
  const marks: Partial<Record<LatencyMark, number>> = {};
  for (const m of seen) marks[m] = Math.max(0, Math.round((at[m] as number) - t0));
  const segments: LatencySnapshot["segments"] = [];
  for (let i = 1; i < seen.length; i++) {
    segments.push({
      from: seen[i - 1],
      to: seen[i],
      ms: Math.max(0, Math.round((at[seen[i]] as number) - (at[seen[i - 1]] as number))),
    });
  }
  return {
    marks,
    stage: seen[seen.length - 1],
    totalMs: marks.session_ready ?? marks.first_audio ?? null,
    segments,
  };
}

/** Compact human label for the overlay: "1.2s" once the turn lands, else the live stage. */
export function formatLatency(s: LatencySnapshot): string | null {
  if (!s.stage) return null;
  if (s.totalMs !== null) return `${(s.totalMs / 1000).toFixed(1)}s`;
  return s.stage.replace(/_/g, " ");
}

/** Shared per-app trace: STT engines, orchestrator and TTS all mark into it. */
export const latencyTrace = new LatencyTrace();
