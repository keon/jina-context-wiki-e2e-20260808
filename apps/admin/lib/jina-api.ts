// Server-side client for the Jina API. Cross-tenant discovery uses the
// read-only JINA_GLOBAL_ADMIN_TOKEN. Graph reads and queries keep using
// INTERNAL_API_TOKEN with the discovered graph's tenant ID, so the existing
// tenant authorization boundary remains intact. Neither token reaches the
// browser: only server components and route handlers import this module.

import type { AdminGraphQueryResult } from "./graph-query";

const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

interface AdminGraphGenerator {
  readonly executor: "daytona" | "fixture" | "projection";
  readonly model: string;
  readonly sandboxId?: string;
}

export interface AdminGraphSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly generator: AdminGraphGenerator;
  readonly summary: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface AdminGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly path?: string;
  readonly evidence: readonly string[];
}

export interface AdminGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly predicate: string;
  readonly plane: "code" | "knowledge";
  readonly confidence?: number;
  readonly why?: string;
  readonly evidence: readonly string[];
}

export interface AdminGraph extends Omit<AdminGraphSummary, "nodeCount" | "edgeCount"> {
  readonly nodes: readonly AdminGraphNode[];
  readonly edges: readonly AdminGraphEdge[];
}

interface AdminGraphStage {
  readonly id: string;
  readonly buildId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly phase: "snapshot" | "history";
  readonly stage: "ingest" | "assert" | "project";
  readonly status: string;
  readonly attempt: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminGraphBuild {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly status: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminGraphWorkflow {
  readonly build: AdminGraphBuild;
  readonly stages: readonly AdminGraphStage[];
}

interface AdminOperationalMetrics {
  readonly outboxDepth: Readonly<Record<string, number>>;
  readonly outboxDepthByConsumer: Readonly<Record<string, number>>;
  readonly oldestOutboxAgeSeconds: number;
  readonly reconciliationLagSeconds: number;
  readonly unparsedBlobCount: number;
  readonly parsedBlobCountLastHour: number;
  readonly manifestStalenessSeconds: number;
  readonly searchStalenessSeconds: number;
  readonly proposedAssertionCount: number;
  readonly unexplainedAssertionCount: number;
  readonly pendingErasureEventCount: number;
  readonly retrievalTemplates: readonly {
    readonly template: string;
    readonly requests: number;
    readonly averageLatencyMs: number;
    readonly p95LatencyMs: number;
    readonly truncationRate: number;
  }[];
}

export interface AdminGithubConnection {
  readonly installationId: string;
  readonly login: string;
  readonly type: string;
  readonly repositoryCount: number;
}

export interface AdminOperationsTenant {
  readonly tenantId: string;
  readonly name?: string;
  readonly kind?: "personal" | "team";
  readonly githubAccountLogin?: string;
  readonly repositoryCount?: number;
  readonly githubConnections?: readonly AdminGithubConnection[];
  readonly workflows: readonly AdminGraphWorkflow[];
  readonly metrics: AdminOperationalMetrics;
}

export interface AdminOperations {
  readonly observedAt: string;
  readonly tenants: readonly AdminOperationsTenant[];
  readonly queueDepth: number;
  readonly nextCursor?: string;
}

export interface AdminServiceHealth {
  readonly id: "api" | "context-graph-worker" | "task-worker";
  readonly name: string;
  readonly status: "operational" | "degraded" | "unconfigured";
  readonly detail: string;
  readonly checkedAt: string;
  readonly lastActivity?: string;
}

export class JinaApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    if (status !== undefined) this.status = status;
  }
}

function apiBaseUrl(): string {
  return (process.env.JINA_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

async function apiRequest(
  pathname: string,
  init?: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly credential?: "global" | "internal";
    readonly tenantId?: string | undefined;
  }
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const credential = init?.credential ?? "internal";
  const internalToken = process.env.INTERNAL_API_TOKEN?.trim();
  const globalAdminToken = process.env.JINA_GLOBAL_ADMIN_TOKEN?.trim();
  if (internalToken && globalAdminToken && internalToken === globalAdminToken) {
    throw new JinaApiError("JINA_GLOBAL_ADMIN_TOKEN must differ from INTERNAL_API_TOKEN");
  }
  const token = credential === "global" ? globalAdminToken : internalToken;
  if (token) headers.authorization = `Bearer ${token}`;
  if (credential === "internal") {
    const tenantId = init?.tenantId?.trim() || process.env.JINA_TENANT_ID?.trim();
    if (tenantId && !SAFE_TENANT_ID.test(tenantId)) throw new JinaApiError("invalid tenant ID");
    if (tenantId) headers["x-jina-tenant-id"] = tenantId;
  }
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${pathname}`, {
      method: init?.method ?? "GET",
      headers,
      cache: "no-store",
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
  } catch (error) {
    throw new JinaApiError(
      `Jina API unreachable at ${apiBaseUrl()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new JinaApiError(`Jina API responded ${response.status} for ${pathname}`, response.status);
  }
  return response.json();
}

function apiGet(
  pathname: string,
  init?: { readonly credential?: "global" | "internal"; readonly tenantId?: string | undefined }
): Promise<unknown> {
  return apiRequest(pathname, init);
}

export async function listAllGraphs(): Promise<readonly AdminGraphSummary[]> {
  const useGlobalIndex = Boolean(process.env.JINA_GLOBAL_ADMIN_TOKEN?.trim());
  const body = (await apiGet(useGlobalIndex ? "/internal/admin/context-graph" : "/context-graph", {
    credential: useGlobalIndex ? "global" : "internal"
  })) as { readonly graphs?: readonly AdminGraphSummary[] };
  const graphs = Array.isArray(body.graphs) ? (body.graphs as readonly AdminGraphSummary[]) : [];
  return [...graphs].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
}

export interface AdminOperationsQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly query?: string;
  readonly tenantId?: string;
  readonly repository?: string;
  readonly statuses?: readonly string[];
  readonly trigger?: "webhook" | "manual" | "scheduled" | "api";
  readonly createdAfter?: string;
  readonly activityAfter?: string;
}

export async function listAdminOperations(options: AdminOperationsQuery = {}): Promise<AdminOperations> {
  if (process.env.JINA_GLOBAL_ADMIN_TOKEN?.trim()) {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.query) query.set("query", options.query);
    if (options.tenantId) query.set("tenantId", options.tenantId);
    if (options.repository) query.set("repository", options.repository);
    if (options.statuses?.length) query.set("statuses", options.statuses.join(","));
    if (options.trigger) query.set("trigger", options.trigger);
    if (options.createdAfter) query.set("createdAfter", options.createdAfter);
    if (options.activityAfter) query.set("activityAfter", options.activityAfter);
    return (await apiGet(`/internal/admin/context-graph/operations${query.size ? `?${query}` : ""}`, {
      credential: "global"
    })) as AdminOperations;
  }

  const [overviewBody, metricsBody] = await Promise.all([
    apiGet("/overview") as Promise<{
      readonly board?: {
        readonly tasks?: readonly {
          readonly id: string;
          readonly parentTaskId?: string;
          readonly type: string;
          readonly status: string;
          readonly attempt?: number;
          readonly createdAt?: string;
          readonly updatedAt?: string;
          readonly metadata?: Readonly<Record<string, unknown>>;
        }[];
      };
    }>,
    apiGet("/context-graph/metrics") as Promise<AdminOperationalMetrics>
  ]);
  const tasks = overviewBody.board?.tasks ?? [];
  const tenantId = process.env.JINA_TENANT_ID?.trim() || "local";
  const workflows: AdminGraphWorkflow[] = tasks
    .filter((task) => task.type === "context_graph_build")
    .map((task) => {
      const metadata = task.metadata ?? {};
      const repository = typeof metadata.repository === "string" ? metadata.repository : "unknown/unknown";
      const ref = typeof metadata.ref === "string" ? metadata.ref : "main";
      const createdAt = task.createdAt ?? new Date(0).toISOString();
      const updatedAt = task.updatedAt ?? createdAt;
      return {
        build: {
          id: task.id,
          tenantId,
          repository,
          ref,
          requestKey: typeof metadata.requestKey === "string" ? metadata.requestKey : task.id,
          status: task.status,
          metadata,
          createdAt,
          updatedAt
        },
        stages: tasks
          .filter((stage) => stage.parentTaskId === task.id && stage.type.startsWith("context_graph_"))
          .map((stage) => ({
            id: stage.id,
            buildId: task.id,
            tenantId,
            repository,
            ref,
            phase: "history" as const,
            stage: stage.type.replace("context_graph_", "") as "ingest" | "assert" | "project",
            status: stage.status,
            attempt: stage.attempt ?? 0,
            createdAt: stage.createdAt ?? createdAt,
            updatedAt: stage.updatedAt ?? updatedAt
          }))
      };
    });
  return {
    observedAt: new Date().toISOString(),
    tenants: [{ tenantId, workflows, metrics: metricsBody }],
    queueDepth: workflows.filter(({ build }) => ["queued", "in_progress", "enriching"].includes(build.status)).length
  };
}

export async function listAllAdminOperations(
  options: Omit<AdminOperationsQuery, "cursor" | "limit"> = {}
): Promise<AdminOperations> {
  const tenants = new Map<string, AdminOperationsTenant>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let observedAt: string;
  let queueDepth: number;
  do {
    const page = await listAdminOperations({
      ...options,
      limit: 500,
      ...(cursor ? { cursor } : {})
    });
    observedAt = page.observedAt;
    queueDepth = page.queueDepth;
    for (const tenant of page.tenants) {
      const existing = tenants.get(tenant.tenantId);
      tenants.set(tenant.tenantId, {
        ...tenant,
        ...existing,
        tenantId: tenant.tenantId,
        workflows: [...(existing?.workflows ?? []), ...tenant.workflows],
        metrics: existing?.metrics ?? tenant.metrics
      });
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new JinaApiError("Jina API returned a repeated operations cursor");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return {
    observedAt,
    tenants: [...tenants.values()],
    queueDepth
  };
}

export async function listServiceHealth(): Promise<readonly AdminServiceHealth[]> {
  const services = [
    {
      id: "api" as const,
      name: "API",
      url: apiBaseUrl()
    },
    {
      id: "context-graph-worker" as const,
      name: "Context graph worker",
      url: process.env.JINA_CONTEXT_GRAPH_WORKER_URL?.trim()
    },
    {
      id: "task-worker" as const,
      name: "Task worker",
      url: process.env.JINA_TASK_WORKER_URL?.trim()
    }
  ];
  return Promise.all(
    services.map(async (service): Promise<AdminServiceHealth> => {
      const checkedAt = new Date().toISOString();
      if (!service.url) {
        return {
          id: service.id,
          name: service.name,
          status: "unconfigured",
          detail: "Health URL is not configured",
          checkedAt
        };
      }
      try {
        const response = await fetch(`${service.url.replace(/\/$/, "")}/health`, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(5_000)
        });
        const payload = (await response.json()) as Readonly<Record<string, unknown>>;
        const detail =
          service.id === "api"
            ? `${typeof payload.storage === "string" ? payload.storage : "unknown"} storage`
            : Array.isArray(payload.topics)
              ? payload.topics.join(", ")
              : "Worker health endpoint";
        return {
          id: service.id,
          name: service.name,
          status: response.ok && payload.ok === true ? "operational" : "degraded",
          detail,
          checkedAt,
          ...(typeof payload.lastApiSuccessAt === "string" ? { lastActivity: payload.lastApiSuccessAt } : {})
        };
      } catch (error) {
        return {
          id: service.id,
          name: service.name,
          status: "degraded",
          detail: error instanceof Error ? error.message : "Health check failed",
          checkedAt
        };
      }
    })
  );
}

export async function getGraph(graphId: string, tenantId?: string): Promise<AdminGraph | undefined> {
  try {
    return (await apiGet(`/context-graph/graphs/${encodeURIComponent(graphId)}`, { tenantId })) as AdminGraph;
  } catch (error) {
    if (error instanceof JinaApiError && error.status === 404) return undefined;
    throw error;
  }
}

export async function askGraph(
  graph: Pick<AdminGraph, "tenantId" | "repository" | "ref" | "commitSha">,
  question: string
): Promise<AdminGraphQueryResult> {
  return (await apiRequest("/context-graph/ask", {
    method: "POST",
    tenantId: graph.tenantId,
    body: {
      repository: graph.repository,
      ref: graph.ref,
      commitSha: graph.commitSha,
      question
    }
  })) as AdminGraphQueryResult;
}

export async function startGraphBuild(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly githubInstallationId: number;
}): Promise<{ readonly task: { readonly id: string } }> {
  return (await apiRequest("/context-graph/build", {
    method: "POST",
    tenantId: input.tenantId,
    body: {
      repository: input.repository,
      ref: input.ref,
      githubInstallationId: input.githubInstallationId,
      requestKey: `admin-${Date.now()}`
    }
  })) as { readonly task: { readonly id: string } };
}
