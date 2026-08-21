import assert from "node:assert/strict";
import test from "node:test";
import { WebhookDeliveries } from "../src/webhook-deliveries.js";

test("duplicate webhook events deliver once and retry safely", () => {
  const deliveries = new WebhookDeliveries();
  const first = deliveries.enqueue("event-123", { orderId: "order-7" });
  const replay = deliveries.enqueue(" event-123 ", { orderId: "order-7" });

  assert.deepEqual(replay, first);
  const firstAttempt = deliveries.attempt("event-123");
  assert.equal(firstAttempt.attempts, 1);
  assert.equal(deliveries.enqueue("event-123", { orderId: "order-7" }).attemptToken, undefined);
  assert.equal(deliveries.attempt("event-123"), null);
  assert.equal(deliveries.fail("event-123", firstAttempt.attemptToken), true);
  const retry = deliveries.attempt("event-123");
  assert.equal(retry.attempts, 2);
  assert.equal(deliveries.complete("event-123", firstAttempt.attemptToken), false);
  assert.equal(deliveries.fail("event-123", firstAttempt.attemptToken), false);
  assert.equal(deliveries.complete("event-123", retry.attemptToken), true);
  assert.equal(deliveries.attempt("event-123"), null);
});

test("replays reject conflicting or externally mutated payloads", () => {
  const deliveries = new WebhookDeliveries();
  const payload = { order: { id: "order-7" } };
  const created = deliveries.enqueue("event-123", payload);
  payload.order.id = "mutated-input";
  created.payload.order.id = "mutated-output";

  assert.deepEqual(deliveries.enqueue("event-123", { order: { id: "order-7" } }).payload, {
    order: { id: "order-7" },
  });
  assert.throws(
    () => deliveries.enqueue("event-123", { order: { id: "different-order" } }),
    /payload conflicts/,
  );
  assert.throws(
    () => deliveries.enqueue("shared-event", { bytes: new SharedArrayBuffer(8) }),
    /JSON objects and arrays/,
  );
  assert.throws(() => deliveries.enqueue("large-event", { body: "x".repeat(65 * 1024) }), /exceeds 64 KiB/);
  const customSerialization = { orderId: "order-7" };
  Object.defineProperty(customSerialization, "toJSON", {
    value: () => ({ orderId: "rewritten" }),
    enumerable: false,
  });
  assert.throws(() => deliveries.enqueue("custom-event", customSerialization), /enumerable JSON data/);
  let deeplyNested = {};
  for (let depth = 0; depth < 65; depth += 1) deeplyNested = { child: deeplyNested };
  assert.throws(() => deliveries.enqueue("deep-event", deeplyNested), /nesting exceeds 64 levels/);
});

test("an expired delivery claim is reclaimed without accepting stale completion", () => {
  let now = 1_000;
  const deliveries = new WebhookDeliveries({ leaseMs: 100, now: () => now });
  deliveries.enqueue("event-123", { orderId: "order-7" });
  const abandoned = deliveries.attempt("event-123");

  now = 1_101;
  assert.equal(deliveries.complete("event-123", abandoned.attemptToken), false);
  const reclaimed = deliveries.attempt("event-123");
  assert.equal(reclaimed.attempts, 2);
  assert.notEqual(reclaimed.attemptToken, abandoned.attemptToken);
  assert.equal(deliveries.complete("event-123", abandoned.attemptToken), false);
  assert.equal(deliveries.complete("event-123", reclaimed.attemptToken), true);
});

test("workers renew active claims and receivers share a stable idempotency key", () => {
  let now = 1_000;
  const deliveries = new WebhookDeliveries({ leaseMs: 100, now: () => now });
  deliveries.enqueue("event-123", { orderId: "order-7" });
  const first = deliveries.attempt("event-123");

  now = 1_075;
  assert.equal(deliveries.renew("event-123", first.attemptToken), true);
  now = 1_150;
  assert.equal(deliveries.attempt("event-123"), null);
  now = 1_176;
  assert.equal(deliveries.renew("event-123", first.attemptToken), false);
  const reclaimed = deliveries.attempt("event-123");

  assert.equal(reclaimed.eventId, first.eventId);
  assert.equal(deliveries.complete("event-123", first.attemptToken), false);
  assert.equal(deliveries.complete("event-123", reclaimed.attemptToken), true);
});
