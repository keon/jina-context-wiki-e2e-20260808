import assert from "node:assert/strict";
import test from "node:test";
import { JobQueue } from "../src/job-queue.js";

test("jobs move from queued to completed", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", { repository: "fixture" });
  const running = queue.next();

  assert.equal(running.id, created.id);
  assert.equal(running.attempts, 1);
  assert.equal(queue.complete(running.id, running.attemptToken), true);
});

test("running jobs can be retried without losing attempt history", () => {
  const queue = new JobQueue();
  queue.enqueue("refresh-wiki", { repository: "fixture" });

  const firstAttempt = queue.next();
  assert.equal(firstAttempt.payload.repository, "fixture");
  assert.equal(queue.retry(firstAttempt.id, firstAttempt.attemptToken), true);
  assert.equal(queue.retry(firstAttempt.id, firstAttempt.attemptToken), false);

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

  const running = queue.next();
  assert.equal(queue.complete(created.id, running.attemptToken), true);
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

test("completion requires a running attempt and succeeds only once", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", {});
  assert.equal(queue.complete(created.id), false);
  assert.equal(queue.complete("missing"), false);
  const running = queue.next();
  assert.equal(running.id, created.id);
  assert.equal(queue.complete(created.id, running.attemptToken), true);
  assert.equal(queue.complete(created.id), false);
  assert.equal(queue.retry(created.id), false);
  assert.equal(queue.next(), null);
});

test("a queued retry cannot be completed until claimed again", () => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", {});
  const running = queue.next();
  assert.equal(queue.retry(created.id, running.attemptToken), true);
  assert.equal(queue.complete(created.id), false);
  const retried = queue.next();
  assert.equal(retried.id, created.id);
  assert.equal(retried.attempts, 2);
  assert.equal(queue.complete(created.id, retried.attemptToken), true);
});

test("obsolete attempts cannot complete or retry a newly claimed attempt", () => {
  const queue = new JobQueue();
  queue.enqueue("refresh-wiki", {});
  const first = queue.next();
  for (const token of [undefined, null, "wrong"]) {
    assert.equal(queue.complete(first.id, token), false);
    assert.equal(queue.retry(first.id, token), false);
  }
  assert.equal(queue.retry(first.id, first.attemptToken), true);
  const second = queue.next();
  assert.notEqual(second.attemptToken, first.attemptToken);
  assert.equal(queue.complete(first.id, first.attemptToken), false);
  assert.equal(queue.retry(first.id, first.attemptToken), false);
  assert.equal(queue.next(), null);
  assert.equal(queue.complete(second.id, second.attemptToken), true);
  assert.equal(queue.complete(second.id, second.attemptToken), false);
  assert.equal(queue.retry(second.id, second.attemptToken), false);
});

test("token generation failure leaves the queued job claimable", (t) => {
  const queue = new JobQueue();
  const created = queue.enqueue("refresh-wiki", {});
  const uuid = t.mock.method(crypto, "randomUUID", () => {
    throw new Error("entropy temporarily unavailable");
  });
  assert.throws(() => queue.next(), /entropy temporarily unavailable/);
  uuid.mock.restore();
  const running = queue.next();
  assert.equal(running.id, created.id);
  assert.equal(running.attempts, 1);
  assert.equal(queue.complete(running.id, running.attemptToken), true);
});

test("retries join the tail behind jobs already waiting", () => {
  const queue = new JobQueue();
  const first = queue.enqueue("first", {});
  const second = queue.enqueue("second", {});
  const third = queue.enqueue("third", {});
  const running = queue.next();
  assert.equal(queue.retry(running.id, running.attemptToken), true);
  assert.equal(queue.next().id, second.id);
  assert.equal(queue.next().id, third.id);
  assert.equal(queue.next().id, first.id);
});

test("producer and worker snapshots cannot mutate stored payloads", () => {
  const queue = new JobQueue();
  const input = { nested: { value: 1 }, items: [1] };
  const created = queue.enqueue("refresh-wiki", input);
  input.nested.value = 2;
  created.payload.nested.value = 3;
  const running = queue.next();
  assert.equal(running.payload.nested.value, 1);
  running.payload.nested.value = 4;
  running.payload.items.push(2);
  assert.equal(queue.retry(running.id, running.attemptToken), true);
  const next = queue.next();
  assert.deepEqual(next.payload, { nested: { value: 1 }, items: [1] });
  assert.equal(queue.complete(next.id, next.attemptToken), true);
});

test("uncloneable payloads fail before enqueueing work", () => {
  const queue = new JobQueue();
  assert.throws(() => queue.enqueue("invalid", { callback() {} }), { name: "DataCloneError" });
  assert.equal(queue.next(), null);
});
