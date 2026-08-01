export const CONTEXT_BOARD_TOPICS = [
  "run-context-input-snapshot",
  "run-context-research-plan",
  "run-context-research",
  "run-context-publication-plan",
  "run-context-page-write",
  "run-context-page-audit",
  "run-context-page-repair",
  "run-context-source-challenge",
  "run-context-task-evaluation",
  "run-context-gap-repair",
  "run-context-certification",
  "run-context-publication",
  "run-context-pageindex"
] as const;

export const SUPPORTED_WORKER_TOPICS = ["run-review", ...CONTEXT_BOARD_TOPICS] as const;

export type WorkerTopic = (typeof SUPPORTED_WORKER_TOPICS)[number];
export type ContextWorkerTopic = (typeof CONTEXT_BOARD_TOPICS)[number];
export type WorkerClaimMode = "enabled" | "paused";

export function configuredWorkerClaimMode(value: string | undefined): WorkerClaimMode {
  const mode = value?.trim() || "enabled";
  if (mode !== "enabled" && mode !== "paused") {
    throw new Error("JINA_WORKER_CLAIM_MODE must be enabled or paused");
  }
  return mode;
}

export function configuredWorkerTopics(value: string | undefined): WorkerTopic[] {
  const requested = (value ?? "run-review")
    .split(/[|,]/)
    .map((topic) => topic.trim())
    .filter(Boolean);
  const unknown = requested.filter((topic) => !SUPPORTED_WORKER_TOPICS.includes(topic as WorkerTopic));
  if (unknown.length > 0) {
    throw new Error(`WORKER_TOPICS contains unsupported topics: ${unknown.join(", ")}`);
  }
  if (requested.length === 0) throw new Error("WORKER_TOPICS must contain at least one topic");
  return [...new Set(requested as WorkerTopic[])];
}

/**
 * Every Context worker must pass the Daytona production preflight, including a
 * worker that happens to claim only snapshot, publication, or PageIndex work.
 */
export function requiresContextBoardExecutor(topics: readonly WorkerTopic[]): boolean {
  return topics.some((topic) => CONTEXT_BOARD_TOPICS.includes(topic as ContextWorkerTopic));
}

export function workerClaimTimeoutMs(
  topics: readonly WorkerTopic[],
  workerApiTimeoutMs: number,
  contextApiTimeoutMs: number
): number {
  return requiresContextBoardExecutor(topics) ? contextApiTimeoutMs : workerApiTimeoutMs;
}
