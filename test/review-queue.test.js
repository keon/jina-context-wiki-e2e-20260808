import assert from "node:assert/strict";
import test from "node:test";

import { selectOldestPendingReview } from "../src/review-queue.js";

test("selects the oldest pending review without changing the input", () => {
  const queue = [
    { id: "completed", status: "completed", createdAt: "2026-08-12T23:00:00Z" },
    { id: "newer", status: "pending", createdAt: "2026-08-13T05:00:00Z" },
    { id: "older", status: "pending", createdAt: "2026-08-13T04:00:00Z" }
  ];
  const original = structuredClone(queue);

  assert.equal(selectOldestPendingReview(queue)?.id, "older");
  assert.deepEqual(queue, original);
});

test("returns undefined when no pending review exists", () => {
  assert.equal(
    selectOldestPendingReview([
      { id: "completed", status: "completed", createdAt: "2026-08-13T04:00:00Z" }
    ]),
    undefined
  );
});
