const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_TOKEN_ATTEMPTS = 8;

export class AccountDeletionRequests {
  #activeByUser = new Map();
  #busy = false;
  #lastNow = 0;
  #maxEntries;
  #now;
  #requests = new Map();
  #retired = new Set();
  #ttlMs;

  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
    this.#maxEntries = maxEntries;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  request(userId) {
    return this.#exclusive(() => {
      const user = normalizeUserId(userId);
      const now = this.#readNow();
      const existing = this.#requests.get(this.#activeByUser.get(user));
      if (existing?.expiresAt > now) return snapshot(existing);
      if (existing) this.#retire(existing);

      if (this.#requests.size >= this.#maxEntries) this.#sweepExpired(now);
      if (this.#requests.size >= this.#maxEntries) throw new RangeError("deletion request capacity reached");
      if (now > Number.MAX_SAFE_INTEGER - this.#ttlMs) {
        throw new RangeError("deletion deadline is not representable");
      }

      const request = {
        token: this.#newToken(),
        userId: user,
        status: "pending",
        expiresAt: now + this.#ttlMs,
      };
      this.#requests.set(request.token, request);
      this.#activeByUser.set(user, request.token);
      return snapshot(request);
    });
  }

  confirm(token) {
    return this.#exclusive(() => this.#finish(token));
  }

  cancel(token) {
    return this.#exclusive(() => this.#finish(token));
  }

  #exclusive(operation) {
    if (this.#busy) throw new Error("reentrant deletion request operation");
    this.#busy = true;
    try {
      return operation();
    } finally {
      this.#busy = false;
    }
  }

  #finish(token) {
    const request = this.#requests.get(token);
    if (!request) return false;
    const now = this.#readNow();
    this.#retire(request);
    return request.expiresAt > now;
  }

  #newToken() {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const token = crypto.randomUUID();
      if (!this.#requests.has(token) && !this.#retired.has(token)) return token;
    }
    throw new Error("could not allocate a unique deletion token");
  }

  #readNow() {
    const observed = this.#now();
    if (!Number.isSafeInteger(observed) || observed < 0) {
      throw new TypeError("now must return a non-negative safe integer");
    }
    this.#lastNow = Math.max(this.#lastNow, observed);
    return this.#lastNow;
  }

  #retire(request) {
    this.#requests.delete(request.token);
    if (this.#activeByUser.get(request.userId) === request.token) {
      this.#activeByUser.delete(request.userId);
    }
    this.#retired.add(request.token);
    if (this.#retired.size > this.#maxEntries) {
      this.#retired.delete(this.#retired.values().next().value);
    }
  }

  #sweepExpired(now) {
    for (const request of this.#requests.values()) {
      if (request.expiresAt <= now) this.#retire(request);
    }
  }
}

function normalizeUserId(userId) {
  if (typeof userId !== "string") throw new TypeError("user id is required");
  const normalized = userId.trim().normalize("NFC");
  if (!normalized || !normalized.isWellFormed()) throw new TypeError("user id is required and well formed");
  return normalized;
}

function snapshot(request) {
  return { ...request };
}
