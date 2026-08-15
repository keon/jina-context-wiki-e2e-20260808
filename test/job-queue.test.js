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
  const running = queue.next();

  assert.equal(queue.retry(created.id, running.attempts), true);
  assert.equal(queue.next().attempts, 2);
});

test("retry budgets are finite positive integers and terminal failure cannot revive", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const running = queue.next();

  assert.throws(() => queue.retry(created.id, running.attempts, Number.NaN), /positive integer/);
  assert.throws(() => queue.retry(created.id, running.attempts, Number.POSITIVE_INFINITY), /positive integer/);
  assert.equal(queue.retry(created.id, running.attempts, 1), true);
  assert.equal(queue.next(), null);
  assert.equal(queue.retry(created.id, running.attempts, 3), false);
});

test("completed jobs cannot be retried", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const running = queue.next();

  assert.equal(queue.complete(created.id, running.attempts), true);
  assert.equal(queue.retry(created.id, running.attempts), false);
  assert.equal(queue.next(), null);
});

test("completion requires an explicit attempt token", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  queue.next();

  assert.throws(() => queue.complete(created.id), /attempt must be a positive integer/);
});

test("stale completions cannot overwrite a newer attempt", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const first = queue.next();

  assert.equal(queue.retry(created.id, first.attempts), true);
  const second = queue.next();
  assert.equal(second.attempts, 2);
  assert.equal(queue.retry(created.id, first.attempts), false);
  assert.equal(queue.complete(created.id, first.attempts), false);
  assert.equal(queue.complete(created.id, second.attempts), true);
});

test("a retry budget cannot increase after the lifecycle begins", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const first = queue.next();

  assert.equal(queue.retry(created.id, first.attempts, 2), true);
  const second = queue.next();
  assert.equal(queue.retry(created.id, second.attempts, 100), true);
  assert.equal(queue.next(), null);
});

test("the default retry argument cannot shrink an established budget", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const first = queue.next();

  assert.equal(queue.retry(created.id, first.attempts, 5), true);
  const second = queue.next();
  assert.equal(queue.retry(created.id, second.attempts), true);
  const third = queue.next();
  assert.equal(third.attempts, 3);
});

test("retried jobs return behind work that is already queued", () => {
  const queue = new JobQueue();
  const firstCreated = queue.enqueue("first", {});
  const secondCreated = queue.enqueue("second", {});
  const firstAttempt = queue.next();

  assert.equal(queue.retry(firstCreated.id, firstAttempt.attempts), true);
  assert.equal(queue.next().id, secondCreated.id);
  assert.equal(queue.next().id, firstCreated.id);
});
