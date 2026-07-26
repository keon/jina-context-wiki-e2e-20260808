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

async function apiGet(pathname: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const tenantId = process.env.JINA_TENANT_ID?.trim();
  if (tenantId) headers["x-jina-tenant-id"] = tenantId;
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

export async function listAllGenerations(): Promise<readonly AdminIndexGeneration[]> {
  const body = (await apiGet("/context/generations")) as {
    readonly generations?: readonly AdminIndexGeneration[];
  };
  const generations: readonly AdminIndexGeneration[] = Array.isArray(body.generations) ? body.generations : [];
  return [...generations].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listKnowledgeDocuments(repository?: string): Promise<readonly AdminContextDocument[]> {
  const query = repository ? `?repository=${encodeURIComponent(repository)}` : "";
  const body = (await apiGet(`/context/documents${query}`)) as {
    readonly documents?: readonly AdminContextDocument[];
  };
  const documents: readonly AdminContextDocument[] = Array.isArray(body.documents) ? body.documents : [];
  return documents;
}

export async function getKnowledgeDocument(id: string): Promise<AdminContextDocument | undefined> {
  try {
    const body = (await apiGet(`/context/documents/${encodeURIComponent(id)}`)) as {
      readonly document?: AdminContextDocument;
    };
    return body.document;
  } catch (error) {
    if (error instanceof JinaApiError && error.status === 404) return undefined;
    throw error;
  }
}

export async function getContextMetrics(): Promise<AdminContextMetrics> {
  return (await apiGet("/context/metrics")) as AdminContextMetrics;
}
