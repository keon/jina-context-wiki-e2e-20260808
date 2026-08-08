/**
 * Queue topic names are a wire contract shared by API admission, workers, and
 * deployment configuration. Keep them here so a topic cannot be renamed in
 * only one process.
 */
export const reviewWorkerTopic = "run-review" as const;
export const contextWikiWorkerTopic = "run-wiki-build" as const;

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

/** Private stages embedded inside a durable page-oriented Context task. */
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
  reviewWorkerTopic,
  contextWikiWorkerTopic,
  ...controlBoardWorkerTopics,
  ...contextWorkflowWorkerTopics,
  ...causalGraphWorkerTopics
] as const;

export type SupportedWorkerTopic = (typeof supportedWorkerTopics)[number];
export type WorkerTopic = SupportedWorkerTopic | InternalContextStageTopic;
