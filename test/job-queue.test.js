import assert from "node:assert/strict";
import test from "node:test";
import { JobQueue } from "../src/job-queue.js";

test("jobs move from queued to completed", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const running = queue.next();

  assert.equal(running.id, created.id);
  assert.equal(running.attempts, 1);
  assert.equal(queue.complete(running.id), true);
});
