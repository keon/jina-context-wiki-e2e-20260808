import {
  applyCommand,
  createEmptyBoardState,
  reduceBoard,
  supersedeEpochTasks,
  type BoardState,
  type CommandActor,
  type TaskId
} from "@jina/board";
import { isIssueTrigger, isReviewTrigger, type ParsedGitHubWebhook } from "@jina/github";
import { applyPrReviewPlan, planPrReview } from "@jina/review";
import { entityId, type IsoTimestamp } from "@jina/shared-kernel";

export interface TrackedPullRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly epoch: number;
}

export interface GitHubIntakeState {
  readonly board: BoardState;
  readonly pullRequests: readonly TrackedPullRequest[];
}

export interface GitHubIntakeOptions {
  readonly deliveryId: string;
  readonly now: IsoTimestamp;
  readonly tenantId?: string;
}

export interface GitHubIntakeResult {
  readonly state: GitHubIntakeState;
  readonly outcome: "created" | "duplicate" | "ignored";
  readonly createdTaskIds: readonly TaskId[];
}

export function createGitHubIntakeState(): GitHubIntakeState {
  return { board: createEmptyBoardState(), pullRequests: [] };
}

export function ingestGitHubWebhook(
  state: GitHubIntakeState,
  webhook: ParsedGitHubWebhook,
  options: GitHubIntakeOptions
): GitHubIntakeResult {
  const beforeIds = new Set(state.board.tasks.map((task) => task.id));
  const tenantId = options.tenantId ?? tenantIdFor(webhook);
  let next = state;

  if (isReviewTrigger(webhook.event)) {
    next = ingestPullRequest(next, webhook, tenantId, options);
  } else if (isIssueTrigger(webhook.event)) {
    next = ingestIssue(next, webhook, tenantId, options);
  } else {
    return { state, outcome: "ignored", createdTaskIds: [] };
  }

  const createdTaskIds = next.board.tasks.filter((task) => !beforeIds.has(task.id)).map((task) => task.id);
  return {
    state: next,
    outcome: createdTaskIds.length > 0 ? "created" : "duplicate",
    createdTaskIds
  };
}

function ingestPullRequest(
  state: GitHubIntakeState,
  webhook: ParsedGitHubWebhook,
  tenantId: string,
  options: GitHubIntakeOptions
): GitHubIntakeState {
  if (!isReviewTrigger(webhook.event)) {
    return state;
  }

  const event = webhook.event;
  const existing = state.pullRequests.find(
    (pullRequest) =>
      pullRequest.tenantId === tenantId &&
      pullRequest.repository === webhook.repository &&
      pullRequest.number === event.pullRequestNumber
  );
  const isNewHead = existing !== undefined && existing.headSha !== event.headSha;
  const epoch = existing ? (isNewHead ? existing.epoch + 1 : existing.epoch) : 1;

  let board = state.board;
  if (isNewHead) {
    board = supersedeEpochTasks(
      board,
      epoch,
      options.now,
      (task) =>
        task.metadata.tenantId === tenantId &&
        task.metadata.repository === webhook.repository &&
        task.metadata.pullRequestNumber === event.pullRequestNumber
    );
  }

  const plan = planPrReview({
    tenantId,
    repository: webhook.repository,
    pullRequestNumber: event.pullRequestNumber,
    headSha: event.headSha,
    epoch,
    needsExternalContext: false
  });
  board = applyPrReviewPlan(board, plan, {
    actor: { type: "github", id: `github-delivery:${options.deliveryId}` },
    now: options.now,
    taskMetadata: { githubDeliveryId: options.deliveryId }
  });

  const tracked: TrackedPullRequest = {
    tenantId,
    repository: webhook.repository,
    number: event.pullRequestNumber,
    headSha: event.headSha,
    epoch
  };

  return {
    board: reduceBoard(board, options.now),
    pullRequests: existing
      ? state.pullRequests.map((pullRequest) => (pullRequest === existing ? tracked : pullRequest))
      : [...state.pullRequests, tracked]
  };
}

function ingestIssue(
  state: GitHubIntakeState,
  webhook: ParsedGitHubWebhook,
  tenantId: string,
  options: GitHubIntakeOptions
): GitHubIntakeState {
  if (!isIssueTrigger(webhook.event)) {
    return state;
  }

  const event = webhook.event;
  const subjectKey = `${tenantId}:${webhook.repository}:issue-${event.issueNumber}`;
  const taskId = entityId<"task">(`task_${subjectKey}:triage`);
  if (state.board.tasks.some((task) => task.dedupeKey === `${subjectKey}:triage`)) {
    return state;
  }
  const actor: CommandActor = { type: "github", id: `github-delivery:${options.deliveryId}` };
  const created = applyCommand(
    state.board,
    {
      command: "CreateTask",
      task: {
        id: taskId,
        type: "issue_triage",
        title: `Triage ${webhook.repository}#${event.issueNumber}`,
        assigneeRole: "human",
        dedupeKey: `${subjectKey}:triage`,
        required: true,
        metadata: {
          tenantId,
          repository: webhook.repository,
          issueNumber: event.issueNumber,
          githubTitle: event.title,
          githubDeliveryId: options.deliveryId,
          ...(event.url ? { githubUrl: event.url } : {}),
          ...(event.authorLogin ? { authorLogin: event.authorLogin } : {}),
          ...(webhook.repositoryId !== undefined ? { githubRepositoryId: webhook.repositoryId } : {}),
          ...(webhook.installationId !== undefined ? { githubInstallationId: webhook.installationId } : {})
        }
      },
      blocksParentCompletion: false
    },
    { actor, now: options.now }
  );

  if (!created.accepted) {
    return { ...state, board: created.state };
  }

  const withEvent = applyCommand(
    created.state,
    {
      command: "CommentTask",
      taskId,
      eventType: "github.issue_opened",
      payload: { deliveryId: options.deliveryId }
    },
    { actor, now: options.now }
  );

  return { ...state, board: reduceBoard(withEvent.state, options.now) };
}

function tenantIdFor(webhook: ParsedGitHubWebhook): string {
  return webhook.installationId === undefined ? "github:unscoped" : `github:installation:${webhook.installationId}`;
}
