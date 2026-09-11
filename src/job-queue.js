export class JobQueue {
  #jobs = [];

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
    job.attemptToken = crypto.randomUUID();
    return { ...job };
  }

  retry(id, attemptToken) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== "running" || job.attemptToken !== attemptToken) return false;
    job.status = "queued";
    delete job.attemptToken;
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
