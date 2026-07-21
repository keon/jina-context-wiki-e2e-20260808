import assert from "node:assert/strict";
import { test } from "node:test";
import { entityId } from "@jina/shared-kernel";
import { applyCommand } from "./commands.js";
import {
  createEmptyBoardState,
  findTask,
  leaseNextOutboxMessage,
  reduceBoard,
  renewOutboxLease,
  transitionBoardTask,
  type BoardState
} from "./reducer.js";
import { canTransition } from "./transitions.js";

test("transition policy follows task kind instead of an extension type name", () => {
  assert.equal(canTransition("aggregate", "triage", "in_progress", "run"), false);
  assert.equal(canTransition("manual", "triage", "done", "user"), true);
  assert.equal(canTransition("waitpoint", "blocked", "done", "user"), true);
  assert.equal(canTransition("dispatchable", "queued", "in_progress", "run"), true);
});

test("workers can pass small durable metadata to a dependent task", () => {
  const taskId = entityId<"task">("task-generation");
  const now = "2026-01-01T00:00:00.000Z";
  const created = applyCommand(
    createEmptyBoardState(),
    {
      command: "CreateTask",
      task: {
        id: taskId,
        type: "context_graph_assert",
        kind: "dispatchable",
        title: "Generate assertions",
        assigneeRole: "context_graph_worker",
        dedupeKey: "contextGraph:assert",
        dispatchTopic: "run-context-graph-assert"
      }
    },
    { actor: { type: "user", id: "test" }, now }
  ).state;
  const updated = applyCommand(
    created,
    {
      command: "UpdateTask",
      taskId,
      metadata: { commitSha: "a".repeat(40) }
    },
    { actor: { type: "run", id: "context-graph-worker" }, now }
  ).state;

  assert.equal(findTask(updated, taskId)?.metadata.commitSha, "a".repeat(40));
  assert.equal(updated.events.at(-1)?.type, "task.updated");
});

test("failed automated dependencies terminate their workflow without synthetic blockers", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const rootId = entityId<"task">("context-graph-root");
  const ingestId = entityId<"task">("context-graph-ingest");
  const assertId = entityId<"task">("context-graph-assert");
  const projectId = entityId<"task">("context-graph-project");
  let state = createEmptyBoardState();
  const create = (task: Parameters<typeof applyCommand>[1] & { command: "CreateTask" }) => {
    state = applyCommand(state, task, { actor: { type: "system", id: "test" }, now }).state;
  };
  create({
    command: "CreateTask",
    blocksParentCompletion: false,
    task: {
      id: rootId,
      type: "context_graph_build",
      kind: "aggregate",
      title: "Build contextGraph",
      assigneeRole: "system",
      dedupeKey: "contextGraph:root"
    }
  });
  create({
    command: "CreateTask",
    task: {
      id: ingestId,
      type: "context_graph_ingest",
      kind: "dispatchable",
      title: "Ingest",
      assigneeRole: "worker",
      dedupeKey: "contextGraph:ingest",
      dispatchTopic: "run-context-graph-ingest",
      parentTaskId: rootId
    }
  });
  create({
    command: "CreateTask",
    task: {
      id: assertId,
      type: "context_graph_assert",
      kind: "dispatchable",
      title: "Assert",
      assigneeRole: "worker",
      dedupeKey: "contextGraph:assert",
      dispatchTopic: "run-context-graph-assert",
      parentTaskId: rootId
    },
    dependencies: [
      {
        taskId: assertId,
        dependsOnTaskId: ingestId,
        relationship: "blocks",
        required: true,
        blocksParentCompletion: true
      }
    ]
  });
  create({
    command: "CreateTask",
    task: {
      id: projectId,
      type: "context_graph_project",
      kind: "dispatchable",
      title: "Project",
      assigneeRole: "worker",
      dedupeKey: "contextGraph:project",
      dispatchTopic: "run-context-graph-project",
      parentTaskId: rootId
    },
    dependencies: [
      {
        taskId: projectId,
        dependsOnTaskId: assertId,
        relationship: "blocks",
        required: true,
        blocksParentCompletion: true
      }
    ]
  });

  state = transitionBoardTask(state, ingestId, "failed", now);
  state = reduceBoard(state, now);

  assert.equal(findTask(state, ingestId)?.status, "failed");
  assert.equal(findTask(state, assertId)?.status, "canceled");
  assert.equal(findTask(state, projectId)?.status, "canceled");
  assert.equal(findTask(state, rootId)?.status, "failed");
  assert.equal(
    state.tasks.some((task) => task.type === "human_decision"),
    false
  );
  assert.equal(
    state.tasks.some((task) => task.status === "blocked"),
    false
  );
});

test("reducer supersedes legacy recovery waitpoints after their parent terminates", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const parentId = entityId<"task">("legacy-parent");
  const failedId = entityId<"task">("legacy-failure");
  const decisionId = entityId<"task">("legacy-decision");
  let state = createEmptyBoardState();
  for (const task of [
    {
      id: failedId,
      type: "context",
      kind: "dispatchable" as const,
      title: "Context",
      dedupeKey: "context",
      dispatchTopic: "run-research"
    },
    {
      id: parentId,
      type: "review_pass",
      kind: "dispatchable" as const,
      title: "Review",
      dedupeKey: "review",
      dispatchTopic: "run-review"
    },
    {
      id: decisionId,
      type: "human_decision",
      kind: "waitpoint" as const,
      title: "Decide",
      dedupeKey: "decision",
      parentTaskId: parentId
    }
  ]) {
    state = applyCommand(
      state,
      { command: "CreateTask", task: { ...task, assigneeRole: "test" } },
      {
        actor: { type: "system", id: "test" },
        now
      }
    ).state;
  }
  state = applyCommand(
    state,
    {
      command: "LinkTask",
      dependency: {
        taskId: parentId,
        dependsOnTaskId: failedId,
        relationship: "blocks",
        required: true,
        blocksParentCompletion: true
      }
    },
    { actor: { type: "system", id: "test" }, now }
  ).state;
  state = transitionBoardTask(state, failedId, "failed", now);
  state = reduceBoard(state, now);

  assert.equal(findTask(state, parentId)?.status, "canceled");
  assert.equal(findTask(state, decisionId)?.status, "superseded");
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
        topic: "run-context-graph-assert",
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
        topic: "run-context-graph-assert",
        idempotencyKey: "b:1",
        status: "pending",
        payload: { taskId: secondTask, attempt: 1 },
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  };

  const claimed = leaseNextOutboxMessage(state, {
    topics: ["run-context-graph-assert"],
    taskIds: [firstTask],
    leaseId: "new",
    now: "2026-01-01T00:02:00.000Z",
    expiresAt: "2026-01-01T00:03:00.000Z"
  });
  assert.equal(claimed?.message.taskId, firstTask);
  assert.equal(claimed?.message.leaseId, "new");
  const renewed = renewOutboxLease(
    claimed.state,
    claimed.message.id,
    "new",
    "2026-01-01T00:02:30.000Z",
    "2026-01-01T00:04:00.000Z"
  );
  assert.equal(renewed?.outbox[0]?.leaseExpiresAt, "2026-01-01T00:04:00.000Z");
  assert.equal(
    renewOutboxLease(
      claimed.state,
      claimed.message.id,
      "wrong",
      "2026-01-01T00:02:30.000Z",
      "2026-01-01T00:04:00.000Z"
    ),
    undefined
  );
});
