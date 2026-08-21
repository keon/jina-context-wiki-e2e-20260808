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
    return { ...job };
  }

  retry(id) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== "running") return false;
    job.status = "queued";
    return true;
  }

  complete(id) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job) return false;
    job.status = "completed";
    return true;
  }
}
