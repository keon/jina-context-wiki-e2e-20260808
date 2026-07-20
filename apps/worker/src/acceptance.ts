import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TERMINAL_FAILURES = new Set(["blocked", "failed", "canceled", "superseded"]);

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

/**
 * Cloud Run exposes a job's numeric exit code to the deployer, but not the
 * container termination message. Keep these codes coarse and stable so CI can
 * identify the failed acceptance boundary without gaining access to private
 * repository logs.
 */
export function productionAcceptanceExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/ended as|timed out|missing from the board|retains blocked ontology tasks/.test(message)) return 20;
  if (/latest ontology graph|ontology\.latest/.test(message)) return 21;
  if (/ontology graph is empty/.test(message)) return 22;
  if (/ontology graph contains uncited/.test(message)) return 23;
  if (/context retrieval/.test(message)) return 24;
  if (/ontology backlog/.test(message)) return 25;
  return 26;
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
  let completedBoardTasks: unknown[] | undefined;

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
    if (status === "done") {
      completedBoardTasks = tasks;
      break;
    }
    if (TERMINAL_FAILURES.has(status)) {
      const failureSummary = await workflowFailureSummary(fetchImpl, apiUrl, headers, tasks, taskId);
      throw new Error(`production ontology task ${taskId} ended as ${status} (${taskSummary}${failureSummary})`);
    }
    await delay(pollIntervalMs);
  }
  if (lastStatus !== "done") {
    const board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers });
    const tasks = requiredArray(board.tasks, "board.tasks");
    const failureSummary = await workflowFailureSummary(fetchImpl, apiUrl, headers, tasks, taskId);
    throw new Error(`production ontology task ${taskId} timed out as ${lastStatus || "unknown"} (${lastTaskSummary || "no task details"}${failureSummary})`);
  }
  const blockedTaskIds = blockedOntologyTaskIds(completedBoardTasks ?? [], repository, ref);
  if (blockedTaskIds.length > 0) {
    throw new Error(`production board retains blocked ontology tasks for ${repository}@${ref}: ${blockedTaskIds.join(", ")}`);
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
  const issueContext = await apiJson(fetchImpl, `${apiUrl}/ontology/ask`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repository, ref, question: "Which PR and commit resolved issue #1?" })
  });
  const issueCalls = requiredArray(issueContext.calls, "issue context.calls");
  const issueTrace = issueCalls.find((call) => isRecord(call) && call.template === "issue_trace");
  const issueItems = isRecord(issueTrace) ? requiredArray(issueTrace.items, "issue trace.items") : [];
  const firstIssueItem = issueItems[0];
  const issueData = isRecord(firstIssueItem) ? requiredRecord(firstIssueItem.data, "issue trace.data") : {};
  const resolutions = requiredArray(issueData.resolutions, "issue trace.resolutions");
  const firstResolution = resolutions[0];
  const commits = isRecord(firstResolution) ? requiredArray(firstResolution.commits, "issue trace.commits") : [];
  if (
    !isRecord(firstResolution) || firstResolution.pullRequestNumber !== 2 || commits.length === 0 ||
    !commits.every((commit) => isRecord(commit) && typeof commit.sha === "string" && commit.sha.length === 40) ||
    !isRecord(firstIssueItem) || !Array.isArray(firstIssueItem.citations) || firstIssueItem.citations.length === 0
  ) {
    throw new Error("production context retrieval did not project issue #1 to PR #2 and its commits");
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

export function blockedOntologyTaskIds(tasks: readonly unknown[], repository: string, ref: string): string[] {
  return tasks.flatMap((task) => {
    if (!isRecord(task) || task.status !== "blocked" || typeof task.type !== "string" || !task.type.startsWith("ontology_")) return [];
    const metadata = isRecord(task.metadata) ? task.metadata : {};
    return metadata.repository === repository && metadata.ref === ref && typeof task.id === "string" ? [task.id] : [];
  });
}

async function apiJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  return requiredRecord(await apiValue(fetchImpl, url, init), new URL(url).pathname);
}

async function apiArray(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown[]> {
  return requiredArray(await apiValue(fetchImpl, url, init), new URL(url).pathname);
}

async function apiValue(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed with ${response.status}: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${new URL(url).pathname} returned invalid JSON`);
  }
}

async function workflowFailureSummary(
  fetchImpl: typeof fetch,
  apiUrl: string,
  headers: Record<string, string>,
  tasks: readonly unknown[],
  rootTaskId: string
): Promise<string> {
  const taskLabels = new Map<string, string>();
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== "string") continue;
    if (task.id !== rootTaskId && task.parentTaskId !== rootTaskId) continue;
    taskLabels.set(task.id, task.id === rootTaskId
      ? "root"
      : typeof task.type === "string" && task.type ? task.type : "child");
  }
  const events = await apiArray(fetchImpl, `${apiUrl}/events`, { headers });
  const failures = events.flatMap((event) => {
    if (!isRecord(event) || typeof event.taskId !== "string" || !taskLabels.has(event.taskId)) return [];
    if (typeof event.type !== "string" || !event.type.endsWith(".failed")) return [];
    const payload = isRecord(event.payload) ? event.payload : {};
    const reason = typeof payload.reason === "string" && payload.reason.trim()
      ? payload.reason.trim().replace(/\s+/g, " ").slice(0, 800)
      : event.type;
    return [`${taskLabels.get(event.taskId)}: ${reason}`];
  });
  return failures.length > 0 ? `; failures: ${failures.slice(-3).join(" | ")}` : "";
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
    const message = `Production ontology accepted: ${summary.nodeCount} nodes, ${summary.edgeCount} edges, ${summary.citationCount} citations, commit ${summary.commitSha}`;
    await writeTerminationMessage(message);
    console.log(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeTerminationMessage(message);
    console.error(message);
    process.exitCode = productionAcceptanceExitCode(error);
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

async function writeTerminationMessage(message: string): Promise<void> {
  // Cloud Run projects this file into the task status. It keeps acceptance
  // diagnostics available to the deployer without granting broad log access.
  await writeFile("/dev/termination-log", message.slice(0, 4_000), "utf8").catch(() => undefined);
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
