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
