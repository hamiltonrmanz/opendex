import type { EndpointPhase } from "./engines/endpointer";

// Tiny external store for the current capture's endpointing phase, so the UI can
// show listening / finalizing without threading state through every engine.
// "idle" = no capture in flight.

export type EndpointUiState = EndpointPhase | "idle";

let current: EndpointUiState = "idle";
const listeners = new Set<() => void>();

export const endpointState = {
  get(): EndpointUiState {
    return current;
  },
  set(next: EndpointUiState): void {
    if (next === current) return;
    current = next;
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
