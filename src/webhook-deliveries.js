import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

export class WebhookDeliveries {
  #deliveries = new Map();
  #leaseMs;
  #now;

  constructor({ leaseMs = 30_000, now = () => performance.now() } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError("leaseMs must be a positive integer");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.#leaseMs = leaseMs;
    this.#now = now;
  }

  enqueue(eventId, payload) {
    const normalizedId = normalizeEventId(eventId);
    const normalizedPayload = cloneJsonPayload(payload);
    const existing = this.#deliveries.get(normalizedId);
    if (existing) {
      if (!isDeepStrictEqual(existing.payload, normalizedPayload)) {
        throw new TypeError("event payload conflicts with replay");
      }
      return snapshot(existing);
    }
    const delivery = { eventId: normalizedId, payload: normalizedPayload, attempts: 0, status: "pending" };
    this.#deliveries.set(normalizedId, delivery);
    return snapshot(delivery);
  }

  attempt(eventId) {
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!delivery || delivery.status === "delivered") return null;
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError("clock must return a finite timestamp");
    if (delivery.status === "delivering" && delivery.leaseExpiresAt > now) return null;
    delivery.attempts += 1;
    delivery.status = "delivering";
    delivery.attemptToken = crypto.randomUUID();
    delivery.leaseExpiresAt = now + this.#leaseMs;
    return snapshot(delivery, true);
  }

  fail(eventId, attemptToken) {
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!ownsLiveAttempt(delivery, attemptToken, this.#now())) return false;
    delivery.status = "pending";
    delete delivery.attemptToken;
    delete delivery.leaseExpiresAt;
    return true;
  }

  complete(eventId, attemptToken) {
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!ownsLiveAttempt(delivery, attemptToken, this.#now())) return false;
    delivery.status = "delivered";
    delete delivery.attemptToken;
    delete delivery.leaseExpiresAt;
    return true;
  }
}

function snapshot(delivery, includeAttemptToken = false) {
  const value = structuredClone(delivery);
  if (!includeAttemptToken) delete value.attemptToken;
  return value;
}

function normalizeEventId(eventId) {
  if (typeof eventId !== "string" || !eventId.trim()) throw new TypeError("event id is required");
  return eventId.trim();
}

function cloneJsonPayload(payload) {
  validateJsonValue(payload, new Set(), 0);
  const cloned = structuredClone(payload);
  const encoded = JSON.stringify(cloned);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new TypeError("event payload exceeds 64 KiB");
  return cloned;
}

function ownsLiveAttempt(delivery, attemptToken, now) {
  return delivery?.status === "delivering"
    && delivery.attemptToken === attemptToken
    && Number.isFinite(now)
    && delivery.leaseExpiresAt > now;
}

function validateJsonValue(value, ancestors, depth) {
  if (depth > 64) throw new TypeError("event payload nesting exceeds 64 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new TypeError("event payload must contain only JSON values");
  if (ancestors.has(value)) throw new TypeError("event payload must not contain cycles");
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("event payload must contain only JSON objects and arrays");
  }
  validateJsonProperties(value, isArray);
  ancestors.add(value);
  const entries = isArray ? value.entries() : Object.entries(value);
  for (const [, child] of entries) validateJsonValue(child, ancestors, depth + 1);
  ancestors.delete(value);
}

function validateJsonProperties(value, isArray) {
  for (const key of Reflect.ownKeys(value)) {
    if (isArray && key === "length") continue;
    const index = typeof key === "string" ? Number(key) : -1;
    if (isArray && (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key)) {
      throw new TypeError("event payload arrays must contain only indexed JSON values");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("event payload properties must be enumerable JSON data");
    }
  }
}
