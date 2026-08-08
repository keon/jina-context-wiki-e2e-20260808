// Server-only tenant-administrator client. The internal credential never reaches
// the browser; only server components import this module.

export interface AdminContextRelease {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  // "unknown" is reserved for a row the API returned without the field: an
  // operator console must not report unmeasured state as healthy.
  readonly completeness: "complete" | "partial" | "unknown";
  readonly contextStatus: "available" | "partial" | "unavailable" | "unknown";
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
  readonly startedAt?: string;
  readonly modelInputTokens?: number;
  readonly modelCachedInputTokens?: number;
  readonly modelOutputTokens?: number;
  readonly modelTotalTokens?: number;
  readonly lastRetryAt?: string;
  readonly lastRetryFailureCode?: string;
  readonly lastRetryFailureReason?: string;
  readonly phaseCheckpoints?: readonly {
    readonly phase: string;
    readonly attempt: number;
    readonly recordedAt: string;
  }[];
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
  readonly consumedExecutionSeconds?: number;
  readonly remainingExecutionSeconds?: number;
  readonly derivationTokenBudget?: number;
  readonly consumedModelTokens?: number;
  readonly activeModelReservedTokens?: number;
  readonly remainingModelTokens?: number;
  readonly queuedFollowup?: {
    readonly repository: string;
    readonly ref: string;
    readonly commitSha?: string;
    readonly trigger: string;
    readonly requestedAt: string;
    readonly reason: string;
  };
  readonly queuedFollowups?: readonly NonNullable<AdminContextBuild["queuedFollowup"]>[];
  readonly queuedFollowupCount?: number;
  /**
   * Whatever the API reported, verbatim. `active`, `completed`, and `failed`
   * are the values this app reasons about, but an unrecognised one is kept
   * rather than coerced: presenting a blocked build or a status introduced by a
   * newer API version as `completed` would report a stalled build as a
   * successful one. Absent when the row carried no status at all — that is not
   * the same as a completed build either.
   */
  readonly status?: string;
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
  readonly status?: NonNullable<AdminContextBuild["status"]>;
  readonly derivationBudgetSeconds?: number;
  readonly derivationDeadlineAt?: string;
  readonly consumedExecutionSeconds?: number;
  readonly remainingExecutionSeconds?: number;
  readonly derivationTokenBudget?: number;
  readonly consumedModelTokens?: number;
  readonly activeModelReservedTokens?: number;
  readonly remainingModelTokens?: number;
  readonly queuedFollowup?: AdminContextBuild["queuedFollowup"];
  readonly queuedFollowups?: AdminContextBuild["queuedFollowups"];
  readonly queuedFollowupCount?: number;
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

/**
 * Every counter here is optional, and an absent one is never defaulted to `0`.
 * Telemetry the API did not send is not a measurement of nothing: on an
 * operations console a fabricated zero reads as a healthy, idle system, which
 * is exactly the state an operator would be looking for a way to rule out. A
 * `0` in this type therefore always means the API measured zero.
 */
export interface AdminContextMetrics {
  readonly publishedGenerationCount?: number;
  readonly documentCount?: number;
  readonly fragmentCount?: number;
  readonly hierarchyNodeCount?: number;
  readonly quotas?: {
    readonly active?: {
      readonly builds?: number;
      readonly modelTasks?: number;
    };
    readonly storage?: {
      readonly committedBytes?: number;
      readonly reservedBytes?: number;
      readonly limitBytes?: number;
    };
    readonly monthlyModel?: {
      readonly requests?: number;
      readonly totalTokens?: number;
      readonly requestLimit?: number;
      readonly tokenLimit?: number;
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

// Response validation ------------------------------------------------------
//
// This page renders every repository in the tenant, so a single malformed row
// must never take a whole section down: an undefined `updatedAt` inside a sort
// comparator throws and blanks the section that would have shown the outage.
// Rows that do not satisfy the fields this app dereferences are skipped and
// counted, and the count is reported server-side for operators.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function reportSkipped(count: number, resource: string): void {
  if (count > 0) console.warn("[admin] skipped %d malformed %s row(s) from the Jina API", count, resource);
}

/** Keeps only rows this app can render without throwing. */
function collectValid<Output>(
  values: readonly unknown[],
  resource: string,
  parse: (value: unknown) => Output | undefined
): Output[] {
  const output: Output[] = [];
  let skipped = 0;
  for (const value of values) {
    const parsed = parse(value);
    if (parsed === undefined) skipped += 1;
    else output.push(parsed);
  }
  reportSkipped(skipped, resource);
  return output;
}

function parseCompleteness(value: unknown): AdminContextRelease["completeness"] {
  if (value === "complete") return "complete";
  if (value === "partial") return "partial";
  return "unknown";
}

function parseContextStatus(value: unknown): AdminContextRelease["contextStatus"] {
  if (value === "available") return "available";
  if (value === "partial") return "partial";
  if (value === "unavailable") return "unavailable";
  return "unknown";
}

function parseRelease(value: unknown): AdminContextRelease | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const repository = requiredString(value.repository);
  const ref = requiredString(value.ref);
  const createdAt = requiredString(value.createdAt);
  if (!id || !repository || !ref || !createdAt) return undefined;
  const publishedAt = requiredString(value.publishedAt);
  return {
    id,
    repository,
    ref,
    commitSha: optionalString(value.commitSha) ?? "",
    completeness: parseCompleteness(value.completeness),
    contextStatus: parseContextStatus(value.contextStatus),
    createdAt,
    ...(publishedAt ? { publishedAt } : {})
  };
}

type ParsedStage = AdminContextBuild["stages"][number];

function parseStage(value: unknown): ParsedStage | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const status = requiredString(value.status);
  if (!id || !status) return undefined;
  const phaseCheckpoints = Array.isArray(value.phaseCheckpoints)
    ? value.phaseCheckpoints.flatMap((checkpoint) => {
        if (!isRecord(checkpoint)) return [];
        const phase = requiredString(checkpoint.phase);
        const recordedAt = requiredString(checkpoint.recordedAt);
        return phase && recordedAt ? [{ phase, attempt: finiteNumber(checkpoint.attempt, 1), recordedAt }] : [];
      })
    : undefined;
  return {
    id,
    type: optionalString(value.type) ?? "stage",
    title: optionalString(value.title) ?? id,
    status,
    attempt: finiteNumber(value.attempt, 1),
    ...definedOnly({
      failureCode: optionalString(value.failureCode),
      failureReason: optionalString(value.failureReason),
      startedAt: optionalString(value.startedAt),
      modelInputTokens: optionalNumber(value.modelInputTokens),
      modelCachedInputTokens: optionalNumber(value.modelCachedInputTokens),
      modelOutputTokens: optionalNumber(value.modelOutputTokens),
      modelTotalTokens: optionalNumber(value.modelTotalTokens),
      lastRetryAt: optionalString(value.lastRetryAt),
      lastRetryFailureCode: optionalString(value.lastRetryFailureCode),
      lastRetryFailureReason: optionalString(value.lastRetryFailureReason)
    }),
    ...(phaseCheckpoints ? { phaseCheckpoints } : {}),
    // Stage rows are rendered with `formatTimestamp`, which tolerates a
    // non-ISO string but not a missing one.
    updatedAt: optionalString(value.updatedAt) ?? ""
  };
}

/** Drops absent keys so the result satisfies `exactOptionalPropertyTypes`. */
function definedOnly<T extends Record<string, unknown>>(input: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function parseStages(value: unknown): ParsedStage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stage) => {
    const parsed = parseStage(stage);
    return parsed ? [parsed] : [];
  });
}

function parseFollowup(value: unknown): AdminContextBuild["queuedFollowup"] | undefined {
  if (!isRecord(value)) return undefined;
  const repository = requiredString(value.repository);
  const ref = requiredString(value.ref);
  if (!repository || !ref) return undefined;
  const commitSha = requiredString(value.commitSha);
  return {
    repository,
    ref,
    ...(commitSha ? { commitSha } : {}),
    trigger: optionalString(value.trigger) ?? "unknown",
    requestedAt: optionalString(value.requestedAt) ?? "",
    reason: optionalString(value.reason) ?? ""
  };
}

function parseBuild(value: unknown): AdminContextBuild | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const repository = requiredString(value.repository);
  const ref = requiredString(value.ref);
  if (!id || !repository || !ref) return undefined;
  const followup = parseFollowup(value.queuedFollowup);
  return {
    id,
    repository,
    ref,
    refSequence: finiteNumber(value.refSequence, 0),
    stages: parseStages(value.stages),
    ...definedOnly({
      status: parseBuildStatus(value.status),
      commitSha: optionalString(value.commitSha),
      trigger: optionalString(value.trigger),
      derivationBudgetSeconds: optionalNumber(value.derivationBudgetSeconds),
      derivationDeadlineAt: optionalString(value.derivationDeadlineAt),
      consumedExecutionSeconds: optionalNumber(value.consumedExecutionSeconds),
      remainingExecutionSeconds: optionalNumber(value.remainingExecutionSeconds),
      derivationTokenBudget: optionalNumber(value.derivationTokenBudget),
      consumedModelTokens: optionalNumber(value.consumedModelTokens),
      activeModelReservedTokens: optionalNumber(value.activeModelReservedTokens),
      remainingModelTokens: optionalNumber(value.remainingModelTokens),
      queuedFollowupCount: optionalNumber(value.queuedFollowupCount),
      failureCode: optionalString(value.failureCode),
      failureReason: optionalString(value.failureReason)
    }),
    ...(followup ? { queuedFollowup: followup } : {}),
    createdAt: optionalString(value.createdAt) ?? "",
    // Sorted on below; an absent value must not reach `localeCompare`.
    updatedAt: optionalString(value.updatedAt) ?? ""
  };
}

function parseCitations(value: unknown): AdminContextDocument["citations"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((citation) => {
    if (!isRecord(citation)) return [];
    const anchor = isRecord(citation.anchor) ? citation.anchor : {};
    return [
      {
        claim: optionalString(citation.claim) ?? "",
        ...definedOnly({
          citationId: optionalString(citation.citationId),
          claimSpan: optionalString(citation.claimSpan)
        }),
        anchor: {
          sourceType: optionalString(anchor.sourceType) ?? "unknown",
          sourceId: optionalString(anchor.sourceId) ?? "",
          ...definedOnly({
            pathOrUrl: optionalString(anchor.pathOrUrl),
            startLine: optionalNumber(anchor.startLine),
            endLine: optionalNumber(anchor.endLine)
          })
        }
      }
    ];
  });
}

type CatalogDocument = Omit<AdminContextDocument, "repository" | "releaseId" | "ref" | "commitSha">;

function parseCatalogDocument(value: unknown): CatalogDocument | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  // Sorted on and used as a map key downstream.
  const logicalId = requiredString(value.logicalId);
  if (!id || !logicalId) return undefined;
  const kind = requiredString(value.kind);
  return {
    id,
    logicalId,
    ...(kind ? { kind } : {}),
    title: optionalString(value.title) ?? logicalId,
    summary: optionalString(value.summary) ?? "",
    citations: parseCitations(value.citations)
  };
}

/**
 * Partial quota telemetry stays partial. Reporting an omitted counter as zero
 * active usage would hide capacity pressure behind a reading that looks idle.
 */
function parseQuotas(value: unknown): AdminContextMetrics["quotas"] {
  if (!isRecord(value)) return undefined;
  const active = isRecord(value.active)
    ? definedOnly({
        builds: optionalNumber(value.active.builds),
        modelTasks: optionalNumber(value.active.modelTasks)
      })
    : undefined;
  const storage = isRecord(value.storage)
    ? definedOnly({
        committedBytes: optionalNumber(value.storage.committedBytes),
        reservedBytes: optionalNumber(value.storage.reservedBytes),
        limitBytes: optionalNumber(value.storage.limitBytes)
      })
    : undefined;
  const monthlyModel = isRecord(value.monthlyModel)
    ? definedOnly({
        requests: optionalNumber(value.monthlyModel.requests),
        totalTokens: optionalNumber(value.monthlyModel.totalTokens),
        requestLimit: optionalNumber(value.monthlyModel.requestLimit),
        tokenLimit: optionalNumber(value.monthlyModel.tokenLimit)
      })
    : undefined;
  return definedOnly({ active, storage, monthlyModel });
}

export async function listAllReleases(): Promise<readonly AdminContextRelease[]> {
  const body = await apiGet("/wiki/releases");
  if (!isRecord(body) || !Array.isArray(body.releases)) {
    throw new JinaApiError("Jina API response for /wiki/releases omitted releases");
  }
  // The API places the highest sequence for each ref before its history.
  // Re-sorting by timestamp could silently select an older release.
  return collectValid(body.releases, "context release", parseRelease);
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
    const body = await apiGet(
      `/wiki/list?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}`
    );
    if (!isRecord(body) || !Array.isArray(body.documents)) {
      throw new JinaApiError(`Jina API response for context release ${release.id} omitted documents`);
    }
    return collectValid(body.documents, "context document", parseCatalogDocument).map((document) => ({
      ...document,
      repository: release.repository,
      releaseId: release.id,
      ref: release.ref,
      commitSha: release.commitSha
    }));
  });
  return catalogs.flat().sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

/** Builds, most recently updated first. */
export async function listContextBuilds(): Promise<readonly AdminContextBuild[]> {
  const body = await apiGet("/wiki/builds");
  if (!isRecord(body) || !Array.isArray(body.builds)) {
    throw new JinaApiError("Jina API response for /wiki/builds omitted builds");
  }
  return collectValid(body.builds, "context build", parseBuild).sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  );
}

/** Upper bound on the active builds sampled for checkpoint progress. */
export const CONTEXT_BUILD_PROGRESS_LIMIT = 12;

export async function listContextBuildProgress(
  builds: readonly AdminContextBuild[],
  limit = CONTEXT_BUILD_PROGRESS_LIMIT
): Promise<readonly AdminContextBuildProgress[]> {
  // Terminal rows already include their stages and bounded failure reason.
  // Checkpoint progress matters only while a build is changing.
  const selected = builds.filter((build) => build.status === "active").slice(0, Math.max(0, limit));
  const progress = await mapInBatches(selected, 3, async (build) => {
    try {
      const item = parseBuildProgress(await apiGet(`/wiki/builds/${encodeURIComponent(build.id)}/progress`));
      if (!item) {
        // Unparseable progress cannot be proven to belong to this build, so it
        // is dropped rather than rendered against the wrong row.
        reportSkipped(1, "context build progress");
        return undefined;
      }
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

function parseValidationStatus(value: unknown): "pending" | "valid" | "invalid" {
  if (value === "valid") return "valid";
  if (value === "invalid") return "invalid";
  return "pending";
}

/**
 * Reports the status verbatim rather than mapping unrecognised values onto
 * `completed`. `statusTone()` leaves anything it does not recognise neutral, so
 * a status this app has never seen reaches an operator uncoloured instead of
 * being presented as a healthy, finished build.
 */
function parseBuildStatus(value: unknown): AdminContextBuild["status"] {
  return requiredString(value);
}

function parseBuildProgress(value: unknown): AdminContextBuildProgress | undefined {
  if (!isRecord(value)) return undefined;
  const buildId = requiredString(value.buildId);
  const repository = requiredString(value.repository);
  const ref = requiredString(value.ref);
  if (!buildId || !repository || !ref) return undefined;
  const followup = parseFollowup(value.queuedFollowup);
  const pages = Array.isArray(value.pages)
    ? value.pages.flatMap((page) => {
        if (!isRecord(page)) return [];
        const documentPath = requiredString(page.documentPath);
        if (!documentPath) return [];
        return [
          {
            documentPath,
            title: optionalString(page.title) ?? documentPath,
            bytes: finiteNumber(page.bytes, 0),
            validationStatus: parseValidationStatus(page.validationStatus),
            diagnostics: Array.isArray(page.diagnostics)
              ? page.diagnostics.filter((entry): entry is string => typeof entry === "string")
              : [],
            checkpointSequence: finiteNumber(page.checkpointSequence, 0),
            updatedAt: optionalString(page.updatedAt) ?? ""
          }
        ];
      })
    : [];
  return {
    buildId,
    repository,
    ref,
    stages: parseStages(value.stages),
    pages,
    ...definedOnly({
      status: parseBuildStatus(value.status),
      derivationBudgetSeconds: optionalNumber(value.derivationBudgetSeconds),
      derivationDeadlineAt: optionalString(value.derivationDeadlineAt),
      consumedExecutionSeconds: optionalNumber(value.consumedExecutionSeconds),
      remainingExecutionSeconds: optionalNumber(value.remainingExecutionSeconds),
      derivationTokenBudget: optionalNumber(value.derivationTokenBudget),
      consumedModelTokens: optionalNumber(value.consumedModelTokens),
      activeModelReservedTokens: optionalNumber(value.activeModelReservedTokens),
      remainingModelTokens: optionalNumber(value.remainingModelTokens),
      queuedFollowupCount: optionalNumber(value.queuedFollowupCount),
      failureCode: optionalString(value.failureCode),
      failureReason: optionalString(value.failureReason)
    }),
    ...(followup ? { queuedFollowup: followup } : {}),
    updatedAt: optionalString(value.updatedAt) ?? ""
  };
}

export async function getContextMetrics(): Promise<AdminContextMetrics> {
  const body = await apiGet("/wiki/metrics");
  if (!isRecord(body)) throw new JinaApiError("Jina API response for /wiki/metrics was not an object");
  // Omitted counters are dropped, not zeroed: the page renders an absent
  // counter as "—" so unavailable telemetry cannot be read as an empty system.
  return definedOnly({
    publishedGenerationCount: optionalNumber(body.publishedGenerationCount),
    documentCount: optionalNumber(body.documentCount),
    fragmentCount: optionalNumber(body.fragmentCount),
    hierarchyNodeCount: optionalNumber(body.hierarchyNodeCount),
    quotas: parseQuotas(body.quotas)
  });
}
