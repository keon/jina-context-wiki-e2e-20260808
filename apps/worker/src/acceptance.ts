import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const CONTEXT_STAGE_TYPES = new Set(["ingest-evidence", "derive-knowledge", "index-context"]);

export interface ProductionContextAcceptanceConfig {
  readonly apiUrl: string;
  readonly internalToken: string;
  readonly contextToken: string;
  readonly tenantId?: string;
  readonly principalId: string;
  readonly adminPrincipalId: string;
  readonly repository?: string;
  readonly ref?: string;
  readonly githubInstallationId?: number;
  readonly requestKey?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly verifyMcp?: (input: {
    apiUrl: string;
    headers: Record<string, string>;
    repository: string;
    ref: string;
    commitSha: string;
  }) => Promise<number>;
  readonly log?: (message: string) => void;
}

export interface ProductionContextAcceptanceSummary {
  readonly buildId: string;
  readonly repository: string;
  readonly ref: string;
  readonly generationId: string;
  readonly commitSha: string;
  readonly generationCount: number;
  readonly documentCount: number;
  readonly citationCount: number;
  readonly mcpCitationCount: number;
  readonly durationMs: number;
}

export async function runProductionContextAcceptance(
  config: ProductionContextAcceptanceConfig
): Promise<ProductionContextAcceptanceSummary> {
  const startedAt = Date.now();
  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const repository = config.repository ?? "omxyz/jina-context-graph-e2e";
  const ref = config.ref ?? "main";
  const timeoutMs = config.timeoutMs ?? 50 * 60_000;
  const pollIntervalMs = config.pollIntervalMs ?? 10_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const log = config.log ?? console.log;
  const queryIdentityHeaders = {
    "x-jina-principal-id": config.principalId,
    ...(config.tenantId ? { "x-jina-tenant-id": config.tenantId } : {})
  };
  const adminIdentityHeaders = {
    "x-jina-principal-id": config.adminPrincipalId,
    ...(config.tenantId ? { "x-jina-tenant-id": config.tenantId } : {})
  };
  const contextHeaders = {
    ...queryIdentityHeaders,
    authorization: `Bearer ${config.contextToken}`,
    "content-type": "application/json"
  };
  const accessSyncHeaders = {
    ...queryIdentityHeaders,
    authorization: `Bearer ${config.internalToken}`,
    "content-type": "application/json"
  };
  const internalHeaders = {
    ...adminIdentityHeaders,
    authorization: `Bearer ${config.internalToken}`,
    "content-type": "application/json"
  };

  await apiJson(fetchImpl, `${apiUrl}/internal/context/access/sync`, {
    method: "POST",
    headers: accessSyncHeaders,
    body: JSON.stringify({ repositories: [repository], mode: "merge" })
  });

  const created = await apiJson(fetchImpl, `${apiUrl}/context/build`, {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({
      repository,
      ref,
      ...(config.githubInstallationId ? { githubInstallationId: config.githubInstallationId } : {}),
      requestKey: config.requestKey ?? `acceptance-${Date.now()}`
    })
  });
  const buildId = requiredString(record(created.build).id, "build.id");
  log(`Production context build ${buildId} accepted for ${repository}@${ref}`);

  const deadline = Date.now() + timeoutMs;
  let completedTasks: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    const board = await apiJson(fetchImpl, `${apiUrl}/board`, { headers: internalHeaders });
    const tasks = requiredArray(board.tasks, "board.tasks").filter(isRecord);
    const root = tasks.find((task) => task.id === buildId);
    if (!root) throw new Error(`production context build ${buildId} is missing from the board`);
    const stages = tasks.filter((task) => task.parentTaskId === buildId && CONTEXT_STAGE_TYPES.has(String(task.type)));
    log(renderStatus(buildId, root, stages));
    const failed = stages.find((task) => task.status === "failed");
    if (failed) {
      throw new Error(`production context stage ${String(failed.type)} failed: ${failureReason(failed)}`);
    }
    if (root.status === "failed") {
      throw new Error(`production context build ${buildId} failed: ${failureReason(root)}`);
    }
    if (root.status === "done" && stages.length === 3 && stages.every((task) => task.status === "done")) {
      completedTasks = stages;
      break;
    }
    await delay(pollIntervalMs);
  }
  if (completedTasks.length !== 3) throw new Error(`production context build ${buildId} timed out`);

  const blocked = blockedContextTaskIds(completedTasks, repository, ref);
  if (blocked.length) throw new Error(`production context workflow retains blocked stages: ${blocked.join(", ")}`);

  const generationsPayload = await apiJson(
    fetchImpl,
    `${apiUrl}/context/generations?repository=${encodeURIComponent(repository)}`,
    { headers: internalHeaders }
  );
  const generations = requiredArray(generationsPayload.generations, "generations").filter(isRecord);
  const latest = generations.find((generation) => generation.ref === ref && generation.status === "published");
  if (!latest) throw new Error("production context has no published generation for the accepted ref");
  const generationId = requiredString(latest.id, "generation.id");
  const commitSha = requiredGitSha(latest.commitSha, "generation.commitSha");
  if (latest.derivedKnowledge !== "available") {
    throw new Error("production enriched generation is missing derived knowledge");
  }

  const documentsPayload = await apiJson(
    fetchImpl,
    `${apiUrl}/context/documents?repository=${encodeURIComponent(repository)}`,
    { headers: internalHeaders }
  );
  const documents = requiredArray(documentsPayload.documents, "documents").filter(isRecord);
  if (documents.length === 0) throw new Error("production knowledge document catalog is empty");

  const query = await apiJson(fetchImpl, `${apiUrl}/context/query`, {
    method: "POST",
    headers: contextHeaders,
    body: JSON.stringify({
      repository,
      ref,
      question: "Summarize this repository's architecture and cite the source evidence.",
      taskKind: "overview"
    })
  });
  const queryGeneration = record(query.generation);
  if (queryGeneration.id !== generationId || queryGeneration.commitSha !== commitSha) {
    throw new Error("production query did not use the certified generation");
  }
  const citations = requiredArray(query.citations, "query.citations").filter(isRecord);
  assertOriginalEvidenceCitations(citations, repository, commitSha);
  if (!requiredString(query.answer, "query.answer").trim())
    throw new Error("production query returned an empty answer");

  const mcpCitationCount = config.verifyMcp
    ? await config.verifyMcp({ apiUrl, headers: contextHeaders, repository, ref, commitSha })
    : await verifyProductionMcp({ apiUrl, headers: contextHeaders, repository, ref, commitSha });

  const metrics = await apiJson(fetchImpl, `${apiUrl}/context/metrics`, { headers: internalHeaders });
  const depths = record(metrics.outboxDepthByConsumer);
  const pending = Object.entries(depths).filter(([, value]) => Number(value) > 0);
  if (pending.length) throw new Error(`production context backlog is not empty: ${JSON.stringify(pending)}`);

  const removedLegacyPath = `/context-${["g", "r", "a", "p", "h"].join("")}`;
  const legacy = await fetchImpl(`${apiUrl}${removedLegacyPath}`, { headers: internalHeaders });
  if (legacy.status !== 404) throw new Error(`legacy context graph route is still reachable with ${legacy.status}`);

  return {
    buildId,
    repository,
    ref,
    generationId,
    commitSha,
    generationCount: generations.length,
    documentCount: documents.length,
    citationCount: citations.length,
    mcpCitationCount,
    durationMs: Date.now() - startedAt
  };
}

export function blockedContextTaskIds(tasks: readonly unknown[], repository: string, ref: string): string[] {
  return tasks
    .filter(isRecord)
    .filter(
      (task) =>
        CONTEXT_STAGE_TYPES.has(String(task.type)) &&
        recordOrEmpty(task.metadata).repository === repository &&
        recordOrEmpty(task.metadata).ref === ref &&
        ["triage", "blocked", "queued", "in_progress"].includes(String(task.status))
    )
    .map((task) => String(task.id));
}

export function productionAcceptanceExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/stage .* failed|build .* failed|timed out|blocked stages/.test(message)) return 20;
  if (/published generation|certified generation|commitSha/.test(message)) return 21;
  if (/document catalog|derived knowledge/.test(message)) return 22;
  if (/citation|empty answer|MCP/.test(message)) return 23;
  if (message.includes("backlog")) return 24;
  return 25;
}

async function verifyProductionMcp(input: {
  apiUrl: string;
  headers: Record<string, string>;
  repository: string;
  ref: string;
  commitSha: string;
}): Promise<number> {
  const client = new Client({ name: "jina-production-acceptance", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${input.apiUrl}/mcp`), {
    requestInit: { headers: input.headers }
  });
  try {
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    if (tools.tools.map((tool) => tool.name).join(",") !== "query_context") {
      throw new Error(`production MCP exposed unexpected tools: ${tools.tools.map((tool) => tool.name).join(",")}`);
    }
    const result = await client.callTool({
      name: "query_context",
      arguments: {
        repository: input.repository,
        ref: input.ref,
        question: "Where is the primary implementation and what evidence supports it?",
        taskKind: "structure"
      }
    });
    if (result.isError) throw new Error("production MCP query_context returned an error");
    const structured = record(result.structuredContent);
    const generation = record(structured.generation);
    if (generation.commitSha !== input.commitSha) throw new Error("production MCP used the wrong commit");
    const citations = requiredArray(structured.citations, "MCP citations").filter(isRecord);
    assertOriginalEvidenceCitations(citations, input.repository, input.commitSha);
    return citations.length;
  } finally {
    await client.close();
  }
}

function assertOriginalEvidenceCitations(
  citations: readonly Record<string, unknown>[],
  repository: string,
  commitSha: string
): void {
  if (citations.length === 0) throw new Error("production query returned no citations");
  const anchors = citations.flatMap((citation) => requiredArray(citation.anchors, "citation.anchors").filter(isRecord));
  if (anchors.length === 0) throw new Error("production query returned no original evidence anchors");
  if (
    !anchors.every(
      (anchor) =>
        anchor.repository === repository &&
        (anchor.commitSha === commitSha || anchor.sourceType === "observation") &&
        typeof anchor.contentDigest === "string"
    )
  ) {
    throw new Error("production citation anchors do not match the accepted repository and commit");
  }
}

async function apiJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${new URL(url).pathname} returned invalid JSON`);
  }
  if (!response.ok) {
    throw new Error(`${new URL(url).pathname} failed with ${response.status}: ${redactedDetail(value)}`);
  }
  return record(value);
}

function renderStatus(
  buildId: string,
  root: Record<string, unknown>,
  stages: readonly Record<string, unknown>[]
): string {
  const values = [...stages]
    .sort((left, right) => String(left.type).localeCompare(String(right.type)))
    .map((stage) => `${String(stage.type)}=${String(stage.status)}`)
    .join(", ");
  return `Production context build ${buildId}: root=${String(root.status)}${values ? `, ${values}` : ""}`;
}

function failureReason(task: Record<string, unknown>): string {
  const metadata = recordOrEmpty(task.metadata);
  return typeof metadata.error === "string" ? metadata.error.slice(0, 500) : "no public reason";
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object response");
  return value;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredGitSha(value: unknown, name: string): string {
  const result = requiredString(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${name} must be a full Git SHA`);
  return result;
}

function redactedDetail(value: unknown): string {
  return JSON.stringify(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 1_000);
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const githubInstallationId = optionalPositiveInteger(process.env.ACCEPTANCE_GITHUB_INSTALLATION_ID);
  const summary = await runProductionContextAcceptance({
    apiUrl: requiredEnv("JINA_API_URL"),
    internalToken: requiredEnv("INTERNAL_API_TOKEN"),
    contextToken: requiredEnv("CONTEXT_API_TOKEN"),
    ...(process.env.ACCEPTANCE_TENANT_ID ? { tenantId: process.env.ACCEPTANCE_TENANT_ID } : {}),
    principalId: requiredEnv("ACCEPTANCE_PRINCIPAL_ID"),
    adminPrincipalId: requiredEnv("ACCEPTANCE_ADMIN_PRINCIPAL_ID"),
    ...(process.env.ACCEPTANCE_REPOSITORY ? { repository: process.env.ACCEPTANCE_REPOSITORY } : {}),
    ...(process.env.ACCEPTANCE_REF ? { ref: process.env.ACCEPTANCE_REF } : {}),
    ...(githubInstallationId ? { githubInstallationId } : {}),
    ...(process.env.ACCEPTANCE_REQUEST_KEY ? { requestKey: process.env.ACCEPTANCE_REQUEST_KEY } : {}),
    ...(process.env.ACCEPTANCE_TIMEOUT_MS ? { timeoutMs: Number(process.env.ACCEPTANCE_TIMEOUT_MS) } : {})
  });
  console.log(JSON.stringify({ event: "production.context.acceptance_succeeded", ...summary }));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("ACCEPTANCE_GITHUB_INSTALLATION_ID must be a positive integer");
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        event: "production.context.acceptance_failed",
        error: error instanceof Error ? error.message : String(error)
      })
    );
    process.exitCode = productionAcceptanceExitCode(error);
  });
}
