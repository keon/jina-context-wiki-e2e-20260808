import { reduceBoard, supersedeEpochTasks, type CommandActor } from "@jina/board";
import type { SourcePolicy } from "@jina/context";
import type { BudgetLimits } from "@jina/policy";
import { applyPrReviewPlan, planPrReview } from "@jina/review";
import type { IsoTimestamp } from "@jina/shared-kernel";
import { findPullRequest, newPullRequest, upsertPullRequest, type WorkflowState } from "../state.js";

const GITHUB_ACTOR: CommandActor = { type: "github", id: "github-webhook" };

export interface PullRequestReviewInput {
  readonly tenantId: string;
  readonly workspaceLabel?: string;
  readonly githubAccountId?: string;
  readonly repository: string;
  readonly githubRepositoryId?: number;
  readonly githubInstallationId?: number;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly authorGithubUserId?: number;
  readonly authorLogin?: string;
  readonly authorAccountType?: string;
  readonly senderGithubUserId?: number;
  readonly senderLogin?: string;
  readonly senderAccountType?: string;
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
    ...(input.workspaceLabel ? { workspaceLabel: input.workspaceLabel } : {}),
    ...(input.githubAccountId !== undefined ? { githubAccountId: input.githubAccountId } : {}),
    ...(input.githubRepositoryId !== undefined ? { githubRepositoryId: input.githubRepositoryId } : {}),
    ...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.authorGithubUserId !== undefined ? { authorGithubUserId: input.authorGithubUserId } : {}),
    ...(input.authorLogin ? { authorLogin: input.authorLogin } : {}),
    ...(input.authorAccountType ? { authorAccountType: input.authorAccountType } : {}),
    ...(input.senderGithubUserId !== undefined ? { senderGithubUserId: input.senderGithubUserId } : {}),
    ...(input.senderLogin ? { senderLogin: input.senderLogin } : {}),
    ...(input.senderAccountType ? { senderAccountType: input.senderAccountType } : {}),
    ...(input.needsExternalContext !== undefined ? { needsExternalContext: input.needsExternalContext } : {})
  });

  board = applyPrReviewPlan(board, plan, { actor: GITHUB_ACTOR, now });

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
    ...(existing ??
      newPullRequest(input.repository, input.pullRequestNumber, input.headSha, epoch, {
        tenantId: input.tenantId,
        ...(input.workspaceLabel ? { workspaceLabel: input.workspaceLabel } : {}),
        ...(input.githubAccountId !== undefined ? { githubAccountId: input.githubAccountId } : {}),
        ...(input.githubRepositoryId !== undefined ? { githubRepositoryId: input.githubRepositoryId } : {}),
        ...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
        ...(input.authorGithubUserId !== undefined ? { authorGithubUserId: input.authorGithubUserId } : {}),
        ...(input.authorLogin ? { authorLogin: input.authorLogin } : {}),
        ...(input.authorAccountType ? { authorAccountType: input.authorAccountType } : {})
      })),
    headSha: input.headSha,
    currentEpoch: epoch,
    tenantId: input.tenantId,
    ...(input.workspaceLabel ? { workspaceLabel: input.workspaceLabel } : {}),
    ...(input.githubAccountId !== undefined ? { githubAccountId: input.githubAccountId } : {}),
    ...(input.githubRepositoryId !== undefined ? { githubRepositoryId: input.githubRepositoryId } : {}),
    ...(input.githubInstallationId !== undefined ? { githubInstallationId: input.githubInstallationId } : {}),
    ...(input.authorGithubUserId !== undefined ? { authorGithubUserId: input.authorGithubUserId } : {}),
    ...(input.authorLogin ? { authorLogin: input.authorLogin } : {}),
    ...(input.authorAccountType ? { authorAccountType: input.authorAccountType } : {})
  });

  return next;
}
