import type { ReviewRun } from "./types";

export function runResult(run: ReviewRun): ReviewRun["result"] {
  const merged: Record<string, unknown> = {};

  // Apply oldest -> newest events, then the stored result last so it wins on
  // top-level keys. Use mergeField so a partial event payload cannot clobber a
  // more complete nested work object already present.
  for (const event of run.events) {
    const payload = objectPayload(event.payload);
    if (payload) {
      mergeInto(merged, payload);
    }
  }

  const stored = objectPayload(run.result);
  if (stored) {
    mergeInto(merged, stored);
  }

  return Object.keys(merged).length > 0 ? (merged) : run.result;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, incoming] of Object.entries(source)) {
    target[key] = mergeField(target[key], incoming);
  }
}

/**
 * Decide which value to keep when a key already exists. The incoming value wins
 * by default (call order encodes precedence), but a more complete nested object
 * is never replaced by a sparser one.
 */
function mergeField(existing: unknown, incoming: unknown): unknown {
  if (incoming === undefined || incoming === null) {
    return existing ?? incoming;
  }
  const existingObj = objectPayload(existing);
  const incomingObj = objectPayload(incoming);
  if (existingObj && incomingObj) {
    return Object.keys(incomingObj).length >= Object.keys(existingObj).length ? incoming : existing;
  }
  return incoming;
}

function objectPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
