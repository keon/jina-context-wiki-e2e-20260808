// Server-side client for the Jina API. Requests authenticate with
// INTERNAL_API_TOKEN and deliberately omit an x-jina-principal-id header, so
// the API treats them as the svc:api tenant-admin principal, which is granted
// every repository in the tenant. That is what lets this app list ALL
// generated graphs rather than an ACL-scoped subset. The token never reaches
// the browser: only server components import this module.

import type { AdminGraphQueryResult } from "./graph-query";

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
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

function apiBaseUrl(): string {
  return (process.env.JINA_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
}

async function apiRequest(
  pathname: string,
  init?: { readonly method?: "GET" | "POST"; readonly body?: unknown }
): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const tenantId = process.env.JINA_TENANT_ID?.trim();
  if (tenantId) headers["x-jina-tenant-id"] = tenantId;
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

function apiGet(pathname: string): Promise<unknown> {
  return apiRequest(pathname);
}

export async function listAllGraphs(): Promise<readonly AdminGraphSummary[]> {
  const body = (await apiGet("/context-graph")) as { readonly graphs?: readonly AdminGraphSummary[] };
  const graphs = Array.isArray(body.graphs) ? (body.graphs as readonly AdminGraphSummary[]) : [];
  return [...graphs].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
}

export async function getGraph(graphId: string): Promise<AdminGraph | undefined> {
  try {
    return (await apiGet(`/context-graph/graphs/${encodeURIComponent(graphId)}`)) as AdminGraph;
  } catch (error) {
    if (error instanceof JinaApiError && error.status === 404) return undefined;
    throw error;
  }
}

export async function askGraph(
  graph: Pick<AdminGraph, "repository" | "ref" | "commitSha">,
  question: string
): Promise<AdminGraphQueryResult> {
  return (await apiRequest("/context-graph/ask", {
    method: "POST",
    body: {
      repository: graph.repository,
      ref: graph.ref,
      commitSha: graph.commitSha,
      question
    }
  })) as AdminGraphQueryResult;
}
