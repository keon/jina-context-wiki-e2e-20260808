const DEFAULT_TTL_MS = 15 * 60 * 1_000;

export class AccountDeletionRequests {
  #activeByUser = new Map();
  #now;
  #requests = new Map();
  #ttlMs;

  constructor({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs must be a positive safe integer");
    }
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  request(userId) {
    const user = normalizeUserId(userId);
    const now = this.#readNow();
    const existing = this.#activeByUser.get(user);
    if (existing) {
      const request = this.#requests.get(existing);
      if (request?.status === "pending" && request.expiresAt > now) return snapshot(request);
      if (request?.status === "pending") request.status = "expired";
      this.#activeByUser.delete(user);
    }

    const request = {
      token: crypto.randomUUID(),
      userId: user,
      status: "pending",
      expiresAt: now + this.#ttlMs,
    };
    this.#requests.set(request.token, request);
    this.#activeByUser.set(user, request.token);
    return snapshot(request);
  }

  confirm(token) {
    return this.#finish(token, "deleted");
  }

  cancel(token) {
    return this.#finish(token, "cancelled");
  }

  #finish(token, status) {
    const request = this.#requests.get(token);
    if (!request || request.status !== "pending") return false;
    if (request.expiresAt <= this.#readNow()) {
      request.status = "expired";
      this.#activeByUser.delete(request.userId);
      return false;
    }
    request.status = status;
    this.#activeByUser.delete(request.userId);
    return true;
  }

  #readNow() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must return a non-negative safe integer");
    if (now > Number.MAX_SAFE_INTEGER - this.#ttlMs) throw new RangeError("deletion deadline is not representable");
    return now;
  }
}

function normalizeUserId(userId) {
  if (typeof userId !== "string" || !userId.trim()) throw new TypeError("user id is required");
  return userId.trim();
}

function snapshot(request) {
  return { ...request };
}
