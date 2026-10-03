/**
 * Short-lived record of actions the reflex path already performed, so the full
 * model run on the same utterance doesn't repeat them. Exact-match only (tool
 * name + normalized input) and consumed once; unmatched calls run normally.
 */

export class ReflexLedger {
  private entries = new Map<string, number>();
  constructor(
    private readonly ttlMs = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  private static key(tool: string, input: unknown): string {
    return `${tool}:${JSON.stringify(normalize(input))}`;
  }

  record(tool: string, input: unknown): void {
    this.sweep();
    this.entries.set(ReflexLedger.key(tool, input), this.now() + this.ttlMs);
  }

  /** Undo a record (the action failed or was denied) so the model may retry. */
  release(tool: string, input: unknown): void {
    this.entries.delete(ReflexLedger.key(tool, input));
  }

  /** True (once) if this exact call was just done by the reflex path. */
  claim(tool: string, input: unknown): boolean {
    this.sweep();
    return this.entries.delete(ReflexLedger.key(tool, input));
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, exp] of this.entries) if (exp <= t) this.entries.delete(k);
  }
}

function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.trim().toLowerCase();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, normalize(val)]),
    );
  }
  return v;
}

export const reflexLedger = new ReflexLedger();
