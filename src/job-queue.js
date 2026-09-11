export class JobQueue {
  #jobs = [];

  enqueue(name, payload) {
    if (!name?.trim()) throw new TypeError("job name is required");
    const job = {
      id: crypto.randomUUID(),
      name,
      payload: structuredClone(payload),
      attempts: 0,
      status: "queued",
    };
    const snapshot = structuredClone(job);
    this.#jobs.push(job);
    return snapshot;
  }

  next() {
    const job = this.#jobs.find((candidate) => candidate.status === "queued");
    if (!job) return null;
    const snapshot = structuredClone(job);
    const attemptToken = crypto.randomUUID();
    job.status = "running";
    job.attempts += 1;
    job.attemptToken = attemptToken;
    return { ...snapshot, status: job.status, attempts: job.attempts, attemptToken };
  }

  retry(id, attemptToken) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== "running" || job.attemptToken !== attemptToken) return false;
    job.status = "queued";
    delete job.attemptToken;
    this.#jobs.splice(this.#jobs.indexOf(job), 1);
    this.#jobs.push(job);
    return true;
  }

  complete(id, attemptToken) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== "running" || job.attemptToken !== attemptToken) return false;
    job.status = "completed";
    delete job.attemptToken;
    return true;
  }
}
