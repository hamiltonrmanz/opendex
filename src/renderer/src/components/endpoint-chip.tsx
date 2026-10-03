import { useEndpointState } from "@/lib/dex/use-endpoint-state";

// Small bottom-center pill that mirrors the endpointer: waiting for you to start,
// hearing you, finalizing (silence detected — about to commit), committing.
const LABEL = {
  waiting: { text: "listening", dot: "bg-white/40" },
  speaking: { text: "hearing you", dot: "bg-cyan-300 animate-pulse" },
  finalizing: { text: "finalizing…", dot: "bg-amber-300 animate-pulse" },
  ended: { text: "got it", dot: "bg-emerald-300" },
} as const;

export function EndpointChip() {
  const state = useEndpointState();
  if (state === "idle") return null;
  const { text, dot } = LABEL[state];
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 font-mono text-[10px] tracking-wide text-white/60 backdrop-blur"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {text}
    </div>
  );
}
