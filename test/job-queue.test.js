import assert from "node:assert/strict";
import test from "node:test";
import { JobQueue } from "../src/job-queue.js";

test("jobs move from queued to completed", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const running = queue.next();

  assert.equal(running.id, created.id);
  assert.equal(running.attempts, 1);
  assert.equal(queue.complete(running.id, running.attempts), true);
});

test("a failed job can be retried within its attempt budget", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  queue.next();

  assert.equal(queue.retry(created.id), true);
  assert.equal(queue.next().attempts, 2);
});

test("retry budgets are finite positive integers and terminal failure cannot revive", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  queue.next();

  assert.throws(() => queue.retry(created.id, Number.NaN), /positive integer/);
  assert.throws(() => queue.retry(created.id, Number.POSITIVE_INFINITY), /positive integer/);
  assert.equal(queue.retry(created.id, 1), true);
  assert.equal(queue.next(), null);
  assert.equal(queue.retry(created.id, 3), false);
});

test("completed jobs cannot be retried", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const running = queue.next();

  assert.equal(queue.complete(created.id, running.attempts), true);
  assert.equal(queue.retry(created.id), false);
  assert.equal(queue.next(), null);
});

test("stale completions cannot overwrite a newer attempt", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const first = queue.next();

  assert.equal(queue.retry(created.id), true);
  const second = queue.next();
  assert.equal(second.attempts, 2);
  assert.equal(queue.complete(created.id, first.attempts), false);
  assert.equal(queue.complete(created.id, second.attempts), true);
});
