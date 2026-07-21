import {
  applyCommand,
  createContextForDependency,
  findTask,
  reduceBoard,
  type BoardTask,
  type TaskId,
  type CommandActor,
  type CommandGuard
} from "@jina/board";
import { isBudgetExhausted } from "@jina/policy";
import { buildFindingFingerprint, upsertFindingThread } from "@jina/review";
import { entityId, type IsoTimestamp } from "@jina/shared-kernel";
import { findPullRequest, recordPullRequestSpend, type TrackedPullRequest, type WorkflowState } from "../state.js";

const RUN_ACTOR: CommandActor = { type: "run", id: "run-review" };
const REVIEW_RUN_COST = 1000;

export function runReviewTask(state: WorkflowState, taskId: TaskId, now: IsoTimestamp): WorkflowState {
  const task = findTask(state.board, taskId);
  if (!task || task.status !== "queued") {
    return state;
  }

  const pr = pullRequestForTask(state, task);
  if (pr && task.epoch !== undefined && task.epoch !== pr.currentEpoch) {
    return state;
  }

  const epoch = task.epoch ?? 1;
  let next: WorkflowState = {
    ...state,
    board: applyCommand(
      state.board,
      { command: "TransitionTask", taskId, toStatus: "in_progress" },
      { actor: RUN_ACTOR, now }
    ).state
  };
  next = recordPullRequestSpend(next, repositoryOf(task), prNumberOf(task), epoch, REVIEW_RUN_COST);

  if (task.metadata.needsExternalContext === true && !hasSatisfiedContext(next, taskId)) {
    const requested = requestContext(next, task, epoch, now);
    if (requested.blocked) {
      return requested.state;
    }
    // Budget rejected the context request; the review continues without external context
    // and the rejection stays on the board as a command.rejected event.
    next = requested.state;
  }

  const fingerprint = buildFindingFingerprint({
    repoId: repositoryOf(task),
    path: "src/changed-file.ts",
    rule: "general-review",
    normalizedMessage: "suspicious change in diff"
  });
  const headSha = stringValue(task.metadata.headSha);

  const board = applyCommand(
    next.board,
    { command: "TransitionTask", taskId, toStatus: "done" },
    { actor: RUN_ACTOR, now }
  ).state;

  return {
    ...next,
    board: reduceBoard(board, now),
    findings: [...next.findings, { taskId, fingerprint, title: "Suspicious change in diff", headSha }],
    findingThreads: upsertFindingThread(next.findingThreads, fingerprint, headSha)
  };
}

function requestContext(
  state: WorkflowState,
  task: BoardTask,
  epoch: number,
  now: IsoTimestamp
): { readonly state: WorkflowState; readonly blocked: boolean } {
  const contextTaskId = entityId<"task">(`${task.id}:context:dependency-docs`);
  const created = applyCommand(
    state.board,
    {
      command: "CreateTask",
      task: {
        id: contextTaskId,
        type: "context",
        title: "Collect dependency context",
        assigneeRole: "research_agent",
        dedupeKey: `${task.dedupeKey}:context:dependency-docs`,
        required: true,
        dispatchTopic: "run-research",
        metadata: {
          targetTaskId: task.id,
          sourceUrls: ["https://example.com/dependency-docs"],
          question: "Extract dependency behavior relevant to this review."
        },
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        epoch
      },
      dependencies: [createContextForDependency(task.id, contextTaskId)]
    },
    { actor: RUN_ACTOR, now, guards: [budgetGuard(state, task, epoch)] }
  );

  if (!created.accepted) {
    return { state: { ...state, board: created.state }, blocked: false };
  }

  const blocked = applyCommand(
    created.state,
    { command: "TransitionTask", taskId: task.id, toStatus: "blocked" },
    { actor: RUN_ACTOR, now }
  ).state;

  return { state: { ...state, board: reduceBoard(blocked, now) }, blocked: true };
}

function budgetGuard(state: WorkflowState, task: BoardTask, epoch: number): CommandGuard {
  return () => {
    const pr = pullRequestForTask(state, task);
    if (!pr || !state.budgetLimits) {
      return undefined;
    }
    return isBudgetExhausted(state.budgetLimits, pr.spend, epoch)
      ? {
          reason: "budget_exhausted",
          detail: `spend ${pr.spend.total} reached the configured ceiling`
        }
      : undefined;
  };
}

function hasSatisfiedContext(state: WorkflowState, taskId: TaskId): boolean {
  const contextDependencies = state.board.dependencies.filter(
    (dependency) => dependency.taskId === taskId && dependency.relationship === "context_for"
  );

  return contextDependencies.some((dependency) => {
    const contextTask = findTask(state.board, dependency.dependsOnTaskId);
    return (
      contextTask?.status === "done" && state.contextItems.some((item) => item.taskId === dependency.dependsOnTaskId)
    );
  });
}

function pullRequestForTask(state: WorkflowState, task: BoardTask): TrackedPullRequest | undefined {
  return findPullRequest(state, repositoryOf(task), prNumberOf(task));
}

function repositoryOf(task: BoardTask): string {
  return stringValue(task.metadata.repository);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function prNumberOf(task: BoardTask): number {
  return Number(task.metadata.pullRequestNumber ?? 0);
}
