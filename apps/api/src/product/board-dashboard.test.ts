import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeDashboardWorkOverviews,
  projectRelationalBoardDashboard,
} from "./board-dashboard.js";

test("relational Board projection maps external waits into live dashboard progress and traceable history", () => {
  const overview = projectRelationalBoardDashboard({
    workflows: [
      {
        id: "workflow-1",
        workflow_type: "pr_review",
        pipeline_version: "pr_review.board.v1",
        status: "running",
        epoch: 1,
        trace_id: "a".repeat(32),
        created_at: "2026-08-04T10:00:00.000Z",
        updated_at: "2026-08-04T10:01:00.000Z",
        metadata: {
          repository: "omxyz/jina",
          pull_request_number: 42,
          head_sha: "head-1",
        },
      },
    ],
    tasks: [
      {
        id: "task-1",
        workflow_id: "workflow-1",
        parent_task_id: null,
        task_type: "runtime-review",
        topic: "runtime-review",
        status: "waiting_external",
        attempt_count: 2,
        required: true,
        created_at: "2026-08-04T10:00:00.000Z",
        updated_at: "2026-08-04T10:01:00.000Z",
        metadata: { review_run_id: "review-1" },
      },
    ],
    dependencies: [],
    events: [
      {
        id: 9,
        workflow_id: "workflow-1",
        task_id: "task-1",
        attempt_id: "00000000-0000-4000-8000-000000000009",
        event_type: "task.claimed",
        actor_type: "worker",
        actor_id: "worker-1",
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        occurred_at: "2026-08-04T10:01:00.000Z",
        payload: { claim: 1 },
      },
    ],
  });

  assert.deepEqual(overview.board.tasks[0], {
    id: "task-1",
    type: "runtime-review",
    title: "Runtime Review",
    status: "in_progress",
    assigneeRole: "review-agent",
    attempt: 2,
    epoch: 1,
    required: true,
    dispatchTopic: "runtime-review",
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:01:00.000Z",
    metadata: {
      repository: "omxyz/jina",
      pull_request_number: 42,
      head_sha: "head-1",
      review_run_id: "review-1",
      workflowId: "workflow-1",
      workflowType: "pr_review",
      workflowStatus: "running",
      pipelineVersion: "pr_review.board.v1",
      traceId: "a".repeat(32),
      pullRequestNumber: 42,
      headSha: "head-1",
    },
  });
  assert.deepEqual(overview.events[0], {
    id: "relational-board-event:9",
    seq: 9,
    taskId: "task-1",
    type: "task.claimed",
    at: "2026-08-04T10:01:00.000Z",
    payload: {
      claim: 1,
      workflowId: "workflow-1",
      attemptId: "00000000-0000-4000-8000-000000000009",
      actorType: "worker",
      actorId: "worker-1",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    },
  });
});

test("work overview merge preserves legacy Context tasks and adds relational review tasks", () => {
  const merged = mergeDashboardWorkOverviews(
    {
      board: {
        tasks: [{ id: "context-1", type: "build-context", title: "Context", status: "queued", attempt: 1 }],
        dependencies: [],
        outbox: [{ id: "legacy-outbox" }],
      },
      events: [{ id: "legacy-event", type: "task.created", at: "2026-08-04T09:00:00.000Z" }],
    },
    {
      board: {
        tasks: [{ id: "review-1", type: "prepare-review", title: "Prepare Review", status: "done", attempt: 1 }],
        dependencies: [],
      },
      events: [{ id: "review-event", type: "task.succeeded", at: "2026-08-04T10:00:00.000Z" }],
    },
  );

  assert.deepEqual(merged.board.tasks.map((task) => task.id), ["context-1", "review-1"]);
  assert.deepEqual(merged.board.outbox, [{ id: "legacy-outbox" }]);
  assert.deepEqual(merged.events.map((event) => event.id), ["review-event", "legacy-event"]);
});
