// Server-only tenant-administrator client. The internal credential never reaches
// the browser; only server components import this module.

export interface AdminIndexGeneration {
  readonly id: string;
  readonly tenantId?: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly status: "building" | "published" | "degraded" | "failed";
  readonly derivedKnowledge: "available" | "partial" | "unavailable";
  readonly projectors: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

export interface AdminContextDocument {
  readonly id: string;
  readonly logicalId: string;
  readonly repository: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly bodyMarkdown?: string;
  readonly confidence: number;
  readonly reviewStatus: string;
  readonly commitSha: string;
  readonly generatorName: string;
  readonly generatorVersion: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: string;
  readonly citations?: readonly {
    readonly id: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly pathOrUrl?: string;
    readonly startLine?: number;
    readonly endLine?: number;
  }[];
}

export interface AdminContextMetrics {
  readonly outboxDepthByConsumer: Readonly<Record<string, number>>;
  readonly publishedGenerationCount: number;
  readonly documentCount: number;
  readonly fragmentCount: number;
  readonly hierarchyNodeCount: number;
  readonly embeddingCount: number;
  readonly query?: {
    readonly count: number;
    readonly p95Ms: number;
    readonly citationFailureCount: number;
    readonly conflictCount: number;
  };
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

async function apiGet(pathname: string): Promise<unknown> {
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  const tenantId = process.env.JINA_TENANT_ID?.trim();
  const headers = adminApiHeaders({
    token,
    tenantId,
    principalId: process.env.JINA_WEB_PRINCIPAL_ID?.trim()
  });
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${pathname}`, { headers, cache: "no-store" });
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

async function apiGetAllPages<T>(pathname: string, collection: string): Promise<readonly T[]> {
  const values: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const separator = pathname.includes("?") ? "&" : "?";
    const pagePath = cursor ? `${pathname}${separator}cursor=${encodeURIComponent(cursor)}` : pathname;
    const body = (await apiGet(pagePath)) as Record<string, unknown>;
    const items = body[collection];
    if (!Array.isArray(items)) {
      throw new JinaApiError(`Jina API response for ${pagePath} omitted ${collection}`);
    }
    values.push(...(items as T[]));
    const nextCursor = typeof body.nextCursor === "string" ? body.nextCursor.trim() : "";
    if (!nextCursor) return values;
    if (seenCursors.has(nextCursor)) {
      throw new JinaApiError(`Jina API repeated a pagination cursor for ${pathname}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new JinaApiError(`Jina API pagination exceeded the safety limit for ${pathname}`);
}

export function adminApiHeaders(input: {
  readonly token?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly principalId?: string | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (!input.token) return headers;
  const principalId = input.principalId || (input.tenantId ? `tenant:${input.tenantId}` : undefined);
  if (!principalId) {
    throw new JinaApiError("JINA_WEB_PRINCIPAL_ID or JINA_TENANT_ID is required when INTERNAL_API_TOKEN is configured");
  }
  headers.authorization = `Bearer ${input.token}`;
  headers["x-jina-principal-id"] = principalId;
  if (input.tenantId) headers["x-jina-tenant-id"] = input.tenantId;
  return headers;
}

export async function listAllGenerations(): Promise<readonly AdminIndexGeneration[]> {
  const generations = await apiGetAllPages<AdminIndexGeneration>("/context/generations?limit=100", "generations");
  return [...generations].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listKnowledgeDocuments(repository?: string): Promise<readonly AdminContextDocument[]> {
  const query = repository ? `?repository=${encodeURIComponent(repository)}&limit=100` : "?limit=100";
  return apiGetAllPages<AdminContextDocument>(`/context/documents${query}`, "documents");
}

export async function getContextMetrics(): Promise<AdminContextMetrics> {
  return (await apiGet("/context/metrics")) as AdminContextMetrics;
}
