import {
  addDependency,
  addTask,
  createBoardTask,
  reduceBoard,
  type TaskDependencyDraft
} from "@jina/board";
import { planPrReview, type PlannedTask, type PrReviewPlan } from "@jina/review";
import type { IsoTimestamp } from "@jina/shared-kernel";
import type { WorkflowState } from "../state.js";

export interface PullRequestReviewInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly epoch?: number;
  readonly needsExternalContext?: boolean;
}

export function ingestPullRequestReview(
  state: WorkflowState,
  input: PullRequestReviewInput,
  now: IsoTimestamp
): WorkflowState {
  const plan = planPrReview({
    ...input,
    epoch: input.epoch ?? 1
  });

  let board = state.board;
  for (const task of plan.tasks) {
    board = addTask(board, toBoardTask(task, plan, now));
  }

  for (const dependency of plan.dependencies) {
    board = addDependency(board, toBoardDependency(dependency), now);
  }

  const nextPlans = state.reviewPlans.some((existing) => existing.rootTaskId === plan.rootTaskId)
    ? state.reviewPlans
    : [...state.reviewPlans, plan];

  return {
    ...state,
    board: reduceBoard(board, now),
    reviewPlans: nextPlans
  };
}

function toBoardTask(task: PlannedTask, plan: PrReviewPlan, now: IsoTimestamp) {
  return createBoardTask({
    id: task.id,
    type: task.type,
    title: task.title,
    assigneeRole: task.assigneeRole,
    dedupeKey: task.dedupeKey,
    now,
    required: task.required,
    metadata: {
      ...task.metadata,
      pipelineSlug: plan.pipeline.slug,
      pipelineVersion: plan.pipeline.version
    },
    ...(task.dispatchTopic ? { dispatchTopic: task.dispatchTopic } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    epoch: plan.epoch
  });
}

function toBoardDependency(dependency: PrReviewPlan["dependencies"][number]): TaskDependencyDraft {
  return {
    taskId: dependency.taskId,
    dependsOnTaskId: dependency.dependsOnTaskId,
    relationship: dependency.relationship,
    required: dependency.required,
    blocksParentCompletion: dependency.blocksParentCompletion
  };
}
