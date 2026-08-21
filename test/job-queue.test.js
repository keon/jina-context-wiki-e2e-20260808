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

test("running jobs can be retried without losing attempt history", () => {
  const queue = new JobQueue();
  queue.enqueue("refresh-wiki", { repository: "fixture" });

  const firstAttempt = queue.next();
  assert.equal(queue.retry(firstAttempt.id), true);
  assert.equal(queue.retry(firstAttempt.id), false);

  const secondAttempt = queue.next();
  assert.equal(secondAttempt.id, firstAttempt.id);
  assert.equal(secondAttempt.attempts, 2);
  assert.equal(secondAttempt.status, "running");
  assert.equal(queue.retry("missing"), false);
});
