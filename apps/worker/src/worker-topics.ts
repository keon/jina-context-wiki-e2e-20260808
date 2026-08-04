export const CONTEXT_BOARD_TOPICS = [
  "run-context-input-snapshot",
  "run-context-page-plan",
  "run-context-page-build",
  "run-context-publication"
] as const;

/** Internal implementation stages executed inside one durable Context task. */
const _INTERNAL_CONTEXT_STAGE_TOPICS = [
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
  "run-context-pageindex"
] as const;

export const CAUSAL_GRAPH_TOPICS = [
  "run-causal-graph-history",
  "run-causal-graph-derive",
  "run-causal-graph-publication"
] as const;

export const REVIEW_BOARD_TOPICS = [
  "prepare-review",
  "summary-review",
  "runtime-review",
  "finalize-review",
  "publish-review",
  "settle-review"
] as const;

export const CONTROL_BOARD_TOPICS = ["github-installation-backfill", "billing-retry"] as const;

export const SUPPORTED_WORKER_TOPICS = [
  "run-review",
  ...REVIEW_BOARD_TOPICS,
  ...CONTROL_BOARD_TOPICS,
  ...CONTEXT_BOARD_TOPICS,
  ...CAUSAL_GRAPH_TOPICS
] as const;

export type ContextWorkerTopic = (typeof CONTEXT_BOARD_TOPICS)[number];
export type InternalContextStageTopic = (typeof _INTERNAL_CONTEXT_STAGE_TOPICS)[number];
export type CausalGraphWorkerTopic = (typeof CAUSAL_GRAPH_TOPICS)[number];
export type ReviewBoardWorkerTopic = (typeof REVIEW_BOARD_TOPICS)[number];
export type ControlBoardWorkerTopic = (typeof CONTROL_BOARD_TOPICS)[number];
export type WorkerTopic = (typeof SUPPORTED_WORKER_TOPICS)[number] | InternalContextStageTopic;
export type WorkerClaimMode = "enabled" | "paused";

export function configuredWorkerClaimMode(value: string | undefined): WorkerClaimMode {
  const mode = value?.trim() || "enabled";
  if (mode !== "enabled" && mode !== "paused") {
    throw new Error("JINA_WORKER_CLAIM_MODE must be enabled or paused");
  }
  return mode;
}

export function configuredWorkerPreferredRepository(value: string | undefined): string | undefined {
  const repository = value?.trim();
  if (!repository) return undefined;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("WORKER_PREFERRED_REPOSITORY must be an owner/repository name");
  }
  return repository;
}

export function configuredWorkerTopics(value: string | undefined): WorkerTopic[] {
  const requested = (value ?? "run-review")
    .split(/[|,]/)
    .map((topic) => topic.trim())
    .filter(Boolean);
  const unknown = requested.filter(
    (topic) => !SUPPORTED_WORKER_TOPICS.includes(topic as (typeof SUPPORTED_WORKER_TOPICS)[number])
  );
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
export function requiresBoardAgentExecutor(topics: readonly WorkerTopic[]): boolean {
  return topics.some(
    (topic) =>
      CONTEXT_BOARD_TOPICS.includes(topic as ContextWorkerTopic) ||
      CAUSAL_GRAPH_TOPICS.includes(topic as CausalGraphWorkerTopic)
  );
}

export function workerClaimTimeoutMs(
  topics: readonly WorkerTopic[],
  workerApiTimeoutMs: number,
  contextApiTimeoutMs: number
): number {
  return requiresBoardAgentExecutor(topics) ? contextApiTimeoutMs : workerApiTimeoutMs;
}
