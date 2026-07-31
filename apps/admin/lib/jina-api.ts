// Server-only tenant-administrator client. The internal credential never reaches
// the browser; only server components import this module.

export interface AdminContextRelease {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly completeness: "complete" | "partial";
  readonly contextStatus: "available" | "partial" | "unavailable";
  readonly createdAt: string;
  readonly publishedAt?: string;
}

export interface AdminContextDocument {
  readonly id: string;
  readonly logicalId: string;
  readonly repository: string;
  readonly releaseId: string;
  readonly ref: string;
  readonly kind?: string;
  readonly title: string;
  readonly summary: string;
  readonly commitSha: string;
  readonly citations: readonly {
    readonly claim: string;
    readonly citationId?: string;
    readonly claimSpan?: string;
    readonly anchor: {
      readonly sourceType: string;
      readonly sourceId: string;
      readonly pathOrUrl?: string;
      readonly startLine?: number;
      readonly endLine?: number;
    };
  }[];
}

interface AdminContextBuildStage {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly attempt: number;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly updatedAt: string;
}

export interface AdminContextBuild {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha?: string;
  readonly trigger?: string;
  readonly derivationBudgetSeconds?: number;
  readonly derivationDeadlineAt?: string;
  readonly derivationTokenBudget?: number;
  readonly consumedModelTokens?: number;
  readonly status: "active" | "completed" | "failed";
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly stages: readonly AdminContextBuildStage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminContextBuildProgress {
  readonly buildId: string;
  readonly repository: string;
  readonly ref: string;
  readonly status: AdminContextBuild["status"];
  readonly derivationBudgetSeconds?: number;
  readonly derivationDeadlineAt?: string;
  readonly derivationTokenBudget?: number;
  readonly consumedModelTokens?: number;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly stages: readonly AdminContextBuildStage[];
  readonly pages: readonly {
    readonly documentPath: string;
    readonly title: string;
    readonly bytes: number;
    readonly validationStatus: "pending" | "valid" | "invalid";
    readonly diagnostics: readonly string[];
    readonly checkpointSequence: number;
    readonly updatedAt: string;
  }[];
  readonly updatedAt: string;
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
  readonly projectors?: readonly {
    readonly name: string;
    readonly status: string;
    readonly checkpoint: string;
    readonly backlog: number;
    readonly version: string;
  }[];
  readonly quotas?: {
    readonly active: {
      readonly builds: number;
      readonly modelTasks: number;
    };
    readonly storage: {
      readonly committedBytes: number;
      readonly reservedBytes: number;
      readonly limitBytes: number;
    };
    readonly monthlyModel: {
      readonly requests: number;
      readonly totalTokens: number;
      readonly requestLimit: number;
      readonly tokenLimit: number;
    };
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl()}${pathname}`, { headers, cache: "no-store" });
    } catch (error) {
      throw new JinaApiError(
        `Jina API unreachable at ${apiBaseUrl()}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }
    throw new JinaApiError(`Jina API responded ${response.status} for ${pathname}`, response.status);
  }
  throw new JinaApiError(`Jina API did not complete ${pathname}`);
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

export async function listAllReleases(): Promise<readonly AdminContextRelease[]> {
  const body = (await apiGet("/context/releases")) as { readonly releases?: unknown };
  if (!Array.isArray(body.releases)) throw new JinaApiError("Jina API response for /context/releases omitted releases");
  // The API places each authoritative current pointer before historical
  // releases. Re-sorting by timestamp would silently select history after an
  // operator rollback to an older certified release.
  return body.releases as AdminContextRelease[];
}

export async function listContextDocuments(
  releases: readonly AdminContextRelease[],
  repository?: string
): Promise<readonly AdminContextDocument[]> {
  const latestByScope = new Map<string, AdminContextRelease>();
  for (const release of releases) {
    if (repository && release.repository !== repository) continue;
    const key = `${release.repository}\0${release.ref}`;
    if (!latestByScope.has(key)) latestByScope.set(key, release);
  }
  const catalogs = await mapInBatches([...latestByScope.values()], 3, async (release) => {
    const body = (await apiGet(
      `/context/list?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}`
    )) as { readonly documents?: unknown };
    if (!Array.isArray(body.documents)) {
      throw new JinaApiError(`Jina API response for context release ${release.id} omitted documents`);
    }
    return (body.documents as Omit<AdminContextDocument, "repository" | "releaseId" | "ref" | "commitSha">[]).map(
      (document) => ({
        ...document,
        repository: release.repository,
        releaseId: release.id,
        ref: release.ref,
        commitSha: release.commitSha
      })
    );
  });
  return catalogs.flat().sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

export async function listContextBuilds(): Promise<readonly AdminContextBuild[]> {
  const body = (await apiGet("/context/builds")) as { readonly builds?: unknown };
  if (!Array.isArray(body.builds)) throw new JinaApiError("Jina API response for /context/builds omitted builds");
  return [...(body.builds as AdminContextBuild[])].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  );
}

export async function listContextBuildProgress(
  builds: readonly AdminContextBuild[],
  limit = 12
): Promise<readonly AdminContextBuildProgress[]> {
  // Terminal rows already include their stages and bounded failure reason.
  // Checkpoint progress matters only while a build is changing.
  const selected = builds.filter((build) => build.status === "active").slice(0, Math.max(0, limit));
  const progress = await mapInBatches(selected, 3, async (build) => {
    try {
      const item = (await apiGet(
        `/context/builds/${encodeURIComponent(build.id)}/progress`
      )) as AdminContextBuildProgress;
      if (item.buildId !== build.id || item.repository !== build.repository || item.ref !== build.ref) {
        throw new JinaApiError(`Jina API returned mismatched progress for context build ${build.id}`);
      }
      return item;
    } catch (error) {
      // Progress is supplementary to the build row. A malformed or temporarily
      // unavailable build must not take down the tenant-wide admin page.
      if (error instanceof JinaApiError && error.status !== undefined) {
        return undefined;
      }
      throw error;
    }
  });
  return progress.filter((item): item is AdminContextBuildProgress => item !== undefined);
}

async function mapInBatches<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>
): Promise<Output[]> {
  const output: Output[] = [];
  for (let index = 0; index < values.length; index += concurrency) {
    output.push(...(await Promise.all(values.slice(index, index + concurrency).map(map))));
  }
  return output;
}

export async function getContextMetrics(): Promise<AdminContextMetrics> {
  return (await apiGet("/context/metrics")) as AdminContextMetrics;
}
