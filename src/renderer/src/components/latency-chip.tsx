import { useLatency } from "@/lib/dex/use-latency";
import { formatLatency, LATENCY_MARKS } from "@/lib/dex/latency-trace";

// Compact voice-latency readout, pinned bottom-left over any theme. Shows the
// live pipeline stage while a turn is in flight, then total time-to-first-audio.
// Hover for the per-stage breakdown. Numbers and stage names only — no text.
export function LatencyChip() {
  const snap = useLatency();
  const label = formatLatency(snap);
  if (!label) return null;

  const breakdown = LATENCY_MARKS.filter((m) => snap.marks[m] !== undefined)
    .map((m) => `${m.replace(/_/g, " ")}: +${snap.marks[m]}ms`)
    .join("\n");

  return (
    <div
      title={breakdown}
      className="pointer-events-auto fixed bottom-3 left-3 z-40 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 font-mono text-[10px] tracking-wide text-white/55 backdrop-blur"
    >
      {snap.totalMs === null ? `· ${label}` : `⏱ ${label}`}
    </div>
  );
}
