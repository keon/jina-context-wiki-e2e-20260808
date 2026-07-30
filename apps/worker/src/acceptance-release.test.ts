import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerReleaseReceipts } from "./acceptance.js";

const task = { id: "task-1", type: "snapshot-context-input", status: "done", attempt: 1 };
const completion = {
  taskId: "task-1",
  taskType: "snapshot-context-input",
  attempt: 1,
  outcome: "done",
  workerReleaseId: "release-1",
  workerService: "jina-context-worker",
  workerRevision: "jina-context-worker-release-1"
};

test("production acceptance receipts bind completed work to the exact candidate revision", () => {
  assert.doesNotThrow(() =>
    assertWorkerReleaseReceipts([task], [completion], "release-1", "jina-context-worker-release-1")
  );
});

test("production acceptance rejects a completion receipt from a stale worker revision", () => {
  assert.throws(
    () =>
      assertWorkerReleaseReceipts(
        [task],
        [{ ...completion, workerRevision: "jina-context-worker-release-stale" }],
        "release-1",
        "jina-context-worker-release-1"
      ),
    /was not produced by the exact candidate worker revision/
  );
});

test("production acceptance does not require worker receipts for aggregate or manual descendants", () => {
  assert.doesNotThrow(() =>
    assertWorkerReleaseReceipts(
      [
        task,
        { id: "graph", type: "context-build-graph", status: "done", attempt: 0 },
        { id: "page", type: "context-page", status: "done", attempt: 0 }
      ],
      [completion],
      "release-1",
      "jina-context-worker-release-1"
    )
  );
});
