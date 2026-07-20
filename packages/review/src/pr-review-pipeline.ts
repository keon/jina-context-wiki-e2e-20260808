import { entityId, type EntityId } from "@jina/shared-kernel";

export interface PipelineRef {
  readonly slug: "pr_review";
  readonly version: string;
}

export type PlannedTaskId = EntityId<"task">;

export interface PlannedTask {
  readonly id: PlannedTaskId;
  readonly type: "pr_review" | "review_pass" | "publish";
  readonly title: string;
  readonly assigneeRole: "system" | "review_agent" | "publisher";
  readonly dedupeKey: string;
  readonly required: boolean;
  readonly dispatchTopic?: "run-review" | "run-publish";
  readonly parentTaskId?: PlannedTaskId;
  readonly metadata: Record<string, unknown>;
}

export interface PlannedTaskDependency {
  readonly taskId: PlannedTaskId;
  readonly dependsOnTaskId: PlannedTaskId;
  readonly relationship: "publishes" | "blocks";
  readonly required: boolean;
  readonly blocksParentCompletion: boolean;
}

/**
 * Workflow-level dependency rules used by catalog/read-model consumers. Runtime
 * task dependencies are still materialized by the planner and board commands.
 */
export const prReviewTaskTypeDependencies = [
  {
    workflow: "pr_review",
    taskType: "pr_review",
    dependsOnTaskType: "review_pass",
    relationship: "blocks",
    required: true
  },
  {
    workflow: "pr_review",
    taskType: "pr_review",
    dependsOnTaskType: "publish",
    relationship: "blocks",
    required: true
  },
  {
    workflow: "pr_review",
    taskType: "pr_review",
    dependsOnTaskType: "publish",
    relationship: "publishes",
    required: true
  },
  {
    workflow: "pr_review",
    taskType: "publish",
    dependsOnTaskType: "review_pass",
    relationship: "blocks",
    required: true
  },
  {
    workflow: "pr_review",
    taskType: "review_pass",
    dependsOnTaskType: "context",
    relationship: "context_for",
    required: true,
    condition: "when external context is requested"
  }
] as const;

/** Intake/runtime events that create executable workflow tasks. */
export const prReviewTaskTypeTriggers = [
  {
    workflow: "pr_review",
    taskType: "pr_review",
    source: "GitHub pull_request webhook",
    description: "Creates the aggregate review workflow parent for a pull-request revision."
  },
  {
    workflow: "pr_review",
    taskType: "review_pass",
    source: "GitHub pull_request webhook",
    description: "Creates and queues the first executable review task."
  },
  {
    workflow: "pr_review",
    taskType: "publish",
    source: "GitHub pull_request webhook",
    description: "Creates the publish task in a waiting state; review_pass completion unblocks it."
  },
  {
    workflow: "pr_review",
    taskType: "context",
    source: "review_pass context request",
    description: "Creates a context task when the running review needs external information.",
    condition: "when external context is requested"
  }
] as const;

export interface PrReviewInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly epoch: number;
  readonly needsExternalContext?: boolean;
}

export interface PrReviewPlan {
  readonly pipeline: PipelineRef;
  readonly rootTaskId: PlannedTaskId;
  readonly epoch: number;
  readonly headSha: string;
  readonly tasks: readonly PlannedTask[];
  readonly dependencies: readonly PlannedTaskDependency[];
}

export function planPrReview(input: PrReviewInput): PrReviewPlan {
  const subjectKey = `${input.tenantId}:${input.repository}:pr-${input.pullRequestNumber}:epoch-${input.epoch}`;
  const rootTaskId = entityId<"task">(`task_${subjectKey}:root`);
  const reviewTaskId = entityId<"task">(`task_${subjectKey}:review:general`);
  const publishTaskId = entityId<"task">(`task_${subjectKey}:publish`);

  return {
    pipeline: { slug: "pr_review", version: "2026-07-08" },
    rootTaskId,
    epoch: input.epoch,
    headSha: input.headSha,
    tasks: [
      {
        id: rootTaskId,
        type: "pr_review",
        title: `Review ${input.repository}#${input.pullRequestNumber}`,
        assigneeRole: "system",
        dedupeKey: `${subjectKey}:root`,
        required: true,
        metadata: {
          tenantId: input.tenantId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha
        }
      },
      {
        id: reviewTaskId,
        type: "review_pass",
        title: "General review pass",
        assigneeRole: "review_agent",
        dedupeKey: `${subjectKey}:review:general`,
        required: true,
        dispatchTopic: "run-review",
        parentTaskId: rootTaskId,
        metadata: {
          tenantId: input.tenantId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha,
          needsExternalContext: input.needsExternalContext ?? true
        }
      },
      {
        id: publishTaskId,
        type: "publish",
        title: "Publish review feedback",
        assigneeRole: "publisher",
        dedupeKey: `${subjectKey}:publish`,
        required: true,
        dispatchTopic: "run-publish",
        parentTaskId: rootTaskId,
        metadata: {
          tenantId: input.tenantId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha
        }
      }
    ],
    dependencies: [
      {
        taskId: publishTaskId,
        dependsOnTaskId: reviewTaskId,
        relationship: "blocks",
        required: true,
        blocksParentCompletion: true
      },
      {
        taskId: rootTaskId,
        dependsOnTaskId: publishTaskId,
        relationship: "publishes",
        required: true,
        blocksParentCompletion: true
      }
    ]
  };
}
