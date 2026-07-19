import { createServer } from "node:http";
import { DaytonaCodexOntologyExecutor } from "@jina/daytona";
import type { OntologyBuildRequest, OntologyGraph } from "@jina/ontology";

interface ClaimedWork {
  readonly message: { readonly id: string; readonly leaseId: string };
  readonly task: {
    readonly id: string;
    readonly metadata: { readonly tenantId?: unknown; readonly repository?: unknown; readonly ref?: unknown };
  };
}

const port = Number(process.env.PORT ?? 8080);
const apiUrl = requiredEnv("JINA_API_URL").replace(/\/$/, "");
const token = requiredEnv("INTERNAL_API_TOKEN");
const workerId = process.env.WORKER_ID?.trim() || `ontology-${process.pid}`;
const pollIntervalMs = positiveInt(process.env.WORKER_POLL_INTERVAL_MS, 2_000);
const executor = new DaytonaCodexOntologyExecutor();
let stopping = false;
let active = false;

const server = createServer((request, response) => {
  if (request.url === "/health" || request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, workerId, active }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not found"}');
});

server.listen(port, () => {
  console.log(`ontology worker listening on ${port}`);
  void poll();
});

async function poll(): Promise<void> {
  while (!stopping) {
    try {
      const work = await claim();
      if (work) await execute(work);
    } catch (error) {
      console.error("ontology worker poll failed", error instanceof Error ? error.message : String(error));
    }
    if (!stopping) await delay(pollIntervalMs);
  }
}

async function claim(): Promise<ClaimedWork | undefined> {
  const response = await apiRequest("/internal/worker/claim", { workerId });
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`claim failed with ${response.status}: ${await response.text()}`);
  return await response.json() as ClaimedWork;
}

async function execute(work: ClaimedWork): Promise<void> {
  active = true;
  const request: OntologyBuildRequest = {
    tenantId: requiredString(work.task.metadata.tenantId, "task tenantId"),
    repository: requiredString(work.task.metadata.repository, "task repository"),
    ref: requiredString(work.task.metadata.ref, "task ref"),
    taskId: work.task.id
  };
  let result: { readonly outcome: "done"; readonly graph: OntologyGraph } | { readonly outcome: "failed"; readonly reason: string };
  try {
    result = { outcome: "done", graph: await executor.build(request) };
  } catch (error) {
    result = { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    await complete(work, result);
  } finally {
    active = false;
  }
}

async function complete(
  work: ClaimedWork,
  result: { readonly outcome: "done"; readonly graph: OntologyGraph } | { readonly outcome: "failed"; readonly reason: string }
): Promise<void> {
  const response = await apiRequest("/internal/worker/complete", {
    messageId: work.message.id,
    leaseId: work.message.leaseId,
    taskId: work.task.id,
    ...result
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`completion failed with ${response.status}: ${await response.text()}`);
  }
}

function apiRequest(path: string, body: unknown): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    server.close(() => undefined);
  });
}
