import { findTasksByType, nextPendingOutboxMessage, type BoardTask, type TaskStatus } from "@jina/board";
import type { GitHubWebhookEvent } from "@jina/github";
import { ingestGitHubWebhook } from "../ingest/github-webhook.js";
import { ingestPullRequestReview } from "../ingest/pull-request.js";
import { drainOneOutboxMessage } from "../relay/outbox-relay.js";
import { createWorkflowState, type WorkflowState } from "../state.js";

runHappyPathWithContextHandoff();
runDuplicatePrWebhookDoesNotDuplicateBoard();

console.log("pr-review simulation ok");

function runHappyPathWithContextHandoff(): void {
  const clock = deterministicClock();
  const event: GitHubWebhookEvent = {
    type: "pull_request.opened",
    pullRequestNumber: 42,
    headSha: "abc123"
  };

  let state = ingestGitHubWebhook(
    createWorkflowState(),
    event,
    {
      tenantId: "tenant_1",
      repository: "omlabs/example",
      needsExternalContext: true
    },
    clock()
  );

  assertTaskStatus(state, "review_pass", "queued");
  assertTaskStatus(state, "publish", "triage");
  assertTaskStatus(state, "pr_review", "triage");
  assertPendingTopic(state, "run-review");

  state = drainRequiredStep(state, clock);
  assertTaskStatus(state, "review_pass", "blocked");
  assertTaskStatus(state, "context", "queued");
  assertPendingTopic(state, "run-research");

  state = drainRequiredStep(state, clock);
  assertTaskStatus(state, "context", "done");
  assertTaskStatus(state, "review_pass", "queued");
  assert(state.contextItems.length === 1, "research stores one cited context item");
  assertPendingTopic(state, "run-review");

  state = drainRequiredStep(state, clock);
  assertTaskStatus(state, "review_pass", "done");
  assertTaskStatus(state, "publish", "queued");
  assertPendingTopic(state, "run-publish");

  state = drainRequiredStep(state, clock);
  assertTaskStatus(state, "publish", "done");
  assertTaskStatus(state, "pr_review", "done");
  assert(state.publications.length === 1, "publish task records one publication");
  assert(nextPendingOutboxMessage(state.board) === undefined, "all outbox messages are drained");
}

function runDuplicatePrWebhookDoesNotDuplicateBoard(): void {
  const clock = deterministicClock();
  const input = {
    tenantId: "tenant_1",
    repository: "omlabs/example",
    pullRequestNumber: 42,
    headSha: "abc123",
    needsExternalContext: false
  };

  let state = ingestPullRequestReview(createWorkflowState(), input, clock());
  state = ingestPullRequestReview(state, input, clock());

  assert(state.board.tasks.length === 3, "duplicate PR ingestion keeps one root, one review, one publish task");
  assert(state.board.dependencies.length === 2, "duplicate PR ingestion keeps one dependency graph");
  assert(state.board.outbox.length === 1, "duplicate PR ingestion keeps one initial outbox message");
  assert(state.reviewPlans.length === 1, "duplicate PR ingestion keeps one review plan");
}

function drainRequiredStep(state: WorkflowState, clock: () => string): WorkflowState {
  const result = drainOneOutboxMessage(state, clock);
  assert(result !== undefined, "expected one pending outbox message");
  return result.state;
}

function assertTaskStatus(state: WorkflowState, type: BoardTask["type"], status: TaskStatus): void {
  const task = singleTask(state, type);
  assert(task.status === status, `expected ${type} to be ${status}, got ${task.status}`);
}

function assertPendingTopic(state: WorkflowState, topic: string): void {
  const message = nextPendingOutboxMessage(state.board);
  assert(message?.topic === topic, `expected pending topic ${topic}, got ${message?.topic ?? "none"}`);
}

function singleTask(state: WorkflowState, type: BoardTask["type"]): BoardTask {
  const tasks = findTasksByType(state.board, type);
  assert(tasks.length === 1, `expected one ${type} task, got ${tasks.length}`);
  const task = tasks[0];
  assert(task !== undefined, `expected ${type} task`);
  return task;
}

function deterministicClock(): () => string {
  let tick = 0;
  return () => {
    const seconds = String(tick).padStart(2, "0");
    tick += 1;
    return `2026-07-08T00:00:${seconds}.000Z`;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
