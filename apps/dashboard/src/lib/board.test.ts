import assert from "node:assert/strict";
import { test } from "node:test";
import { filterBoardTasks, EMPTY_BOARD_FILTERS, partitionBoardTasks, taskRelationships } from "./board.ts";
import type { BoardState, BoardTask } from "./types.ts";

function task(overrides: Partial<BoardTask> & { readonly id: string }): BoardTask {
  return {
    type: "review",
    title: overrides.id,
    status: "queued",
    attempt: 1,
    ...overrides
  };
}

test("partitionBoardTasks keeps only the latest context build request per scope", () => {
  const scope = { tenantId: "t", repository: "o/r", ref: "main" };
  const tasks = [
    task({
      id: "old-build",
      type: "build-context",
      createdAt: "2026-01-01T00:00:00Z",
      metadata: { ...scope, requestKey: "old" }
    }),
    task({
      id: "new-build",
      type: "build-context",
      createdAt: "2026-01-02T00:00:00Z",
      metadata: { ...scope, requestKey: "new" }
    }),
    task({
      id: "old-stage",
      type: "research-context-subject",
      metadata: { ...scope, requestKey: "old" }
    }),
    task({
      id: "new-stage",
      type: "write-context-page",
      metadata: { ...scope, requestKey: "new" }
    }),
    task({ id: "plain" }),
    task({ id: "superseded", status: "superseded" })
  ];
  const { current, history } = partitionBoardTasks(tasks);
  assert.deepEqual(
    current.map((item) => item.id),
    ["new-build", "new-stage", "plain"]
  );
  assert.deepEqual(
    history.map((item) => item.id),
    ["old-build", "old-stage", "superseded"]
  );
});

test("filterBoardTasks combines query and facet filters", () => {
  const tasks = [
    task({ id: "a", title: "Review PR", type: "review", assigneeRole: "agent", metadata: { repository: "o/r" } }),
    task({ id: "b", title: "Publish", type: "publish", assigneeRole: "human", metadata: { repository: "o/x" } })
  ];
  assert.deepEqual(
    filterBoardTasks(tasks, { ...EMPTY_BOARD_FILTERS, query: "review" }).map((item) => item.id),
    ["a"]
  );
  assert.deepEqual(
    filterBoardTasks(tasks, { ...EMPTY_BOARD_FILTERS, repository: "o/x" }).map((item) => item.id),
    ["b"]
  );
  assert.deepEqual(
    filterBoardTasks(tasks, { ...EMPTY_BOARD_FILTERS, owner: "agent", status: "queued" }).map((item) => item.id),
    ["a"]
  );
});

test("filterBoardTasks searches original workspace and PR author names", () => {
  const tasks = [
    task({
      id: "identity",
      title: "Review PR",
      metadata: { repository: "omxyz/jina", workspaceLabel: "omxyz", authorLogin: "octocat" }
    })
  ];
  assert.deepEqual(
    filterBoardTasks(tasks, { ...EMPTY_BOARD_FILTERS, query: "octocat" }).map((item) => item.id),
    ["identity"]
  );
  assert.deepEqual(
    filterBoardTasks(tasks, { ...EMPTY_BOARD_FILTERS, query: "omxyz" }).map((item) => item.id),
    ["identity"]
  );
});

test("taskRelationships returns parent, child, and both dependency directions", () => {
  const selected = task({ id: "selected", parentTaskId: "parent" });
  const board = {
    tasks: [selected, task({ id: "parent" }), task({ id: "child", parentTaskId: "selected" }), task({ id: "other" })],
    dependencies: [
      { taskId: "selected", dependsOnTaskId: "other", relationship: "blocks", required: true },
      { taskId: "other", dependsOnTaskId: "selected", relationship: "informs", required: false }
    ]
  } as BoardState;
  assert.deepEqual(taskRelationships(selected, board), [
    { direction: "Parent", taskId: "parent", relationship: "parent" },
    { direction: "Child", taskId: "child", relationship: "child" },
    { direction: "Depends on", taskId: "other", relationship: "blocks", required: true },
    { direction: "Required by", taskId: "other", relationship: "informs", required: false }
  ]);
});
