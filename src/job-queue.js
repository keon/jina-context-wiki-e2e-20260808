export class JobQueue {
  #jobs = [];
  #retryLimits = new Map();

  enqueue(name, payload) {
    if (!name?.trim()) throw new TypeError("job name is required");
    const job = {
      id: crypto.randomUUID(),
      name,
      payload,
      attempts: 0,
      status: "queued",
    };
    this.#jobs.push(job);
    return { ...job };
  }

  next() {
    const job = this.#jobs.find((candidate) => candidate.status === "queued");
    if (!job) return null;
    job.status = "running";
    job.attempts += 1;
    return { ...job };
  }

  complete(id, attempt) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== "running" || job.attempts !== attempt) return false;
    job.status = "completed";
    return true;
  }

  retry(id, attempt, maxAttempts = 3) {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new TypeError("attempt must be a positive integer");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError("maxAttempts must be a positive integer");
    }
    const index = this.#jobs.findIndex((candidate) => candidate.id === id);
    const job = this.#jobs[index];
    if (!job || job.status !== "running" || job.attempts !== attempt) return false;
    const retryLimit = Math.min(this.#retryLimits.get(id) ?? maxAttempts, maxAttempts);
    this.#retryLimits.set(id, retryLimit);
    job.status = job.attempts >= retryLimit ? "failed" : "queued";
    if (job.status === "queued") {
      this.#jobs.splice(index, 1);
      this.#jobs.push(job);
    }
    return true;
  }
}
