import {
  applyCommand,
  reduceBoard,
  supersedeEpochTasks,
  type BoardState,
  type CommandActor
} from "@jina/board";
import type { SourcePolicy } from "@jina/context";
import type { BudgetLimits } from "@jina/policy";
import { planPrReview, type PrReviewPlan } from "@jina/review";
import type { IsoTimestamp } from "@jina/shared-kernel";
import { findPullRequest, newPullRequest, upsertPullRequest, type WorkflowState } from "../state.js";

const GITHUB_ACTOR: CommandActor = { type: "github", id: "github-webhook" };

export interface PullRequestReviewInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly needsExternalContext?: boolean;
  readonly budgetLimits?: BudgetLimits;
  readonly sourcePolicy?: SourcePolicy;
}

export function ingestPullRequestReview(
  state: WorkflowState,
  input: PullRequestReviewInput,
  now: IsoTimestamp
): WorkflowState {
  const existing = findPullRequest(state, input.repository, input.pullRequestNumber);
  const isNewHead = existing !== undefined && existing.headSha !== input.headSha;
  const epoch = existing ? (isNewHead ? existing.currentEpoch + 1 : existing.currentEpoch) : 1;

  let board = state.board;
  if (isNewHead) {
    board = supersedeEpochTasks(
      board,
      epoch,
      now,
      (task) =>
        task.metadata.tenantId === input.tenantId &&
        task.metadata.repository === input.repository &&
        task.metadata.pullRequestNumber === input.pullRequestNumber
    );
  }

  const plan = planPrReview({
    tenantId: input.tenantId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    epoch,
    ...(input.needsExternalContext !== undefined ? { needsExternalContext: input.needsExternalContext } : {})
  });

  board = applyPlan(board, plan, now);

  let next: WorkflowState = {
    ...state,
    board: reduceBoard(board, now),
    reviewPlans: state.reviewPlans.some((candidate) => candidate.rootTaskId === plan.rootTaskId)
      ? state.reviewPlans
      : [...state.reviewPlans, plan],
    ...(input.sourcePolicy ? { sourcePolicy: input.sourcePolicy } : {}),
    ...(input.budgetLimits ? { budgetLimits: input.budgetLimits } : {})
  };

  next = upsertPullRequest(next, {
    ...(existing ?? newPullRequest(input.repository, input.pullRequestNumber, input.headSha, epoch)),
    headSha: input.headSha,
    currentEpoch: epoch
  });

  return next;
}

function applyPlan(board: BoardState, plan: PrReviewPlan, now: IsoTimestamp): BoardState {
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
            pipelineVersion: plan.pipeline.version
          },
          ...(task.dispatchTopic ? { dispatchTopic: task.dispatchTopic } : {}),
          ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
          epoch: plan.epoch
        }
      },
      { actor: GITHUB_ACTOR, now }
    ).state;
  }

  for (const dependency of plan.dependencies) {
    next = applyCommand(
      next,
      {
        command: "LinkTask",
        dependency: {
          taskId: dependency.taskId,
          dependsOnTaskId: dependency.dependsOnTaskId,
          relationship: dependency.relationship,
          required: dependency.required,
          blocksParentCompletion: dependency.blocksParentCompletion
        }
      },
      { actor: GITHUB_ACTOR, now }
    ).state;
  }

  return next;
}
