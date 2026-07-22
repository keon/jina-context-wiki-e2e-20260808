"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared connection status for the header indicator. Pages report the outcome
 * of their polls; the header subscribes without owning any fetch.
 */

type ConnectionState = boolean | undefined;

let state: ConnectionState;
const listeners = new Set<() => void>();

export function reportConnection(online: boolean): void {
  if (state === online) return;
  state = online;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnection(): ConnectionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => undefined
  );
}
