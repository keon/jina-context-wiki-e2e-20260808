import type { ContextBuildSummary } from "./types.ts";

/**
 * Context's durable Board exposes terminal task stages as `done`, while the
 * public build status is normalized to `completed`. Accept both spellings so
 * the dashboard does not report a completed workflow as 0/N stages.
 */
export function completedContextStageCount(stages: readonly { readonly status: string }[]): number {
  return stages.filter((stage) => stage.status === "done" || stage.status === "completed").length;
}

/**
 * Pick the build that best represents the current state of one repository/ref.
 *
 * Build status is deliberately not part of the ordering. A historical failure
 * must not hide a newer successful build (and a newly admitted active build will
 * naturally win once its updated timestamp advances). refSequence is the stable
 * tie-breaker for APIs that serialize timestamps at the same precision.
 */
export function newestContextBuild(builds: readonly ContextBuildSummary[]): ContextBuildSummary | undefined {
  return [...builds].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.refSequence - left.refSequence ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id)
  )[0];
}
