export type ContextBuildStage = {
  id: string;
  type: string;
  title: string;
  status: "triage" | "queued" | "in_progress" | "done" | "failed" | "canceled" | string;
  attempt: number;
  failureCode?: string;
  failureReason?: string;
  updatedAt: string;
};

export type ContextCheckpointPage = {
  documentPath: string;
  title: string;
  bytes: number;
  validationStatus: "pending" | "valid" | "invalid";
  diagnostics: string[];
  checkpointSequence: number;
  updatedAt: string;
};

export function contextBuildLabel(build: {
  repository?: string;
  ref?: string;
  refSequence?: number;
  commitSha?: string;
}): string {
  const parts = [build.repository || "Repository"];
  if (build.ref) parts.push(build.ref);
  if (typeof build.refSequence === "number" && Number.isSafeInteger(build.refSequence)) {
    parts.push(`seq ${build.refSequence}`);
  }
  if (build.commitSha) parts.push(build.commitSha.slice(0, 8));
  return parts.join(" · ");
}

export function contextStageStatus(stage: ContextBuildStage): string {
  return {
    triage: "Preparing",
    queued: "Queued",
    in_progress: "In progress",
    done: "Complete",
    failed: "Failed",
    canceled: "Canceled",
  }[stage.status] ?? stage.status.replace(/_/g, " ");
}

export function contextStageTiming(
  stage: ContextBuildStage,
  now = Date.now(),
): string {
  const updatedAt = Date.parse(stage.updatedAt);
  if (!Number.isFinite(updatedAt)) return "";
  const duration = formatDuration(Math.max(0, now - updatedAt));
  if (stage.status === "in_progress") return `Running for ${duration}`;
  if (stage.status === "queued" || stage.status === "triage") {
    return `Waiting for ${duration}`;
  }
  return `Updated ${duration} ago`;
}

export function contextStageCounts(stages: readonly ContextBuildStage[]) {
  return {
    complete: stages.filter((stage) => stage.status === "done").length,
    running: stages.filter((stage) => stage.status === "in_progress").length,
    waiting: stages.filter(
      (stage) => stage.status === "queued" || stage.status === "triage",
    ).length,
    failed: stages.filter(
      (stage) => stage.status === "failed" || stage.status === "canceled",
    ).length,
    retried: stages.filter((stage) => stage.attempt > 1).length,
  };
}

export function contextCheckpointCounts(pages: readonly ContextCheckpointPage[]) {
  return {
    verified: pages.filter((page) => page.validationStatus === "valid").length,
    pending: pages.filter((page) => page.validationStatus === "pending").length,
    invalid: pages.filter((page) => page.validationStatus === "invalid").length,
  };
}

export function contextDeadlineText(
  deadlineAt: string | undefined,
  now = Date.now(),
): string {
  const deadline = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  if (!Number.isFinite(deadline)) return "";
  const remaining = deadline - now;
  return remaining >= 0
    ? `Deadline in ${formatDuration(remaining)}`
    : `Deadline passed ${formatDuration(-remaining)} ago`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
