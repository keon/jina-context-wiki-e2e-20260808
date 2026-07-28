import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyCommand,
  findOutboxMessage,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  reduceBoard,
  renewOutboxLease,
  taskTypeDefinitions,
  type BoardOutboxMessageId,
  type BoardTask,
  type CommandActor,
  type TaskId
} from "@jina/board";
import {
  DeriveKnowledgeService,
  EvidenceFocusSelector,
  IndexContextService,
  IngestEvidenceService,
  KnowledgeOutputValidator,
  MemoryContextEngineStore,
  MemoryContextPipelineCoordinator,
  QueryContextService,
  buildKnowledgeFilePrompt,
  derivationDetailLevels,
  derivationDetailOrDefault,
  isDerivationDetail,
  buildKnowledgePrompt,
  contextQueueTopics,
  contextTaskTypeDefinitions,
  contextTaskTypeDependencies,
  contextTaskTypeTriggers,
  contextTaskTypes,
  evidenceSourceTypes,
  fingerprint,
  isContextTaskType,
  newId,
  selectPriorKnowledge,
  stableId,
  type ApiTokenRecord,
  type ContextBuild,
  type ContextEngineStore,
  type ContextPipelineCoordinator,
  type ContextPipelineStage,
  type ContextQueueTopic,
  type ContextWriteFence,
  type IngestEvidenceInput,
  type KnowledgeDocumentGenerator,
  type KnowledgeRevisionEvent,
  type QueryContextRequest,
  type VerifiedApiToken
} from "@jina/context-engine";
import type { ParsedGitHubWebhook } from "@jina/github";
import { isContextTrigger } from "@jina/github";
import {
  createLogger,
  errorLogFields,
  MetricsRegistry,
  recordHttpRequest,
  requestTraceContext
} from "@jina/observability";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { prReviewTaskTypeDependencies, prReviewTaskTypeTriggers } from "@jina/review";
import { entityId, nowIso } from "@jina/shared-kernel";
import { createGitHubIntakeState, ingestGitHubWebhook, type GitHubIntakeState } from "./github-intake.js";
import { handleContextMcpRequest } from "./mcp.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";
import { buildTaskTypeCatalog, type TaskTypeTriggerRule } from "./task-type-catalog.js";

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const MAX_CONTEXT_QUERY_REQUEST_BYTES = 128 * 1024;
const MAX_CONTEXT_TARGETS_PER_KIND = 100;
const MAX_CONTEXT_TARGET_LENGTH = 1_000;
const WORKER_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_CONTEXT_WORKER_LEASE_MS = 75 * 60 * 1000;
const RUN_ACTOR: CommandActor = { type: "run", id: "worker" };
const WORKER_TOPICS = [
  "run-review",
  "run-research",
  "run-publish",
  "run-cleanup",
  ...Object.values(contextQueueTopics)
] as const;

export interface ApiServerConfig {
  readonly githubWebhookSecret?: string;
  readonly tenantId?: string;
  readonly tenantAliases?: readonly string[];
  readonly enableDevEndpoints?: boolean;
  readonly simulateRuns?: boolean;
  readonly seedDemo?: boolean;
  readonly stateStore?: ApiStateStore;
  readonly contextStore?: ContextEngineStore;
  readonly contextCoordinator?: ContextPipelineCoordinator;
  readonly sharedIdentityResolver?: SharedIdentityResolver;
  readonly internalApiToken?: string;
  readonly contextApiToken?: string;
  readonly contextApiTenantId?: string;
  readonly contextApiPrincipalId?: string;
  readonly tenantAdminPrincipalIds?: readonly string[];
  readonly mcpAllowedOrigins?: readonly string[];
  readonly contextWorkerLeaseMs?: number;
}

interface ResolvedRepositoryIdentity {
  readonly tenantId: string;
  readonly githubAccountId: string;
  readonly githubAccountLogin: string;
  readonly githubAccountType: string;
  readonly githubRepositoryId?: string;
  readonly githubInstallationId?: string;
  readonly repository: string;
  readonly defaultBranch?: string;
}

interface SharedIdentityResolver {
  resolveRepository(input: {
    readonly githubRepositoryId?: number;
    readonly githubInstallationId?: number;
    readonly tenantId?: string;
    readonly repository: string;
  }): Promise<ResolvedRepositoryIdentity | undefined>;
  listTenantIds(): Promise<readonly string[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface ApiSnapshot {
  readonly intakeState: GitHubIntakeState;
  readonly publications: readonly PublicationRecord[];
  readonly devDeliverySequence: number;
}

export interface ApiStateStore {
  load(): Promise<ApiSnapshot | undefined>;
  loadNewer?(
    sinceVersion: number
  ): Promise<{ readonly snapshot: ApiSnapshot; readonly version: number } | "unchanged" | undefined>;
  ping(): Promise<void>;
  hasDelivery(deliveryId: string): Promise<boolean>;
  save(snapshot: ApiSnapshot, deliveryId?: string): Promise<boolean>;
  update<T>(
    operation: (snapshot: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>,
    deliveryId?: string
  ): Promise<{ readonly committed: boolean; readonly result?: T }>;
  close(): Promise<void>;
}

interface Principal {
  readonly tenantId: string;
  readonly principalId: string;
  readonly forwarded: boolean;
  /**
   * Present only for an issued token. `exactOptionalPropertyTypes` is on, so the
   * static-credential return sites keep working precisely because they omit these
   * keys; nothing may ever assign `undefined` to them.
   */
  readonly scopes?: readonly ContextScope[];
  readonly tokenId?: string;
}

type ContextScope = "context:query" | "context:read" | "context:build" | "context:admin";

/**
 * What `CONTEXT_API_TOKEN` reaches, stated as scopes. Reading is part of
 * answering — a caller cannot ask about what it cannot find — so the read-only
 * projections sit beside the query scope. Writes, administration and board
 * traffic stay with the internal credential.
 */
const CONTEXT_CREDENTIAL_SCOPES: readonly ContextScope[] = ["context:query", "context:read"];

const CONTEXT_SCOPES = ["context:query", "context:read", "context:build", "context:admin"] as const;

function isContextScope(value: string): value is ContextScope {
  return (CONTEXT_SCOPES as readonly string[]).includes(value);
}

const API_TOKEN_PATTERN = /^jina_atk_[A-Za-z0-9_-]{43}$/;

/** Long enough that the write is rare, short enough to be useless to a reader. */
const API_TOKEN_USE_STAMP_MS = 60_000;

/**
 * Minutes rather than days, because phase 4 delegates short-lived tokens per
 * tenant and a one-day floor would mean a fleet of day-long bearer tokens held in
 * a web tier's memory. Day-shaped lifetimes are a presentation choice.
 */
const MIN_API_TOKEN_MINUTES = 5;
const MAX_API_TOKEN_MINUTES = 525_600;

/**
 * The privilege boundary of this phase. `isTenantAdmin` is a pure string test on
 * the principal id, and a minted token's principal comes from a database row
 * rather than a header — so it never passes through
 * `normalizedForwardedPrincipal`, the only filter standing between a caller and
 * administrator status today. Without these refusals a minter could issue a
 * read-scoped token whose principal makes it a tenant administrator everywhere it
 * reaches.
 */
function refusedTokenPrincipal(
  principalId: string,
  administrator: boolean,
  tenantId: string,
  config: ApiServerConfig
): string | undefined {
  const normalized = normalizedForwardedPrincipal(principalId);
  // Normalization is checked first so every test below runs on the normalized
  // string; otherwise `TENANT:…` or a leading space walks past a prefix test.
  if (!normalized) return "principal must be a recognisable user, tenant or service principal";
  if (normalized.startsWith("tenant:")) {
    // A tenant principal is tenant administration by construction, so it is
    // opt-in rather than forbidden — the same treatment a configured
    // administrator gets, and for the same reason: the only caller here holds
    // the internal credential, which already reaches every tenant on every other
    // route, so this grants no new reach. What it does grant is something the
    // shared static credential cannot: a credential that names one tenant and
    // can be revoked. It is the honest shape for a caller that legitimately acts
    // for a whole tenant, which is what a tenant's own operator console does.
    if (!administrator) {
      return "a tenant principal confers tenant administration; pass administrator: true to issue it deliberately";
    }
    // And only for its own tenant. Without this a mint into tenant A could name
    // tenant B's principal, which reads nothing today but would quietly become a
    // cross-tenant grant the moment anything resolved that principal.
    if (normalized !== `tenant:${tenantId.toLowerCase()}`) {
      return "a tenant principal must name the tenant the token is issued for";
    }
  }
  if (normalized.startsWith("svc:")) {
    return "a service principal names no accountable person and cannot be issued as a token";
  }
  if (isConfiguredTenantAdmin(normalized, config) && !administrator) {
    return "this principal is a tenant administrator; pass administrator: true to issue it deliberately";
  }
  return undefined;
}

/**
 * Whether a principal would satisfy `isTenantAdmin` for this tenant. Mirrors its
 * two static rules deliberately: if these ever drift, mint starts issuing tokens
 * whose privileges do not match what it thought it was granting.
 */
function isAdministrativePrincipal(normalizedPrincipalId: string, tenantId: string, config: ApiServerConfig): boolean {
  return (
    normalizedPrincipalId === `tenant:${tenantId.toLowerCase()}` ||
    isConfiguredTenantAdmin(normalizedPrincipalId, config)
  );
}

/**
 * Whether a normalized principal is one the deployment has named an
 * administrator. Deliberately wider than the privilege it guards: the configured
 * list is raw trimmed env with no lowercasing, so a mixed-case entry confers
 * nothing today, and treating it as administrative anyway is the safe direction —
 * and keeps working on the day somebody corrects the entry.
 */
function isConfiguredTenantAdmin(normalizedPrincipalId: string, config: ApiServerConfig): boolean {
  return (config.tenantAdminPrincipalIds ?? []).map((id) => id.trim().toLowerCase()).includes(normalizedPrincipalId);
}

function unsupportedApiTokenStore(): never {
  throw new ApiError(501, "unsupported", "this deployment does not store API tokens");
}

/** Never the secret, never its hash: those exist only in the mint response. */
function publicApiToken(token: ApiTokenRecord): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    principalId: token.principalId,
    scopes: token.scopes,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
    ...(token.revokedAt ? { revokedAt: token.revokedAt } : {})
  };
}

/** Creates the HTTP API without binding a port. */
export function createApiServer(config: ApiServerConfig = {}): Server {
  const contextWorkerLeaseMs = config.contextWorkerLeaseMs ?? DEFAULT_CONTEXT_WORKER_LEASE_MS;
  if (!Number.isSafeInteger(contextWorkerLeaseMs) || contextWorkerLeaseMs <= 0) {
    throw new Error("contextWorkerLeaseMs must be a positive safe integer");
  }
  // A static secret shaped like an issued token would be shadowed by the token
  // branch and could never authenticate, taking the deployment offline. Refuse at
  // construction rather than at the first request.
  for (const staticToken of [config.internalApiToken, config.contextApiToken]) {
    if (staticToken?.startsWith("jina_atk_")) {
      throw new Error("static API tokens must not use the jina_atk_ prefix reserved for issued tokens");
    }
  }
  const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-api" });
  const metrics = new MetricsRegistry();
  const startedAt = nowIso();
  const contextCoordinator = config.contextCoordinator ?? new MemoryContextPipelineCoordinator();
  const contextStore = config.contextStore ?? new MemoryContextEngineStore(contextCoordinator);

  /**
   * Resolves a presented secret to its principal, or `undefined`. Every failure —
   * unknown hash, expired, revoked, a store that does not implement verification,
   * or a lookup that throws — answers identically, so the response never says
   * which tokens exist or why one stopped working.
   */
  async function verifyApiToken(token: string): Promise<Principal | undefined> {
    if (!contextStore.verifyApiToken) return undefined;
    const secretHash = createHash("sha256").update(token, "utf8").digest("hex");
    let verified: VerifiedApiToken | undefined;
    try {
      verified = await contextStore.verifyApiToken(secretHash);
    } catch (error: unknown) {
      // Fail closed. A throw here is a database or role problem, not a credential
      // problem, and 401 is the only answer that cannot accidentally admit
      // anybody. Without this the rejection escapes into the request's catch and
      // the caller gets a 500.
      logger.warn("api token verification failed", {
        event: "api.token.verify_failed",
        ...errorLogFields(error)
      });
      return undefined;
    }
    if (!verified) return undefined;
    stampApiTokenUse(verified);
    return {
      tenantId: verified.tenantId,
      principalId: verified.principalId,
      forwarded: true,
      scopes: verified.scopes.filter(isContextScope),
      tokenId: verified.tokenId
    };
  }

  /**
   * Coarsened to a minute and never awaited. Exact would be one UPDATE of a
   * single hot row per request — lock contention and WAL churn proportional to
   * traffic, on a path that must not be able to fail a request that has already
   * authenticated.
   */
  function stampApiTokenUse(token: VerifiedApiToken): void {
    if (token.lastUsedAt && Date.now() - Date.parse(token.lastUsedAt) < API_TOKEN_USE_STAMP_MS) return;
    const stamped = contextStore.stampApiTokenUse?.(token.tenantId, token.tokenId, nowIso());
    if (!stamped) return;
    void stamped.catch((error: unknown) => {
      logger.warn("api token last-used stamp failed", {
        event: "api.token.stamp_failed",
        tokenId: token.tokenId,
        ...errorLogFields(error)
      });
    });
  }
  let intakeState = createGitHubIntakeState();
  let publications: readonly PublicationRecord[] = [];
  let devDeliverySequence = 0;
  let restoredVersion = 0;
  let mutations = Promise.resolve();
  const deliveries = new DeliveryCache(10_000);
  const ready = initialize();

  async function initialize(): Promise<void> {
    const stored = await config.stateStore?.load();
    if (isApiSnapshot(stored)) {
      restore(migrateSnapshotTenantAliases(stored, config.tenantId, config.tenantAliases ?? []));
    }
    if (config.tenantId) {
      for (const alias of config.tenantAliases ?? []) {
        await contextStore.migrateTenantAliases(alias, config.tenantId);
      }
    }
    if (config.seedDemo) await seedDemoContext();
  }

  function restore(snapshot: ApiSnapshot): void {
    const current = sanitizeSnapshotForCurrentRuntime(snapshot);
    intakeState = current.intakeState;
    publications = current.publications;
    devDeliverySequence = current.devDeliverySequence;
  }

  function snapshot(): ApiSnapshot {
    return { intakeState, publications, devDeliverySequence };
  }

  async function persist(deliveryId?: string): Promise<boolean> {
    if (!config.stateStore) {
      if (deliveryId) deliveries.add(deliveryId);
      return true;
    }
    return config.stateStore.save(snapshot(), deliveryId);
  }

  async function reload(): Promise<void> {
    if (!config.stateStore) return;
    if (config.stateStore.loadNewer) {
      const result = await config.stateStore.loadNewer(restoredVersion);
      if (result === undefined || result === "unchanged") return;
      if (!isApiSnapshot(result.snapshot)) return;
      restore(result.snapshot);
      restoredVersion = result.version;
      return;
    }
    const stored = await config.stateStore.load();
    if (isApiSnapshot(stored)) restore(stored);
  }

  function mutate<T>(operation: () => Promise<T>, deliveryId?: string): Promise<T | undefined> {
    const result = mutations.then(async () => {
      if (!config.stateStore) {
        const value = await operation();
        await persist(deliveryId);
        return value;
      }
      const updated = await config.stateStore.update(async (stored) => {
        if (isApiSnapshot(stored)) restore(stored);
        const value = await operation();
        return { state: snapshot(), result: value };
      }, deliveryId);
      if (!updated.committed) {
        await reload();
        return undefined;
      }
      return updated.result;
    });
    mutations = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function seedDemoContext(): Promise<void> {
    const tenantId = config.tenantId ?? "default";
    const repository = "omlabs/example";
    const commitSha = "d".repeat(40);
    const body = [
      "# Demo repository",
      "",
      "The webhook service receives GitHub events and creates review tasks.",
      "",
      "Use handleWebhook to validate and normalize each delivery."
    ].join("\n");
    const checkpoint = await new IngestEvidenceService(contextStore).ingest({
      tenantId,
      repository,
      ref: "main",
      refSequence: 1,
      commitSha,
      files: [{ path: "README.md", blobSha: "b".repeat(40), body, language: "markdown" }],
      observations: [],
      aclFingerprint: createHash("sha256").update(`${tenantId}:${repository}`).digest("hex"),
      observationFrontier: "dev-seed",
      createdAt: "2026-07-26T00:00:00.000Z",
      sourceComplete: true
    });
    await contextStore.replaceRepositoryAccess(tenantId, "svc:dev", [repository]);
    await new IndexContextService(contextStore).index(checkpoint.id, "2026-07-26T00:00:01.000Z");
  }

  const server = createServer((request, response) => {
    const requestStartedAt = Date.now();
    const trace = requestTraceContext(request.headers);
    const requestLogger = logger.withTrace(trace);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const routeLabel = metricsRoute(pathname);
    let settled = false;
    const settle = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      recordHttpRequest({
        logger: requestLogger,
        metrics,
        method: request.method ?? "GET",
        path: routeLabel === "(unknown)" ? "(unknown)" : pathname,
        route: routeLabel,
        statusCode: aborted && !response.headersSent ? 0 : response.statusCode,
        durationMs: Date.now() - requestStartedAt,
        trace,
        aborted,
        quiet: routeLabel === "/health" && response.statusCode < 400
      });
    };
    response.once("finish", () => settle(false));
    response.once("close", () => settle(true));
    // Resolved once and passed down. Two calls would mean two lookups, two
    // last-used stamps, and — worse — two reads under different database scopes,
    // since this one runs before any tenant scope is entered and the second would
    // run inside it. The wrapping IIFE keeps `routed` a synchronously-produced
    // promise, so the catch below stays the sole error-to-response path and now
    // also covers a throw raised during verification.
    const routed = (async () => {
      const principal = await authenticatedPrincipal(request, config, pathname, verifyApiToken);
      return principal && principal.tenantId !== "*" && contextStore.runInTenantScope
        ? contextStore.runInTenantScope(principal.tenantId, () => route(request, response, principal))
        : route(request, response, principal);
    })();
    void routed.catch((error: unknown) => {
      if (response.destroyed || response.socket?.destroyed) return;
      const apiError = httpError(error);
      requestLogger.error("API request failed", {
        event: "http.request.error",
        method: request.method,
        path: routeLabel,
        code: apiError.code,
        ...errorLogFields(error)
      });
      json(response, apiError.statusCode, {
        accepted: false,
        error: apiError.expose ? apiError.message : "internal server error",
        ...(apiError.expose ? { code: apiError.code } : {})
      });
    });
  });

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    principal: Principal | undefined
  ): Promise<void> {
    await ready;
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isReadOnlyContextRoute(request.method, url.pathname) && !url.pathname.startsWith("/internal/")) {
      await reload();
    }
    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return;
    }
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      const [contextHealth] = await Promise.all([
        contextStore.health(),
        config.stateStore?.ping(),
        config.sharedIdentityResolver?.ping()
      ]);
      json(response, contextHealth.ok ? 200 : 503, {
        ok: contextHealth.ok,
        storage: contextHealth.adapter,
        githubWebhookConfigured: Boolean(config.githubWebhookSecret),
        durableWorker: true
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/task-types") {
      jsonCacheable(
        request,
        response,
        buildTaskTypeCatalog(
          [...taskTypeDefinitions, ...contextTaskTypeDefinitions],
          [...prReviewTaskTypeDependencies, ...contextTaskTypeDependencies],
          [...prReviewTaskTypeTriggers, ...contextTriggers()]
        )
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      await acceptSignedWebhook(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/dev/webhooks/github" && config.enableDevEndpoints) {
      const webhook = parseDevWebhook(parseJsonObject(await readRawBody(request)));
      devDeliverySequence += 1;
      const deliveryId = `dev-${devDeliverySequence}`;
      const result = await acceptParsedWebhook(webhook, deliveryId);
      json(response, 202, { accepted: true, deliveryId, ...result });
      return;
    }

    if (!principal) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const isInternal = hasInternalApiCredential(request, config);
    if (url.pathname.startsWith("/internal/") && !isInternal && url.pathname !== "/internal/context/access/sync") {
      json(response, 401, { error: "internal credential required" });
      return;
    }
    // Only an issued token carries scopes; the static credentials keep the reach
    // they had, decided during authentication. Placed after the `/internal/` gate,
    // so a token on an internal path gets that gate's 401 — except access-sync,
    // which the gate exempts and which therefore lands here and gets 403.
    if (principal.scopes) {
      const required = requiredScope(url.pathname, request.method ?? "GET");
      if (required === "internal-only" || !principal.scopes.includes(required)) {
        throw new ApiError(403, "insufficient_scope", "token scope does not permit this route");
      }
    }

    if (request.method === "POST" && url.pathname === "/internal/context/access/sync") {
      await synchronizeRepositoryAccess(request, response, principal);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/tokens") {
      await mintApiToken(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/internal/context/tokens") {
      await listApiTokens(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/internal/context/tokens/") &&
      url.pathname.endsWith("/revoke")
    ) {
      await revokeApiToken(request, response, routeId(url.pathname, "/internal/context/tokens/", "/revoke"));
      return;
    }
    if (url.pathname === "/mcp") {
      requireBoundPrincipal(principal, config);
      const origin = firstHeader(request.headers.origin);
      if (origin && !(config.mcpAllowedOrigins ?? []).includes(origin)) {
        json(response, 403, { error: "forbidden" });
        return;
      }
      const body =
        request.method === "POST"
          ? parseJsonValue(await readRawBody(request, MAX_CONTEXT_QUERY_REQUEST_BYTES))
          : undefined;
      await handleContextMcpRequest(
        request,
        response,
        async (query) =>
          queryContext(principal, {
            tenantId: principal.tenantId,
            principalId: principal.principalId,
            repository: query.repository,
            question: query.question,
            ...(query.ref ? { ref: query.ref } : {}),
            ...(query.taskKind ? { taskKind: query.taskKind } : {}),
            ...(query.targets
              ? {
                  targets: parseTargets({
                    paths: query.targets.paths,
                    symbols: query.targets.symbols,
                    pullRequests: query.targets.pullRequests,
                    issues: query.targets.issues
                  })
                }
              : {}),
            ...(query.timeWindow ? { timeWindow: query.timeWindow } : {})
          }),
        body
      );
      return;
    }
    if (url.pathname.startsWith("/context/")) {
      requireBoundPrincipal(principal, config);
    }
    if (request.method === "POST" && url.pathname === "/context/build") {
      requireTenantAdmin(principal);
      const body = parseJsonObject(await readRawBody(request));
      const repository = requiredRepositoryName(body.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      const commitSha = optionalString(body.commitSha);
      const derivationDetail =
        body.derivationDetail === undefined ? undefined : requiredString(body.derivationDetail, "derivationDetail");
      if (derivationDetail !== undefined && !isDerivationDetail(derivationDetail)) {
        throw invalidRequest(`derivationDetail must be one of ${derivationDetailLevels.join(", ")}`);
      }
      const requestedGithubInstallationId =
        body.githubInstallationId === undefined
          ? undefined
          : requiredPositiveInteger(body.githubInstallationId, "githubInstallationId");
      const identity = config.sharedIdentityResolver
        ? await config.sharedIdentityResolver.resolveRepository({
            tenantId: principal.tenantId,
            repository,
            ...(requestedGithubInstallationId ? { githubInstallationId: requestedGithubInstallationId } : {})
          })
        : undefined;
      if (config.sharedIdentityResolver && (!identity || identity.tenantId !== principal.tenantId)) {
        throw notFound("repository context not found");
      }
      const githubInstallationId = identity?.githubInstallationId
        ? requiredPositiveInteger(Number(identity.githubInstallationId), "resolved githubInstallationId")
        : requestedGithubInstallationId;
      if (config.sharedIdentityResolver && !githubInstallationId) throw notFound("repository context not found");
      const build = await contextCoordinator.createBuild({
        tenantId: principal.tenantId,
        repository: identity?.repository ?? repository,
        ref: optionalString(body.ref) ?? identity?.defaultBranch ?? "main",
        ...(commitSha ? { commitSha: requiredGitSha(commitSha, "commitSha") } : {}),
        ...(githubInstallationId ? { githubInstallationId } : {}),
        ...(derivationDetail ? { derivationDetail } : {}),
        requestKey: optionalString(body.requestKey) ?? randomUUID(),
        createdAt: nowIso()
      });
      json(response, 202, { build });
      return;
    }
    if (request.method === "POST" && url.pathname === "/context/query") {
      const body = parseJsonObject(await readRawBody(request, MAX_CONTEXT_QUERY_REQUEST_BYTES));
      const requestValue = parseQueryContextRequest(body, principal);
      json(response, 200, await queryContext(principal, requestValue));
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/generations") {
      const repositories = await permittedRepositories(principal);
      const requestedValue = url.searchParams.get("repository");
      const requested = requestedValue === null ? undefined : requiredRepositoryName(requestedValue, "repository");
      if (requested && !repositories.includes(requested)) throw notFound("repository context not found");
      const selected = requested ? [requested] : repositories;
      const generations = (
        await Promise.all(selected.map((repository) => contextStore.listGenerations(principal.tenantId, repository)))
      )
        .flat()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(publicGeneration);
      const page = paginateByCreatedAt(generations, url);
      jsonCacheable(request, response, {
        generations: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/context/generations/")) {
      const generationId = routeId(url.pathname, "/context/generations/");
      if (!generationId) throw notFound("context generation not found");
      const repositories = await permittedRepositories(principal);
      let projection = await contextStore.getScopedGeneration(principal.tenantId, repositories, generationId);
      if (
        !projection ||
        projection.generation.tenantId !== principal.tenantId ||
        !repositories.includes(projection.generation.repository)
      ) {
        throw notFound("context generation not found");
      }
      if (!isTenantAdmin(principal)) {
        projection = await contextStore.getAuthorizedGeneration(generationId, principal.principalId);
        if (!projection) throw notFound("context generation not found");
      }
      json(response, 200, {
        generation: {
          ...publicGeneration(projection.generation),
          capabilities: projection.generation.capabilities,
          counts: {
            manifest: projection.manifest.length,
            knowledge: projection.currentKnowledge.length,
            documents: projection.documents.length,
            fragments: projection.fragments.length,
            hierarchyNodes: projection.hierarchyNodes.length,
            structuralRelations: projection.structuralRelations.length
          }
        }
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/documents") {
      const repositories = await permittedRepositories(principal);
      const requestedValue = url.searchParams.get("repository");
      const requested = requestedValue === null ? undefined : requiredRepositoryName(requestedValue, "repository");
      if (requested && !repositories.includes(requested)) throw notFound("repository context not found");
      const selected = requested ? [requested] : repositories;
      const revisions = (
        await Promise.all(
          selected.map(async (repository) => {
            const revisions = await contextStore.listRevisions(principal.tenantId, repository);
            if (isTenantAdmin(principal)) return revisions;
            const allowed = await allowedKnowledgeRevisionIds(principal, repository);
            return revisions.filter((revision) => allowed.has(revision.id));
          })
        )
      )
        .flat()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const page = paginateByCreatedAt(revisions, url);
      jsonCacheable(request, response, {
        documents: await Promise.all(
          page.items.map(async (revision) =>
            publicKnowledgeSummary(revision, await contextStore.listRevisionEvents(revision.id))
          )
        ),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/context/documents/")) {
      const revisionId = routeId(url.pathname, "/context/documents/");
      if (!revisionId) throw notFound("knowledge document not found");
      const repositories = await permittedRepositories(principal);
      const revision = await contextStore.getScopedRevision(principal.tenantId, repositories, revisionId);
      const revisionAllowed =
        revision !== undefined &&
        (isTenantAdmin(principal) ||
          (await allowedKnowledgeRevisionIds(principal, revision.repository)).has(revision.id));
      if (
        !revision ||
        revision.tenantId !== principal.tenantId ||
        !repositories.includes(revision.repository) ||
        !revisionAllowed
      ) {
        throw notFound("knowledge document not found");
      }
      const priorRevision = (await contextStore.listRevisions(revision.tenantId, revision.repository))
        .filter((candidate) => candidate.logicalId === revision.logicalId && candidate.id !== revision.id)
        .filter((candidate) => candidate.createdAt <= revision.createdAt)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
      json(response, 200, {
        document: {
          ...publicKnowledgeSummary(revision, await contextStore.listRevisionEvents(revision.id)),
          bodyMarkdown: revision.bodyMarkdown,
          structuredSummary: revision.structuredSummary,
          scope: revision.scope,
          citations: await contextStore.listCitations(revision.id),
          events: await contextStore.listRevisionEvents(revision.id),
          ...(priorRevision ? { priorRevisionId: priorRevision.id } : {})
        }
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/structure") {
      const repository = requiredRepositoryName(url.searchParams.get("repository"), "repository");
      await requireRepositoryAccess(principal, repository);
      const ref = url.searchParams.get("ref")?.trim() || "main";
      const latest = (await contextStore.listGenerations(principal.tenantId, repository)).find(
        (generation) => generation.status === "published" && generation.ref === ref
      );
      const projection =
        latest === undefined
          ? undefined
          : isTenantAdmin(principal)
            ? await contextStore.getGeneration(latest.id)
            : await contextStore.getAuthorizedGeneration(latest.id, principal.principalId);
      if (!projection) throw notFound("published context generation not found");
      const path = url.searchParams.get("path")?.toLowerCase();
      const symbol = url.searchParams.get("symbol")?.toLowerCase();
      const relations = projection.structuralRelations.filter(
        (relation) =>
          (!path || `${relation.from}\n${relation.to}`.toLowerCase().includes(path)) &&
          (!symbol || `${relation.from}\n${relation.to}`.toLowerCase().includes(symbol))
      );
      json(response, 200, { generationId: projection.generation.id, relations });
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/metrics") {
      requireTenantAdmin(principal);
      json(response, 200, await contextMetrics(principal.tenantId));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/context/knowledge/") &&
      url.pathname.endsWith("/review")
    ) {
      requireBoundPrincipal(principal, config);
      requireTenantAdmin(principal);
      const revisionId = routeId(url.pathname, "/context/knowledge/", "/review");
      if (!revisionId) throw notFound("knowledge revision not found");
      const repositories = await permittedRepositories(principal);
      const revision = await contextStore.getScopedRevision(principal.tenantId, repositories, revisionId);
      if (!revision || revision.tenantId !== principal.tenantId) throw notFound("knowledge revision not found");
      await requireRepositoryAccess(principal, revision.repository);
      const body = parseJsonObject(await readRawBody(request));
      const action = requiredString(body.action, "action");
      const type =
        action === "accept"
          ? "reviewed"
          : action === "reject"
            ? "rejected"
            : action === "invalidate"
              ? "invalidated"
              : undefined;
      if (!type) throw invalidRequest("action must be accept, reject, or invalidate");
      const prior = await contextStore.listRevisionEvents(revisionId);
      const event: KnowledgeRevisionEvent = {
        id: stableId("ke", { revisionId, sequence: prior.length + 1, type, actorId: principal.principalId }),
        revisionId,
        sequence: prior.length + 1,
        type,
        actorId: principal.principalId,
        reason: optionalString(body.reason) ?? (type === "reviewed" ? "reviewed" : "no reason supplied"),
        createdAt: nowIso()
      };
      const storedEvent = await contextStore.appendRevisionEvent(event);
      const checkpoint = await contextStore.latestCheckpoint(
        principal.tenantId,
        revision.repository,
        revision.scope.ref
      );
      const generation =
        checkpoint?.commitSha === revision.scope.commitSha
          ? await new IndexContextService(contextStore).index(checkpoint.id, nowIso())
          : undefined;
      json(response, 200, {
        event: storedEvent,
        ...(generation ? { generationId: generation.id } : {})
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/context/rebuild") {
      requireTenantAdmin(principal);
      const body = parseJsonObject(await readRawBody(request));
      const repository = requiredRepositoryName(body.repository, "repository");
      const ref = optionalString(body.ref) ?? "main";
      const checkpoint = await contextStore.latestCheckpoint(principal.tenantId, repository, ref);
      if (!checkpoint) throw notFound("evidence checkpoint not found");
      const generation = await new IndexContextService(contextStore).index(checkpoint.id, nowIso());
      json(response, 202, { generationId: generation.id, status: generation.status });
      return;
    }
    if (request.method === "POST" && url.pathname === "/context/erasure") {
      requireTenantAdmin(principal);
      const body = parseJsonObject(await readRawBody(request));
      const repository = requiredRepositoryName(body.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      const sourceType = requiredString(body.sourceType, "sourceType");
      if (!evidenceSourceTypes.includes(sourceType as (typeof evidenceSourceTypes)[number])) {
        throw invalidRequest("unsupported sourceType");
      }
      const erased = await contextStore.eraseEvidence({
        tenantId: principal.tenantId,
        repository,
        sourceType: sourceType as (typeof evidenceSourceTypes)[number],
        sourceId: requiredString(body.sourceId, "sourceId"),
        actorId: principal.principalId,
        reason: requiredString(body.reason, "reason"),
        createdAt: nowIso()
      });
      const ref = optionalString(body.ref) ?? "main";
      const checkpoint = await contextStore.latestCheckpoint(principal.tenantId, repository, ref);
      const generation = checkpoint
        ? await new IndexContextService(contextStore).index(checkpoint.id, nowIso())
        : undefined;
      json(response, 202, {
        erasedGenerationCount: erased.erasedGenerationCount,
        ...(generation
          ? { generationId: generation.id, status: generation.status }
          : { status: "awaiting-reingestion" })
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/board") {
      jsonCacheable(request, response, await boardView(principal));
      return;
    }
    if (request.method === "GET" && url.pathname === "/overview") {
      const board = await boardView(principal);
      jsonCacheable(request, response, {
        board,
        events: intakeState.board.events.filter(
          (event) => !event.taskId || board.tasks.some((task) => task.id === event.taskId)
        )
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const board = await boardView(principal);
      jsonCacheable(
        request,
        response,
        intakeState.board.events.filter(
          (event) => !event.taskId || board.tasks.some((task) => task.id === event.taskId)
        )
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/internal/context/ingest") {
      const body = parseJsonObject(await readRawBody(request, MAX_REQUEST_BYTES));
      const lease = await requireLeasedContextStage(principal.tenantId, body, contextQueueTopics.ingestEvidence);
      const input = parseIngestInput(body.input, principal.tenantId, lease.build.repository, lease.build.ref);
      if (input.refSequence !== lease.build.refSequence) throw staleLease();
      const checkpoint = await new IngestEvidenceService(contextStore).ingest(input, lease.fence);
      json(response, 200, {
        effect: "changed",
        checkpointId: checkpoint.id,
        commitSha: checkpoint.commitSha,
        evidenceFingerprint: checkpoint.evidenceFingerprint
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/derive/prepare") {
      const body = parseJsonObject(await readRawBody(request));
      const lease = await requireLeasedContextStage(principal.tenantId, body, contextQueueTopics.deriveKnowledge);
      const checkpointId = requiredString(body.checkpointId, "checkpointId");
      if (lease.stage.metadata.checkpointId !== checkpointId) throw staleLease();
      const bundle = await new EvidenceFocusSelector(contextStore).select(checkpointId);
      const [manifest, priorKnowledge] = await Promise.all([
        contextStore.listManifest(checkpointId),
        selectPriorKnowledge(contextStore, bundle.checkpoint)
      ]);
      json(response, 200, {
        checkpointId,
        detail: derivationDetailOrDefault(lease.stage.metadata.derivationDetail),
        prompt:
          process.env.CONTEXT_DERIVE_DOCUMENT_FILES === "true"
            ? buildKnowledgeFilePrompt(bundle)
            : buildKnowledgePrompt(bundle),
        bundle,
        manifest,
        priorKnowledge
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/derive/commit") {
      const body = parseJsonObject(await readRawBody(request, MAX_REQUEST_BYTES));
      const lease = await requireLeasedContextStage(principal.tenantId, body, contextQueueTopics.deriveKnowledge);
      const checkpointId = requiredString(body.checkpointId, "checkpointId");
      if (lease.stage.metadata.checkpointId !== checkpointId) throw staleLease();
      const rawOutput = body.rawOutput;
      const repairPresentationFields = body.repairPresentationFields === true;
      const generator: KnowledgeDocumentGenerator = {
        name: "daytona-codex",
        version: "agentic-knowledge-documents-v2",
        model: process.env.CONTEXT_CODEX_MODEL?.trim() || "openai/gpt-5.4-mini",
        async generate() {
          return rawOutput;
        }
      };
      const service = new DeriveKnowledgeService(
        new EvidenceFocusSelector(contextStore),
        generator,
        contextStore,
        new KnowledgeOutputValidator(contextStore)
      );
      // The remote worker owns the single repair attempt. Each commit request
      // validates exactly one untrusted model output and records that attempt.
      const run = await service.derive(checkpointId, nowIso(), lease.fence, 1, repairPresentationFields);
      const enrichedGeneration =
        run.status === "succeeded"
          ? await new IndexContextService(contextStore).index(checkpointId, nowIso(), lease.fence)
          : undefined;
      json(response, 200, {
        status: run.status,
        runId: run.id,
        diagnostics: run.diagnostics,
        revisionIds: run.revisionIds,
        ...(enrichedGeneration ? { enrichedGenerationId: enrichedGeneration.id } : {})
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/index") {
      const body = parseJsonObject(await readRawBody(request));
      const lease = await requireLeasedContextStage(principal.tenantId, body, contextQueueTopics.indexContext);
      const checkpointId = requiredString(body.checkpointId, "checkpointId");
      if (lease.stage.metadata.checkpointId !== checkpointId) throw staleLease();
      const generation = await new IndexContextService(contextStore).index(checkpointId, nowIso(), lease.fence);
      json(response, 200, {
        effect: "changed",
        generationId: generation.id,
        commitSha: generation.commitSha,
        status: generation.status,
        capabilities: generation.capabilities
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/outbox/drain") {
      const body = parseJsonObject(await readRawBody(request));
      const limit =
        typeof body.limit === "number" && Number.isSafeInteger(body.limit)
          ? Math.max(1, Math.min(body.limit, 100))
          : 20;
      const checkpoints = await contextStore.pendingProjectionCheckpoints(principal.tenantId, limit);
      const processed: string[] = [];
      for (const checkpointId of checkpoints) {
        await new IndexContextService(contextStore).index(checkpointId, nowIso());
        processed.push(checkpointId);
      }
      const backlog = await contextStore.projectionBacklog(principal.tenantId);
      json(response, 200, {
        processedCheckpointCount: processed.length,
        processedCheckpointIds: processed,
        consumers: Object.entries(backlog).map(([consumer, value]) => ({
          consumer,
          pending: value.count,
          ...(value.oldestAvailableAt ? { oldestAvailableAt: value.oldestAvailableAt } : {})
        }))
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/internal/observability") {
      json(response, 200, { service: process.env.K_SERVICE ?? "jina-api", startedAt, metrics: metrics.snapshot() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/claim") {
      await claimWork(request, response, principal.tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/renew") {
      await renewWork(request, response, principal.tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/release") {
      await releaseWork(request, response, principal.tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/complete") {
      await completeWork(request, response, principal.tenantId);
      return;
    }

    json(response, 404, { error: "not found" });
  }

  async function acceptSignedWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readRawBody(request);
    const result = handleGitHubWebhook({
      rawBody,
      secret: config.githubWebhookSecret,
      eventName: firstHeader(request.headers["x-github-event"]),
      deliveryId: firstHeader(request.headers["x-github-delivery"]),
      signature: firstHeader(request.headers["x-hub-signature-256"])
    });
    if (!result.accepted || !result.deliveryId) {
      json(response, result.statusCode, result);
      return;
    }
    if (await hasDelivery(result.deliveryId)) {
      json(response, 200, { accepted: true, duplicate: true, deliveryId: result.deliveryId });
      return;
    }
    if (!result.webhook) {
      await persist(result.deliveryId);
      json(response, result.statusCode, result);
      return;
    }
    const accepted = await acceptParsedWebhook(result.webhook, result.deliveryId);
    json(response, result.statusCode, { accepted: true, deliveryId: result.deliveryId, ...accepted });
  }

  async function acceptParsedWebhook(webhook: ParsedGitHubWebhook, deliveryId: string) {
    const identity = await resolveWebhookIdentity(webhook);
    const tenantId = identity?.tenantId ?? config.tenantId ?? "default";
    if (isContextTrigger(webhook.event)) {
      const ref = webhook.event.ref.slice("refs/heads/".length);
      const build = await contextCoordinator.createBuild({
        tenantId,
        repository: webhook.repository,
        ref,
        commitSha: webhook.event.headSha,
        ...(webhook.installationId ? { githubInstallationId: webhook.installationId } : {}),
        requestKey: `push:${webhook.event.headSha}:delivery:${deliveryId}`,
        createdAt: nowIso()
      });
      await persist(deliveryId);
      return { outcome: "created", createdTaskIds: [build.id, ...build.stages.map((stage) => stage.id)] };
    }
    const result = await mutate(async () => {
      const accepted = ingestGitHubWebhook(intakeState, webhook, {
        deliveryId,
        now: nowIso(),
        tenantId,
        ...(identity ? { workspaceLabel: identity.githubAccountLogin, githubAccountId: identity.githubAccountId } : {})
      });
      intakeState = accepted.state;
      return accepted;
    }, deliveryId);
    return result ?? { outcome: "duplicate", createdTaskIds: [] };
  }

  async function resolveWebhookIdentity(webhook: ParsedGitHubWebhook): Promise<ResolvedRepositoryIdentity | undefined> {
    if (!config.sharedIdentityResolver) return undefined;
    const identity = await config.sharedIdentityResolver.resolveRepository({
      ...(webhook.repositoryId === undefined ? {} : { githubRepositoryId: webhook.repositoryId }),
      ...(webhook.installationId === undefined ? {} : { githubInstallationId: webhook.installationId }),
      repository: webhook.repository
    });
    if (!identity) throw new ApiError(409, "repository_identity_missing", "repository identity is not provisioned");
    return identity;
  }

  async function hasDelivery(deliveryId: string): Promise<boolean> {
    return config.stateStore ? config.stateStore.hasDelivery(deliveryId) : deliveries.has(deliveryId);
  }

  async function synchronizeRepositoryAccess(
    request: IncomingMessage,
    response: ServerResponse,
    principal: Principal
  ): Promise<void> {
    if (!hasInternalApiCredential(request, config) || !principal.forwarded) {
      throw new ApiError(401, "unauthorized", "internal credential and bound principal required");
    }
    const body = parseJsonObject(await readRawBody(request));
    if (!Array.isArray(body.repositories) || body.repositories.length > 5_000) {
      throw invalidRequest("repositories must be an array with at most 5000 entries");
    }
    const requested = [
      ...new Set(body.repositories.map((repository) => requiredRepositoryName(repository, "repository")))
    ].sort();
    const mode = optionalString(body.mode) ?? "replace";
    if (mode !== "replace" && mode !== "merge") throw invalidRequest("mode must be replace or merge");
    if (mode === "merge") {
      await contextStore.mergeRepositoryAccess(principal.tenantId, principal.principalId, requested);
    } else {
      await contextStore.replaceRepositoryAccess(principal.tenantId, principal.principalId, requested);
    }
    const repositories = await contextStore.repositoriesForPrincipal(principal.tenantId, principal.principalId);
    json(response, 200, { principalId: principal.principalId, repositoryCount: repositories.length, mode });
  }

  /**
   * The tenant a credential-management request acts for. Caller-selected, which
   * is worth saying plainly: the internal credential has no tenant binding and can
   * already act for any tenant on every other route, so this grants it no new
   * reach. What is new is that it can issue a durable credential, and the controls
   * for that are the principal refusals in `refusedTokenPrincipal`, `created_by`
   * recording who minted it, and the `/internal/` gate ensuring a minted token can
   * never itself mint.
   */
  function tokenRequestTenantId(request: IncomingMessage): string {
    const tenantId = config.sharedIdentityResolver
      ? normalizedTenantId(firstHeader(request.headers["x-jina-tenant-id"]))
      : config.tenantId;
    if (!tenantId) throw invalidRequest("x-jina-tenant-id is required");
    return tenantId;
  }

  function tokenRequestActor(request: IncomingMessage): string {
    return normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"])) ?? "svc:api";
  }

  /**
   * Credential management needs a store that implements it. The port's methods
   * are optional so that adding them broke no existing implementation, which
   * means the endpoints have to say so rather than assume.
   */
  function requireApiTokenStore(): Required<
    Pick<ContextEngineStore, "mintApiToken" | "listApiTokens" | "revokeApiToken">
  > {
    if (!contextStore.mintApiToken || !contextStore.listApiTokens || !contextStore.revokeApiToken) {
      throw new ApiError(501, "unsupported", "this deployment does not store API tokens");
    }
    return {
      mintApiToken: (token) => contextStore.mintApiToken?.(token) ?? unsupportedApiTokenStore(),
      listApiTokens: (tenantId) => contextStore.listApiTokens?.(tenantId) ?? unsupportedApiTokenStore(),
      revokeApiToken: (tenantId, tokenId, revokedBy, revokedAt) =>
        contextStore.revokeApiToken?.(tenantId, tokenId, revokedBy, revokedAt) ?? unsupportedApiTokenStore()
    };
  }

  async function mintApiToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const store = requireApiTokenStore();
    const tenantId = tokenRequestTenantId(request);
    const body = parseJsonObject(await readRawBody(request));
    const principalId = requiredString(body.principalId, "principalId");
    const name = requiredString(body.name, "name");
    const administrator = body.administrator === true;
    if (body.administrator !== undefined && typeof body.administrator !== "boolean") {
      throw invalidRequest("administrator must be a boolean");
    }
    const refusal = refusedTokenPrincipal(principalId, administrator, tenantId, config);
    if (refusal) throw invalidRequest(refusal);
    const principal = normalizedForwardedPrincipal(principalId)!;
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      throw invalidRequest("scopes must be a non-empty array");
    }
    const scopes = [...new Set(body.scopes.map((scope) => requiredString(scope, "scope")))];
    for (const scope of scopes) {
      if (!isContextScope(scope)) throw invalidRequest(`unsupported scope ${scope}`);
    }
    // A token carrying these on a non-administrator principal is issued dead: it
    // reaches the route and is then refused by requireTenantAdmin. Refusing here
    // makes that a mint-time error rather than a puzzle at first use.
    //
    // Gated on what the principal *is*, never on the body's `administrator` flag.
    // That flag is the caller acknowledging it means to issue an administrator
    // token; letting it also assert the fact would make it self-certifying, and a
    // caller could mint an admin-scoped token for an ordinary principal by setting
    // it.
    if (
      !isAdministrativePrincipal(principal, tenantId, config) &&
      scopes.some((scope) => scope === "context:build" || scope === "context:admin")
    ) {
      throw invalidRequest("context:build and context:admin require an administrator principal");
    }
    const expiresInMinutes = requiredPositiveInteger(body.expiresInMinutes, "expiresInMinutes");
    if (expiresInMinutes < MIN_API_TOKEN_MINUTES || expiresInMinutes > MAX_API_TOKEN_MINUTES) {
      throw invalidRequest(`expiresInMinutes must be between ${MIN_API_TOKEN_MINUTES} and ${MAX_API_TOKEN_MINUTES}`);
    }
    const secret = `jina_atk_${randomBytes(32).toString("base64url")}`;
    const createdAt = nowIso();
    const token = await store.mintApiToken({
      id: newId("atk"),
      tenantId,
      principalId: principal,
      name,
      secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
      scopes,
      createdAt,
      createdBy: tokenRequestActor(request),
      expiresAt: new Date(Date.parse(createdAt) + expiresInMinutes * 60_000).toISOString()
    });
    // The only time the secret exists outside the caller's hands. `writeHead`
    // merges headers already set on the response, so this survives `json`.
    response.setHeader("cache-control", "no-store");
    json(response, 201, { secret, token: publicApiToken(token) });
  }

  async function listApiTokens(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const store = requireApiTokenStore();
    const tenantId = tokenRequestTenantId(request);
    const now = Date.now();
    const tokens = (await store.listApiTokens(tenantId))
      .filter((token) => !token.revokedAt && Date.parse(token.expiresAt) > now)
      .map(publicApiToken);
    json(response, 200, { tokens });
  }

  async function revokeApiToken(
    request: IncomingMessage,
    response: ServerResponse,
    tokenId: string | undefined
  ): Promise<void> {
    const store = requireApiTokenStore();
    const tenantId = tokenRequestTenantId(request);
    if (!tokenId) throw notFound("api token not found");
    const revoked = await store.revokeApiToken(tenantId, tokenId, tokenRequestActor(request), nowIso());
    // A token in another tenant is a 404 rather than an idempotent 200, which
    // would confirm that it exists.
    if (!revoked) throw notFound("api token not found");
    json(response, 200, { token: publicApiToken(revoked) });
  }

  async function queryContext(principal: Principal, requestValue: QueryContextRequest) {
    const normalizedRequest = {
      ...requestValue,
      repository: requiredRepositoryName(requestValue.repository, "repository")
    };
    const allowed = await permittedRepositories(principal);
    if (!allowed.includes(normalizedRequest.repository)) throw notFound("repository context not found");
    const startedAt = nowIso();
    const started = Date.now();
    const execution = await new QueryContextService(contextStore).queryWithTrace(normalizedRequest);
    const result = execution.response;
    const completedAt = nowIso();
    await contextStore.recordQueryRun({
      id: result.traceId,
      tenantId: principal.tenantId,
      repository: normalizedRequest.repository,
      principalFingerprint: fingerprint({ tenantId: principal.tenantId, principalId: principal.principalId }),
      generationId: result.generation.id,
      requestFingerprint: fingerprint(normalizedRequest),
      ...(normalizedRequest.taskKind ? { taskKind: normalizedRequest.taskKind } : {}),
      routes: result.coverage.retrieversUsed,
      coverageStatus: result.coverage.status,
      degradedCapabilities: result.generation.derivedKnowledge === "unavailable" ? ["derivedKnowledge"] : [],
      citationFailureCount: result.answer.startsWith("Synthesis failed citation verification") ? 1 : 0,
      conflictCount: result.conflicts.length,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.now() - started),
      candidates: execution.telemetry.candidates,
      citations: execution.telemetry.citations,
      routeMetrics: execution.telemetry.routeMetrics
    });
    return result;
  }

  async function contextMetrics(tenantId: string) {
    const repositories = await contextStore.listRepositories(tenantId);
    const generations = (
      await Promise.all(repositories.map((repository) => contextStore.listGenerations(tenantId, repository)))
    ).flat();
    const revisions = (
      await Promise.all(repositories.map((repository) => contextStore.listRevisions(tenantId, repository)))
    ).flat();
    let fragmentCount = 0;
    let hierarchyNodeCount = 0;
    for (const generation of generations) {
      const projection = await contextStore.getGeneration(generation.id);
      fragmentCount += projection?.fragments.length ?? 0;
      hierarchyNodeCount += projection?.hierarchyNodes.length ?? 0;
    }
    const backlog = await contextStore.projectionBacklog(tenantId);
    const oldestPendingAt = Object.values(backlog)
      .map((value) => value.oldestAvailableAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    const latestGeneration = [...generations].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return {
      outboxDepthByConsumer: Object.fromEntries(
        Object.entries(backlog).map(([consumer, value]) => [consumer, value.count])
      ),
      ...(oldestPendingAt ? { oldestPendingAt } : {}),
      publishedGenerationCount: generations.filter((generation) => generation.status === "published").length,
      documentCount: revisions.length,
      fragmentCount,
      hierarchyNodeCount,
      embeddingCount: 0,
      query: await contextStore.queryMetrics(tenantId),
      projectors: latestGeneration
        ? Object.entries(latestGeneration.projectorStatuses).map(([name, status]) => ({
            name,
            status: backlog[name as keyof typeof backlog].count > 0 ? "behind" : status,
            checkpoint: latestGeneration.id,
            backlog: backlog[name as keyof typeof backlog].count,
            version: latestGeneration.projectorVersions[name as keyof typeof latestGeneration.projectorVersions]
          }))
        : []
    };
  }

  async function boardView(principal: Principal) {
    const allowed = isTenantAdmin(principal) ? undefined : new Set(await permittedRepositories(principal));
    const base = tenantBoardView(intakeState, publications, principal.tenantId, allowed);
    const builds = (await contextCoordinator.list(principal.tenantId)).filter(
      (build) => !allowed || allowed.has(build.repository)
    );
    return mergeContextBuilds(base, builds);
  }

  async function permittedRepositories(principal: Principal): Promise<string[]> {
    return isTenantAdmin(principal)
      ? contextStore.listRepositories(principal.tenantId)
      : contextStore.repositoriesForPrincipal(principal.tenantId, principal.principalId);
  }

  async function requireRepositoryAccess(principal: Principal, repository: string): Promise<void> {
    if (isTenantAdmin(principal)) return;
    if (!(await permittedRepositories(principal)).includes(repository)) throw notFound("repository context not found");
  }

  async function allowedKnowledgeRevisionIds(principal: Principal, repository: string): Promise<Set<string>> {
    const generations = await contextStore.listGenerations(principal.tenantId, repository);
    const allowed = new Set<string>();
    for (const generation of generations) {
      if (generation.status !== "published") continue;
      const projection = await contextStore.getAuthorizedGeneration(generation.id, principal.principalId);
      for (const document of projection?.documents ?? []) {
        if (document.sourceRevisionId) allowed.add(document.sourceRevisionId);
      }
    }
    return allowed;
  }

  function isTenantAdmin(principal: Principal): boolean {
    return (
      (Boolean(config.enableDevEndpoints) && principal.principalId.startsWith("svc:")) ||
      principal.principalId === `tenant:${principal.tenantId}` ||
      (config.tenantAdminPrincipalIds ?? []).includes(principal.principalId)
    );
  }

  function requireTenantAdmin(principal: Principal): void {
    if (!isTenantAdmin(principal)) throw new ApiError(403, "forbidden", "tenant administrator access required");
  }

  async function claimWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerId = requiredString(body.workerId, "workerId");
    if (!Array.isArray(body.topics) || body.topics.length === 0) {
      throw invalidRequest("at least one topic is required");
    }
    const topics = body.topics.map((topic) => requiredString(topic, "topic"));
    const unsupported = topics.filter((topic) => !WORKER_TOPICS.includes(topic as (typeof WORKER_TOPICS)[number]));
    if (unsupported.length) throw invalidRequest(`unsupported worker topics: ${unsupported.join(", ")}`);
    const contextTopics = topics.filter(isContextQueueTopic);
    const claimTenantIds = tenantId === "*" ? [...(await config.sharedIdentityResolver!.listTenantIds())] : [tenantId];
    if (contextTopics.length) {
      const claim = await contextCoordinator.claim({
        tenantIds: claimTenantIds,
        workerId,
        topics: contextTopics,
        now: nowIso(),
        leaseExpiresAt: new Date(Date.now() + contextWorkerLeaseMs).toISOString()
      });
      if (claim) {
        json(response, 200, {
          message: {
            id: claim.stage.id,
            topic: claim.stage.topic,
            leaseId: claim.fence.leaseId,
            leaseExpiresAt: claim.fence.leaseExpiresAt,
            attempt: claim.fence.attempt,
            writeFenceToken: claim.fence.token
          },
          task: {
            id: claim.stage.id,
            metadata: {
              tenantId: claim.build.tenantId,
              repository: claim.build.repository,
              ref: claim.build.ref,
              refSequence: claim.build.refSequence,
              ...claim.stage.metadata
            }
          }
        });
        return;
      }
    }
    if (contextTopics.length === topics.length) {
      json(response, 204, {});
      return;
    }
    const requested = topics.filter((topic) => !isContextQueueTopic(topic));
    const claimed = await mutate(async () => {
      const taskIds = intakeState.board.tasks
        .filter((task) => claimTenantIds.includes(String(task.metadata.tenantId)))
        .map((task) => task.id);
      const now = nowIso();
      const leaseId = randomUUID();
      const leased = leaseNextOutboxMessage(intakeState.board, {
        topics: requested,
        taskIds,
        leaseId,
        now,
        expiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString()
      });
      if (!leased) return undefined;
      const task = findTask(leased.state, leased.message.taskId);
      if (!task) return undefined;
      let board = leased.state;
      if (task.status === "queued") {
        board = applyCommand(
          board,
          { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" },
          { actor: { type: "run", id: workerId }, now }
        ).state;
      }
      intakeState = { ...intakeState, board };
      return { message: leased.message, task: findTask(board, task.id) };
    });
    json(response, claimed ? 200 : 204, claimed ?? {});
  }

  async function renewWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = requiredString(body.messageId, "messageId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    if (messageId.startsWith("cs_")) {
      const located = await findBuildByStage(tenantId, messageId);
      const activeFence = located?.stages.find((stage) => stage.id === messageId)?.fence;
      if (
        !activeFence ||
        activeFence.attempt !== requiredPositiveInteger(body.attempt, "attempt") ||
        activeFence.token !== requiredString(body.writeFenceToken, "writeFenceToken")
      ) {
        throw staleLease();
      }
      const renewed = await contextCoordinator.renew({
        tenantId,
        stageId: messageId,
        leaseId,
        now: nowIso(),
        leaseExpiresAt: new Date(Date.now() + contextWorkerLeaseMs).toISOString()
      });
      if (!renewed) throw staleLease();
      json(response, 200, { accepted: true });
      return;
    }
    const id = entityId<"board_outbox_message">(messageId) as BoardOutboxMessageId;
    const renewed = await mutate(async () => {
      const message = findOutboxMessage(intakeState.board, id);
      const task = message ? findTask(intakeState.board, message.taskId) : undefined;
      if (!task || task.metadata.tenantId !== tenantId) return false;
      const now = nowIso();
      const board = renewOutboxLease(
        intakeState.board,
        id,
        leaseId,
        now,
        new Date(Date.now() + WORKER_LEASE_MS).toISOString()
      );
      if (!board) return false;
      intakeState = { ...intakeState, board };
      return true;
    });
    if (!renewed) throw staleLease();
    json(response, 200, { accepted: true });
  }

  async function releaseWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const stageId = requiredString(body.messageId, "messageId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const build = await findBuildByStage(tenantId, stageId);
    const fence = build?.stages.find((stage) => stage.id === stageId)?.fence;
    if (
      !fence ||
      fence.leaseId !== leaseId ||
      fence.attempt !== requiredPositiveInteger(body.attempt, "attempt") ||
      fence.token !== requiredString(body.writeFenceToken, "writeFenceToken")
    ) {
      throw staleLease();
    }
    const released = await contextCoordinator.release?.({
      tenantId,
      stageId,
      leaseId,
      now: nowIso(),
      reason: optionalString(body.reason) ?? "worker release"
    });
    if (released === false) throw staleLease();
    json(response, 200, { accepted: true });
  }

  async function completeWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = requiredString(body.messageId, "messageId");
    const taskId = requiredString(body.taskId, "taskId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const outcome = body.outcome;
    if (outcome !== "done" && outcome !== "failed") throw invalidRequest("outcome must be done or failed");
    if (messageId.startsWith("cs_") || taskId.startsWith("cs_")) {
      if (messageId !== taskId) throw staleLease();
      const located = await findBuildByStage(tenantId, taskId);
      const stage = located?.stages.find((candidate) => candidate.id === taskId);
      if (
        !stage?.fence ||
        stage.fence.leaseId !== leaseId ||
        stage.fence.attempt !== requiredPositiveInteger(body.attempt, "attempt") ||
        stage.fence.token !== requiredString(body.writeFenceToken, "writeFenceToken")
      ) {
        throw staleLease();
      }
      const result = safeResultPayload(body.result);
      const completed = await contextCoordinator.complete({
        tenantId,
        stageId: taskId,
        fence: stage.fence,
        outcome: outcome === "done" ? "succeeded" : "failed",
        now: nowIso(),
        ...(outcome === "done" ? { metadata: result } : { error: optionalString(body.reason) ?? "worker failed" })
      });
      if (!completed) throw staleLease();
      json(response, 200, { accepted: true });
      return;
    }
    const outboxId = entityId<"board_outbox_message">(messageId) as BoardOutboxMessageId;
    const boardTaskId = entityId<"task">(taskId) as TaskId;
    const completed = await mutate(async () => {
      const message = findOutboxMessage(intakeState.board, outboxId);
      const task = findTask(intakeState.board, boardTaskId);
      const now = nowIso();
      if (
        !message ||
        !task ||
        message.taskId !== boardTaskId ||
        message.status !== "leased" ||
        message.leaseId !== leaseId ||
        task.metadata.tenantId !== tenantId
      ) {
        return false;
      }
      let board = markOutboxDispatched(intakeState.board, message.id, now);
      board = applyCommand(
        board,
        {
          command: "CommentTask",
          taskId: boardTaskId,
          eventType: outcome === "failed" ? `${message.topic}.failed` : completionEventType(message.topic),
          payload:
            outcome === "failed"
              ? { reason: optionalString(body.reason)?.slice(0, 2_000) ?? "worker failed" }
              : safeResultPayload(body.result)
        },
        { actor: RUN_ACTOR, now }
      ).state;
      if (outcome === "done" && message.topic === "run-publish") {
        const repository = optionalString(task.metadata.repository) ?? "";
        const pullRequestNumber = Number(task.metadata.pullRequestNumber ?? 0);
        const headSha = optionalString(task.metadata.headSha) ?? "";
        const key = buildPublicationKey(`${repository}#${pullRequestNumber}`, headSha, "summary");
        publications = upsertPublication(publications, { key, headSha, target: "summary" }).records;
      }
      board = applyCommand(
        board,
        { command: "TransitionTask", taskId: boardTaskId, toStatus: outcome },
        { actor: RUN_ACTOR, now }
      ).state;
      intakeState = { ...intakeState, board: reduceBoard(board, now) };
      return true;
    });
    if (!completed) throw staleLease();
    json(response, 200, { accepted: true });
  }

  async function requireLeasedContextStage(
    tenantId: string,
    body: Record<string, unknown>,
    topic: ContextQueueTopic
  ): Promise<{ build: ContextBuild; stage: ContextPipelineStage; fence: ContextWriteFence }> {
    const taskId = requiredString(body.taskId, "taskId");
    if (requiredString(body.messageId, "messageId") !== taskId) throw staleLease();
    const leaseId = requiredString(body.leaseId, "leaseId");
    const build = await findBuildByStage(tenantId, taskId);
    const stage = build?.stages.find((candidate) => candidate.id === taskId);
    if (
      !build ||
      !stage?.fence ||
      stage.topic !== topic ||
      stage.fence.leaseId !== leaseId ||
      stage.fence.attempt !== requiredPositiveInteger(body.attempt, "attempt") ||
      stage.fence.token !== requiredString(body.writeFenceToken, "writeFenceToken")
    ) {
      throw staleLease();
    }
    await requireFence(tenantId, stage.fence);
    return { build, stage, fence: stage.fence };
  }

  async function requireFence(tenantId: string, fence: ContextWriteFence): Promise<void> {
    if (!(await contextCoordinator.validateWriteFence({ tenantId, fence, now: nowIso() }))) throw staleLease();
  }

  async function findBuildByStage(tenantId: string, stageId: string): Promise<ContextBuild | undefined> {
    return (await contextCoordinator.list(tenantId)).find((build) =>
      build.stages.some((stage) => stage.id === stageId)
    );
  }

  async function drainOneSimulatedRun(): Promise<void> {
    const message = intakeState.board.outbox.find(
      (candidate) => candidate.status === "pending" && !isContextQueueTopic(candidate.topic)
    );
    if (!message) return;
    let board = markOutboxDispatched(intakeState.board, message.id, nowIso());
    const task = findTask(board, message.taskId);
    if (!task || task.status !== "queued") return;
    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" },
      { actor: RUN_ACTOR, now: nowIso() }
    ).state;
    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "done" },
      { actor: RUN_ACTOR, now: nowIso() }
    ).state;
    intakeState = { ...intakeState, board: reduceBoard(board, nowIso()) };
    await persist();
  }

  if (config.simulateRuns) {
    const timer = setInterval(
      () =>
        void mutate(drainOneSimulatedRun).catch((error) => logger.error("simulated run failed", errorLogFields(error))),
      1_500
    );
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }
  if (config.stateStore) server.once("close", () => void config.stateStore?.close());
  if (config.sharedIdentityResolver) server.once("close", () => void config.sharedIdentityResolver?.close());
  server.once("close", () => void contextStore.close());
  return server;
}

async function authenticatedPrincipal(
  request: IncomingMessage,
  config: ApiServerConfig,
  pathname: string,
  verifyApiToken: (token: string) => Promise<Principal | undefined>
): Promise<Principal | undefined> {
  const authorization = firstHeader(request.headers.authorization);
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (presented && API_TOKEN_PATTERN.test(presented)) {
    // Terminal, and first in the function. A shape-matched token is never
    // reinterpreted as a shared secret, so an issued token cannot fall through to
    // a static path. It goes ahead of the dev branch too: that branch returns
    // without reading any bearer and takes identity from unvalidated headers, so a
    // token presented to a dev-enabled server would otherwise be ignored and the
    // caller would be whoever the headers claim.
    const principal = await verifyApiToken(presented);
    return principal && assertedIdentity(request, config, principal);
  }
  if (config.enableDevEndpoints) {
    return {
      tenantId: firstHeader(request.headers["x-jina-tenant-id"]) ?? config.tenantId ?? "default",
      principalId: normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"])) ?? "svc:dev",
      forwarded: true
    };
  }
  const internal = Boolean(config.internalApiToken && authorization === `Bearer ${config.internalApiToken}`);
  const context = Boolean(
    config.contextApiToken &&
    authorization === `Bearer ${config.contextApiToken}` &&
    isContextCredentialRoute(pathname, request.method ?? "GET")
  );
  if (!internal && !context) return undefined;
  if (internal && pathname === "/internal/context/access/sync") {
    const tenantId = contextCredentialTenantId(config.contextApiTenantId, config);
    const principalId = normalizedForwardedPrincipal(config.contextApiPrincipalId);
    if (!tenantId || !principalId) return undefined;
    const requestedTenantHeader = firstHeader(request.headers["x-jina-tenant-id"]);
    const requestedPrincipalHeader = firstHeader(request.headers["x-jina-principal-id"]);
    const requestedTenantId = contextCredentialTenantId(requestedTenantHeader, config);
    const requestedPrincipalId = normalizedForwardedPrincipal(requestedPrincipalHeader);
    if (
      (requestedTenantHeader !== undefined && requestedTenantId !== tenantId) ||
      (requestedPrincipalHeader !== undefined && requestedPrincipalId !== principalId)
    ) {
      return undefined;
    }
    return { tenantId, principalId, forwarded: true };
  }
  if (context && !internal) {
    const tenantId = contextCredentialTenantId(config.contextApiTenantId, config);
    const principalId = normalizedForwardedPrincipal(config.contextApiPrincipalId);
    if (!tenantId || !principalId) return undefined;
    const requestedTenantHeader = firstHeader(request.headers["x-jina-tenant-id"]);
    const requestedPrincipalHeader = firstHeader(request.headers["x-jina-principal-id"]);
    const requestedTenantId = contextCredentialTenantId(requestedTenantHeader, config);
    const requestedPrincipalId = normalizedForwardedPrincipal(requestedPrincipalHeader);
    if (
      (requestedTenantHeader !== undefined && requestedTenantId !== tenantId) ||
      (requestedPrincipalHeader !== undefined && requestedPrincipalId !== principalId)
    ) {
      return undefined;
    }
    return { tenantId, principalId, forwarded: true };
  }
  const requestedTenantId = normalizedTenantId(firstHeader(request.headers["x-jina-tenant-id"]));
  const tenantId = config.sharedIdentityResolver
    ? (requestedTenantId ?? (internal && pathname === "/internal/worker/claim" ? "*" : undefined))
    : config.tenantId;
  if (!tenantId) return undefined;
  const forwarded = normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"]));
  if (config.sharedIdentityResolver && forwarded?.startsWith("tenant:") && forwarded !== `tenant:${tenantId}`) {
    return undefined;
  }
  return { tenantId, principalId: forwarded ?? "svc:api", forwarded: forwarded !== undefined };
}

/**
 * The row is authoritative; a header only has to agree with it. Present and
 * disagreeing is rejected rather than reinterpreted, which is what the two
 * config-bound branches already do and what makes multi-tenant access safe:
 * every token names its own tenant, so nothing trusts a caller's claim about
 * which tenant it is acting for.
 *
 * The comparisons are deliberately the same ones those branches use, which makes
 * them asymmetric: `normalizedForwardedPrincipal` lowercases, so the principal
 * header is case-insensitive, while `contextCredentialTenantId` in fixed tenancy
 * does not, so the tenant header is not.
 */
function assertedIdentity(
  request: IncomingMessage,
  config: ApiServerConfig,
  principal: Principal
): Principal | undefined {
  const tenantHeader = firstHeader(request.headers["x-jina-tenant-id"]);
  const principalHeader = firstHeader(request.headers["x-jina-principal-id"]);
  if (tenantHeader !== undefined && contextCredentialTenantId(tenantHeader, config) !== principal.tenantId) {
    return undefined;
  }
  if (principalHeader !== undefined && normalizedForwardedPrincipal(principalHeader) !== principal.principalId) {
    return undefined;
  }
  return principal;
}

function requireBoundPrincipal(principal: Principal, config: ApiServerConfig): void {
  if (!config.enableDevEndpoints && !principal.forwarded) {
    throw new ApiError(401, "bound_principal_required", "a bound principal is required");
  }
}

function hasInternalApiCredential(request: IncomingMessage, config: ApiServerConfig): boolean {
  return Boolean(
    config.internalApiToken && firstHeader(request.headers.authorization) === `Bearer ${config.internalApiToken}`
  );
}

/**
 * The scope a route demands, or `"internal-only"` for routes no issued token may
 * reach. Never `undefined`: a lookup that answers `undefined` for a route it does
 * not recognise is indistinguishable from one answering `undefined` for a route
 * that needs no scope, and the second reading would silently open `/board`,
 * `/events`, the `/internal/` namespace and every route added after this one. The
 * map is exhaustive over what a token may reach; everything else, including the
 * 404 fallback, is closed by construction until somebody opens it deliberately.
 */
function requiredScope(pathname: string, method: string): ContextScope | "internal-only" {
  if (method === "POST") {
    if (pathname === "/mcp" || pathname === "/context/query") return "context:query";
    if (pathname === "/context/build" || pathname === "/context/rebuild") return "context:build";
    if (pathname === "/context/erasure") return "context:admin";
    if (pathname.startsWith("/context/knowledge/") && pathname.endsWith("/review")) return "context:admin";
    return "internal-only";
  }
  if (method !== "GET") return "internal-only";
  if (pathname === "/context/metrics") return "context:admin";
  return pathname === "/context/structure" ||
    pathname === "/context/generations" ||
    pathname === "/context/documents" ||
    isSingleSegmentChildOf(pathname, "/context/generations") ||
    isSingleSegmentChildOf(pathname, "/context/documents")
    ? "context:read"
    : "internal-only";
}

/**
 * Routes the narrow context credential may reach, now derived from the scope map
 * rather than restated. The union of the query and read scopes is exactly the set
 * this predicate admitted before, so its behaviour is unchanged.
 *
 * This stays a separate helper on purpose. For the static credential the route
 * check is part of *authentication* — an out-of-scope path makes the credential
 * not match at all, and the request is a 401, because the server genuinely cannot
 * tell "wrong token" from "right token, wrong route". An issued token
 * authenticates first and is refused on scope afterwards, which is a different
 * fact and gets a 403.
 */
function isContextCredentialRoute(pathname: string, method: string): boolean {
  const required = requiredScope(pathname, method);
  return required !== "internal-only" && CONTEXT_CREDENTIAL_SCOPES.includes(required);
}

/** Matches `${parent}/{id}` without matching a deeper path such as `${parent}/{id}/review`. */
function isSingleSegmentChildOf(pathname: string, parent: string): boolean {
  if (!pathname.startsWith(`${parent}/`)) return false;
  const remainder = pathname.slice(parent.length + 1);
  return remainder.length > 0 && !remainder.includes("/");
}

function contextCredentialTenantId(value: string | undefined, config: ApiServerConfig): string | undefined {
  if (config.sharedIdentityResolver) return normalizedTenantId(value);
  const normalized = value?.trim();
  return normalized !== "" && normalized === config.tenantId ? normalized : undefined;
}

function contextTriggers(): TaskTypeTriggerRule[] {
  return contextTaskTypeTriggers.flatMap((trigger) =>
    trigger.taskTypes.map((taskType) => ({
      workflow: trigger.workflow,
      taskType,
      source: trigger.source,
      description: `Creates ${taskType} work for the repository context workflow.`
    }))
  );
}

function parseQueryContextRequest(body: Record<string, unknown>, principal: Principal): QueryContextRequest {
  const taskKind = optionalString(body.taskKind);
  const ref = optionalString(body.ref);
  const from = isRecord(body.timeWindow) ? optionalIsoTime(body.timeWindow.from, "timeWindow.from") : undefined;
  const to = isRecord(body.timeWindow) ? optionalIsoTime(body.timeWindow.to, "timeWindow.to") : undefined;
  if (from && to && from > to) throw invalidRequest("timeWindow.from must not follow timeWindow.to");
  if (taskKind && !["lookup", "structure", "change", "intent", "overview", "status", "diagnose"].includes(taskKind)) {
    throw invalidRequest("unsupported taskKind");
  }
  return {
    tenantId: principal.tenantId,
    principalId: principal.principalId,
    repository: requiredRepositoryName(body.repository, "repository"),
    question: boundedString(body.question, "question", 4_000),
    ...(ref ? { ref } : {}),
    ...(taskKind ? { taskKind: taskKind as NonNullable<QueryContextRequest["taskKind"]> } : {}),
    ...(isRecord(body.targets) ? { targets: parseTargets(body.targets) } : {}),
    ...(isRecord(body.timeWindow) ? { timeWindow: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {})
  };
}

function parseTargets(value: Record<string, unknown>): NonNullable<QueryContextRequest["targets"]> {
  const paths = boundedStringArray(value.paths, "targets.paths");
  const symbols = boundedStringArray(value.symbols, "targets.symbols");
  const pullRequests = boundedStringArray(value.pullRequests, "targets.pullRequests");
  const issues = boundedStringArray(value.issues, "targets.issues");
  return {
    ...(paths ? { paths } : {}),
    ...(symbols ? { symbols } : {}),
    ...(pullRequests ? { pullRequests } : {}),
    ...(issues ? { issues } : {})
  };
}

function parseIngestInput(value: unknown, tenantId: string, repository: string, ref: string): IngestEvidenceInput {
  if (!isRecord(value) || !Array.isArray(value.files)) throw invalidRequest("input.files must be an array");
  if (value.tenantId !== tenantId || value.repository !== repository || value.ref !== ref) {
    throw invalidRequest("ingest input does not match leased stage scope");
  }
  return value as unknown as IngestEvidenceInput;
}

function publicGeneration(generation: Awaited<ReturnType<ContextEngineStore["listGenerations"]>>[number]) {
  return {
    id: generation.id,
    tenantId: generation.tenantId,
    repository: generation.repository,
    ref: generation.ref,
    commitSha: generation.commitSha,
    status: generation.status,
    derivedKnowledge: generation.capabilities.derivedKnowledge,
    projectors: generation.projectorStatuses,
    createdAt: generation.createdAt,
    ...(generation.publishedAt ? { publishedAt: generation.publishedAt } : {})
  };
}

function publicKnowledgeSummary(
  revision: Awaited<ReturnType<ContextEngineStore["getRevision"]>> & {},
  events: readonly KnowledgeRevisionEvent[]
) {
  if (!revision) throw new Error("revision is required");
  const terminal = events.at(-1)?.type;
  const reviewStatus =
    terminal === "reviewed"
      ? "reviewed"
      : terminal === "rejected" || terminal === "invalidated" || terminal === "redacted"
        ? terminal
        : "generated";
  return {
    id: revision.id,
    logicalId: revision.logicalId,
    repository: revision.repository,
    kind: revision.kind,
    title: revision.title,
    summary: revision.summary,
    confidence: revision.confidence,
    reviewStatus,
    commitSha: revision.scope.commitSha,
    generatorName: revision.generatorName,
    generatorVersion: revision.generatorVersion,
    model: revision.model,
    promptVersion: revision.promptVersion,
    createdAt: revision.createdAt
  };
}

function mergeContextBuilds(board: ReturnType<typeof tenantBoardView>, builds: readonly ContextBuild[]) {
  const contextTasks = builds.flatMap((build) => [
    buildBoardTask(build),
    ...build.stages.map((stage) => stageBoardTask(build, stage))
  ]);
  const contextTaskIds = new Set(contextTasks.map((task) => task.id));
  return {
    ...board,
    tasks: [...board.tasks.filter((task) => !isContextTaskType(task.type)), ...contextTasks],
    dependencies: [
      ...board.dependencies.filter(
        (dependency) => !contextTaskIds.has(dependency.taskId) && !contextTaskIds.has(dependency.dependsOnTaskId)
      ),
      ...builds.flatMap((build) => {
        const ingest = build.stages.find((stage) => stage.type === contextTaskTypes.ingestEvidence)!;
        return [
          ...build.stages
            .filter((stage) => stage.type !== contextTaskTypes.ingestEvidence)
            .map((stage) => ({
              taskId: entityId<"task">(stage.id),
              dependsOnTaskId: entityId<"task">(ingest.id),
              relationship: "blocks" as const,
              required: true,
              blocksParentCompletion: stage.required
            })),
          ...build.stages.map((stage) => ({
            taskId: entityId<"task">(build.id),
            dependsOnTaskId: entityId<"task">(stage.id),
            relationship: "blocks" as const,
            required: stage.required,
            blocksParentCompletion: stage.required
          }))
        ];
      })
    ],
    outbox: [
      ...board.outbox.filter((message) => !contextTaskIds.has(message.taskId)),
      ...builds.flatMap((build) =>
        build.stages
          .filter((stage) => stage.status !== "blocked")
          .map((stage) => ({
            id: entityId<"board_outbox_message">(stage.id),
            taskId: entityId<"task">(stage.id),
            topic: stage.topic,
            idempotencyKey: `${stage.id}:${stage.attempt}`,
            status:
              stage.status === "queued"
                ? ("pending" as const)
                : stage.status === "leased"
                  ? ("leased" as const)
                  : ("dispatched" as const),
            payload: { taskId: stage.id, attempt: stage.attempt },
            createdAt: build.createdAt,
            ...(stage.fence
              ? {
                  leaseId: stage.fence.leaseId,
                  leasedAt: stage.startedAt ?? build.createdAt,
                  leaseExpiresAt: stage.fence.leaseExpiresAt
                }
              : {}),
            ...(["succeeded", "failed"].includes(stage.status)
              ? { dispatchedAt: stage.completedAt ?? build.completedAt ?? build.createdAt }
              : {})
          }))
      )
    ]
  };
}

function buildBoardTask(build: ContextBuild): BoardTask {
  return {
    id: entityId<"task">(build.id),
    type: contextTaskTypes.build,
    title: `Build context for ${build.repository}@${build.ref}`,
    status: build.status === "active" ? "in_progress" : build.status === "failed" ? "failed" : "done",
    assigneeRole: "system",
    dedupeKey: `context:${build.tenantId}:${build.repository}:${build.ref}:${build.requestKey}`,
    required: true,
    attempt: 0,
    metadata: {
      tenantId: build.tenantId,
      repository: build.repository,
      ref: build.ref,
      requestKey: build.requestKey,
      ...(build.status === "degraded" ? { degraded: true } : {})
    },
    kind: "aggregate",
    createdAt: build.createdAt,
    updatedAt: build.completedAt ?? build.createdAt
  };
}

function stageBoardTask(build: ContextBuild, stage: ContextPipelineStage): BoardTask {
  return {
    id: entityId<"task">(stage.id),
    parentTaskId: entityId<"task">(build.id),
    type: stage.type,
    title: `${stage.type} for ${build.repository}@${build.ref}`,
    status:
      stage.status === "blocked"
        ? "triage"
        : stage.status === "queued"
          ? "queued"
          : stage.status === "leased"
            ? "in_progress"
            : stage.status === "succeeded"
              ? "done"
              : "failed",
    assigneeRole: "context_worker",
    dedupeKey: `context:${build.id}:${stage.type}`,
    required: stage.required,
    attempt: stage.attempt,
    metadata: {
      tenantId: build.tenantId,
      repository: build.repository,
      ref: build.ref,
      ...stage.metadata,
      ...(stage.error ? { error: stage.error } : {})
    },
    kind: "dispatchable",
    dispatchTopic: stage.topic,
    createdAt: build.createdAt,
    updatedAt: stage.completedAt ?? stage.startedAt ?? build.createdAt
  };
}

function tenantBoardView(
  state: GitHubIntakeState,
  records: readonly PublicationRecord[],
  tenantId: string,
  allowedRepositories?: ReadonlySet<string>
) {
  const taskIds = new Set(
    state.board.tasks
      .filter(
        (task) =>
          task.metadata.tenantId === tenantId &&
          (!allowedRepositories ||
            (typeof task.metadata.repository === "string" && allowedRepositories.has(task.metadata.repository)))
      )
      .map((task) => task.id)
  );
  const pullRequests = state.pullRequests.filter(
    (pullRequest) =>
      pullRequest.tenantId === tenantId && (!allowedRepositories || allowedRepositories.has(pullRequest.repository))
  );
  return {
    tasks: state.board.tasks.filter((task) => taskIds.has(task.id)),
    dependencies: state.board.dependencies.filter(
      (dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)
    ),
    outbox: state.board.outbox.filter((message) => taskIds.has(message.taskId)),
    publications: records.filter((record) =>
      pullRequests.some((pr) => record.key.startsWith(`pr:${pr.repository}#${pr.number}:`))
    ),
    pullRequests
  };
}

function completionEventType(topic: string): string {
  if (topic === "run-review") return "review.completed";
  if (topic === "run-research") return "context.collected";
  if (topic === "run-publish") return "publish.completed";
  if (topic === "run-cleanup") return "cleanup.completed";
  return "worker.completed";
}

function parseDevWebhook(body: Record<string, unknown>): ParsedGitHubWebhook {
  const repository = requiredRepositoryName(body.repository, "repository");
  if (body.ref !== undefined || body.push === true) {
    return {
      repository,
      event: {
        type: "push",
        ref: `refs/heads/${optionalString(body.ref) ?? "main"}`,
        headSha: requiredGitSha(body.headSha, "headSha"),
        deleted: false
      }
    };
  }
  if (body.issueNumber !== undefined) {
    return {
      repository,
      event: {
        type: "issue.opened",
        issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber"),
        title: optionalString(body.title) ?? "Dev issue"
      }
    };
  }
  return {
    repository,
    event: {
      type: "pull_request.opened",
      pullRequestNumber: requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber"),
      headSha: requiredGitSha(body.headSha, "headSha")
    }
  };
}

function migrateSnapshotTenantAliases(
  snapshot: ApiSnapshot,
  tenantId: string | undefined,
  aliases: readonly string[]
): ApiSnapshot {
  if (!tenantId || aliases.length === 0) return snapshot;
  const set = new Set(aliases);
  return {
    ...snapshot,
    intakeState: {
      board: {
        ...snapshot.intakeState.board,
        tasks: snapshot.intakeState.board.tasks.map((task) =>
          set.has(optionalString(task.metadata.tenantId) ?? "")
            ? { ...task, metadata: { ...task.metadata, tenantId } }
            : task
        )
      },
      pullRequests: snapshot.intakeState.pullRequests.map((pullRequest) =>
        set.has(pullRequest.tenantId) ? { ...pullRequest, tenantId } : pullRequest
      )
    }
  };
}

function sanitizeSnapshotForCurrentRuntime(snapshot: ApiSnapshot): ApiSnapshot {
  const supportedTypes = new Set(
    [...taskTypeDefinitions, ...contextTaskTypeDefinitions].map((definition) => definition.type)
  );
  const tasks = snapshot.intakeState.board.tasks.filter((task) => supportedTypes.has(task.type));
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
    ...snapshot,
    intakeState: {
      ...snapshot.intakeState,
      board: {
        tasks,
        dependencies: snapshot.intakeState.board.dependencies.filter(
          (dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)
        ),
        outbox: snapshot.intakeState.board.outbox.filter(
          (message) => taskIds.has(message.taskId) && (WORKER_TOPICS as readonly string[]).includes(message.topic)
        ),
        events: snapshot.intakeState.board.events.filter(
          (event) => event.taskId === undefined || taskIds.has(event.taskId)
        )
      }
    }
  };
}

function safeResultPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        item === null || typeof item === "boolean" || typeof item === "number"
          ? item
          : typeof item === "string"
            ? item.slice(0, 5_000)
            : (JSON.stringify(item) ?? "").slice(0, 5_000)
      ])
  );
}

function isContextQueueTopic(value: string): value is ContextQueueTopic {
  return Object.values(contextQueueTopics).includes(value as ContextQueueTopic);
}

function normalizedTenantId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function normalizedForwardedPrincipal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^user:[^\s@]+@[^\s@]+$/.test(value)) return value.toLowerCase();
  if (/^tenant:[0-9a-f-]{36}$/i.test(value)) return value.toLowerCase();
  if (/^svc:[a-z0-9_.:-]+$/i.test(value)) return value.toLowerCase();
  return undefined;
}

const METRICS_ROUTES = new Set([
  "/health",
  "/healthz",
  "/task-types",
  "/webhooks/github",
  "/dev/webhooks/github",
  "/mcp",
  "/board",
  "/overview",
  "/events",
  "/context/build",
  "/context/query",
  "/context/generations",
  "/context/documents",
  "/context/structure",
  "/context/metrics",
  "/context/rebuild",
  "/context/erasure",
  "/internal/context/access/sync",
  "/internal/context/tokens",
  "/internal/context/ingest",
  "/internal/context/derive/prepare",
  "/internal/context/derive/commit",
  "/internal/context/index",
  "/internal/context/outbox/drain",
  "/internal/worker/claim",
  "/internal/worker/renew",
  "/internal/worker/release",
  "/internal/worker/complete",
  "/internal/observability"
]);

function metricsRoute(pathname: string): string {
  if (routeId(pathname, "/context/generations/")) return "/context/generations/:id";
  if (routeId(pathname, "/context/documents/")) return "/context/documents/:id";
  if (routeId(pathname, "/context/knowledge/", "/review")) return "/context/knowledge/:id/review";
  if (routeId(pathname, "/internal/context/tokens/", "/revoke")) return "/internal/context/tokens/:id/revoke";
  return METRICS_ROUTES.has(pathname) ? pathname : "(unknown)";
}

function isReadOnlyContextRoute(method: string | undefined, pathname: string): boolean {
  return (
    method === "OPTIONS" ||
    (method === "GET" &&
      (pathname === "/health" ||
        pathname === "/healthz" ||
        pathname === "/task-types" ||
        pathname.startsWith("/context/"))) ||
    (method === "POST" && (pathname === "/context/query" || pathname === "/mcp"))
  );
}

function routeId(pathname: string, prefix: string, suffix = ""): string | undefined {
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) return undefined;
  const segment = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  if (!segment || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function readRawBody(request: IncomingMessage, maximumBytes = MAX_REQUEST_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new ApiError(413, "payload_too_large", "request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(value: Uint8Array): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed)) throw invalidRequest("request body must be a JSON object");
  return parsed;
}

function parseJsonValue(value: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(value).toString("utf8"));
  } catch {
    throw invalidRequest("request body is not valid JSON");
  }
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidRequest(`${field} is required`);
  return value.trim();
}

function boundedString(value: unknown, field: string, maximum: number): string {
  const text = requiredString(value, field);
  if (text.length > maximum) throw invalidRequest(`${field} must not exceed ${maximum} characters`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalIsoTime(value: unknown, field: string): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) throw invalidRequest(`${field} must be an ISO-8601 timestamp`);
  return parsed.toISOString();
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidRequest(`${field} must be an array of strings`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function boundedStringArray(value: unknown, field: string): string[] {
  const values = optionalStringArray(value, field);
  if (values.length > MAX_CONTEXT_TARGETS_PER_KIND) {
    throw invalidRequest(`${field} must contain at most ${MAX_CONTEXT_TARGETS_PER_KIND} items`);
  }
  for (const item of values) {
    if (item.length > MAX_CONTEXT_TARGET_LENGTH) {
      throw invalidRequest(`${field} items must not exceed ${MAX_CONTEXT_TARGET_LENGTH} characters`);
    }
  }
  return [...new Set(values)];
}

function requiredRepositoryName(value: unknown, field: string): string {
  const repository = requiredString(value, field).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw invalidRequest(`${field} must be owner/name`);
  }
  return repository;
}

function requiredGitSha(value: unknown, field: string): string {
  const sha = requiredString(value, field).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw invalidRequest(`${field} must be a full Git SHA`);
  return sha;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidRequest(`${field} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiSnapshot(value: unknown): value is ApiSnapshot {
  if (!isRecord(value) || !isRecord(value.intakeState)) return false;
  const intake = value.intakeState;
  return (
    isRecord(intake.board) &&
    Array.isArray(intake.board.tasks) &&
    Array.isArray(intake.board.dependencies) &&
    Array.isArray(intake.board.events) &&
    Array.isArray(intake.board.outbox) &&
    Array.isArray(intake.pullRequests) &&
    Array.isArray(value.publications) &&
    typeof value.devDeliverySequence === "number"
  );
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-jina-schema-version": "context-api-v1",
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type, authorization, x-jina-tenant-id, x-jina-principal-id, x-github-event, x-github-delivery, x-hub-signature-256",
  "access-control-allow-methods": "GET, POST, OPTIONS"
} as const;

function paginateByCreatedAt<T extends { id: string; createdAt: string }>(
  values: readonly T[],
  url: URL
): { items: T[]; nextCursor?: string } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw invalidRequest("limit must be an integer between 1 and 200");
  }
  const cursor = url.searchParams.get("cursor");
  let start = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    const located = values.findIndex((value) => value.id === decoded.id && value.createdAt === decoded.createdAt);
    if (located < 0) throw invalidRequest("cursor is invalid for this result set");
    start = located + 1;
  }
  const items = values.slice(start, start + limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < values.length
      ? { nextCursor: Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt })).toString("base64url") }
      : {})
  };
}

function decodeCursor(value: string): { id: string; createdAt: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "string" ||
      !parsed.id ||
      !parsed.createdAt
    ) {
      throw new Error("invalid cursor");
    }
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch {
    throw invalidRequest("cursor is invalid");
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload));
}

function jsonCacheable(request: IncomingMessage, response: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = { ...JSON_HEADERS, etag, "cache-control": "no-cache" };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(body);
}

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly expose = true
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function invalidRequest(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

function notFound(message: string): ApiError {
  return new ApiError(404, "not_found", message);
}

function staleLease(): ApiError {
  return new ApiError(409, "stale_lease", "stale worker lease");
}

function httpError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(500, "internal_error", "internal server error", false);
}

class DeliveryCache {
  readonly #ids = new Set<string>();
  constructor(private readonly capacity: number) {}
  has(id: string): boolean {
    return this.#ids.has(id);
  }
  add(id: string): void {
    if (this.#ids.has(id)) return;
    if (this.#ids.size >= this.capacity) {
      const oldest = this.#ids.values().next().value;
      if (oldest) this.#ids.delete(oldest);
    }
    this.#ids.add(id);
  }
}
