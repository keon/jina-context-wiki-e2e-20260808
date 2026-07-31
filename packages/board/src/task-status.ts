export type TaskStatus =
  "triage" | "blocked" | "queued" | "in_progress" | "in_review" | "done" | "canceled" | "failed" | "superseded";

const terminalTaskStatuses = ["done", "canceled", "failed", "superseded"] as const;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return terminalTaskStatuses.includes(status as (typeof terminalTaskStatuses)[number]);
}

export function isTerminalFailure(status: TaskStatus): boolean {
  return status === "failed" || status === "canceled";
}
