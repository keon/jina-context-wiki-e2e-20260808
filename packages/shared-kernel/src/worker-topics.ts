/**
 * Queue topic names are a wire contract shared by API admission, workers, and
 * deployment configuration. Keep them here so a topic cannot be renamed in
 * only one process.
 */
export const legacyReviewWorkerTopic = "run-review" as const;
export type ReviewRunTopicMode = "disabled" | "legacy" | "relational";

export function configuredReviewRunTopicMode(
  value: string | undefined,
  legacyCompatibilityEnabled = false
): ReviewRunTopicMode {
  const normalized = value?.trim();
  if (!normalized) return legacyCompatibilityEnabled ? "legacy" : "disabled";
  if (normalized === "legacy" || normalized === "relational") return normalized;
  throw new Error("JINA_REVIEW_RUN_TOPIC_MODE must be legacy or relational when set");
}

export const reviewBoardTopics = {
  prepare: "prepare-review",
  summary: "summary-review",
  runtime: "runtime-review",
  finalize: "finalize-review",
  publish: "publish-review",
  settle: "settle-review"
} as const;

export const reviewBoardWorkerTopics = Object.values(reviewBoardTopics);
export type ReviewBoardWorkerTopic = (typeof reviewBoardTopics)[keyof typeof reviewBoardTopics];

export const controlBoardTopics = {
  githubInstallationBackfill: "github-installation-backfill",
  billingRetry: "billing-retry"
} as const;

export const controlBoardWorkerTopics = Object.values(controlBoardTopics);
export type ControlBoardWorkerTopic = (typeof controlBoardTopics)[keyof typeof controlBoardTopics];

export const contextWorkflowBoardTopics = {
  snapshot: "run-context-input-snapshot",
  planner: "run-context-page-plan",
  page: "run-context-page-build",
  publication: "run-context-publication"
} as const;

export const contextWorkflowWorkerTopics = Object.values(contextWorkflowBoardTopics);
export type ContextWorkflowWorkerTopic = (typeof contextWorkflowBoardTopics)[keyof typeof contextWorkflowBoardTopics];

/** Transitional stages run inside a durable page-oriented Context task. */
export const internalContextStageTopics = {
  researchPlan: "run-context-research-plan",
  research: "run-context-research",
  publicationPlan: "run-context-publication-plan",
  pageWrite: "run-context-page-write",
  pageAudit: "run-context-page-audit",
  pageRepair: "run-context-page-repair",
  sourceChallenge: "run-context-source-challenge",
  taskEvaluation: "run-context-task-evaluation",
  gapRepair: "run-context-gap-repair",
  certification: "run-context-certification",
  pageIndex: "run-context-pageindex"
} as const;

export type InternalContextStageTopic = (typeof internalContextStageTopics)[keyof typeof internalContextStageTopics];

/** Internal stages still embedded by the four durable page-oriented tasks. */
export const embeddedContextStageTopics = {
  researchPlan: internalContextStageTopics.researchPlan,
  research: internalContextStageTopics.research,
  publicationPlan: internalContextStageTopics.publicationPlan,
  pageWrite: internalContextStageTopics.pageWrite,
  pageAudit: internalContextStageTopics.pageAudit,
  pageRepair: internalContextStageTopics.pageRepair
} as const;

export type EmbeddedContextStageTopic = (typeof embeddedContextStageTopics)[keyof typeof embeddedContextStageTopics];

export const causalGraphBoardTopics = {
  snapshot: "run-causal-graph-history",
  derive: "run-causal-graph-derive",
  publication: "run-causal-graph-publication"
} as const;

export const causalGraphWorkerTopics = Object.values(causalGraphBoardTopics);
export type CausalGraphWorkerTopic = (typeof causalGraphBoardTopics)[keyof typeof causalGraphBoardTopics];

export const supportedWorkerTopics = [
  legacyReviewWorkerTopic,
  ...reviewBoardWorkerTopics,
  ...controlBoardWorkerTopics,
  ...contextWorkflowWorkerTopics,
  ...causalGraphWorkerTopics
] as const;

export type SupportedWorkerTopic = (typeof supportedWorkerTopics)[number];
export type WorkerTopic = SupportedWorkerTopic | InternalContextStageTopic;
