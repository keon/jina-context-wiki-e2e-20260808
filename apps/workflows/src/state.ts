import { createEmptyBoardState, type BoardState } from "@jina/board";
import type { ContextItemDraft, SourcePolicy } from "@jina/context";
import { emptyBudgetSpend, recordSpend, type BudgetLimits, type BudgetSpend } from "@jina/policy";
import type { PublicationRecord } from "@jina/publication";
import type { FindingThread, PrReviewPlan } from "@jina/review";

export interface TrackedPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly currentEpoch: number;
  readonly spend: BudgetSpend;
}

export interface StoredContextItem {
  readonly taskId: string;
  readonly targetTaskId: string;
  readonly item: ContextItemDraft;
}

export interface StoredFinding {
  readonly taskId: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly headSha: string;
}

export interface WorkflowState {
  readonly board: BoardState;
  readonly reviewPlans: readonly PrReviewPlan[];
  readonly pullRequests: readonly TrackedPullRequest[];
  readonly contextItems: readonly StoredContextItem[];
  readonly findings: readonly StoredFinding[];
  readonly findingThreads: readonly FindingThread[];
  readonly publications: readonly PublicationRecord[];
  readonly sourcePolicy: SourcePolicy;
  readonly budgetLimits?: BudgetLimits;
}

export function createWorkflowState(): WorkflowState {
  return {
    board: createEmptyBoardState(),
    reviewPlans: [],
    pullRequests: [],
    contextItems: [],
    findings: [],
    findingThreads: [],
    publications: [],
    sourcePolicy: { egressEnabled: false, allowlist: [] }
  };
}

export function findPullRequest(
  state: WorkflowState,
  repository: string,
  number: number
): TrackedPullRequest | undefined {
  return state.pullRequests.find((pr) => pr.repository === repository && pr.number === number);
}

export function upsertPullRequest(state: WorkflowState, pr: TrackedPullRequest): WorkflowState {
  const exists = findPullRequest(state, pr.repository, pr.number);
  return {
    ...state,
    pullRequests: exists
      ? state.pullRequests.map((existing) =>
          existing.repository === pr.repository && existing.number === pr.number ? pr : existing
        )
      : [...state.pullRequests, pr]
  };
}

export function recordPullRequestSpend(
  state: WorkflowState,
  repository: string,
  number: number,
  epoch: number,
  amount: number
): WorkflowState {
  const pr = findPullRequest(state, repository, number);
  if (!pr) {
    return state;
  }
  return upsertPullRequest(state, { ...pr, spend: recordSpend(pr.spend, epoch, amount) });
}

export function newPullRequest(repository: string, number: number, headSha: string, epoch: number): TrackedPullRequest {
  return { repository, number, headSha, currentEpoch: epoch, spend: emptyBudgetSpend };
}
