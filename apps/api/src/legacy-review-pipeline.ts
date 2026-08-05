import { applyCommand, type BoardState, type CommandActor } from "@jina/board";
import { entityId, type EntityId, type IsoTimestamp } from "@jina/shared-kernel";

/**
 * Compatibility planner for the production `run-review` queue. Fresh webhook
 * admission remains here only until the documented product API and relational
 * review-topic cutover; persisted work keeps this contract alive until drain.
 */

interface PipelineRef {
  readonly slug: "pr_review";
  readonly version: string;
}

type PlannedTaskId = EntityId<"task">;

interface PlannedTask {
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

interface PlannedTaskDependency {
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
  }
] as const;

interface PrReviewInput {
  readonly tenantId: string;
  /** Human-readable organization or personal workspace label. */
  readonly workspaceLabel?: string;
  /** Stable GitHub account id as a decimal string (the source column is bigint). */
  readonly githubAccountId?: string;
  readonly repository: string;
  readonly githubRepositoryId?: number;
  readonly githubInstallationId?: number;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly epoch: number;
  readonly authorGithubUserId?: number;
  readonly authorLogin?: string;
  readonly authorAccountType?: string;
  readonly senderGithubUserId?: number;
  readonly senderLogin?: string;
  readonly senderAccountType?: string;
  readonly needsExternalContext?: boolean;
  readonly includePublication?: boolean;
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
  const includePublication = input.includePublication ?? true;
  const identityMetadata = {
    tenantId: input.tenantId,
    ...(input.workspaceLabel ? { workspaceLabel: input.workspaceLabel } : {}),
    ...(input.githubAccountId !== undefined ? { githubAccountId: input.githubAccountId } : {}),
    repository: input.repository,
    ...(input.githubRepositoryId !== undefined ? { githubRepositoryId: input.githubRepositoryId } : {}),
    ...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.authorGithubUserId !== undefined ? { authorGithubUserId: input.authorGithubUserId } : {}),
    ...(input.authorLogin ? { authorLogin: input.authorLogin } : {}),
    ...(input.authorAccountType ? { authorAccountType: input.authorAccountType } : {}),
    ...(input.senderGithubUserId !== undefined ? { senderGithubUserId: input.senderGithubUserId } : {}),
    ...(input.senderLogin ? { senderLogin: input.senderLogin } : {}),
    ...(input.senderAccountType ? { senderAccountType: input.senderAccountType } : {})
  };

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
          ...identityMetadata,
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
          ...identityMetadata,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha,
          needsExternalContext: input.needsExternalContext ?? true
        }
      },
      ...(includePublication
        ? [
            {
              id: publishTaskId,
              type: "publish" as const,
              title: "Publish review feedback",
              assigneeRole: "publisher" as const,
              dedupeKey: `${subjectKey}:publish`,
              required: true,
              dispatchTopic: "run-publish" as const,
              parentTaskId: rootTaskId,
              metadata: {
                ...identityMetadata,
                pullRequestNumber: input.pullRequestNumber,
                headSha: input.headSha
              }
            }
          ]
        : [])
    ],
    dependencies: includePublication
      ? [
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
      : [
          {
            taskId: rootTaskId,
            dependsOnTaskId: reviewTaskId,
            relationship: "blocks",
            required: true,
            blocksParentCompletion: true
          }
        ]
  };
}

export function applyPrReviewPlan(
  board: BoardState,
  plan: PrReviewPlan,
  options: { readonly actor: CommandActor; readonly now: IsoTimestamp; readonly taskMetadata?: Record<string, unknown> }
): BoardState {
  let next = board;
  for (const task of plan.tasks) {
    next = applyCommand(
      next,
      {
        command: "CreateTask",
        task: {
          id: task.id,
          type: task.type,
          title: task.title,
          assigneeRole: task.assigneeRole,
          dedupeKey: task.dedupeKey,
          required: task.required,
          metadata: {
            ...task.metadata,
            pipelineSlug: plan.pipeline.slug,
            pipelineVersion: plan.pipeline.version,
            ...options.taskMetadata
          },
          ...(task.dispatchTopic ? { dispatchTopic: task.dispatchTopic } : {}),
          ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
          epoch: plan.epoch
        }
      },
      { actor: options.actor, now: options.now }
    ).state;
  }
  for (const dependency of plan.dependencies) {
    next = applyCommand(next, { command: "LinkTask", dependency }, { actor: options.actor, now: options.now }).state;
  }
  return next;
}
