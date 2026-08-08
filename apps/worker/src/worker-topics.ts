import {
  causalGraphWorkerTopics,
  contextWorkflowWorkerTopics,
  controlBoardWorkerTopics,
  reviewWorkerTopic,
  supportedWorkerTopics,
  type CausalGraphWorkerTopic,
  type ControlBoardWorkerTopic,
  type ContextWorkflowWorkerTopic,
  type EmbeddedContextStageTopic,
  type SupportedWorkerTopic,
  type WorkerTopic
} from "@jina/shared-kernel";

export const CONTEXT_BOARD_TOPICS = contextWorkflowWorkerTopics;
export const CAUSAL_GRAPH_TOPICS = causalGraphWorkerTopics;
export const CONTROL_BOARD_TOPICS = controlBoardWorkerTopics;
export const SUPPORTED_WORKER_TOPICS = supportedWorkerTopics;

export type ContextWorkerTopic = ContextWorkflowWorkerTopic;
export type {
  CausalGraphWorkerTopic,
  ControlBoardWorkerTopic,
  EmbeddedContextStageTopic,
  SupportedWorkerTopic,
  WorkerTopic
};
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

export function configuredWorkerTopics(value: string | undefined): SupportedWorkerTopic[] {
  // A task worker with no explicit specialization runs the current relational
  // review/control Board. Context workers always set WORKER_TOPICS explicitly.
  const requested = (value ?? [reviewWorkerTopic, ...CONTROL_BOARD_TOPICS].join(","))
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
  return [...new Set(requested as SupportedWorkerTopic[])];
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
