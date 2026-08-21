import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

export class WebhookDeliveries {
  #deliveries = new Map();
  #lastNow = Number.NEGATIVE_INFINITY;
  #leaseMs;
  #maxEntries;
  #now;
  #readingClock = false;
  #validatingPayload = false;

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
    this.#assertNotReentrant();
    const normalizedId = normalizeEventId(eventId);
    const existing = this.#deliveries.get(normalizedId);
    this.#validatingPayload = true;
    let normalizedPayload;
    try {
      normalizedPayload = cloneJsonPayload(payload);
    } finally {
      this.#validatingPayload = false;
    }
    if (existing) {
      if (!isDeepStrictEqual(existing.payload, normalizedPayload)) {
        throw new TypeError("event payload conflicts with replay");
      }
      return snapshot(existing);
    }
    this.#makeRoom();
    const delivery = { eventId: normalizedId, payload: normalizedPayload, attempts: 0, status: "pending" };
    this.#deliveries.set(normalizedId, delivery);
    return snapshot(delivery);
  }

  attempt(eventId) {
    this.#assertNotReentrant();
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!delivery || delivery.status === "delivered") return null;
    const now = this.#readNow();
    if (delivery.status === "delivering" && delivery.leaseExpiresAt > now) return null;
    const leaseExpiresAt = this.#leaseDeadline(now);
    delivery.attempts += 1;
    delivery.status = "delivering";
    delivery.attemptToken = crypto.randomUUID();
    delivery.leaseExpiresAt = leaseExpiresAt;
    return snapshot(delivery, true);
  }

  fail(eventId, attemptToken) {
    this.#assertNotReentrant();
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!ownsLiveAttempt(delivery, attemptToken, this.#readNow())) return false;
    delivery.status = "pending";
    delete delivery.attemptToken;
    delete delivery.leaseExpiresAt;
    return true;
  }

  renew(eventId, attemptToken) {
    this.#assertNotReentrant();
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    const now = this.#readNow();
    if (!ownsLiveAttempt(delivery, attemptToken, now)) return false;
    delivery.leaseExpiresAt = this.#leaseDeadline(now);
    return true;
  }

  complete(eventId, attemptToken) {
    this.#assertNotReentrant();
    const delivery = this.#deliveries.get(normalizeEventId(eventId));
    if (!ownsLiveAttempt(delivery, attemptToken, this.#readNow())) return false;
    delivery.status = "delivered";
    delete delivery.attemptToken;
    delete delivery.leaseExpiresAt;
    return true;
  }

  #readNow() {
    this.#readingClock = true;
    let now;
    try {
      now = this.#now();
    } finally {
      this.#readingClock = false;
    }
    if (!Number.isFinite(now)) throw new TypeError("clock must return a finite timestamp");
    if (now < this.#lastNow) throw new RangeError("clock must be monotonic");
    this.#leaseDeadline(now);
    this.#lastNow = now;
    return now;
  }

  #leaseDeadline(now) {
    const deadline = now + this.#leaseMs;
    if (!Number.isFinite(deadline) || deadline <= now) throw new RangeError("clock is too large for lease duration");
    return deadline;
  }

  #makeRoom() {
    if (this.#deliveries.size < this.#maxEntries) return;
    for (const [eventId, delivery] of this.#deliveries) {
      if (delivery.status !== "delivered") continue;
      this.#deliveries.delete(eventId);
      return;
    }
    throw new Error("delivery capacity exceeded");
  }

  #assertNotReentrant() {
    if (this.#validatingPayload || this.#readingClock) {
      throw new Error("delivery operations cannot reenter callbacks");
    }
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
  const cloned = normalizeJsonValue(payload, new Set(), 0, { bytes: 0, properties: 0 });
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

function normalizeJsonValue(value, ancestors, depth, budget) {
  if (depth > 64) throw new TypeError("event payload nesting exceeds 64 levels");
  if (typeof value === "string" && value.length > 64 * 1024) {
    throw new TypeError("event payload exceeds 64 KiB");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    chargePayloadBudget(budget, JSON.stringify(value));
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const encoded = JSON.stringify(value);
    chargePayloadBudget(budget, encoded);
    return JSON.parse(encoded);
  }
  if (typeof value !== "object") throw new TypeError("event payload must contain only JSON values");
  if (ancestors.has(value)) throw new TypeError("event payload must not contain cycles");
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("event payload must contain only JSON objects and arrays");
  }
  ancestors.add(value);
  const cloned = isArray ? [] : Object.create(null);
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
    const child = normalizeJsonValue(descriptor.value, ancestors, depth + 1, budget);
    Object.defineProperty(cloned, key, { value: child, enumerable: true, writable: true, configurable: true });
    entries += 1;
  }
  ancestors.delete(value);
  validateJsonProperties(value, isArray, entries);
  return cloned;
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
