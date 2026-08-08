import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, createEmptyBoardState, type BoardState } from "@jina/board";
import {
  CONTEXT_WORKFLOW_CONTRACT,
  CONTEXT_WORKFLOW_SCHEMA_REVISION,
  createContextWorkflowBoardBuild
} from "@jina/context-engine";
import { compactTerminalContextBuildHistory } from "./context-board-compaction.js";

const workflowMetadata = {
  contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
  contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
  promptContractVersion: "context-page-workflow-1",
  validatorVersion: "context-page-validator-1",
  pageIndexVersion: "pageindex-local-1",
  executionProfileDigest: "a".repeat(64)
} as const;

test("compaction retains active builds and only the newest terminal history per tenant", () => {
  let state = createEmptyBoardState();
  const roots: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const at = `2026-08-02T00:00:0${index}.000Z`;
    const created = createContextWorkflowBoardBuild(state, {
      ...workflowMetadata,
      tenantId: "tenant-a",
      repository: "acme/repo",
      ref: `refs/heads/build-${index}`,
      refSequence: 1,
      requestKey: `request-${index}`,
      trigger: "manual",
      now: at
    });
    state = created.state;
    roots.push(created.buildTaskId);
    if (index === 0) {
      const deferred = applyCommand(
        state,
        {
          command: "CommentTask",
          taskId: created.buildTaskId,
          eventType: "context.build_followup_requested",
          payload: {
            followup: {
              tenantId: "tenant-a",
              repository: "acme/repo",
              ref: "refs/heads/build-0",
              requestKey: "followup-after-compaction",
              trigger: "manual"
            }
          }
        },
        { actor: { type: "system", id: "test" }, now: at }
      );
      assert.equal(deferred.accepted, true);
      state = deferred.state;
    }
    if (index < 3) state = terminal(state, created.buildTaskId, at);
  }
  const otherTenant = createContextWorkflowBoardBuild(state, {
    ...workflowMetadata,
    tenantId: "tenant-b",
    repository: "acme/repo",
    ref: "main",
    refSequence: 1,
    requestKey: "other-tenant",
    trigger: "manual",
    now: "2026-08-02T00:00:04.000Z"
  });
  state = terminal(otherTenant.state, otherTenant.buildTaskId, "2026-08-02T00:00:04.000Z");

  const compacted = compactTerminalContextBuildHistory(state, 2);
  assert.equal(compacted.prunedBuilds, 1);
  assert.equal(
    compacted.state.tasks.some((task) => task.id === roots[0]),
    true,
    "root tombstone preserves request idempotency and ref sequence history"
  );
  assert.equal(
    compacted.state.tasks.some((task) => task.metadata.contextBuildId === roots[0] && task.id !== roots[0]),
    false,
    "old execution children must be removed"
  );
  assert.equal(
    compacted.state.tasks.some((task) => task.id === roots[1]),
    true
  );
  assert.equal(
    compacted.state.tasks.some((task) => task.id === roots[2]),
    true
  );
  assert.equal(
    compacted.state.tasks.some((task) => task.id === roots[3]),
    true,
    "active build must remain"
  );
  assert.equal(
    compacted.state.tasks.some((task) => task.id === otherTenant.buildTaskId),
    true
  );
  assert.equal(
    compacted.state.dependencies.every(
      (dependency) =>
        compacted.state.tasks.some((task) => task.id === dependency.taskId) &&
        compacted.state.tasks.some((task) => task.id === dependency.dependsOnTaskId)
    ),
    true
  );
  assert.equal(
    compacted.state.outbox.every((message) => compacted.state.tasks.some((task) => task.id === message.taskId)),
    true
  );
  assert.equal(
    compacted.state.events.every(
      (event) => event.taskId === undefined || compacted.state.tasks.some((task) => task.id === event.taskId)
    ),
    true
  );
  assert.equal(
    compacted.state.events
      .filter((event) => event.taskId === roots[0])
      .map((event) => event.type)
      .join(","),
    "context.build_followup_requested",
    "only the durable follow-up survives on a compacted root tombstone"
  );
});

test("compaction is stable once the retained history is bounded", () => {
  const state = createEmptyBoardState();
  const first = compactTerminalContextBuildHistory(state, 20);
  const second = compactTerminalContextBuildHistory(first.state, 20);
  assert.equal(first.state, state);
  assert.equal(second.state, state);
  assert.equal(second.prunedBuilds, 0);
});

function terminal(state: BoardState, taskId: string, now: string): BoardState {
  const result = applyCommand(
    state,
    { command: "TransitionTask", taskId: taskId as never, toStatus: "failed" },
    { actor: { type: "system", id: "test" }, now }
  );
  assert.equal(result.accepted, true);
  return result.state;
}
