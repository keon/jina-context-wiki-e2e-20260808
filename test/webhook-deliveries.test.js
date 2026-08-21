import assert from "node:assert/strict";
import test from "node:test";
import { WebhookDeliveries } from "../src/webhook-deliveries.js";

test("duplicate webhook events deliver once and retry safely", () => {
  const deliveries = new WebhookDeliveries();
  const first = deliveries.enqueue("event-123", { orderId: "order-7" });
  const replay = deliveries.enqueue("event-123", { orderId: "order-7" });

  assert.deepEqual(replay, first);
  assert.equal(deliveries.attempt("event-123").attempts, 1);
  assert.equal(deliveries.fail("event-123"), true);
  assert.equal(deliveries.attempt("event-123").attempts, 2);
  assert.equal(deliveries.complete("event-123"), true);
  assert.equal(deliveries.attempt("event-123"), null);
});
