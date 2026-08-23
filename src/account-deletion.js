const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class AccountDeletionRequests {
  #activeByUser = new Map();
  #busy = false;
  #lastNow;
  #maxEntries;
  #now;
  #requests = new Map();
  #sequence = 0;
  #tokenNamespace;
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
    this.#tokenNamespace = crypto.randomUUID();
    this.#ttlMs = ttlMs;
  }

  request(userId) {
    return this.#exclusive(() => {
      const user = normalizeUserId(userId);
      const now = this.#observeNow();
      if (now > Number.MAX_SAFE_INTEGER - this.#ttlMs) {
        throw new RangeError("deletion deadline is not representable");
      }
      this.#acceptClock(now);

      const existing = this.#requests.get(this.#activeByUser.get(user));
      if (existing?.expiresAt > now) return snapshot(existing);
      this.#sweepExpired(now);
      if (this.#requests.size >= this.#maxEntries) throw new RangeError("deletion request capacity reached");

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

  confirm(userId, token) {
    return this.#exclusive(() => {
      const request = this.#ownedRequest(userId, token);
      if (!request) return false;
      const now = this.#observeNow();
      if (now > Number.MAX_SAFE_INTEGER - this.#ttlMs) {
        this.#retire(request);
        return false;
      }
      if (this.#acceptClock(now)) return false;
      this.#retire(request);
      return request.expiresAt > now;
    });
  }

  cancel(userId, token) {
    return this.#exclusive(() => {
      const request = this.#ownedRequest(userId, token);
      if (!request) return false;
      this.#retire(request);
      return true;
    });
  }

  #acceptClock(now) {
    const rolledBack = this.#lastNow !== undefined && now < this.#lastNow;
    if (rolledBack) {
      this.#requests.clear();
      this.#activeByUser.clear();
    }
    this.#lastNow = now;
    return rolledBack;
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

  #newToken() {
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("deletion token space exhausted");
    this.#sequence += 1;
    return `${this.#tokenNamespace}.${this.#sequence.toString(36)}`;
  }

  #observeNow() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("now must return a non-negative safe integer");
    }
    return now;
  }

  #ownedRequest(userId, token) {
    const user = normalizeUserId(userId);
    const request = this.#requests.get(token);
    return request?.userId === user ? request : undefined;
  }

  #retire(request) {
    this.#requests.delete(request.token);
    if (this.#activeByUser.get(request.userId) === request.token) {
      this.#activeByUser.delete(request.userId);
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
