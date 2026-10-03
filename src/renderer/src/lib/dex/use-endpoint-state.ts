import { useSyncExternalStore } from "react";
import { endpointState, type EndpointUiState } from "./endpoint-state";

export function useEndpointState(): EndpointUiState {
  return useSyncExternalStore(endpointState.subscribe, endpointState.get);
}
