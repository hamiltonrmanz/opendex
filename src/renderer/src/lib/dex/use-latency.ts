import { useSyncExternalStore } from "react";
import { latencyTrace, type LatencySnapshot } from "./latency-trace";

/** Subscribe a component to the live per-turn latency snapshot. */
export function useLatency(): LatencySnapshot {
  return useSyncExternalStore(
    (cb) => latencyTrace.subscribe(cb),
    () => latencyTrace.snapshot(),
  );
}
