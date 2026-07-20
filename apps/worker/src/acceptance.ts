import { pathToFileURL } from "node:url";

const TERMINAL_FAILURES = new Set(["failed", "canceled", "superseded"]);

export interface ProductionAcceptanceConfig {
  readonly apiUrl: string;
  readonly token: string;
  readonly requestKey: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly principalId?: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface ProductionAcceptanceSummary {
  readonly taskId: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly citationCount: number;
}

/** Runs inside Cloud Run so Secret Manager never exposes the service credential to CI. */
export async function runProductionOntologyAcceptance(
  config: ProductionAcceptanceConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ProductionAcceptanceSummary> {
  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const repository = config.repository ?? "omxyz/jina-ontology-e2e";
  const ref = config.ref ?? "main";
  const principalId = config.principalId ?? "user:keon@omlabs.xyz";
  const pollIntervalMs = positiveInteger(config.pollIntervalMs ?? 10_000, "pollIntervalMs");
  // Daytona setup plus the Codex run may legitimately consume the worker's
  // 30-minute execution budget. Keep acceptance outside that envelope so it
  // observes the durable task's terminal state instead of killing itself first.
  const timeoutMs = positiveInteger(config.timeoutMs ?? 35 * 60_000, "timeoutMs");
  const log = config.log ?? console.log;
  const headers = {
    authorization: `Bearer ${config.token}`,
    "x-jina-principal-id": principalId
  };

  const created = await apiJson(fetchImpl, `${apiUrl}/ontology/build`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repository, ref, requestKey: config.requestKey })
  });
  const taskId = requiredNestedString(created, "task", "id");
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastTaskSummary = "";

  while (Date.now() < deadline) {
    const board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers });
    const tasks = requiredArray(board.tasks, "board.tasks");
    const task = tasks.find((value) => isRecord(value) && value.id === taskId);
    if (!isRecord(task)) throw new Error(`acceptance task ${taskId} is missing from the board`);
    const status = requiredString(task.status, "task.status");
    const taskSummary = summarizeWorkflowTasks(tasks, taskId);
    if (taskSummary !== lastTaskSummary) {
      log(`Production ontology task ${taskId}: ${taskSummary}`);
      lastTaskSummary = taskSummary;
    }
    if (status !== lastStatus) {
      lastStatus = status;
    }
    if (status === "done") break;
    if (TERMINAL_FAILURES.has(status)) {
      throw new Error(`production ontology task ${taskId} ended as ${status} (${taskSummary})`);
    }
    await delay(pollIntervalMs);
  }
  if (lastStatus !== "done") {
    throw new Error(`production ontology task ${taskId} timed out as ${lastStatus || "unknown"} (${lastTaskSummary || "no task details"})`);
  }

  const ontology = await apiJson(fetchImpl, `${apiUrl}/ontology`, { headers });
  const latest = requiredRecord(ontology.latest, "ontology.latest");
  if (latest.repository !== repository || latest.ref !== ref) {
    throw new Error("latest ontology graph does not match the acceptance repository and ref");
  }
  const nodes = requiredArray(latest.nodes, "ontology.latest.nodes");
  const edges = requiredArray(latest.edges, "ontology.latest.edges");
  if (nodes.length === 0 || edges.length === 0) throw new Error("production ontology graph is empty");
  if (![...nodes, ...edges].every(hasEvidence)) throw new Error("production ontology graph contains uncited items");

  const context = await apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      repository,
      ref,
      question: "What changed, why, and who owns the access policy?"
    })
  });
  const calls = requiredArray(context.calls, "context.calls");
  const citations = requiredArray(context.citations, "context.citations");
  if (calls.length < 3 || citations.length === 0 || !calls.every(hasCitedItems)) {
    throw new Error("production context retrieval did not return cited change, intent, and ownership results");
  }

  const metrics = await apiJson(fetchImpl, `${apiUrl}/ontology/metrics`, { headers });
  const outboxDepth = requiredRecord(metrics.outboxDepth, "metrics.outboxDepth");
  const pendingEvents = Object.values(outboxDepth).reduce<number>((sum, value) => sum + requiredNonNegativeNumber(value, "outbox depth"), 0);
  if (pendingEvents !== 0 || metrics.unparsedBlobCount !== 0) {
    throw new Error(`production ontology backlog is not empty (outbox=${pendingEvents}, unparsed=${String(metrics.unparsedBlobCount)})`);
  }

  return {
    taskId,
    repository,
    commitSha: requiredString(latest.commitSha, "ontology.latest.commitSha"),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    citationCount: citations.length
  };
}

async function apiJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed with ${response.status}: ${body.slice(0, 500)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${new URL(url).pathname} returned invalid JSON`);
  }
  return requiredRecord(parsed, new URL(url).pathname);
}

function hasEvidence(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every((item) => typeof item === "string" && item.length > 0);
}

function hasCitedItems(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) return false;
  return value.items.every((item) => isRecord(item) && Array.isArray(item.citations) && item.citations.length > 0);
}

function requiredNestedString(value: Record<string, unknown>, container: string, field: string): string {
  return requiredString(requiredRecord(value[container], container)[field], `${container}.${field}`);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configuredTimeout = optionalPositiveIntegerEnv("ACCEPTANCE_TIMEOUT_MS");
    const summary = await runProductionOntologyAcceptance({
      apiUrl: requiredEnv("JINA_API_URL"),
      token: requiredEnv("INTERNAL_API_TOKEN"),
      requestKey: requiredEnv("ACCEPTANCE_REQUEST_KEY"),
      ...(configuredTimeout === undefined ? {} : { timeoutMs: configuredTimeout })
    });
    console.log(`Production ontology accepted: ${summary.nodeCount} nodes, ${summary.edgeCount} edges, ${summary.citationCount} citations, commit ${summary.commitSha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return positiveInteger(parsed, name);
}

function summarizeWorkflowTasks(tasks: readonly unknown[], rootTaskId: string): string {
  const related = tasks
    .filter((value): value is Record<string, unknown> => isRecord(value) && (value.id === rootTaskId || value.parentTaskId === rootTaskId))
    .sort((left, right) => taskSortKey(left, rootTaskId).localeCompare(taskSortKey(right, rootTaskId)));
  if (related.length === 0) return "no related tasks";
  return related.map((task) => {
    const label = task.id === rootTaskId ? "root" : typeof task.type === "string" && task.type ? task.type : "child";
    const status = typeof task.status === "string" && task.status ? task.status : "unknown";
    return `${label}=${status}`;
  }).join(", ");
}

function taskSortKey(task: Record<string, unknown>, rootTaskId: string): string {
  if (task.id === rootTaskId) return "0-root";
  const order: Record<string, string> = {
    ontology_ingest: "1-ingest",
    ontology_assert: "2-assert",
    ontology_project: "3-project"
  };
  return typeof task.type === "string" ? order[task.type] ?? `9-${task.type}` : "9-child";
}
