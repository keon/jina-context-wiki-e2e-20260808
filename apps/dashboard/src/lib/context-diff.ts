import type { ContextDiffResponse } from "./types.ts";

export function resolveContextDiffReleaseId(currentId: string, candidateIds: readonly string[]): string {
  return currentId && candidateIds.includes(currentId) ? currentId : (candidateIds[0] ?? "");
}

export function isCurrentContextDiff(
  diff: ContextDiffResponse | null,
  toReleaseId: string,
  candidateIds: readonly string[]
): diff is ContextDiffResponse {
  return Boolean(diff && diff.to.id === toReleaseId && candidateIds.includes(diff.from.id));
}
