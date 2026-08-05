import assert from "node:assert/strict";
import { test } from "node:test";
import { entityId } from "@jina/shared-kernel";
import { applyCommand } from "./commands.js";
import {
  BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS,
  BOARD_TASK_HARD_MAX_ATTEMPTS,
  boardOperatorRetryEligibility,
  createEmptyBoardState,
  fenceOutboxLeases,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  reduceBoard,
  releaseOutboxLease,
  retryFailedBoardTask,
  retryFailedBoardTasks,
  retryLeasedOutboxTask,
  renewOutboxLease,
  transitionBoardTask,
  type BoardState
} from "./reducer.js";
import { supersedeEpochTasks } from "./supersession.js";
import { canTransition } from "./transitions.js";

test("transition policy follows task kind instead of an extension type name", () => {
  assert.equal(canTransition("aggregate", "triage", "in_progress", "run"), false);
  assert.equal(canTransition("manual", "triage", "done", "user"), true);
  assert.equal(canTransition("waitpoint", "blocked", "done", "user"), true);
  assert.equal(canTransition("dispatchable", "queued", "in_progress", "run"), true);
});

test("deployment fencing invalidates every selected live lease without consuming an attempt", () => {
  const now = "2026-07-30T00:00:00.000Z";
  const taskId = entityId<"task">("deployment-drain-task");
  const created = applyCommand(
    createEmptyBoardState(),
    {
      command: "CreateTask",
      task: {
        id: taskId,
        type: "fixture_transform",
        kind: "dispatchable",
        title: "Resume after deployment",
        assigneeRole: "fixture_worker",
        dedupeKey: "deployment:drain",
        dispatchTopic: "run-context-publication"
      }
    },
    { actor: { type: "user", id: "test" }, now }
  ).state;
  const reduced = reduceBoard(created, now);
  const leased = leaseNextOutboxMessage(reduced, {
    topics: ["run-context-publication"],
    leaseId: "lease-before-deploy",
    writeFenceToken: "fence-before-deploy",
    now,
    expiresAt: "2026-07-30T03:00:00.000Z"
  });
  assert.ok(leased);

  const fenced = fenceOutboxLeases(leased.state, {
    topics: ["run-context-publication"],
    now: "2026-07-30T00:01:00.000Z",
    actorId: "deployment:build-1",
    reason: "coordinated release"
  });
  assert.deepEqual(fenced.releasedMessageIds, [leased.message.id]);
  const message = fenced.state.outbox.find((candidate) => candidate.id === leased.message.id);
  assert.equal(message?.status, "pending");
  assert.equal(message?.payload.attempt, 1);
  assert.equal(message?.leaseId, undefined);
  assert.equal(message?.writeFenceToken, undefined);
  assert.equal(message?.leaseExpiresAt, undefined);
  assert.equal(fenced.state.events.filter((event) => event.type === "task.worker_lease_fenced").length, 1);
  assert.equal(
    releaseOutboxLease(
      fenced.state,
      leased.message.id,
      "lease-before-deploy",
      "fence-before-deploy",
      "2026-07-30T00:02:00.000Z"
    ),
    undefined
  );
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
        type: "fixture_transform",
        kind: "dispatchable",
        title: "Transform fixture",
        assigneeRole: "fixture_worker",
        dedupeKey: "contextPipeline:assert",
        dispatchTopic: "run-context-pipeline-assert"
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
    { actor: { type: "run", id: "context-pipeline-worker" }, now }
  ).state;

  assert.equal(findTask(updated, taskId)?.metadata.commitSha, "a".repeat(40));
  assert.deepEqual(created.events[0]?.payload, { type: "fixture_transform", actor: "test", actorType: "user" });
  assert.equal(updated.events.at(-1)?.type, "task.updated");
});

test("failed automated dependencies terminate their workflow without synthetic blockers", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const rootId = entityId<"task">("context-pipeline-root");
  const ingestId = entityId<"task">("context-pipeline-ingest");
  const assertId = entityId<"task">("context-pipeline-assert");
  const projectId = entityId<"task">("context-pipeline-project");
  let state = createEmptyBoardState();
  const create = (task: Parameters<typeof applyCommand>[1] & { command: "CreateTask" }) => {
    state = applyCommand(state, task, { actor: { type: "system", id: "test" }, now }).state;
  };
  create({
    command: "CreateTask",
    blocksParentCompletion: false,
    task: {
      id: rootId,
      type: "fixture_build",
      kind: "aggregate",
      title: "Build fixture pipeline",
      assigneeRole: "system",
      dedupeKey: "contextPipeline:root"
    }
  });
  create({
    command: "CreateTask",
    task: {
      id: ingestId,
      type: "fixture_ingest",
      kind: "dispatchable",
      title: "Ingest",
      assigneeRole: "worker",
      dedupeKey: "contextPipeline:ingest",
      dispatchTopic: "run-context-pipeline-ingest",
      parentTaskId: rootId
    }
  });
  create({
    command: "CreateTask",
    task: {
      id: assertId,
      type: "fixture_transform",
      kind: "dispatchable",
      title: "Transform",
      assigneeRole: "worker",
      dedupeKey: "contextPipeline:assert",
      dispatchTopic: "run-context-pipeline-assert",
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
      type: "fixture_publish",
      kind: "dispatchable",
      title: "Publish",
      assigneeRole: "worker",
      dedupeKey: "contextPipeline:project",
      dispatchTopic: "run-context-pipeline-project",
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
        topic: "run-context-pipeline-assert",
        idempotencyKey: "a:1",
        status: "leased",
        payload: { taskId: firstTask, attempt: 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
        leaseId: "old",
        writeFenceToken: "old-fence",
        leasedAt: "2026-01-01T00:00:01.000Z",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z"
      },
      {
        id: entityId<"board_outbox_message">("message-b"),
        taskId: secondTask,
        topic: "run-context-pipeline-assert",
        idempotencyKey: "b:1",
        status: "pending",
        payload: { taskId: secondTask, attempt: 1 },
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  };

  const claimed = leaseNextOutboxMessage(state, {
    topics: ["run-context-pipeline-assert"],
    taskIds: [firstTask],
    leaseId: "new",
    writeFenceToken: "new-fence",
    now: "2026-01-01T00:02:00.000Z",
    expiresAt: "2026-01-01T00:03:00.000Z"
  });
  assert.equal(claimed?.message.taskId, firstTask);
  assert.equal(claimed?.message.leaseId, "new");
  assert.equal(claimed?.message.writeFenceToken, "new-fence");
  const renewed = renewOutboxLease(
    claimed.state,
    claimed.message.id,
    "new",
    "new-fence",
    "2026-01-01T00:02:30.000Z",
    "2026-01-01T00:04:00.000Z"
  );
  assert.equal(renewed?.outbox[0]?.leaseExpiresAt, "2026-01-01T00:04:00.000Z");
  const released = releaseOutboxLease(renewed, claimed.message.id, "new", "new-fence", "2026-01-01T00:02:45.000Z");
  assert.equal(released?.outbox[0]?.status, "pending");
  assert.equal(released?.outbox[0]?.leaseId, undefined);
  assert.equal(released?.outbox[0]?.writeFenceToken, undefined);
  assert.equal(
    releaseOutboxLease(renewed, claimed.message.id, "new", "wrong-fence", "2026-01-01T00:02:45.000Z"),
    undefined
  );
  const dispatched = markOutboxDispatched(claimed.state, claimed.message.id, "2026-01-01T00:02:45.000Z").outbox[0];
  assert.equal(dispatched?.status, "dispatched");
  assert.equal(dispatched?.dispatchedLeaseId, "new");
  assert.equal(dispatched?.leaseId, undefined);
  assert.equal(dispatched?.writeFenceToken, undefined);
  assert.equal(
    renewOutboxLease(
      claimed.state,
      claimed.message.id,
      "wrong",
      "new-fence",
      "2026-01-01T00:02:30.000Z",
      "2026-01-01T00:04:00.000Z"
    ),
    undefined
  );
});

test("fenced retries preserve sibling checkpoints and requeue one bounded attempt idempotently", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const rootId = entityId<"task">("retry-root");
  const retryTaskId = entityId<"task">("retry-model-task");
  const siblingTaskId = entityId<"task">("retry-completed-sibling");
  let state = createEmptyBoardState();
  for (const input of [
    {
      command: "CreateTask" as const,
      blocksParentCompletion: false,
      task: {
        id: rootId,
        type: "fixture_build",
        kind: "aggregate" as const,
        title: "Retry fixture",
        assigneeRole: "system",
        dedupeKey: "retry:root"
      }
    },
    {
      command: "CreateTask" as const,
      task: {
        id: retryTaskId,
        type: "fixture_retry",
        kind: "dispatchable" as const,
        title: "Retry transient work",
        assigneeRole: "worker",
        dedupeKey: "retry:work",
        dispatchTopic: "run-retry-fixture",
        parentTaskId: rootId
      }
    },
    {
      command: "CreateTask" as const,
      task: {
        id: siblingTaskId,
        type: "fixture_sibling",
        kind: "dispatchable" as const,
        title: "Completed sibling",
        assigneeRole: "worker",
        dedupeKey: "retry:sibling",
        dispatchTopic: "run-retry-sibling",
        parentTaskId: rootId
      }
    }
  ]) {
    state = applyCommand(state, input, {
      actor: { type: "system", id: "retry-test" },
      now
    }).state;
  }
  state = transitionBoardTask(state, siblingTaskId, "done", now);
  state = reduceBoard(state, now);
  const firstClaim = leaseNextOutboxMessage(state, {
    topics: ["run-retry-fixture"],
    taskIds: [retryTaskId],
    leaseId: "retry-lease-1",
    writeFenceToken: "retry-fence-1",
    now: "2026-01-01T00:00:01.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z"
  });
  assert.ok(firstClaim);
  state = transitionBoardTask(firstClaim.state, retryTaskId, "in_progress", "2026-01-01T00:00:01.000Z");
  const retryInput = {
    messageId: firstClaim.message.id,
    taskId: retryTaskId,
    leaseId: "retry-lease-1",
    writeFenceToken: "retry-fence-1",
    attempt: 1,
    maxAttempts: BOARD_TASK_HARD_MAX_ATTEMPTS,
    now: "2026-01-01T00:00:02.000Z",
    diagnostic: {
      category: "model",
      reason: "provider temporarily unavailable"
    }
  } as const;
  const retried = retryLeasedOutboxTask(state, retryInput);
  assert.ok(retried);
  assert.equal(retried.replay, false);
  assert.equal(retried.terminal, false);
  assert.equal(retried.nextMessage?.payload.attempt, 2);
  assert.equal(retried.nextMessage?.status, "pending");
  assert.equal(findTask(retried.state, retryTaskId)?.status, "queued");
  assert.equal(findTask(retried.state, retryTaskId)?.attempt, 2);
  assert.equal(findTask(retried.state, siblingTaskId)?.status, "done");
  assert.equal(findTask(retried.state, rootId)?.status, "triage");
  assert.equal(findTask(retried.state, siblingTaskId)?.updatedAt, findTask(state, siblingTaskId)?.updatedAt);

  const replay = retryLeasedOutboxTask(retried.state, retryInput);
  assert.ok(replay);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.state, retried.state);
  assert.equal(replay.state.events.filter((event) => event.type === "task.retry_scheduled").length, 1);

  const secondClaim = leaseNextOutboxMessage(retried.state, {
    topics: ["run-retry-fixture"],
    taskIds: [retryTaskId],
    leaseId: "retry-lease-2",
    writeFenceToken: "retry-fence-2",
    now: "2026-01-01T00:00:03.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z"
  });
  assert.ok(secondClaim);
  assert.equal(secondClaim.message.payload.attempt, 2);
  assert.notEqual(secondClaim.message.leaseId, firstClaim.message.leaseId);
  assert.notEqual(secondClaim.message.writeFenceToken, firstClaim.message.writeFenceToken);
  assert.equal(
    renewOutboxLease(
      secondClaim.state,
      firstClaim.message.id,
      "retry-lease-1",
      "retry-fence-1",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:11:00.000Z"
    ),
    undefined
  );
});

test("bounded retries fail the task and root only after the fourth attempt", () => {
  const rootId = entityId<"task">("retry-limit-root");
  const taskId = entityId<"task">("retry-limit-task");
  let state = createEmptyBoardState();
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      blocksParentCompletion: false,
      task: {
        id: rootId,
        type: "fixture_build",
        kind: "aggregate",
        title: "Retry limit fixture",
        assigneeRole: "system",
        dedupeKey: "retry-limit:root"
      }
    },
    { actor: { type: "system", id: "retry-test" }, now: "2026-01-01T00:00:00.000Z" }
  ).state;
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      task: {
        id: taskId,
        type: "fixture_retry",
        kind: "dispatchable",
        title: "Retry until exhausted",
        assigneeRole: "worker",
        dedupeKey: "retry-limit:work",
        dispatchTopic: "run-retry-fixture",
        parentTaskId: rootId
      }
    },
    { actor: { type: "system", id: "retry-test" }, now: "2026-01-01T00:00:00.000Z" }
  ).state;
  state = reduceBoard(state, "2026-01-01T00:00:00.000Z");

  for (let attempt = 1; attempt <= BOARD_TASK_HARD_MAX_ATTEMPTS; attempt += 1) {
    // Retry requeues carry an exponential availableAt backoff, so each claim
    // happens comfortably after the previous retry's delay has elapsed.
    const claimAt = `2026-01-01T00:${String(2 * attempt).padStart(2, "0")}:00.000Z`;
    const retryAt = `2026-01-01T00:${String(2 * attempt + 1).padStart(2, "0")}:00.000Z`;
    const claim = leaseNextOutboxMessage(state, {
      topics: ["run-retry-fixture"],
      taskIds: [taskId],
      leaseId: `retry-limit-lease-${attempt}`,
      writeFenceToken: `retry-limit-fence-${attempt}`,
      now: claimAt,
      expiresAt: "2026-01-01T01:00:00.000Z"
    });
    assert.ok(claim);
    state = transitionBoardTask(claim.state, taskId, "in_progress", claimAt);
    const result = retryLeasedOutboxTask(state, {
      messageId: claim.message.id,
      taskId,
      leaseId: `retry-limit-lease-${attempt}`,
      writeFenceToken: `retry-limit-fence-${attempt}`,
      attempt,
      maxAttempts: BOARD_TASK_HARD_MAX_ATTEMPTS,
      now: retryAt,
      diagnostic: { category: "daytona", reason: "sandbox unavailable" }
    });
    assert.ok(result);
    state = result.state;
    if (attempt < BOARD_TASK_HARD_MAX_ATTEMPTS) {
      assert.equal(result.terminal, false);
      assert.equal(findTask(state, taskId)?.status, "queued");
      assert.equal(findTask(state, rootId)?.status, "triage");
    } else {
      assert.equal(result.terminal, true);
      assert.equal(findTask(state, taskId)?.status, "failed");
      assert.equal(findTask(state, rootId)?.status, "failed");
      assert.equal(result.nextMessage, undefined);
    }
  }
});

test("operator retry reopens only a failed dependency chain and preserves completed checkpoints", () => {
  const now = "2026-07-29T00:00:00.000Z";
  const failedAt = "2026-07-29T00:01:00.000Z";
  const retriedAt = "2026-07-29T00:02:00.000Z";
  const rootId = entityId<"task">("operator-root");
  const graphId = entityId<"task">("operator-graph");
  const checkpointId = entityId<"task">("operator-checkpoint");
  const plannerId = entityId<"task">("operator-publication-plan");
  const dependentId = entityId<"task">("operator-dependent");
  const queuedSiblingId = entityId<"task">("operator-queued-sibling");
  let state = createEmptyBoardState();
  for (const task of [
    {
      id: rootId,
      type: "build",
      kind: "aggregate" as const,
      title: "Build",
      assigneeRole: "system",
      dedupeKey: "operator:root"
    },
    {
      id: graphId,
      type: "graph",
      kind: "manual" as const,
      title: "Dynamic graph",
      assigneeRole: "system",
      dedupeKey: "operator:graph",
      parentTaskId: rootId
    },
    {
      id: checkpointId,
      type: "checkpoint",
      kind: "dispatchable" as const,
      title: "Completed checkpoint",
      assigneeRole: "worker",
      dedupeKey: "operator:checkpoint",
      dispatchTopic: "run-checkpoint",
      parentTaskId: rootId
    }
  ]) {
    state = applyCommand(
      state,
      {
        command: "CreateTask",
        ...(task.id === rootId ? { blocksParentCompletion: false } : {}),
        task
      },
      { actor: { type: "system", id: "test" }, now }
    ).state;
  }
  state = transitionBoardTask(state, checkpointId, "done", now);
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      task: {
        id: plannerId,
        type: "publication-plan",
        kind: "dispatchable",
        title: "Publication plan",
        assigneeRole: "agent",
        dedupeKey: "operator:planner",
        dispatchTopic: "run-publication-plan",
        parentTaskId: rootId
      },
      dependencies: [
        {
          taskId: plannerId,
          dependsOnTaskId: checkpointId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }
      ]
    },
    { actor: { type: "system", id: "test" }, now }
  ).state;
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      task: {
        id: dependentId,
        type: "write-page",
        kind: "dispatchable",
        title: "Later dependent",
        assigneeRole: "agent",
        dedupeKey: "operator:dependent",
        dispatchTopic: "run-write-page",
        parentTaskId: rootId
      },
      dependencies: [
        {
          taskId: dependentId,
          dependsOnTaskId: plannerId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }
      ]
    },
    { actor: { type: "system", id: "test" }, now }
  ).state;
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      task: {
        id: queuedSiblingId,
        type: "independent-page-repair",
        kind: "dispatchable",
        title: "Independent queued repair",
        assigneeRole: "agent",
        dedupeKey: "operator:queued-sibling",
        dispatchTopic: "run-page-repair",
        parentTaskId: rootId
      }
    },
    { actor: { type: "system", id: "test" }, now }
  ).state;
  state = reduceBoard(state, now);
  const firstClaim = leaseNextOutboxMessage(state, {
    topics: ["run-publication-plan"],
    taskIds: [plannerId],
    leaseId: "operator-old-lease",
    writeFenceToken: "operator-old-fence",
    now,
    expiresAt: "2026-07-29T01:00:00.000Z"
  });
  assert.ok(firstClaim);
  state = transitionBoardTask(firstClaim.state, plannerId, "in_progress", now);
  state = markOutboxDispatched(state, firstClaim.message.id, failedAt);
  state = transitionBoardTask(state, plannerId, "failed", failedAt);
  state = reduceBoard(state, failedAt);
  assert.equal(findTask(state, rootId)?.status, "failed");
  assert.equal(findTask(state, dependentId)?.status, "canceled");
  state = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === queuedSiblingId ? { ...task, status: "queued" as const, updatedAt: failedAt } : task
    )
  };

  const automaticAttemptsExhausted = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === plannerId ? { ...task, attempt: BOARD_TASK_HARD_MAX_ATTEMPTS } : task
    )
  };
  const operatorRecovery = retryFailedBoardTask(automaticAttemptsExhausted, {
    buildTaskId: rootId,
    taskId: plannerId,
    requestKey: "operator:retry:after-automatic-exhaustion",
    actorId: "user:operator@example.com",
    reason: "infrastructure defect fixed",
    now: retriedAt
  });
  assert.equal(operatorRecovery.nextMessage.payload.attempt, BOARD_TASK_HARD_MAX_ATTEMPTS + 1);
  assert.ok(BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS > BOARD_TASK_HARD_MAX_ATTEMPTS);

  const checkpointBefore = findTask(state, checkpointId);
  const retried = retryFailedBoardTask(state, {
    buildTaskId: rootId,
    taskId: plannerId,
    requestKey: "operator:retry:1",
    actorId: "user:operator@example.com",
    reason: "planner contract fixed",
    now: retriedAt
  });
  assert.equal(retried.replay, false);
  assert.equal(retried.nextMessage.payload.attempt, 2);
  assert.equal(retried.nextMessage.status, "pending");
  assert.equal(findTask(retried.state, plannerId)?.status, "queued");
  assert.equal(findTask(retried.state, rootId)?.status, "triage");
  assert.equal(findTask(retried.state, dependentId)?.status, "triage");
  assert.equal(findTask(retried.state, graphId)?.status, "triage");
  assert.equal(findTask(retried.state, queuedSiblingId)?.status, "queued");
  assert.deepEqual(findTask(retried.state, checkpointId), checkpointBefore);
  assert.deepEqual(
    new Set(retried.reopenedTaskIds),
    new Set([rootId, graphId, plannerId, dependentId, queuedSiblingId])
  );
  assert.equal(
    retried.state.outbox.find((message) => message.taskId === queuedSiblingId && message.payload.attempt === 2)?.status,
    "pending"
  );
  assert.equal(
    renewOutboxLease(
      retried.state,
      firstClaim.message.id,
      "operator-old-lease",
      "operator-old-fence",
      retriedAt,
      "2026-07-29T01:02:00.000Z"
    ),
    undefined
  );

  const replay = retryFailedBoardTask(retried.state, {
    buildTaskId: rootId,
    taskId: plannerId,
    requestKey: "operator:retry:1",
    actorId: "user:operator@example.com",
    reason: "planner contract fixed",
    now: "2026-07-29T00:03:00.000Z"
  });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.state, retried.state);
  assert.equal(replay.state.events.filter((event) => event.type === "task.operator_retry_scheduled").length, 1);
});

test("operator batch retry atomically reopens parallel failures and their shared downstream", () => {
  const createdAt = "2026-07-29T00:00:00.000Z";
  const failedAt = "2026-07-29T00:01:00.000Z";
  const retriedAt = "2026-07-29T00:02:00.000Z";
  const rootId = entityId<"task">("batch-retry-root");
  const prerequisiteId = entityId<"task">("batch-retry-prerequisite");
  const leftId = entityId<"task">("batch-retry-left");
  const rightId = entityId<"task">("batch-retry-right");
  const downstreamId = entityId<"task">("batch-retry-shared-downstream");
  const completedSiblingId = entityId<"task">("batch-retry-completed-sibling");
  let state = createEmptyBoardState();
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      blocksParentCompletion: false,
      task: {
        id: rootId,
        type: "fixture_build",
        kind: "aggregate",
        title: "Batch retry build",
        assigneeRole: "system",
        dedupeKey: "batch-retry:root"
      }
    },
    { actor: { type: "system", id: "test" }, now: createdAt }
  ).state;
  for (const task of [
    {
      id: prerequisiteId,
      type: "fixture_prerequisite",
      title: "Completed prerequisite",
      dedupeKey: "batch-retry:prerequisite",
      dispatchTopic: "run-batch-prerequisite"
    },
    {
      id: completedSiblingId,
      type: "fixture_sibling",
      title: "Completed sibling",
      dedupeKey: "batch-retry:sibling",
      dispatchTopic: "run-batch-sibling"
    }
  ]) {
    state = applyCommand(
      state,
      {
        command: "CreateTask",
        task: {
          ...task,
          kind: "dispatchable",
          assigneeRole: "worker",
          parentTaskId: rootId
        }
      },
      { actor: { type: "system", id: "test" }, now: createdAt }
    ).state;
  }
  for (const task of [
    {
      id: leftId,
      type: "fixture_page",
      title: "Left page",
      dedupeKey: "batch-retry:left",
      dispatchTopic: "run-batch-page"
    },
    {
      id: rightId,
      type: "fixture_page",
      title: "Right page",
      dedupeKey: "batch-retry:right",
      dispatchTopic: "run-batch-page"
    }
  ]) {
    state = applyCommand(
      state,
      {
        command: "CreateTask",
        task: {
          ...task,
          kind: "dispatchable",
          assigneeRole: "worker",
          parentTaskId: rootId
        },
        dependencies: [
          {
            taskId: task.id,
            dependsOnTaskId: prerequisiteId,
            relationship: "blocks",
            required: true,
            blocksParentCompletion: true
          }
        ]
      },
      { actor: { type: "system", id: "test" }, now: createdAt }
    ).state;
  }
  state = applyCommand(
    state,
    {
      command: "CreateTask",
      task: {
        id: downstreamId,
        type: "fixture_shared_downstream",
        kind: "dispatchable",
        title: "Shared downstream",
        assigneeRole: "worker",
        dedupeKey: "batch-retry:downstream",
        dispatchTopic: "run-batch-downstream",
        parentTaskId: rootId
      },
      dependencies: [leftId, rightId].map((dependsOnTaskId) => ({
        taskId: downstreamId,
        dependsOnTaskId,
        relationship: "blocks" as const,
        required: true,
        blocksParentCompletion: true
      }))
    },
    { actor: { type: "system", id: "test" }, now: createdAt }
  ).state;
  state = {
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id === prerequisiteId || task.id === completedSiblingId) {
        return { ...task, status: "done" as const, updatedAt: failedAt };
      }
      return task;
    })
  };
  state = reduceBoard(state, createdAt);
  state = {
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id === leftId || task.id === rightId) {
        return { ...task, status: "failed" as const, attempt: BOARD_TASK_HARD_MAX_ATTEMPTS, updatedAt: failedAt };
      }
      if (task.id === downstreamId) {
        return { ...task, status: "canceled" as const, updatedAt: failedAt };
      }
      if (task.id === rootId) {
        return { ...task, status: "failed" as const, updatedAt: failedAt };
      }
      return task;
    }),
    outbox: state.outbox.map((message) => {
      if (message.taskId === leftId) {
        return {
          ...message,
          status: "leased" as const,
          leaseId: "stale-left-lease",
          writeFenceToken: "stale-left-fence",
          leasedAt: createdAt,
          leaseExpiresAt: "2026-07-29T01:00:00.000Z"
        };
      }
      return message;
    })
  };

  const beforeRejectedRetry = structuredClone(state);
  const leasedOutsideState: BoardState = {
    ...state,
    outbox: [
      ...state.outbox,
      {
        id: entityId<"board_outbox_message">("batch-retry-leased-sibling-message"),
        taskId: completedSiblingId,
        topic: "run-batch-sibling",
        idempotencyKey: `${completedSiblingId}:leased-outside-recovery`,
        status: "leased",
        payload: { taskId: completedSiblingId, attempt: 1 },
        createdAt,
        leaseId: "batch-retry-sibling-lease",
        writeFenceToken: "batch-retry-sibling-fence",
        leasedAt: createdAt,
        leaseExpiresAt: "2026-07-29T01:00:00.000Z"
      }
    ]
  };
  const reconciledLeasedSibling = retryFailedBoardTasks(leasedOutsideState, {
    buildTaskId: rootId,
    taskIds: [leftId, rightId],
    requestKey: "operator:batch:leased-sibling",
    actorId: "user:operator@example.com",
    reason: "terminal reconciliation fences stale sibling work",
    now: retriedAt
  });
  assert.equal(
    reconciledLeasedSibling.state.outbox.find(
      (message) => message.id === entityId<"board_outbox_message">("batch-retry-leased-sibling-message")
    )?.status,
    "dispatched"
  );
  assert.deepEqual(
    findTask(reconciledLeasedSibling.state, completedSiblingId),
    findTask(leasedOutsideState, completedSiblingId)
  );
  assert.deepEqual(state, beforeRejectedRetry);

  const runningSiblingState: BoardState = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === completedSiblingId
        ? { ...task, status: "in_progress" as const, attempt: 1, updatedAt: failedAt }
        : task
    ),
    outbox: [
      ...state.outbox,
      {
        id: entityId<"board_outbox_message">("batch-retry-running-sibling-message"),
        taskId: completedSiblingId,
        topic: "run-batch-sibling",
        idempotencyKey: `${completedSiblingId}:1`,
        status: "leased",
        payload: { taskId: completedSiblingId, attempt: 1 },
        createdAt,
        leaseId: "running-sibling-lease",
        writeFenceToken: "running-sibling-fence",
        leasedAt: createdAt,
        leaseExpiresAt: "2026-07-29T01:00:00.000Z"
      }
    ]
  };
  const eligibility = boardOperatorRetryEligibility(runningSiblingState, {
    buildTaskId: rootId,
    now: retriedAt
  });
  assert.deepEqual(eligibility, {
    eligible: true,
    recoverableTaskIds: [leftId, rightId],
    blockers: []
  });
  const recoveredRunningSibling = retryFailedBoardTasks(runningSiblingState, {
    buildTaskId: rootId,
    taskIds: eligibility.recoverableTaskIds,
    requestKey: "operator:batch:running-sibling",
    actorId: "user:operator@example.com",
    reason: "retry failed leaves and restart the fenced sibling",
    now: retriedAt
  });
  assert.equal(findTask(recoveredRunningSibling.state, completedSiblingId)?.status, "queued");
  assert.equal(
    recoveredRunningSibling.state.outbox.find(
      (message) => message.taskId === completedSiblingId && message.payload.attempt === 1
    )?.status,
    "dispatched"
  );
  assert.equal(
    recoveredRunningSibling.state.outbox.find(
      (message) => message.taskId === completedSiblingId && message.payload.attempt === 2
    )?.status,
    "pending"
  );
  assert.equal(findTask(recoveredRunningSibling.state, prerequisiteId)?.status, "done");

  assert.throws(
    () =>
      retryFailedBoardTasks(state, {
        buildTaskId: rootId,
        taskIds: [leftId],
        requestKey: "operator:batch:omitted-right",
        actorId: "user:operator@example.com",
        reason: "must select both failed page branches",
        now: retriedAt
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "build has another terminal failure outside the selected dependency chain"
  );
  assert.deepEqual(state, beforeRejectedRetry);

  const retried = retryFailedBoardTasks(state, {
    buildTaskId: rootId,
    taskIds: [rightId, leftId],
    requestKey: "operator:batch:parallel-pages",
    actorId: "user:operator@example.com",
    reason: "repair both failed page branches",
    now: retriedAt
  });
  assert.equal(retried.replay, false);
  assert.deepEqual(
    retried.nextMessages.map((message) => [message.taskId, message.payload.attempt, message.status]),
    [
      [leftId, BOARD_TASK_HARD_MAX_ATTEMPTS + 1, "pending"],
      [rightId, BOARD_TASK_HARD_MAX_ATTEMPTS + 1, "pending"]
    ]
  );
  assert.deepEqual(new Set(retried.reopenedTaskIds), new Set([rootId, leftId, rightId, downstreamId]));
  assert.equal(findTask(retried.state, rootId)?.status, "triage");
  assert.equal(findTask(retried.state, leftId)?.status, "queued");
  assert.equal(findTask(retried.state, rightId)?.status, "queued");
  assert.equal(findTask(retried.state, downstreamId)?.status, "triage");
  assert.deepEqual(findTask(retried.state, completedSiblingId), findTask(state, completedSiblingId));
  assert.equal(
    retried.state.outbox.find((message) => message.taskId === leftId && message.payload.attempt === 1)?.status,
    "dispatched"
  );

  const replay = retryFailedBoardTasks(retried.state, {
    buildTaskId: rootId,
    taskIds: [leftId, rightId],
    requestKey: "operator:batch:parallel-pages",
    actorId: "user:operator@example.com",
    reason: "repair both failed page branches",
    now: "2026-07-29T00:03:00.000Z"
  });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.state, retried.state);
  assert.deepEqual(
    replay.nextMessages.map((message) => message.id),
    retried.nextMessages.map((message) => message.id)
  );

  const exhaustedState = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === rightId ? { ...task, attempt: BOARD_OPERATOR_RETRY_HARD_MAX_ATTEMPTS } : task
    )
  };
  assert.throws(() =>
    retryFailedBoardTasks(exhaustedState, {
      buildTaskId: rootId,
      taskIds: [leftId, rightId],
      requestKey: "operator:batch:exhausted",
      actorId: "user:operator@example.com",
      reason: "must be rejected atomically",
      now: retriedAt
    })
  );
  assert.deepEqual(findTask(exhaustedState, leftId), findTask(state, leftId));
});

test("epoch supersession retires undispatched outbox messages so workers cannot claim dead work", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const oldTaskId = entityId<"task">("supersede-old");
  const leasedTaskId = entityId<"task">("supersede-leased");
  const currentTaskId = entityId<"task">("supersede-current");
  const doneTaskId = entityId<"task">("supersede-done");
  const baseTask = {
    type: "review_pass",
    title: "review",
    assigneeRole: "review_agent",
    required: true,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    kind: "dispatchable",
    dispatchTopic: "run-review",
    metadata: { repository: "acme/app" }
  } as const;
  const state: BoardState = {
    tasks: [
      { ...baseTask, id: oldTaskId, status: "queued", dedupeKey: "old:1", epoch: 1 },
      { ...baseTask, id: leasedTaskId, status: "in_progress", dedupeKey: "leased:1", epoch: 1 },
      { ...baseTask, id: doneTaskId, status: "done", dedupeKey: "done:1", epoch: 1 },
      { ...baseTask, id: currentTaskId, status: "queued", dedupeKey: "current:2", epoch: 2 }
    ],
    dependencies: [],
    events: [],
    outbox: [
      {
        id: entityId<"board_outbox_message">("supersede-message-pending"),
        taskId: oldTaskId,
        topic: "run-review",
        idempotencyKey: "old:1",
        status: "pending",
        payload: { taskId: oldTaskId, attempt: 1 },
        createdAt: now
      },
      {
        id: entityId<"board_outbox_message">("supersede-message-leased"),
        taskId: leasedTaskId,
        topic: "run-review",
        idempotencyKey: "leased:1",
        status: "leased",
        payload: { taskId: leasedTaskId, attempt: 1 },
        createdAt: now,
        leaseId: "lease",
        writeFenceToken: "fence",
        leasedAt: now,
        leaseExpiresAt: "2026-01-01T00:01:00.000Z"
      },
      {
        id: entityId<"board_outbox_message">("supersede-message-dispatched"),
        taskId: doneTaskId,
        topic: "run-review",
        idempotencyKey: "done:1",
        status: "dispatched",
        payload: { taskId: doneTaskId, attempt: 1 },
        createdAt: now,
        dispatchedAt: now
      },
      {
        id: entityId<"board_outbox_message">("supersede-message-current"),
        taskId: currentTaskId,
        topic: "run-review",
        idempotencyKey: "current:2",
        status: "pending",
        payload: { taskId: currentTaskId, attempt: 1 },
        createdAt: now
      }
    ]
  };

  const supersededAt = "2026-01-01T00:02:00.000Z";
  const next = supersedeEpochTasks(state, 2, supersededAt, (task) => task.metadata.repository === "acme/app");

  assert.equal(findTask(next, oldTaskId)?.status, "superseded");
  assert.equal(findTask(next, leasedTaskId)?.status, "superseded");
  assert.equal(findTask(next, doneTaskId)?.status, "done");
  assert.equal(findTask(next, currentTaskId)?.status, "queued");

  const outboxByTask = new Map(next.outbox.map((message) => [message.taskId, message]));
  assert.equal(outboxByTask.get(oldTaskId)?.status, "dispatched");
  assert.equal(outboxByTask.get(leasedTaskId)?.status, "dispatched");
  assert.equal(outboxByTask.get(leasedTaskId)?.leaseId, undefined);
  assert.equal(outboxByTask.get(currentTaskId)?.status, "pending");

  const retirements = next.events.filter((event) => event.type === "task.superseded_outbox_retired");
  assert.deepEqual(retirements.map((event) => event.taskId).sort(), [leasedTaskId, oldTaskId].sort());

  const claimed = leaseNextOutboxMessage(next, {
    topics: ["run-review"],
    leaseId: "next-lease",
    writeFenceToken: "next-fence",
    now: "2026-01-01T00:03:00.000Z",
    expiresAt: "2026-01-01T00:04:00.000Z"
  });
  assert.equal(claimed?.message.taskId, currentTaskId);
});

test("retry requeues back off exponentially before the next claim", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const taskId = entityId<"task">("backoff-task");
  let state = applyCommand(
    createEmptyBoardState(),
    {
      command: "CreateTask",
      task: {
        id: taskId,
        type: "fixture_retry",
        kind: "dispatchable",
        title: "Backoff fixture",
        assigneeRole: "worker",
        dedupeKey: "backoff:work",
        dispatchTopic: "run-retry-fixture"
      }
    },
    { actor: { type: "system", id: "test" }, now }
  ).state;
  state = reduceBoard(state, now);

  const first = state.outbox.find((message) => message.payload.attempt === 1);
  assert.ok(first);
  assert.equal(first.availableAt, undefined);

  const leased = leaseNextOutboxMessage(state, {
    topics: ["run-retry-fixture"],
    leaseId: "lease-1",
    writeFenceToken: "fence-1",
    now,
    expiresAt: "2026-01-01T00:05:00.000Z"
  });
  assert.ok(leased);
  state = transitionBoardTask(leased.state, taskId, "in_progress", now);

  const retried = retryLeasedOutboxTask(state, {
    messageId: leased.message.id,
    taskId,
    leaseId: "lease-1",
    writeFenceToken: "fence-1",
    attempt: 1,
    maxAttempts: 4,
    now: "2026-01-01T00:01:00.000Z",
    diagnostic: { category: "github_response", reason: "HTTP 502" }
  });
  assert.ok(retried);
  assert.equal(retried.terminal, false);
  assert.ok(retried.nextMessage);
  // Failed attempt 1 -> second attempt waits 1s.
  assert.equal(retried.nextMessage.availableAt, "2026-01-01T00:01:01.000Z");

  const tooEarly = leaseNextOutboxMessage(retried.state, {
    topics: ["run-retry-fixture"],
    leaseId: "lease-2",
    writeFenceToken: "fence-2",
    now: "2026-01-01T00:01:00.500Z",
    expiresAt: "2026-01-01T00:06:00.000Z"
  });
  assert.equal(tooEarly, undefined);

  const afterDelay = leaseNextOutboxMessage(retried.state, {
    topics: ["run-retry-fixture"],
    leaseId: "lease-2",
    writeFenceToken: "fence-2",
    now: "2026-01-01T00:01:01.000Z",
    expiresAt: "2026-01-01T00:06:00.000Z"
  });
  assert.equal(afterDelay?.message.payload.attempt, 2);
});
