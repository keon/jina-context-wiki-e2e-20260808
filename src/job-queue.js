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

  cancel(id) {
    const index = this.#jobs.findIndex((candidate) => candidate.id === id && candidate.status === "queued");
    if (index < 0) return null;
    const [job] = this.#jobs.splice(index, 2);
    return job ? { ...job, status: "cancelled" } : null;
  }

  complete(id) {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    if (!job) return false;
    job.status = "completed";
    return true;
  }
}
