import { ApiError } from "./errors.js";
import type { GraphConfig } from "./config.js";
import {
  contextGraphDetail,
  contextQueryResult,
  generationToSummary,
  type ContextGeneration,
  type ContextKnowledgeCitation,
  type ContextKnowledgeSummary,
  type ContextQueryResponse,
  type ContextStructuralRelation,
} from "./context-graph-mapping.js";

/**
 * Documents whose citations are fetched when assembling the knowledge plane. Each
 * one costs a request, so the newest are linked to code and the remainder still
 * appear as nodes without citation edges.
 */
const citationDetailLimit = 25;

export type GraphSummary = {
  id: string;
  repository: string;
  versionLabel: string;
  sourceCommit: string;
  generatedAt: string;
  summary: string;
  nodeCount: number;
  edgeCount: number;
};

export type GraphNode = {
  id: string;
  kind: string;
  label: string;
  description: string;
  path?: string;
  evidence: string[];
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  predicate: string;
  plane: "code" | "knowledge" | string;
  confidence?: number;
  qualifiers?: Record<string, string | number | boolean>;
  why?: string;
  evidence: string[];
};

export type GraphDetail = GraphSummary & {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphCitation = {
  kind: "code" | "commit_change" | "assertion" | "observation" | "entity";
  id: string;
  repository: string;
  commitSha?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
};

export type GraphQueryResult = {
  graphId: string;
  answer: string;
  claims: Array<{ text: string; citations: GraphCitation[] }>;
  highlightedNodeIds: string[];
  highlightedEdgeIds: string[];
  incomplete: boolean;
  notes: string[];
};

export type GraphRepository = {
  name: string;
  defaultBranch: string;
  graphId?: string;
  indexing: boolean;
};

export type GraphListResult = {
  graphs: GraphSummary[];
  graphVersions: GraphSummary[];
  repositories: GraphRepository[];
  indexingRepositories: string[];
};

export type TenantWorkOverview = {
  board: {
    tasks: Array<Record<string, unknown>>;
    dependencies: Array<Record<string, unknown>>;
    outbox: Array<Record<string, unknown>>;
  };
  events: Array<Record<string, unknown>>;
};

export type GraphRepositoryAccess = { name: string; defaultBranch: string };

/** A knowledge document as the context page lists it. */
/** A build in flight, and the pages it has finished so far. */
export type ContextBuildProgress = {
  buildId: string;
  repository: string;
  ref: string;
  status: string;
  failureCode?: string;
  failureReason?: string;
  derivationBudgetSeconds?: number;
  derivationDeadlineAt?: string;
  derivationTokenBudget?: number;
  consumedModelTokens?: number;
  stages: {
    id: string;
    type: string;
    title: string;
    status: string;
    attempt: number;
    failureCode?: string;
    failureReason?: string;
    updatedAt: string;
  }[];
  pages: {
    documentPath: string;
    title: string;
    bytes: number;
    validationStatus: "pending" | "valid" | "invalid";
    diagnostics: string[];
    checkpointSequence: number;
    updatedAt: string;
  }[];
  updatedAt?: string;
};

export type ContextBuildSummary = {
  id: string;
  repository: string;
  ref: string;
  refSequence?: number;
  commitSha?: string;
  status: "active" | "completed" | "failed";
  derivationBudgetSeconds?: number;
  derivationDeadlineAt?: string;
  derivationTokenBudget?: number;
  consumedModelTokens?: number;
  failureCode?: string;
  failureReason?: string;
  stages: ContextBuildProgress["stages"];
  createdAt: string;
  updatedAt: string;
};

export type ContextBuildCancellation = {
  accepted: true;
  buildId: string;
  status: string;
  canceled: boolean;
  changed: boolean;
};

export type ContextDocumentSummary = {
  id: string;
  releaseId: string;
  logicalId: string;
  repository: string;
  kind: string;
  title: string;
  summary: string;
  confidence?: number;
  reviewStatus: string;
  commitSha?: string;
  createdAt: string;
};

export type ContextDocumentCitation = {
  sourceType?: string;
  sourceId?: string;
  repository?: string;
  commitSha?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
};

export type ContextDocumentDetail = ContextDocumentSummary & {
  bodyMarkdown: string;
  structuredSummary?: unknown;
  scope?: { ref?: string; commitSha?: string };
  citations: ContextDocumentCitation[];
  events: { type: string; createdAt: string }[];
  priorRevisionId?: string;
};

type RequestContext = {
  tenantId: string;
  installationId?: number;
  repositories: readonly GraphRepositoryAccess[];
};

export type DashboardGraphBuildInput = {
  repository: string;
  snapshotFirst?: boolean;
  requestKey: string;
  metadata: Readonly<Record<string, string | number>>;
};

type DelegatedToken = { secret: string; tokenId: string; renewAt: number };

type ContextRelease = {
  id: string;
  repository: string;
  ref: string;
  commitSha: string;
  createdAt: string;
  publishedAt?: string;
  contextStatus: "available" | "partial" | "unavailable";
};

type ContextCatalogDocument = {
  id: string;
  logicalId: string;
  revisionId: string;
  kind?: string;
  title: string;
  summary: string;
  citations: ContextCatalogCitation[];
};

type ContextCatalogCitation = {
  claim: string;
  citationId?: string;
  claimSpan?: string;
  anchor: {
    sourceType?: string;
    sourceId?: string;
    repository?: string;
    commitSha?: string;
    pathOrUrl?: string;
    startLine?: number;
    endLine?: number;
  };
};

/** Renew this far before expiry so a request never races the boundary. */
const delegatedTokenRenewalMarginMs = 60_000;

/** Matches the graph service's minimum, so a default never mints an invalid lifetime. */
const defaultDelegatedTokenTtlMinutes = 15;

/** Only events that can change derived Context cross the V1-to-V2 boundary. */
export function shouldRelayGithubContext(event: string, rawBody: string): boolean {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    payload = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  if (event === "push") {
    return (
      payload.deleted !== true &&
      typeof payload.ref === "string" &&
      payload.ref.startsWith("refs/heads/") &&
      payload.after !== "0".repeat(40)
    );
  }
  if (event === "pull_request") {
    return payload.action === "opened" || payload.action === "synchronize";
  }
  if (event === "issues") {
    const issue = payload.issue;
    return (
      payload.action === "opened" &&
      !!issue &&
      typeof issue === "object" &&
      !Array.isArray(issue) &&
      !("pull_request" in issue)
    );
  }
  return false;
}

export class GraphApiClient {
  /**
   * One delegated token per tenant. The graph service resolves a token's tenant
   * and principal from the token itself, which is the whole point: the static
   * credential is bound server-side to a single tenant and principal, so it
   * cannot serve a second tenant and — because the principal never matches what
   * this client forwards — it cannot serve the first one either.
   */
  private readonly delegatedTokens = new Map<string, DelegatedToken>();
  /** Collapses concurrent misses for the same tenant into one mint. */
  private readonly delegatedMints = new Map<
    string,
    Promise<DelegatedToken | undefined>
  >();

  constructor(
    private readonly config: GraphConfig | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The bearer to present for this tenant, and whether it was delegated.
   *
   * Falls back to the static credential whenever a delegated token cannot be
   * obtained — no internal credential configured, or a graph service that does
   * not issue tokens yet. That fallback is what makes this deployable in either
   * order: behaviour is unchanged until both sides are in place, and no request
   * fails because minting is unavailable.
   */
  private async authorization(
    tenantId: string,
  ): Promise<{ secret: string; delegated: boolean }> {
    const staticToken = { secret: this.config!.accessToken, delegated: false };
    if (!this.config?.internalToken) return staticToken;
    const cached = this.delegatedTokens.get(tenantId);
    if (cached && this.now() < cached.renewAt)
      return { secret: cached.secret, delegated: true };
    const minted = await this.mintDelegatedToken(tenantId, cached);
    return minted ? { secret: minted.secret, delegated: true } : staticToken;
  }

  /**
   * The credential for a route the graph service will not let a scoped token
   * reach at all — the board plane, which is internal-only there. A delegated
   * token gets 403 on these, so it must not be used; the internal credential is
   * what this client already holds to mint with.
   */
  private internalAuthorization(): string {
    return this.config?.internalToken ?? this.config!.accessToken;
  }

  /**
   * Relay the exact provider delivery after V1 has verified it. V2 verifies the
   * original HMAC again and admits only Context work, so V1 remains the sole
   * review orchestrator and the relay cannot manufacture GitHub events.
   */
  async relayGithubContext(headers: Headers, rawBody: string): Promise<void> {
    if (!this.config) return;
    const event = requiredHeader(headers, "x-github-event");
    if (!shouldRelayGithubContext(event, rawBody)) return;
    const delivery = requiredHeader(headers, "x-github-delivery");
    const signature = requiredHeader(headers, "x-hub-signature-256");
    try {
      const response = await this.sendWithDeadline(
        `${this.config.apiUrl}/context/webhooks/github`,
        {
          method: "POST",
          headers: {
            "content-type": headers.get("content-type") ?? "application/json",
            "x-github-event": event,
            "x-github-delivery": delivery,
            "x-hub-signature-256": signature,
          },
          body: rawBody,
        },
        this.config.timeoutMs,
      );
      if (!response.ok) throw new Error(`Context relay responded ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError(504, "Context event relay timed out");
      }
      throw new ApiError(502, "Context event relay failed");
    }
  }

  async createReviewMcpAccess(
    context: RequestContext,
    input: { repository: string; reviewRunId: string },
  ): Promise<{ mcpUrl: string; accessToken: string; expiresAt: string }> {
    if (!this.config?.internalToken) {
      throw new ApiError(503, "Context review access is not configured");
    }
    const result = await this.request<{
      repository: string;
      mcpPath: string;
      secret: string;
      token: { expiresAt: string };
    }>("/internal/context/review-access", context, {
      method: "POST",
      internalCredential: true,
      body: {
        repository: input.repository,
        reviewRunId: input.reviewRunId,
      },
    });
    if (result.repository.toLowerCase() !== input.repository.toLowerCase()) {
      throw new ApiError(502, "Context review access returned the wrong repository");
    }
    return {
      mcpUrl: new URL(result.mcpPath, `${this.config.apiUrl}/`).toString(),
      accessToken: result.secret,
      expiresAt: result.token.expiresAt,
    };
  }

  /**
   * One attempt, with its own deadline.
   *
   * Each attempt gets a fresh controller rather than sharing one across the
   * whole call. Sharing meant a mint that consumed the budget, or a 401 arriving
   * near the deadline, left the retry holding an already-aborted signal and
   * turned a recoverable case into a 504.
   */
  private async sendWithDeadline(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) abortFromCaller();
    else
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private mintDelegatedToken(
    tenantId: string,
    replacing?: DelegatedToken,
  ): Promise<DelegatedToken | undefined> {
    const inflight = this.delegatedMints.get(tenantId);
    if (inflight) return inflight;
    const mint = this.requestDelegatedToken(tenantId)
      .then((token) => {
        if (token) {
          this.delegatedTokens.set(tenantId, token);
          // Best effort, and deliberately after the replacement is in hand: a
          // failed revocation leaves a token that expires on its own, where
          // revoking first would leave a window with no usable credential.
          if (replacing)
            void this.revokeDelegatedToken(tenantId, replacing.tokenId);
        }
        return token;
      })
      .finally(() => this.delegatedMints.delete(tenantId));
    this.delegatedMints.set(tenantId, mint);
    return mint;
  }

  private async requestDelegatedToken(
    tenantId: string,
  ): Promise<DelegatedToken | undefined> {
    const config = this.config;
    if (!config?.internalToken) return undefined;
    const ttlMinutes =
      config.delegatedTokenTtlMinutes ?? defaultDelegatedTokenTtlMinutes;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${config.apiUrl}/internal/context/tokens`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.internalToken}`,
            "x-jina-tenant-id": tenantId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            principalId: tenantPrincipal(tenantId),
            name: `jina-api delegated reader (${tenantId})`,
            // Every scope this client actually uses. A tenant principal is an
            // administrator, so V2 permits `context:build`; without it an explicit
            // dashboard build would 403 on /context/build.
            scopes: ["context:read", "context:query", "context:build"],
            expiresInMinutes: ttlMinutes,
            administrator: true,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        secret?: unknown;
        token?: { id?: unknown };
      };
      const secret = typeof body.secret === "string" ? body.secret : undefined;
      const tokenId =
        typeof body.token?.id === "string" ? body.token.id : undefined;
      if (!secret || !tokenId) return undefined;
      return {
        secret,
        tokenId,
        renewAt:
          this.now() +
          Math.max(ttlMinutes * 60_000 - delegatedTokenRenewalMarginMs, 30_000),
      };
    } catch {
      // Never fatal. The caller falls back to the static credential.
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async revokeDelegatedToken(
    tenantId: string,
    tokenId: string,
  ): Promise<void> {
    const config = this.config;
    if (!config?.internalToken) return;
    try {
      await this.fetchImpl(
        `${config.apiUrl}/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.internalToken}`,
            "x-jina-tenant-id": tenantId,
          },
        },
      );
    } catch {
      // A token left to expire is not a failure worth surfacing.
    }
  }

  /** Drops a delegated token that the graph service no longer accepts. */
  private forgetDelegatedToken(tenantId: string): void {
    this.delegatedTokens.delete(tenantId);
  }

  get configured(): boolean {
    return Boolean(this.config);
  }

  async listGraphs(context: RequestContext): Promise<GraphListResult> {
    const repositories = normalizedRepositories(context.repositories);
    if (!repositories.length)
      return {
        graphs: [],
        graphVersions: [],
        repositories: [],
        indexingRepositories: [],
      };
    const generations = await this.listGenerations(context);
    const allowedRepositories = new Set(
      repositories.map((repository) => repository.name.toLowerCase()),
    );
    const allowed = generations.filter((generation) =>
      allowedRepositories.has(generation.repository.toLowerCase()),
    );
    // Counts belong to a generation's detail, so a listed version reports none.
    const graphVersions = allowed.map((generation) =>
      generationToSummary(generation, { nodeCount: 0, edgeCount: 0 }),
    );
    const graphs: GraphSummary[] = [];
    for (const repository of repositories) {
      const current = allowed
        .filter(
          (candidate) =>
            candidate.repository.toLowerCase() ===
              repository.name.toLowerCase() &&
            candidate.ref === repository.defaultBranch &&
            candidate.status === "published",
        )
        .sort((left, right) =>
          (right.publishedAt ?? right.createdAt).localeCompare(
            left.publishedAt ?? left.createdAt,
          ),
        )[0];
      if (current)
        graphs.push(
          generationToSummary(current, { nodeCount: 0, edgeCount: 0 }),
        );
    }
    const graphIdsByRepository = new Map(
      graphs.map((graph) => [graph.repository.toLowerCase(), graph.id]),
    );
    return {
      graphs: graphs.sort((left, right) =>
        left.repository.localeCompare(right.repository),
      ),
      graphVersions,
      repositories: repositories.map((repository) => {
        const graphId = graphIdsByRepository.get(repository.name.toLowerCase());
        return {
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          ...(graphId ? { graphId } : {}),
          indexing: false,
        };
      }),
      indexingRepositories: [],
    };
  }

  async buildDashboardGraph(
    context: RequestContext,
    input: DashboardGraphBuildInput,
  ): Promise<{
    task: { id: string; status: string; metadata: Record<string, unknown> };
  }> {
    const repository = context.repositories.find(
      (candidate) =>
        candidate.name.toLowerCase() === input.repository.toLowerCase(),
    );
    if (!repository) throw new ApiError(403, "repository access denied");
    return this.startBuild(context, {
      repository: repository.name,
      ref: repository.defaultBranch,
      requestKey: input.requestKey,
    });
  }

  /**
   * Starts a context build. The engine derives knowledge from immutable evidence
   * and accepts no caller-supplied metadata, so build requests carry only the
   * scope and an idempotency key.
   */
  private async startBuild(
    context: RequestContext,
    input: {
      repository: string;
      ref: string;
      commitSha?: string;
      requestKey: string;
    },
  ): Promise<{
    task: { id: string; status: string; metadata: Record<string, unknown> };
  }> {
    const githubInstallationId = requiredInstallationId(context);
    const result = await this.request<{
      build: {
        id: string;
        status: string;
        repository: string;
        ref: string;
        refSequence?: number;
        commitSha?: string;
      };
    }>("/context/build", context, {
      method: "POST",
      body: {
        repository: input.repository,
        ref: input.ref,
        ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        githubInstallationId,
        requestKey: input.requestKey,
      },
    });
    return {
      task: {
        id: result.build.id,
        status: result.build.status,
        metadata: {
          repository: result.build.repository,
          ref: result.build.ref,
          ...(result.build.refSequence === undefined
            ? {}
            : { refSequence: result.build.refSequence }),
          ...(result.build.commitSha ? { commitSha: result.build.commitSha } : {}),
        },
      },
    };
  }

  /**
   * What a build has written so far.
   *
   * A derivation runs for up to ninety minutes and finishes its pages one at a
   * time, so this is what the context page polls to show the wiki appearing
   * rather than leaving somebody watching a spinner with nothing behind it.
   */
  async contextBuildProgress(
    context: RequestContext,
    buildId: string,
  ): Promise<ContextBuildProgress> {
    const result = await this.request<ContextBuildProgress>(
      `/context/builds/${encodeURIComponent(buildId)}/progress`,
      context,
    );
    const allowed = new Set(
      normalizedRepositories(context.repositories).map((entry) =>
        entry.name.toLowerCase(),
      ),
    );
    // Defence in depth: the engine scopes by principal, and a build for a
    // repository this tenant no longer holds must not be watchable here either.
    if (!allowed.has(result.repository.toLowerCase())) {
      throw new ApiError(404, "build not found");
    }
    return result;
  }

  /** Cancels a tenant-admin-selected build through V2's internal operator endpoint. */
  async cancelContextBuild(
    context: RequestContext,
    buildId: string,
  ): Promise<ContextBuildCancellation> {
    if (!this.config?.internalToken) {
      throw new ApiError(503, "Context build cancellation is not configured");
    }
    return this.request<ContextBuildCancellation>(
      `/internal/context/builds/${encodeURIComponent(buildId)}/cancel`,
      context,
      {
        method: "POST",
        internalCredential: true,
        body: { reason: "Canceled from the Jina dashboard." },
      },
    );
  }

  /** Recent builds for the Models page's actionable provider-failure notice. */
  async listContextBuilds(context: RequestContext): Promise<ContextBuildSummary[]> {
    const result = await this.request<{ builds?: ContextBuildSummary[] }>(
      "/context/builds",
      context,
    );
    const allowed = new Set(
      normalizedRepositories(context.repositories).map((entry) =>
        entry.name.toLowerCase(),
      ),
    );
    return (Array.isArray(result.builds) ? result.builds : []).filter(
      (build) =>
        typeof build.repository === "string" &&
        allowed.has(build.repository.toLowerCase()),
    );
  }

  async getGraph(
    context: RequestContext,
    graphId: string,
  ): Promise<GraphDetail> {
    return this.getAuthorizedGraph(context, graphId);
  }

  async getWorkOverview(
    context: RequestContext,
    signal?: AbortSignal,
  ): Promise<TenantWorkOverview> {
    // The board plane is internal-only on the graph service: a scoped token is
    // refused there, so this one route keeps the service credential.
    return this.request("/overview", context, {
      signal,
      internalCredential: true,
    });
  }

  /**
   * Return whether the graph service has published any graph head for this
   * repository. This deliberately uses the scoped list endpoint without
   * mutating repository ACLs: the tenant principal already carries the
   * authorization boundary, and an availability probe must stay read-only.
   */
  async hasRepositoryGraph(
    context: RequestContext,
    repositoryName: string,
  ): Promise<boolean> {
    const repository = context.repositories.find(
      (candidate) =>
        candidate.name.toLowerCase() === repositoryName.trim().toLowerCase(),
    );
    if (!repository) return false;
    try {
      const result = await this.request<{ releases: ContextRelease[] }>(
        `/context/releases?repository=${encodeURIComponent(repository.name)}`,
        context,
      );
      return result.releases.some(
        (release) =>
          release.repository.toLowerCase() === repository.name.toLowerCase() &&
          release.contextStatus !== "unavailable",
      );
    } catch (error) {
      // The graph API intentionally returns not-found when the requested
      // repository has no authorized/published graph. Other failures remain
      // observable so the review stage can record graph unavailability.
      if (error instanceof ApiError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * Knowledge documents for a tenant, newest first. These are what the context
   * page browses: each carries a `logicalId` of the form `kind:repository:subject`,
   * which is what gives the collection a folder shape.
   */
  async listDocuments(context: RequestContext, repository?: string): Promise<ContextDocumentSummary[]> {
    const repositories = normalizedRepositories(context.repositories);
    if (!repositories.length) return [];
    const allowed = new Set(repositories.map((entry) => entry.name.toLowerCase()));
    if (repository && !allowed.has(repository.toLowerCase())) return [];
    const releases = await this.request<{ releases: ContextRelease[] }>(
      repository
        ? `/context/releases?repository=${encodeURIComponent(repository)}`
        : "/context/releases",
      context,
    );
    const selected = repositories
      .filter((entry) => !repository || entry.name.toLowerCase() === repository.toLowerCase())
      .flatMap((entry) => {
        const release = releases.releases.find(
          (candidate) =>
            candidate.repository.toLowerCase() === entry.name.toLowerCase() &&
            candidate.ref === entry.defaultBranch &&
            candidate.contextStatus !== "unavailable",
        );
        return release ? [release] : [];
      });
    const catalogs = await Promise.all(
      selected.map(async (release) => {
        const result = await this.request<{ documents: ContextCatalogDocument[] }>(
          `/context/list?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}`,
          context,
        );
        return result.documents.map((document) => contextDocumentSummary(release, document));
      }),
    );
    return catalogs.flat().sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  }

  /** One document with its body, citations and review history. */
  async getDocument(
    context: RequestContext,
    input: { repository: string; releaseId: string; documentId: string },
  ): Promise<ContextDocumentDetail> {
    const result = await this.request<{
      release: ContextRelease;
      document: ContextCatalogDocument & { bodyMarkdown: string };
    }>(
      `/context/read?repository=${encodeURIComponent(input.repository)}&releaseId=${encodeURIComponent(input.releaseId)}&document=${encodeURIComponent(input.documentId)}`,
      context,
    );
    const allowed = new Set(normalizedRepositories(context.repositories).map((entry) => entry.name.toLowerCase()));
    if (!allowed.has(result.release.repository.toLowerCase())) throw new ApiError(404, "document not found");
    return {
      ...contextDocumentSummary(result.release, result.document),
      bodyMarkdown: result.document.bodyMarkdown,
      scope: { ref: result.release.ref, commitSha: result.release.commitSha },
      citations: result.document.citations.map(contextDocumentCitation),
      events: [],
    };
  }

  /** Follows every cursor page of a listing the engine paginates. */
  private async listGenerations(
    context: RequestContext,
    repository?: string,
  ): Promise<ContextGeneration[]> {
    const base = repository
      ? `/context/generations?repository=${encodeURIComponent(repository)}&limit=200`
      : "/context/generations?limit=200";
    const generations: ContextGeneration[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const path =
        cursor === undefined
          ? base
          : `${base}&cursor=${encodeURIComponent(cursor)}`;
      const result = await this.request<{
        generations: ContextGeneration[];
        nextCursor?: string;
      }>(path, context);
      generations.push(...result.generations);
      if (!result.nextCursor) return generations;
      if (result.nextCursor === cursor)
        throw new ApiError(502, "graph service unavailable");
      cursor = result.nextCursor;
    }
    throw new ApiError(502, "graph service unavailable");
  }

  /**
   * Assembles one generation into the two-plane graph. The engine exposes an edge
   * list and cited documents rather than nodes, so the code plane comes from the
   * structural projection and the knowledge plane from documents.
   */
  private async getAuthorizedGraph(
    context: RequestContext,
    graphId: string,
  ): Promise<GraphDetail> {
    const { generation } = await this.request<{
      generation: ContextGeneration;
    }>(`/context/generations/${encodeURIComponent(graphId)}`, context);
    if (
      !context.repositories.some(
        (repository) =>
          repository.name.toLowerCase() === generation.repository.toLowerCase(),
      )
    ) {
      throw new ApiError(404, "graph not found");
    }
    const scope = `repository=${encodeURIComponent(generation.repository)}`;
    const [structure, documents] = await Promise.all([
      this.request<{ relations: ContextStructuralRelation[] }>(
        `/context/structure?${scope}&ref=${encodeURIComponent(generation.ref)}`,
        context,
      ),
      this.request<{ documents: ContextKnowledgeSummary[] }>(
        `/context/documents?${scope}&limit=200`,
        context,
      ),
    ]);
    const citationsByRevision = await this.citationsForDocuments(
      context,
      documents.documents,
    );
    return contextGraphDetail({
      generation,
      relations: structure.relations,
      documents: documents.documents,
      citationsByRevision,
    });
  }

  private async citationsForDocuments(
    context: RequestContext,
    documents: readonly ContextKnowledgeSummary[],
  ): Promise<Map<string, ContextKnowledgeCitation[]>> {
    const citations = new Map<string, ContextKnowledgeCitation[]>();
    const detailed = await Promise.all(
      documents.slice(0, citationDetailLimit).map(async (document) => {
        try {
          const result = await this.request<{
            document: { citations?: ContextKnowledgeCitation[] };
          }>(`/context/documents/${encodeURIComponent(document.id)}`, context);
          return [document.id, result.document.citations ?? []] as const;
        } catch {
          // A document that cannot be read still belongs on the graph as a node.
          return [document.id, [] as ContextKnowledgeCitation[]] as const;
        }
      }),
    );
    for (const [id, entries] of detailed) citations.set(id, entries);
    return citations;
  }

  /**
   * Answers a question about a repository. The engine routes retrieval itself and
   * resolves the generation, so the caller's graph id is not sent upstream; the
   * answer reports the generation it was actually served from.
   */
  async queryGraph(
    context: RequestContext,
    input: { graphId: string; repository: string; query: string },
  ): Promise<GraphQueryResult> {
    const repository = context.repositories.find(
      (candidate) =>
        candidate.name.toLowerCase() === input.repository.toLowerCase(),
    );
    if (!repository) throw new ApiError(404, "graph not found");
    const response = await this.request<ContextQueryResponse>(
      "/context/query",
      context,
      {
        method: "POST",
        body: {
          repository: repository.name,
          question: input.query,
          ref: repository.defaultBranch,
        },
      },
    );
    return contextQueryResult(repository.name, response);
  }

  private async request<T>(
    path: string,
    context: RequestContext,
    input: {
      method?: "GET" | "POST";
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** For routes the graph service keeps internal-only, where a scoped token is refused. */
      internalCredential?: boolean;
    } = {},
  ): Promise<T> {
    if (!this.config) {
      throw new ApiError(503, "graph exploration is not configured");
    }
    const timeoutMs = input.timeoutMs ?? this.config.timeoutMs;
    try {
      // Acquiring the credential happens before any request deadline starts, so
      // a slow mint cannot leave the request itself with no time left. Minting
      // carries its own timeout and falls back to the static credential.
      const send = async (): Promise<Response> => {
        const secret = input.internalCredential
          ? this.internalAuthorization()
          : (await this.authorization(context.tenantId)).secret;
        return this.sendWithDeadline(
          `${this.config!.apiUrl}${path}`,
          {
            method: input.method ?? "GET",
            headers: {
              authorization: `Bearer ${secret}`,
              "x-jina-tenant-id": context.tenantId,
              "x-jina-principal-id": tenantPrincipal(context.tenantId),
              ...(input.body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            body:
              input.body === undefined ? undefined : JSON.stringify(input.body),
          },
          timeoutMs,
          input.signal,
        );
      };
      let response = await send();
      if (
        response.status === 401 &&
        !input.internalCredential &&
        this.delegatedTokens.has(context.tenantId)
      ) {
        this.forgetDelegatedToken(context.tenantId);
        response = await send();
      }
      if (!response.ok) {
        if (response.status === 404) throw new ApiError(404, "graph not found");
        if (response.status === 401 || response.status === 403)
          throw new ApiError(502, "graph authorization failed");
        throw new ApiError(502, "graph service unavailable");
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError(504, "graph request timed out");
      }
      throw new ApiError(502, "graph service unavailable");
    }
  }
}

function tenantPrincipal(tenantId: string): string {
  return `tenant:${tenantId.toLowerCase()}`;
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new ApiError(400, `missing ${name} header`);
  return value;
}

function contextDocumentSummary(
  release: ContextRelease,
  document: ContextCatalogDocument,
): ContextDocumentSummary {
  return {
    id: document.id,
    releaseId: release.id,
    logicalId: document.logicalId,
    repository: release.repository,
    kind: document.kind ?? document.logicalId.split(":", 1)[0] ?? "topic",
    title: document.title,
    summary: document.summary,
    reviewStatus: "published",
    commitSha: release.commitSha,
    createdAt: release.publishedAt ?? release.createdAt,
  };
}

function contextDocumentCitation(
  citation: ContextCatalogCitation,
): ContextDocumentCitation {
  return {
    sourceType: citation.anchor.sourceType,
    sourceId: citation.anchor.sourceId,
    repository: citation.anchor.repository,
    commitSha: citation.anchor.commitSha,
    path: citation.anchor.pathOrUrl,
    startLine: citation.anchor.startLine,
    endLine: citation.anchor.endLine,
  };
}

function requiredInstallationId(context: RequestContext): number {
  if (
    !Number.isSafeInteger(context.installationId) ||
    (context.installationId ?? 0) <= 0
  ) {
    throw new ApiError(
      409,
      "GitHub installation is required to build a context graph",
    );
  }
  return context.installationId!;
}

function normalizedRepositories(
  repositories: readonly GraphRepositoryAccess[],
): GraphRepositoryAccess[] {
  const unique = new Map<string, GraphRepositoryAccess>();
  for (const repository of repositories) {
    const name = repository.name.trim();
    const defaultBranch = repository.defaultBranch.trim();
    if (name && defaultBranch)
      unique.set(name.toLowerCase(), { name, defaultBranch });
  }
  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
