import {
  findTasksByType,
  nextPendingOutboxMessage,
  type BoardTask,
  type TaskStatus
} from "@jina/board";
import type { GitHubWebhookEvent } from "@jina/github";
import { ingestGitHubWebhook } from "../ingest/github-webhook.js";
import { drainOneOutboxMessage } from "../relay/outbox-relay.js";
import { createWorkflowState, type WorkflowState } from "../state.js";
import { deterministicClock } from "./deterministic-clock.js";

const clock = deterministicClock();
const event: GitHubWebhookEvent = {
  type: "pull_request.opened",
  pullRequestNumber: 42,
  headSha: "abc123"
};

let state = createWorkflowState();
printHeader("Start");
printState(state);

state = ingestGitHubWebhook(
  state,
  event,
  {
    tenantId: "tenant_1",
    repository: "omlabs/example",
    needsExternalContext: true,
    sourcePolicy: { egressEnabled: true, allowlist: ["https://example.com/"] }
  },
  clock()
);
printHeader("1. PR webhook ingested");
printState(state);

state = drainRequiredStep(state, "run-review");
printHeader("2. Review agent requests more context");
printState(state);

state = drainRequiredStep(state, "run-research");
printHeader("3. Research agent attaches cited context");
printState(state);

state = drainRequiredStep(state, "run-review");
printHeader("4. Review agent resumes and completes");
printState(state);

state = drainRequiredStep(state, "run-publish");
printHeader("5. Publisher publishes review feedback");
printState(state);

printHeader("Result");
console.log("Simulation completed end to end.");

function drainRequiredStep(current: WorkflowState, expectedTopic: string): WorkflowState {
  const pending = nextPendingOutboxMessage(current.board);
  if (!pending) {
    throw new Error(`Expected pending topic ${expectedTopic}, got none`);
  }
  if (pending.topic !== expectedTopic) {
    throw new Error(`Expected pending topic ${expectedTopic}, got ${pending.topic}`);
  }

  const result = drainOneOutboxMessage(current, clock);
  if (!result) {
    throw new Error(`Expected ${expectedTopic} to dispatch`);
  }

  console.log(`Dispatched: ${result.message.topic} (${result.message.idempotencyKey})`);
  return result.state;
}

function printState(current: WorkflowState): void {
  const rows = current.board.tasks.map((task) => ({
    type: task.type,
    status: task.status,
    assignee: task.assigneeRole,
    attempt: task.attempt,
    title: task.title
  }));

  if (rows.length === 0) {
    console.log("Tasks: none");
  } else {
    for (const row of rows) {
      console.log(
        `Task: ${row.type.padEnd(11)} status=${formatStatus(row.status)} attempt=${row.attempt} assignee=${row.assignee} title="${row.title}"`
      );
    }
  }

  const pending = nextPendingOutboxMessage(current.board);
  console.log(`Pending outbox: ${pending ? `${pending.topic} (${pending.idempotencyKey})` : "none"}`);
  console.log(`Dependencies: ${current.board.dependencies.length}`);
  console.log(`Context items: ${current.contextItems.length}`);
  console.log(`Findings: ${current.findings.length} (threads: ${current.findingThreads.length})`);
  console.log(`Publications: ${current.publications.map((publication) => publication.key).join(", ") || "none"}`);
  console.log(`Root done: ${isSingleTaskDone(current, "pr_review") ? "yes" : "no"}`);
}

function printHeader(title: string): void {
  console.log("");
  console.log(`=== ${title} ===`);
}

function formatStatus(status: TaskStatus): string {
  return status.padEnd(11);
}

function isSingleTaskDone(current: WorkflowState, type: BoardTask["type"]): boolean {
  const tasks = findTasksByType(current.board, type);
  return tasks.length === 1 && tasks[0]?.status === "done";
}

