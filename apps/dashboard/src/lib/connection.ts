/**
 * Shared connection status. Pages report the outcome of their polls so a
 * future live-status surface can consume one authoritative state.
 */

type ConnectionState = boolean | undefined;

let state: ConnectionState;
const listeners = new Set<() => void>();

export function reportConnection(online: boolean): void {
  if (state === online) return;
  state = online;
  for (const listener of listeners) listener();
}
