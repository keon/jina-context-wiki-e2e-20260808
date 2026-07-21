import {
  applyCommand,
  findTasksByType,
  nextPendingOutboxMessage,
  type BoardTask,
  type TaskStatus
} from "@jina/board";
import type { GitHubWebhookEvent } from "@jina/github";
import { aiCreditsForCost, defaultBillingPolicy, infraCreditsForRun } from "@jina/policy";
import { ingestGitHubWebhook, type GitHubWebhookIngestContext } from "../ingest/github-webhook.js";
import { ingestPullRequestReview } from "../ingest/pull-request.js";
import { drainOneOutboxMessage, drainOutbox } from "../relay/outbox-relay.js";
import { createWorkflowState, type WorkflowState } from "../state.js";
import { deterministicClock } from "./deterministic-clock.js";

const OPENED: GitHubWebhookEvent = { type: "pull_request.opened", pullRequestNumber: 42, headSha: "abc123" };
const SYNCHRONIZED: GitHubWebhookEvent = { type: "pull_request.synchronize", pullRequestNumber: 42, headSha: "def456" };

const BASE_CONTEXT: GitHubWebhookIngestContext = {
  tenantId: "tenant_1",
  repository: "omlabs/example",
  needsExternalContext: true,
  sourcePolicy: { egressEnabled: true, allowlist: ["https://example.com/"] }
};

runHappyPathWithContextHandoff();
runDuplicatePrWebhookDoesNotDuplicateBoard();
runSupersessionMidReview();
runFailedContextTerminatesAutomatedDependents();
runBudgetExhaustionSkipsContext();
runTransitionLegality();
runBillingCreditMath();

console.log("pr-review simulation ok");

function runHappyPathWithContextHandoff(): void {
  const clock = deterministicClock();
  let state = ingestGitHubWebhook(createWorkflowState(), OPENED, BASE_CONTEXT, clock());

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
  assert(state.findings.length === 1, "review records one finding");
  assert(state.findingThreads.length === 1, "one finding thread exists");
  assertPendingTopic(state, "run-publish");

  state = drainRequiredStep(state, clock);
  assertTaskStatus(state, "publish", "done");
  assertTaskStatus(state, "pr_review", "done");
  assert(state.publications.length === 1, "publish records one publication");
  assert(state.publications[0]?.key.includes("abc123") === true, "publication key is fenced by head SHA");
  assert(nextPendingOutboxMessage(state.board) === undefined, "all outbox messages are drained");

  const reviewEvents = state.board.events.filter((event) => event.taskId === singleTask(state, "review_pass").id);
  assert(
    reviewEvents.every((event, index) => event.seq === index + 1),
    "task events carry a gapless per-task seq"
  );
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
  assert(state.board.dependencies.length === 4, "duplicate PR ingestion keeps one dependency graph");
  assert(state.board.outbox.length === 1, "duplicate PR ingestion keeps one initial outbox message");
  assert(state.reviewPlans.length === 1, "duplicate PR ingestion keeps one review plan");
  const pr = state.pullRequests[0];
  assert(pr?.currentEpoch === 1, "duplicate delivery does not bump the epoch");
}

function runSupersessionMidReview(): void {
  const clock = deterministicClock();
  let state = ingestGitHubWebhook(createWorkflowState(), OPENED, BASE_CONTEXT, clock());

  // The review requests context, then the PR is force-pushed while research is still pending.
  state = drainRequiredStep(state, clock);
  assertTaskStatus(state, "review_pass", "blocked", 1);
  assertTaskStatus(state, "context", "queued", 1);

  state = ingestGitHubWebhook(state, SYNCHRONIZED, BASE_CONTEXT, clock());
  assert(state.pullRequests[0]?.currentEpoch === 2, "synchronize bumps the epoch");
  for (const type of ["pr_review", "review_pass", "publish", "context"] as const) {
    for (const task of tasksOf(state, type, 1)) {
      assert(task.status === "superseded", `epoch-1 ${type} is superseded, got ${task.status}`);
    }
  }
  assertTaskStatus(state, "review_pass", "queued", 2);

  // Drain everything: the stale run-research dispatch must no-op via the currency check.
  state = drainOutbox(state, clock).state;

  assertTaskStatus(state, "pr_review", "done", 2);
  assert(state.board.tasks.length === 8, "both epochs keep their four tasks each");
  assert(state.publications.length === 1, "only the current epoch publishes");
  assert(state.publications[0]?.key.includes("def456") === true, "publication is keyed to the new head SHA");
  assert(state.findings.length === 1, "the superseded epoch never produced findings");
  assert(state.findingThreads[0]?.lastSeenHeadSha === "def456", "finding thread tracks the latest head SHA");
}

function runFailedContextTerminatesAutomatedDependents(): void {
  const clock = deterministicClock();
  const context: GitHubWebhookIngestContext = {
    ...BASE_CONTEXT,
    sourcePolicy: { egressEnabled: false, allowlist: [] }
  };
  let state = ingestGitHubWebhook(createWorkflowState(), OPENED, context, clock());

  state = drainRequiredStep(state, clock); // review requests context
  state = drainRequiredStep(state, clock); // research fails: egress disabled

  assertTaskStatus(state, "context", "failed");
  assertTaskStatus(state, "review_pass", "canceled");
  assertTaskStatus(state, "publish", "canceled");
  assertTaskStatus(state, "pr_review", "failed");

  const decisions = findTasksByType(state.board, "human_decision");
  assert(decisions.length === 0, "generic dependency failure does not invent manual recovery work");
  assert(
    state.board.events.some((event) => event.type === "context.failed"),
    "the context failure is on the task timeline"
  );
}

function runBudgetExhaustionSkipsContext(): void {
  const clock = deterministicClock();
  const context: GitHubWebhookIngestContext = {
    ...BASE_CONTEXT,
    budgetLimits: { perPrTotal: 500 }
  };
  let state = ingestGitHubWebhook(createWorkflowState(), OPENED, context, clock());

  state = drainOutbox(state, clock).state;

  assert(findTasksByType(state.board, "context").length === 0, "an exhausted budget rejects the context request");
  const rejection = state.board.events.find(
    (event) => event.type === "command.rejected" && event.payload?.reason === "budget_exhausted"
  );
  assert(rejection !== undefined, "the budget rejection is recorded as a board event");
  assertTaskStatus(state, "review_pass", "done");
  assertTaskStatus(state, "pr_review", "done");
  assert(state.publications.length === 1, "the review still completes and publishes without context");
}

function runTransitionLegality(): void {
  const clock = deterministicClock();
  const state = ingestGitHubWebhook(createWorkflowState(), OPENED, BASE_CONTEXT, clock());
  const review = singleTask(state, "review_pass");

  const invalid = applyCommand(
    state.board,
    { command: "TransitionTask", taskId: review.id, toStatus: "done" },
    { actor: { type: "user", id: "keon" }, now: clock() }
  );
  assert(!invalid.accepted, "a user cannot force a queued review_pass to done");
  assert(invalid.rejection?.reason === "invalid_transition", "illegal transitions are rejected as such");
  assert(
    invalid.state.events.some((event) => event.type === "command.rejected"),
    "the rejected command is recorded as a board event"
  );

  const cancel = applyCommand(
    state.board,
    { command: "TransitionTask", taskId: review.id, toStatus: "canceled" },
    { actor: { type: "user", id: "keon" }, now: clock() }
  );
  assert(cancel.accepted, "a user can cancel a queued review_pass");
}

function runBillingCreditMath(): void {
  // The canonical example from the billing spec: a $50 managed run at default
  // 30% subsidy and included rates costs 3,500 AI credits + 100 infra = 3,600.
  const ai = aiCreditsForCost(50, defaultBillingPolicy, "included", "managed");
  const infra = infraCreditsForRun(defaultBillingPolicy, "included");
  assert(ai === 3500 && infra === 100 && ai + infra === 3600, "spec example: $50 managed run = 3,600 credits");

  // Overage rates: no subsidy, 150 infra.
  assert(
    aiCreditsForCost(50, defaultBillingPolicy, "overage", "managed") === 5000,
    "overage AI cost passes through with no subsidy"
  );
  assert(infraCreditsForRun(defaultBillingPolicy, "overage") === 150, "overage infra is 150 credits");

  // Own-harness runs never bill AI credits.
  assert(aiCreditsForCost(50, defaultBillingPolicy, "included", "user") === 0, "own-harness AI credits are 0");

  // Credits round up per row.
  assert(aiCreditsForCost(0.001, defaultBillingPolicy, "included", "managed") === 1, "credits round up");
}

function drainRequiredStep(state: WorkflowState, clock: () => string): WorkflowState {
  const result = drainOneOutboxMessage(state, clock);
  assert(result !== undefined, "expected one pending outbox message");
  return result.state;
}

function assertTaskStatus(state: WorkflowState, type: BoardTask["type"], status: TaskStatus, epoch?: number): void {
  const tasks = epoch === undefined ? findTasksByType(state.board, type) : tasksOf(state, type, epoch);
  assert(tasks.length === 1, `expected one ${type} task${epoch === undefined ? "" : ` in epoch ${epoch}`}, got ${tasks.length}`);
  const task = tasks[0];
  assert(task !== undefined && task.status === status, `expected ${type} to be ${status}, got ${task?.status}`);
}

function tasksOf(state: WorkflowState, type: BoardTask["type"], epoch: number): readonly BoardTask[] {
  return findTasksByType(state.board, type).filter((task) => task.epoch === epoch);
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


function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
