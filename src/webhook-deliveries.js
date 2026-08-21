export class WebhookDeliveries {
  #deliveries = new Map();

  enqueue(eventId, payload) {
    if (!eventId?.trim()) throw new TypeError("event id is required");
    const existing = this.#deliveries.get(eventId);
    if (existing) return { ...existing };
    const delivery = { eventId, payload, attempts: 0, status: "pending" };
    this.#deliveries.set(eventId, delivery);
    return { ...delivery };
  }

  attempt(eventId) {
    const delivery = this.#deliveries.get(eventId);
    if (!delivery || delivery.status === "delivered") return null;
    delivery.attempts += 1;
    delivery.status = "delivering";
    return { ...delivery };
  }

  fail(eventId) {
    const delivery = this.#deliveries.get(eventId);
    if (!delivery || delivery.status !== "delivering") return false;
    delivery.status = "pending";
    return true;
  }

  complete(eventId) {
    const delivery = this.#deliveries.get(eventId);
    if (!delivery || delivery.status !== "delivering") return false;
    delivery.status = "delivered";
    return true;
  }
}
