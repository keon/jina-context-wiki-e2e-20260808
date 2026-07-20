import assert from "node:assert/strict";
import { test } from "node:test";
import { entityId } from "@jina/shared-kernel";
import { applyCommand } from "./commands.js";
import { createEmptyBoardState, findTask } from "./reducer.js";
import { canTransition } from "./transitions.js";
import { leaseNextOutboxMessage, renewOutboxLease, type BoardState } from "./reducer.js";

test("transition policy follows task kind instead of an extension type name", () => {
  assert.equal(canTransition("aggregate", "triage", "in_progress", "run"), false);
  assert.equal(canTransition("manual", "triage", "done", "user"), true);
  assert.equal(canTransition("waitpoint", "blocked", "done", "user"), true);
  assert.equal(canTransition("dispatchable", "queued", "in_progress", "run"), true);
});

test("workers can pass small durable metadata to a dependent task", () => {
  const taskId = entityId<"task">("task-generation");
  const now = "2026-01-01T00:00:00.000Z";
  const created = applyCommand(createEmptyBoardState(), {
    command: "CreateTask",
    task: {
      id: taskId,
      type: "ontology_assert",
      kind: "dispatchable",
      title: "Generate assertions",
      assigneeRole: "ontology_worker",
      dedupeKey: "ontology:assert",
      dispatchTopic: "run-ontology-assert"
    }
  }, { actor: { type: "user", id: "test" }, now }).state;
  const updated = applyCommand(created, {
    command: "UpdateTask",
    taskId,
    metadata: { commitSha: "a".repeat(40) }
  }, { actor: { type: "run", id: "ontology-worker" }, now }).state;

  assert.equal(findTask(updated, taskId)?.metadata.commitSha, "a".repeat(40));
  assert.equal(updated.events.at(-1)?.type, "task.updated");
});

test("outbox leases are tenant-filterable and reclaimable after expiry", () => {
  const firstTask = entityId<"task">("task-a");
  const secondTask = entityId<"task">("task-b");
  const state: BoardState = {
    tasks: [],
    dependencies: [],
    events: [],
    outbox: [
      {
        id: entityId<"board_outbox_message">("message-a"),
        taskId: firstTask,
        topic: "run-ontology",
        idempotencyKey: "a:1",
        status: "leased",
        payload: { taskId: firstTask, attempt: 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
        leaseId: "old",
        leasedAt: "2026-01-01T00:00:01.000Z",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z"
      },
      {
        id: entityId<"board_outbox_message">("message-b"),
        taskId: secondTask,
        topic: "run-ontology",
        idempotencyKey: "b:1",
        status: "pending",
        payload: { taskId: secondTask, attempt: 1 },
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  };

  const claimed = leaseNextOutboxMessage(state, {
    topics: ["run-ontology"],
    taskIds: [firstTask],
    leaseId: "new",
    now: "2026-01-01T00:02:00.000Z",
    expiresAt: "2026-01-01T00:03:00.000Z"
  });
  assert.equal(claimed?.message.taskId, firstTask);
  assert.equal(claimed?.message.leaseId, "new");
  const renewed = renewOutboxLease(
    claimed!.state,
    claimed!.message.id,
    "new",
    "2026-01-01T00:02:30.000Z",
    "2026-01-01T00:04:00.000Z"
  );
  assert.equal(renewed?.outbox[0]?.leaseExpiresAt, "2026-01-01T00:04:00.000Z");
  assert.equal(
    renewOutboxLease(claimed!.state, claimed!.message.id, "wrong", "2026-01-01T00:02:30.000Z", "2026-01-01T00:04:00.000Z"),
    undefined
  );
});
