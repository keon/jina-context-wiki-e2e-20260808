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

test("pending count excludes running and completed work", () => {
  const queue = new JobQueue();
  queue.enqueue("first", {});
  queue.enqueue("second", {});
  assert.equal(queue.pendingCount(), 2);

  const running = queue.next();
  assert.equal(queue.pendingCount(), 1);
  queue.complete(running.id);
  assert.equal(queue.pendingCount(), 1);
});

test("running jobs can be retried without losing attempt history", () => {
  const queue = new JobQueue();
  queue.enqueue("refresh-wiki", { repository: "fixture" });

  const firstAttempt = queue.next();
  assert.equal(firstAttempt.payload.repository, "fixture");
  assert.equal(queue.retry(firstAttempt.id), true);
  assert.equal(queue.retry(firstAttempt.id), false);

  const secondAttempt = queue.next();
  assert.notStrictEqual(secondAttempt, firstAttempt);
  assert.equal(secondAttempt.id, firstAttempt.id);
  assert.equal(secondAttempt.attempts, 2);
  assert.equal(secondAttempt.status, "running");
  assert.deepEqual(secondAttempt.payload, { repository: "fixture" });
  assert.equal(queue.retry("missing"), false);
});

test("completed jobs cannot be retried", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });

  queue.next();
  assert.equal(queue.complete(created.id), true);
  assert.equal(queue.retry(created.id), false);
  assert.equal(queue.next(), null);
});

test("blank names are rejected without adding claimable work", () => {
  const queue = new JobQueue();

  assert.throws(() => queue.enqueue("   ", { repository: "fixture" }), {
    name: "TypeError",
    message: "job name is required",
  });
  assert.equal(queue.next(), null);
});
