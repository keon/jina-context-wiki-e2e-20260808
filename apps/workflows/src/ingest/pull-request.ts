import {
  addDependency,
  addTask,
  reduceBoard,
  type BoardState,
  type TaskDependencyDraft
} from "@jina/board";
import { planPrReviewFactoryRun, type PlannedTask, type PrReviewFactoryPlan } from "@jina/factory";
import type { IsoTimestamp } from "@jina/shared-kernel";
import { createBoardTask } from "@jina/board";
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
  const plan = planPrReviewFactoryRun({
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

  const nextPlans = state.factoryPlans.some((existing) => existing.factoryRunId === plan.factoryRunId)
    ? state.factoryPlans
    : [...state.factoryPlans, plan];

  return {
    ...state,
    board: reduceBoard(board, now),
    factoryPlans: nextPlans
  };
}

function toBoardTask(task: PlannedTask, plan: PrReviewFactoryPlan, now: IsoTimestamp) {
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
      factoryRunId: plan.factoryRunId,
      assemblyLineSlug: plan.assemblyLine.slug,
      assemblyLineVersion: plan.assemblyLine.version
    },
    ...(task.dispatchTopic ? { dispatchTopic: task.dispatchTopic } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    epoch: plan.epoch
  });
}

function toBoardDependency(dependency: PrReviewFactoryPlan["dependencies"][number]): TaskDependencyDraft {
  return {
    taskId: dependency.taskId,
    dependsOnTaskId: dependency.dependsOnTaskId,
    relationship: dependency.relationship,
    required: dependency.required,
    blocksParentCompletion: dependency.blocksParentCompletion
  };
}
