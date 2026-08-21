import { isDeepStrictEqual } from "node:util";

export class WebhookDeliveries {
  #deliveries = new Map();

  enqueue(eventId, payload) {
    const normalizedId = eventId?.trim();
    if (!normalizedId) throw new TypeError("event id is required");
    const existing = this.#deliveries.get(normalizedId);
    if (existing) {
      if (!isDeepStrictEqual(existing.payload, payload)) throw new TypeError("event payload conflicts with replay");
      return snapshot(existing);
    }
    const delivery = { eventId: normalizedId, payload: structuredClone(payload), attempts: 0, status: "pending" };
    this.#deliveries.set(normalizedId, delivery);
    return snapshot(delivery);
  }

  attempt(eventId) {
    const delivery = this.#deliveries.get(eventId.trim());
    if (!delivery || delivery.status !== "pending") return null;
    delivery.attempts += 1;
    delivery.status = "delivering";
    delivery.attemptToken = crypto.randomUUID();
    return snapshot(delivery);
  }

  fail(eventId, attemptToken) {
    const delivery = this.#deliveries.get(eventId.trim());
    if (!delivery || delivery.status !== "delivering" || delivery.attemptToken !== attemptToken) return false;
    delivery.status = "pending";
    delete delivery.attemptToken;
    return true;
  }

  complete(eventId, attemptToken) {
    const delivery = this.#deliveries.get(eventId.trim());
    if (!delivery || delivery.status !== "delivering" || delivery.attemptToken !== attemptToken) return false;
    delivery.status = "delivered";
    delete delivery.attemptToken;
    return true;
  }
}

function snapshot(delivery) {
  return structuredClone(delivery);
}
