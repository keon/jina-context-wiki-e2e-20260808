import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

export class WebhookDeliveries {
  #deliveries = new Map();
  #lastNow = Number.NEGATIVE_INFINITY;
  #leaseMs;
  #maxEntries;
  #now;

  constructor({ leaseMs = 30_000, maxEntries = 10_000, now = () => performance.now() } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError("leaseMs must be a positive integer");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.#leaseMs = leaseMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  enqueue(eventId, payload) {
    const normalizedId = normalizeEventId(eventId);
    const existing = this.#deliveries.get(normalizedId);
    if (!existing && this.#deliveries.size >= this.#maxEntries) throw new Error("delivery capacity exceeded");
    const normalizedPayload = cloneJsonPayload(payload);
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
    const now = this.#readNow();
    if (delivery.status === "delivering" && delivery.leaseExpiresAt > now) return null;
    delivery.attempts += 1;
    delivery.status = "delivering";
    delivery.attemptToken = crypto.randomUUID();
    delivery.leaseExpiresAt = now + this.#leaseMs;
    return snapshot(delivery, true);
  }

  fail(eventId, attemptToken) {
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!ownsLiveAttempt(delivery, attemptToken, this.#readNow())) return false;
    delivery.status = "pending";
    delete delivery.attemptToken;
    delete delivery.leaseExpiresAt;
    return true;
  }

  renew(eventId, attemptToken) {
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    const now = this.#readNow();
    if (!ownsLiveAttempt(delivery, attemptToken, now)) return false;
    delivery.leaseExpiresAt = now + this.#leaseMs;
    return true;
  }

  complete(eventId, attemptToken) {
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!ownsLiveAttempt(delivery, attemptToken, this.#readNow())) return false;
    delivery.status = "delivered";
    delete delivery.attemptToken;
    delete delivery.leaseExpiresAt;
    return true;
  }

  #readNow() {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError("clock must return a finite timestamp");
    if (now < this.#lastNow) throw new RangeError("clock must be monotonic");
    this.#lastNow = now;
    return now;
  }
}

function snapshot(delivery, includeAttemptToken = false) {
  const value = structuredClone(delivery);
  if (!includeAttemptToken) delete value.attemptToken;
  return value;
}

function normalizeEventId(eventId) {
  if (typeof eventId !== "string" || !eventId.trim()) throw new TypeError("event id is required");
  const normalized = eventId.trim();
  if (normalized.length > 256 || Buffer.byteLength(normalized, "utf8") > 256) {
    throw new TypeError("event id exceeds 256 bytes");
  }
  return normalized;
}

function cloneJsonPayload(payload) {
  validateJsonValue(payload, new Set(), 0, { bytes: 0, properties: 0 });
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new TypeError("event payload exceeds 64 KiB");
  return JSON.parse(encoded);
}

function ownsLiveAttempt(delivery, attemptToken, now) {
  return delivery?.status === "delivering"
    && delivery.attemptToken === attemptToken
    && Number.isFinite(now)
    && delivery.leaseExpiresAt > now;
}

function validateJsonValue(value, ancestors, depth, budget) {
  if (depth > 64) throw new TypeError("event payload nesting exceeds 64 levels");
  if (typeof value === "string" && value.length > 64 * 1024) {
    throw new TypeError("event payload exceeds 64 KiB");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    chargePayloadBudget(budget, JSON.stringify(value));
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    chargePayloadBudget(budget, JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") throw new TypeError("event payload must contain only JSON values");
  if (ancestors.has(value)) throw new TypeError("event payload must not contain cycles");
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("event payload must contain only JSON objects and arrays");
  }
  ancestors.add(value);
  chargePayloadBudget(budget, "[]");
  let entries = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    budget.properties += 1;
    if (budget.properties > 4_096) throw new TypeError("event payload has too many properties");
    if (entries > 0) chargePayloadBudget(budget, ",");
    if (key.length > 64 * 1024) throw new TypeError("event payload exceeds 64 KiB");
    if (!isArray) chargePayloadBudget(budget, `${JSON.stringify(key)}:`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("event payload properties must be enumerable JSON data");
    }
    validateJsonValue(descriptor.value, ancestors, depth + 1, budget);
    entries += 1;
  }
  ancestors.delete(value);
  validateJsonProperties(value, isArray, entries);
}

function validateJsonProperties(value, isArray, enumerableEntries) {
  if (isArray && enumerableEntries !== value.length) {
    throw new TypeError("event payload arrays must not contain holes");
  }
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

function chargePayloadBudget(budget, fragment) {
  if (typeof fragment === "string" && fragment.length > 64 * 1024) {
    throw new TypeError("event payload exceeds 64 KiB");
  }
  budget.bytes += Buffer.byteLength(fragment, "utf8");
  if (budget.bytes > 64 * 1024) throw new TypeError("event payload exceeds 64 KiB");
}
