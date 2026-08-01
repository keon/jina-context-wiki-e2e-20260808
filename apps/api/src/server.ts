import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  BOARD_TASK_HARD_MAX_ATTEMPTS,
  OperatorRetryRejectedError,
  applyCommand,
  boardOperatorRetryEligibility,
  findOutboxMessage,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  reduceBoard,
  releaseOutboxLease,
  retryFailedBoardTask,
  retryFailedBoardTasks,
  retryLeasedOutboxTask,
  renewOutboxLease,
  isTerminalTaskStatus,
  taskTypeDefinitions,
  type BoardOutboxMessageId,
  type BoardState,
  type BoardTask,
  type CommandActor,
  type TaskId
} from "@jina/board";
import {
  BoardContextPublicationError,
  BoardPageIndexAttachmentError,
  ContextCatalogService,
  MemoryContextEngineStore,
  derivationDetailLevels,
  derivationProgressDocumentPath,
  isDerivationDetail,
  contextBoardTaskTypeDefinitions,
  contextBoardTaskTypes,
  contextBoardTopics,
  contextArtifactKinds,
  contextArtifactKey,
  contextArtifactScopePrefix,
  boardPageIndexAttachmentInputDigest,
  assertContextPriorReleaseMatches,
  isContextArtifactKeyInScope,
  parseCertifiedContextReleaseArtifact,
  parseContextPriorReleaseSeed,
  parseContextBoardTaskResult,
  parseBoardPageIndexTreeArtifact,
  isContextBoardTaskType,
  MAX_CONTEXT_OPERATOR_REMEDIATION_PASS,
  resumeContextGateExhaustion,
  resumeContextPageExhaustion,
  newId,
  type ApiTokenRecord,
  type ContextArtifactStore,
  type ContextArtifactRef,
  type ContextArtifactKind,
  type ContextEngineStore,
  type BoardContextPublicationTransactionPort,
  type BoardContextReleaseSeedPort,
  type BoardPageIndexAttachmentTransactionPort,
  type VerifiedApiToken
} from "@jina/context-engine";
import type { GitHubWebhookEvent, ParsedGitHubWebhook } from "@jina/github";
import { isContextTrigger } from "@jina/github";
import {
  createLogger,
  errorLogFields,
  MetricsRegistry,
  recordHttpRequest,
  requestTraceContext,
  type Logger
} from "@jina/observability";
import { prReviewTaskTypeDependencies, prReviewTaskTypeTriggers } from "@jina/review";
import { entityId, nowIso, type IsoTimestamp } from "@jina/shared-kernel";
import { createGitHubIntakeState, ingestGitHubWebhook, type GitHubIntakeState } from "./github-intake.js";
import { admitContextBoardBuild } from "./context-board-admission.js";
import {
  applyContextBoardTaskResult,
  finalizeContextBoardTaskResult,
  type ContextBoardPostCompletion
} from "./context-board-runtime.js";
import { ContextBoardPublicationService } from "./context-board-publication.js";
import {
  ContextQuotaExceededError,
  ContextQuotaInvariantError,
  DEFAULT_CONTEXT_QUOTA_LIMITS,
  type ContextQuotaService
} from "./context-quotas.js";
import { handleContextMcpRequest } from "./mcp.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";
import { buildTaskTypeCatalog } from "./task-type-catalog.js";

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const MAX_CONTEXT_BOARD_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_CONTEXT_QUERY_REQUEST_BYTES = 128 * 1024;
const MAX_CONTEXT_OPERATOR_RETRY_TASKS = 25;
const WORKER_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_CONTEXT_WORKER_LEASE_MS = 75 * 60 * 1000;
const DEFAULT_CONTEXT_BOARD_MAX_ATTEMPTS = BOARD_TASK_HARD_MAX_ATTEMPTS;
const RUN_ACTOR: CommandActor = { type: "run", id: "worker" };
const WORKER_TOPICS = ["run-review", ...Object.values(contextBoardTopics)] as const;
const CONTEXT_BOARD_TOPICS = new Set<string>(Object.values(contextBoardTopics));
const CONTEXT_MODEL_TOPICS = new Set<string>([
  contextBoardTopics.researchPlan,
  contextBoardTopics.research,
  contextBoardTopics.publicationPlan,
  contextBoardTopics.pageWrite,
  contextBoardTopics.pageAudit,
  contextBoardTopics.pageRepair,
  contextBoardTopics.sourceChallenge,
  contextBoardTopics.taskEvaluation,
  contextBoardTopics.gapRepair
]);
const RETRYABLE_WORKER_FAILURE_CATEGORIES = new Set([
  "api_transport",
  "daytona",
  "github_rate_limit",
  "github_response",
  "github_timeout",
  "model"
]);
const RUNTIME_CONTEXT_TASK_TYPE_DEFINITIONS = contextBoardTaskTypeDefinitions;

export interface ApiServerConfig {
  readonly githubWebhookSecret?: string;
  readonly tenantId?: string;
  readonly tenantAliases?: readonly string[];
  readonly enableDevEndpoints?: boolean;
  /**
   * Allows unauthenticated development requests to derive identity from
   * x-jina-* headers. Defaults to true only when dev endpoints are enabled.
   * Set false to expose unsigned dev webhooks while keeping normal auth.
   */
  readonly trustDevIdentityHeaders?: boolean;
  readonly simulateRuns?: boolean;
  readonly stateStore?: ApiStateStore;
  readonly contextStore?: ContextEngineStore;
  readonly sharedIdentityResolver?: SharedIdentityResolver;
  readonly internalApiToken?: string;
  /**
   * Production-only generation fence. When enabled, every worker lease
   * mutation must carry the exact release credential and Cloud Run revision
   * selected in jina_runtime.release_control.
   */
  readonly requireWorkerReleaseGate?: boolean;
  /** Audit actor bound to the internal credential; never taken from request headers. */
  readonly internalApiPrincipalId?: string;
  readonly contextApiToken?: string;
  readonly contextApiTenantId?: string;
  readonly contextApiPrincipalId?: string;
  readonly tenantAdminPrincipalIds?: readonly string[];
  readonly mcpAllowedOrigins?: readonly string[];
  readonly contextWorkerLeaseMs?: number;
  readonly contextBoardMaxAttempts?: number;
  readonly contextArtifactStore?: ContextArtifactStore;
  readonly contextBoardPublicationTransaction?: BoardContextPublicationTransactionPort;
  readonly contextBoardReleaseSeedStore?: BoardContextReleaseSeedPort;
  readonly contextBoardPageIndexAttachmentTransaction?: BoardPageIndexAttachmentTransactionPort;
  readonly contextQuotaService?: ContextQuotaService;
  /** Test/embedding override. Production uses the structured service logger. */
  readonly logger?: Logger;
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
    deliveryId?: string,
    workerRelease?: WorkerReleaseGuard
  ): Promise<{ readonly committed: boolean; readonly result?: T }>;
  close(): Promise<void>;
}

export interface WorkerReleaseGuard {
  readonly releaseId: string;
  readonly credentialSha256: string;
  readonly service: "jina-context-worker" | "jina-task-worker";
  readonly revision: string;
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
// Floor: below this no run reaches a first document. Ceiling: the sandbox
// enforces the same two hours, and the worker lease must outlast it.
const MIN_DERIVATION_BUDGET_SECONDS = 300;
// The retained Jina cold run demonstrated that a repository-sized Board build
// needs a three-hour operational envelope. Production acceptance uses the same
// ceiling; keeping the API at the old two-hour limit would reject the
// coordinated deployment gate before any work was admitted.
const MAX_DERIVATION_BUDGET_SECONDS = 3 * 60 * 60;
const DEFAULT_DERIVATION_BUDGET_SECONDS = MAX_DERIVATION_BUDGET_SECONDS;
const MIN_DERIVATION_TOKEN_BUDGET = DEFAULT_CONTEXT_QUOTA_LIMITS.defaultModelTaskReservationTokens;
const MAX_DERIVATION_TOKEN_BUDGET = 50_000_000;
// Cold repository initialization includes research, document generation, and
// independent citation repair. Retain enough headroom for certification and
// atomic publication after the model-heavy page stages finish. Incremental
// builds reuse the published catalog and normally consume substantially less.
const DEFAULT_DERIVATION_TOKEN_BUDGET = 24_000_000;
// Repository research stages regularly use 0.5M-1M tokens. The quota service
// keeps its smaller global reservation for concurrency accounting, while the
// per-build guard uses this observed upper estimate so parallel claims cannot
// silently consume the publication tail.
const DEFAULT_CONTEXT_BUILD_TASK_RESERVATION_TOKENS = 1_000_000;
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
  const contextBoardMaxAttempts =
    config.contextBoardMaxAttempts ??
    (process.env.CONTEXT_BOARD_MAX_ATTEMPTS?.trim()
      ? Number(process.env.CONTEXT_BOARD_MAX_ATTEMPTS)
      : DEFAULT_CONTEXT_BOARD_MAX_ATTEMPTS);
  if (
    !Number.isSafeInteger(contextBoardMaxAttempts) ||
    contextBoardMaxAttempts < 1 ||
    contextBoardMaxAttempts > BOARD_TASK_HARD_MAX_ATTEMPTS
  ) {
    throw new Error(`contextBoardMaxAttempts must be between 1 and ${BOARD_TASK_HARD_MAX_ATTEMPTS}`);
  }
  // A static secret shaped like an issued token would be shadowed by the token
  // branch and could never authenticate, taking the deployment offline. Refuse at
  // construction rather than at the first request.
  for (const staticToken of [config.internalApiToken, config.contextApiToken]) {
    if (staticToken?.startsWith("jina_atk_")) {
      throw new Error("static API tokens must not use the jina_atk_ prefix reserved for issued tokens");
    }
  }
  if (config.internalApiToken && config.contextApiToken && config.internalApiToken === config.contextApiToken) {
    throw new Error("internal and Context API tokens must be distinct");
  }
  if (config.internalApiPrincipalId && !normalizedForwardedPrincipal(config.internalApiPrincipalId)) {
    throw new Error("internalApiPrincipalId must be a recognisable user, tenant or service principal");
  }
  if (config.requireWorkerReleaseGate && !config.stateStore) {
    throw new Error("requireWorkerReleaseGate requires a durable stateStore");
  }
  const logger = config.logger ?? createLogger({ service: process.env.K_SERVICE ?? "jina-api" });
  const metrics = new MetricsRegistry();
  const startedAt = nowIso();
  const contextStore: ContextEngineStore = config.contextStore ?? new MemoryContextEngineStore();
  const contextCatalog = new ContextCatalogService(contextStore);
  const contextBoardPublisher =
    config.contextArtifactStore && config.contextBoardPublicationTransaction
      ? new ContextBoardPublicationService(
          config.contextArtifactStore,
          config.contextBoardPublicationTransaction,
          config.contextQuotaService
        )
      : undefined;

  async function verifyApiToken(token: string, expectedTenantId?: string): Promise<Principal | undefined> {
    if (!contextStore.verifyApiToken) return undefined;
    const secretHash = createHash("sha256").update(token, "utf8").digest("hex");
    let verified: VerifiedApiToken | undefined;
    try {
      verified = await contextStore.verifyApiToken(secretHash, expectedTenantId);
    } catch (error: unknown) {
      // Fail closed. A throw here is a database or role problem, not a credential
      // problem, and 401 is the only answer that cannot accidentally admit
      // anybody. Without this the rejection escapes into the request's catch and
      // the caller gets a 500.
      // The token store receives a bearer-derived hash. A driver or adapter is
      // allowed to include bind values in its error text, so this boundary must
      // not forward the exception message/stack to durable logs.
      logger.warn("api token verification failed", {
        event: "api.token.verify_failed",
        errorName: error instanceof Error ? error.name : "UnknownError"
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
   * Issued credentials are mutable authorization state. A long Context read
   * must not keep the authority captured at request admission after its token
   * is revoked. Re-read the exact bearer after the expensive retrieval and
   * immediately before its result leaves the API process.
   *
   * Static deployment credentials are intentionally excluded: they are config
   * state and cannot be revoked through the token repository.
   */
  async function resultAfterCredentialRevalidation<T>(
    request: IncomingMessage,
    principal: Principal,
    operation: () => Promise<T>
  ): Promise<T> {
    const result = await operation();
    if (!principal.tokenId) return result;
    const authorization = firstHeader(request.headers.authorization);
    const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const current =
      presented && API_TOKEN_PATTERN.test(presented) ? await verifyApiToken(presented, principal.tenantId) : undefined;
    if (
      !current ||
      current.tokenId !== principal.tokenId ||
      current.tenantId !== principal.tenantId ||
      current.principalId !== principal.principalId ||
      !assertedIdentity(request, config, current)
    ) {
      throw new ApiError(401, "unauthorized", "unauthorized");
    }
    return result;
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
  }

  function restore(snapshot: ApiSnapshot): void {
    const current = sanitizeSnapshotForCurrentRuntime(snapshot);
    intakeState = current.intakeState;
    devDeliverySequence = current.devDeliverySequence;
  }

  function snapshot(): ApiSnapshot {
    return { intakeState, devDeliverySequence };
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

  function mutate<T>(
    operation: () => Promise<T>,
    deliveryId?: string,
    workerRelease?: WorkerReleaseGuard
  ): Promise<T | undefined> {
    const result = mutations.then(async () => {
      if (!config.stateStore) {
        const value = await operation();
        await persist(deliveryId);
        return value;
      }
      let updated: { readonly committed: boolean; readonly result?: T };
      try {
        updated = await config.stateStore.update(
          async (stored) => {
            if (isApiSnapshot(stored)) restore(stored);
            const value = await operation();
            return { state: snapshot(), result: value };
          },
          deliveryId,
          workerRelease
        );
      } catch (error) {
        if (error instanceof Error && error.name === "WorkerReleaseRejectedError") {
          throw new ApiError(409, "worker_release_rejected", "worker release identity is not active");
        }
        throw error;
      }
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
          [...taskTypeDefinitions, ...RUNTIME_CONTEXT_TASK_TYPE_DEFINITIONS],
          prReviewTaskTypeDependencies,
          prReviewTaskTypeTriggers
        )
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      await acceptSignedWebhook(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/context/webhooks/github") {
      await acceptSignedContextWebhook(request, response);
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
      const allowed =
        request.method === "POST" && url.pathname === "/mcp"
          ? principal.scopes.includes("context:query") || principal.scopes.includes("context:read")
          : required !== "internal-only" && principal.scopes.includes(required);
      if (!allowed) {
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
    if (request.method === "POST" && url.pathname === "/internal/context/review-access") {
      await mintReviewAccess(request, response);
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
      await config.contextQuotaService?.admitQuery({
        tenantId: principal.tenantId,
        requestId: quotaRequestId(request)
      });
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
        {
          search: async (input) => {
            requireIssuedTokenScope(principal, "context:query");
            const repository = requiredRepositoryName(input.repository, "repository");
            await requireRepositoryAccess(principal, repository);
            return resultAfterCredentialRevalidation(request, principal, () =>
              catalogCall(() =>
                deterministicContextSearch({
                  ...catalogAccess(principal, repository),
                  query: input.query,
                  ...(input.ref ? { ref: input.ref } : {}),
                  ...(input.releaseId ? { releaseId: input.releaseId } : {}),
                  ...(input.limit ? { limit: input.limit } : {})
                })
              )
            );
          },
          list: async (input) => {
            requireIssuedTokenScope(principal, "context:read");
            const repository = requiredRepositoryName(input.repository, "repository");
            await requireRepositoryAccess(principal, repository);
            return resultAfterCredentialRevalidation(request, principal, () =>
              catalogCall(() =>
                contextCatalog.listContext({
                  ...catalogAccess(principal, repository),
                  ...(input.ref ? { ref: input.ref } : {}),
                  ...(input.releaseId ? { releaseId: input.releaseId } : {})
                })
              )
            );
          },
          read: async (input) => {
            requireIssuedTokenScope(principal, "context:read");
            const repository = requiredRepositoryName(input.repository, "repository");
            await requireRepositoryAccess(principal, repository);
            return resultAfterCredentialRevalidation(request, principal, () =>
              catalogCall(() =>
                contextCatalog.readContext({
                  ...catalogAccess(principal, repository),
                  document: input.document,
                  ...(input.ref ? { ref: input.ref } : {}),
                  ...(input.releaseId ? { releaseId: input.releaseId } : {})
                })
              )
            );
          },
          diff: async (input) => {
            requireIssuedTokenScope(principal, "context:read");
            const repository = requiredRepositoryName(input.repository, "repository");
            await requireRepositoryAccess(principal, repository);
            return resultAfterCredentialRevalidation(request, principal, () =>
              catalogCall(() =>
                contextCatalog.diffContext({
                  ...catalogAccess(principal, repository),
                  fromReleaseId: input.fromReleaseId,
                  toReleaseId: input.toReleaseId
                })
              )
            );
          }
        },
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
      // The wall clock the whole derive stage may use. A release passes a small
      // one so a slow repository cannot hold up a deploy, and an ordinary build
      // can ask for the ceiling.
      const derivationBudgetSeconds =
        body.derivationBudgetSeconds === undefined
          ? DEFAULT_DERIVATION_BUDGET_SECONDS
          : requiredPositiveInteger(body.derivationBudgetSeconds, "derivationBudgetSeconds");
      if (
        derivationBudgetSeconds !== undefined &&
        (derivationBudgetSeconds < MIN_DERIVATION_BUDGET_SECONDS ||
          derivationBudgetSeconds > MAX_DERIVATION_BUDGET_SECONDS)
      ) {
        throw invalidRequest(
          `derivationBudgetSeconds must be between ${MIN_DERIVATION_BUDGET_SECONDS} and ${MAX_DERIVATION_BUDGET_SECONDS}`
        );
      }
      const derivationTokenBudget =
        body.derivationTokenBudget === undefined
          ? DEFAULT_DERIVATION_TOKEN_BUDGET
          : requiredPositiveInteger(body.derivationTokenBudget, "derivationTokenBudget");
      if (derivationTokenBudget < MIN_DERIVATION_TOKEN_BUDGET || derivationTokenBudget > MAX_DERIVATION_TOKEN_BUDGET) {
        throw invalidRequest(
          `derivationTokenBudget must be between ${MIN_DERIVATION_TOKEN_BUDGET} and ${MAX_DERIVATION_TOKEN_BUDGET}`
        );
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
      const buildRepository = identity?.repository ?? repository;
      const buildRef = optionalString(body.ref) ?? identity?.defaultBranch ?? "main";
      let newlyReservedBuildId: string | undefined;
      const admitted = await mutate(async () => {
        await reconcileActiveContextBuildQuotas(config.contextQuotaService, intakeState.board, principal.tenantId);
        const priorRelease = await config.contextBoardReleaseSeedStore?.findCurrentReleaseSeed({
          tenantId: principal.tenantId,
          repository: buildRepository,
          ref: buildRef
        });
        const admission = admitContextBoardBuild(intakeState.board, {
          source: "manual",
          tenantId: principal.tenantId,
          repository: buildRepository,
          ref: buildRef,
          ...(priorRelease ? { priorRelease } : {}),
          ...(commitSha ? { commitSha: requiredGitSha(commitSha, "commitSha") } : {}),
          ...(githubInstallationId ? { githubInstallationId } : {}),
          ...(derivationDetail ? { derivationDetail } : {}),
          derivationBudgetSeconds,
          derivationTokenBudget,
          requestKey: optionalString(body.requestKey) ?? randomUUID(),
          now: nowIso()
        });
        if (admission.outcome === "created" && config.contextQuotaService) {
          await config.contextQuotaService.admitBuild({
            tenantId: principal.tenantId,
            buildId: admission.build.buildTaskId
          });
          newlyReservedBuildId = admission.build.buildTaskId;
        }
        intakeState = { ...intakeState, board: admission.state };
        return admission;
      });
      if (!admitted) {
        if (newlyReservedBuildId && config.contextQuotaService) {
          await config.contextQuotaService
            .completeBuild({ tenantId: principal.tenantId, buildId: newlyReservedBuildId })
            .catch(() => undefined);
        }
        throw new ApiError(409, "conflict", "context build admission raced another update");
      }
      if (admitted.outcome === "ignored") throw new Error("manual context build admission was unexpectedly ignored");
      json(response, admitted.outcome === "created" ? 202 : 200, {
        build:
          admitted.outcome === "created"
            ? publicContextBoardBuild(admitted.state, admitted.build.buildTaskId)
            : publicContextBoardBuild(admitted.state, admitted.existingBuildTaskId),
        duplicate: admitted.outcome === "duplicate"
      });
      return;
    }
    const operatorBatchRetryBuildId = contextBuildRetryRoute(url.pathname);
    if (request.method === "POST" && operatorBatchRetryBuildId) {
      requireTenantAdmin(principal);
      const body = parseJsonObject(await readRawBody(request));
      const requestKey = requiredString(body.requestKey, "requestKey");
      if (requestKey.length > 240 || !/^[a-zA-Z0-9._:@/-]+$/.test(requestKey)) {
        throw invalidRequest("requestKey must be at most 240 safe identifier characters");
      }
      const reason = requiredString(body.reason, "reason");
      if (reason.length > 2_000) throw invalidRequest("reason must be at most 2000 characters");
      if (
        !Array.isArray(body.taskIds) ||
        body.taskIds.length === 0 ||
        body.taskIds.length > MAX_CONTEXT_OPERATOR_RETRY_TASKS
      ) {
        throw invalidRequest(`taskIds must contain between 1 and ${MAX_CONTEXT_OPERATOR_RETRY_TASKS} task ids`);
      }
      const taskIds = body.taskIds.map((value, index) => {
        const taskId = requiredString(value, `taskIds[${index}]`);
        if (taskId.length > 512) throw invalidRequest(`taskIds[${index}] must be at most 512 characters`);
        return entityId<"task">(taskId);
      });
      if (new Set(taskIds).size !== taskIds.length) {
        throw invalidRequest("taskIds must not contain duplicates");
      }

      const buildTaskId = entityId<"task">(operatorBatchRetryBuildId) as TaskId;
      const visibleBuild = contextBoardBuildForPrincipal(
        intakeState.board,
        principal.tenantId,
        operatorBatchRetryBuildId
      );
      if (!visibleBuild) throw notFound("build not found");
      const repository = requiredRepositoryName(visibleBuild.metadata.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      const visibleTargets = taskIds.map((taskId) => {
        const target = findTask(intakeState.board, taskId);
        if (!target || target.metadata.contextBuildId !== visibleBuild.id || !isContextBoardTaskType(target.type)) {
          throw notFound("build task not found");
        }
        assertContextOperatorRetrySafety(intakeState.board, visibleBuild, target);
        return target;
      });

      let quotaResumed = false;
      let retried;
      try {
        retried = await mutate(async () => {
          const build = contextBoardBuildForPrincipal(intakeState.board, principal.tenantId, operatorBatchRetryBuildId);
          if (!build) throw notFound("build not found");
          const targets = taskIds.map((taskId) => {
            const target = findTask(intakeState.board, taskId);
            if (!target || target.metadata.contextBuildId !== build.id || !isContextBoardTaskType(target.type)) {
              throw notFound("build task not found");
            }
            assertContextOperatorRetrySafety(intakeState.board, build, target);
            return target;
          });
          const pageTargets = targets.filter((target) => target.type === contextBoardTaskTypes.page);
          const gateTargets = targets.filter((target) => target.type === contextBoardTaskTypes.certification);
          if (pageTargets.length > 0 && pageTargets.length !== targets.length) {
            throw new OperatorRetryRejectedError(
              "unsafe_graph_state",
              "page-quality remediation cannot be combined with dispatchable task retry"
            );
          }
          if (pageTargets.length > 1) {
            throw new OperatorRetryRejectedError(
              "unsafe_graph_state",
              "page-quality remediations must be resumed one failed page at a time"
            );
          }
          if (gateTargets.length > 0 && gateTargets.length !== targets.length) {
            throw new OperatorRetryRejectedError(
              "unsafe_graph_state",
              "gate-quality remediation cannot be combined with another retry"
            );
          }
          if (gateTargets.length > 1) {
            throw new OperatorRetryRejectedError(
              "unsafe_graph_state",
              "gate-quality remediation requires exactly one certification target"
            );
          }
          const result =
            pageTargets.length === 1
              ? (() => {
                  const page = pageTargets[0]!;
                  const recovered = resumeContextPageExhaustion(intakeState.board, {
                    buildTaskId,
                    pageTaskId: page.id,
                    requestKey,
                    actorId: principal.principalId,
                    reason,
                    now: nowIso()
                  });
                  const recoveryTaskIds = new Set([recovered.repairTaskId, recovered.auditTaskId]);
                  return {
                    state: recovered.state,
                    replay: recovered.replay,
                    reopenedTaskIds: recovered.reopenedTaskIds,
                    nextMessages: recovered.state.outbox.filter(
                      (message) => recoveryTaskIds.has(message.taskId) && message.status === "pending"
                    )
                  };
                })()
              : gateTargets.length === 1
                ? (() => {
                    const recovered = resumeContextGateExhaustion(intakeState.board, {
                      buildTaskId,
                      requestKey,
                      actorId: principal.principalId,
                      reason,
                      now: nowIso()
                    });
                    const recoveryTaskIds = new Set([
                      ...recovered.reopenedTaskIds,
                      recovered.repairTaskId,
                      recovered.sourceChallengeTaskId,
                      recovered.taskEvaluationTaskId
                    ]);
                    return {
                      state: recovered.state,
                      replay: recovered.replay,
                      reopenedTaskIds: recovered.reopenedTaskIds,
                      nextMessages: recovered.state.outbox.filter(
                        (message) => recoveryTaskIds.has(message.taskId) && message.status === "pending"
                      )
                    };
                  })()
                : retryFailedBoardTasks(intakeState.board, {
                    buildTaskId,
                    taskIds: targets.map((target) => target.id),
                    requestKey,
                    actorId: principal.principalId,
                    reason,
                    now: nowIso()
                  });
          if (!result.replay && config.contextQuotaService) {
            const quota = await config.contextQuotaService.resumeBuild({
              tenantId: principal.tenantId,
              buildId: build.id
            });
            quotaResumed = quota.outcome === "admitted";
          }
          intakeState = { ...intakeState, board: result.state };
          return result;
        });
      } catch (error) {
        if (quotaResumed && config.contextQuotaService) {
          await config.contextQuotaService
            .completeBuild({ tenantId: principal.tenantId, buildId: visibleBuild.id })
            .catch(() => undefined);
        }
        if (error instanceof OperatorRetryRejectedError) {
          throw new ApiError(409, "operator_retry_rejected", error.message);
        }
        throw error;
      }
      if (!retried) {
        if (quotaResumed && config.contextQuotaService) {
          await config.contextQuotaService
            .completeBuild({ tenantId: principal.tenantId, buildId: visibleBuild.id })
            .catch(() => undefined);
        }
        throw new ApiError(409, "conflict", "operator retry raced another update");
      }
      if (config.contextQuotaService) {
        await settleTerminalReconciledModelQuotas(
          config.contextQuotaService,
          intakeState.board,
          principal.tenantId,
          visibleBuild.id
        );
      }
      json(response, retried.replay ? 200 : 202, {
        accepted: true,
        duplicate: retried.replay,
        buildId: visibleBuild.id,
        taskIds: visibleTargets.map((target) => target.id),
        tasks: retried.nextMessages.map((message) => ({
          taskId: message.taskId,
          attempt: message.payload.attempt,
          outboxMessageId: message.id
        })),
        reopenedTaskIds: retried.reopenedTaskIds
      });
      return;
    }
    const operatorRetryRoute = contextTaskRetryRoute(url.pathname);
    if (request.method === "POST" && operatorRetryRoute) {
      requireTenantAdmin(principal);
      const body = parseJsonObject(await readRawBody(request));
      const requestKey = requiredString(body.requestKey, "requestKey");
      if (requestKey.length > 240 || !/^[a-zA-Z0-9._:@/-]+$/.test(requestKey)) {
        throw invalidRequest("requestKey must be at most 240 safe identifier characters");
      }
      const reason = requiredString(body.reason, "reason");
      if (reason.length > 2_000) throw invalidRequest("reason must be at most 2000 characters");

      const buildTaskId = entityId<"task">(operatorRetryRoute.buildId) as TaskId;
      const boardTaskId = entityId<"task">(operatorRetryRoute.taskId) as TaskId;
      const visibleBuild = contextBoardBuildForPrincipal(
        intakeState.board,
        principal.tenantId,
        operatorRetryRoute.buildId
      );
      if (!visibleBuild) throw notFound("build not found");
      const repository = requiredRepositoryName(visibleBuild.metadata.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      const visibleTarget = findTask(intakeState.board, boardTaskId);
      if (
        !visibleTarget ||
        visibleTarget.metadata.contextBuildId !== visibleBuild.id ||
        !isContextBoardTaskType(visibleTarget.type)
      ) {
        throw notFound("build task not found");
      }
      assertContextOperatorRetrySafety(intakeState.board, visibleBuild, visibleTarget);

      let quotaResumed = false;
      let retried;
      try {
        retried = await mutate(async () => {
          const build = contextBoardBuildForPrincipal(
            intakeState.board,
            principal.tenantId,
            operatorRetryRoute.buildId
          );
          const target = findTask(intakeState.board, boardTaskId);
          if (
            !build ||
            !target ||
            target.metadata.contextBuildId !== build.id ||
            !isContextBoardTaskType(target.type)
          ) {
            throw notFound("build task not found");
          }
          assertContextOperatorRetrySafety(intakeState.board, build, target);
          const result = retryFailedBoardTask(intakeState.board, {
            buildTaskId,
            taskId: boardTaskId,
            requestKey,
            actorId: principal.principalId,
            reason,
            now: nowIso()
          });
          if (!result.replay && config.contextQuotaService) {
            const quota = await config.contextQuotaService.resumeBuild({
              tenantId: principal.tenantId,
              buildId: build.id
            });
            quotaResumed = quota.outcome === "admitted";
          }
          intakeState = { ...intakeState, board: result.state };
          return result;
        });
      } catch (error) {
        if (quotaResumed && config.contextQuotaService) {
          await config.contextQuotaService
            .completeBuild({ tenantId: principal.tenantId, buildId: visibleBuild.id })
            .catch(() => undefined);
        }
        if (error instanceof OperatorRetryRejectedError) {
          throw new ApiError(409, "operator_retry_rejected", error.message);
        }
        throw error;
      }
      if (!retried) {
        if (quotaResumed && config.contextQuotaService) {
          await config.contextQuotaService
            .completeBuild({ tenantId: principal.tenantId, buildId: visibleBuild.id })
            .catch(() => undefined);
        }
        throw new ApiError(409, "conflict", "operator retry raced another update");
      }
      if (config.contextQuotaService) {
        await settleTerminalReconciledModelQuotas(
          config.contextQuotaService,
          intakeState.board,
          principal.tenantId,
          visibleBuild.id
        );
      }
      json(response, retried.replay ? 200 : 202, {
        accepted: true,
        duplicate: retried.replay,
        buildId: visibleBuild.id,
        taskId: visibleTarget.id,
        attempt: retried.nextMessage.payload.attempt,
        outboxMessageId: retried.nextMessage.id,
        reopenedTaskIds: retried.reopenedTaskIds
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/context/search") {
      await config.contextQuotaService?.admitQuery({
        tenantId: principal.tenantId,
        requestId: quotaRequestId(request)
      });
      const body = parseJsonObject(await readRawBody(request, MAX_CONTEXT_QUERY_REQUEST_BYTES));
      const repository = requiredRepositoryName(body.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      const query = requiredString(body.query, "query");
      if (query.length > 4_000) throw invalidRequest("query must be at most 4000 characters");
      const limit = body.limit === undefined ? undefined : requiredPositiveInteger(body.limit, "limit");
      if (limit !== undefined && limit > 25) throw invalidRequest("limit must be at most 25");
      const result = await resultAfterCredentialRevalidation(request, principal, () =>
        catalogCall(() =>
          deterministicContextSearch({
            ...catalogAccess(principal, repository),
            query,
            ...(optionalString(body.ref) ? { ref: optionalString(body.ref)! } : {}),
            ...(optionalString(body.releaseId) ? { releaseId: optionalString(body.releaseId)! } : {}),
            ...(limit ? { limit } : {})
          })
        )
      );
      json(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/releases") {
      await config.contextQuotaService?.admitQuery({
        tenantId: principal.tenantId,
        requestId: quotaRequestId(request)
      });
      const requestedRepository = optionalQuery(url, "repository");
      const repositories = requestedRepository
        ? [requiredRepositoryName(requestedRepository, "repository")]
        : await permittedRepositories(principal);
      if (requestedRepository) await requireRepositoryAccess(principal, repositories[0]!);
      const releases = await resultAfterCredentialRevalidation(request, principal, async () => ({
        // Each catalog preserves its authoritative current pointer before
        // historical releases. A global timestamp sort would undo that after
        // an intentional rollback to an older certified release.
        releases: (
          await Promise.all(
            repositories.map((repository) => contextCatalog.listReleases(catalogAccess(principal, repository)))
          )
        ).flat()
      }));
      json(response, 200, releases);
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/list") {
      await config.contextQuotaService?.admitQuery({
        tenantId: principal.tenantId,
        requestId: quotaRequestId(request)
      });
      const repository = requiredRepositoryName(url.searchParams.get("repository"), "repository");
      await requireRepositoryAccess(principal, repository);
      const result = await resultAfterCredentialRevalidation(request, principal, () =>
        catalogCall(() =>
          contextCatalog.listContext({
            ...catalogAccess(principal, repository),
            ...(optionalQuery(url, "ref") ? { ref: optionalQuery(url, "ref")! } : {}),
            ...(optionalQuery(url, "releaseId") ? { releaseId: optionalQuery(url, "releaseId")! } : {})
          })
        )
      );
      json(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/read") {
      await config.contextQuotaService?.admitQuery({
        tenantId: principal.tenantId,
        requestId: quotaRequestId(request)
      });
      const repository = requiredRepositoryName(url.searchParams.get("repository"), "repository");
      await requireRepositoryAccess(principal, repository);
      const document = requiredString(url.searchParams.get("document"), "document");
      const result = await resultAfterCredentialRevalidation(request, principal, () =>
        catalogCall(() =>
          contextCatalog.readContext({
            ...catalogAccess(principal, repository),
            document,
            ...(optionalQuery(url, "ref") ? { ref: optionalQuery(url, "ref")! } : {}),
            ...(optionalQuery(url, "releaseId") ? { releaseId: optionalQuery(url, "releaseId")! } : {})
          })
        )
      );
      json(response, 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/context/diff") {
      await config.contextQuotaService?.admitQuery({
        tenantId: principal.tenantId,
        requestId: quotaRequestId(request)
      });
      const repository = requiredRepositoryName(url.searchParams.get("repository"), "repository");
      await requireRepositoryAccess(principal, repository);
      const fromReleaseId = requiredString(url.searchParams.get("fromReleaseId"), "fromReleaseId");
      const toReleaseId = requiredString(url.searchParams.get("toReleaseId"), "toReleaseId");
      const result = await resultAfterCredentialRevalidation(request, principal, () =>
        catalogCall(() =>
          contextCatalog.diffContext({
            ...catalogAccess(principal, repository),
            fromReleaseId,
            toReleaseId
          })
        )
      );
      json(response, 200, result);
      return;
    }
    // Builds in flight, so a page can find one to watch. Progress was only
    // reachable by id, which meant a build was watchable only by whoever had
    // just started it -- a webhook build, or one started from another tab, was
    // invisible while it ran.
    if (request.method === "GET" && url.pathname === "/context/builds") {
      await reload();
      const allowed = isTenantAdmin(principal) ? undefined : new Set(await permittedRepositories(principal));
      const activeOnly = url.searchParams.get("status") === "active";
      const builds = intakeState.board.tasks
        .filter(
          (task) =>
            task.type === contextBoardTaskTypes.build &&
            task.metadata.tenantId === principal.tenantId &&
            typeof task.metadata.repository === "string" &&
            (!allowed || allowed.has(task.metadata.repository))
        )
        .filter((task) => !activeOnly || !isTerminalTaskStatus(task.status))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
        .slice(0, 50)
        .map((task) => ({
          ...publicContextBoardBuild(intakeState.board, task.id),
          status: publicContextBuildStatus(task.status),
          stages: publicContextBoardStages(intakeState.board, task.id)
        }));
      json(response, 200, { builds });
      return;
    }

    // One page's text before the build that wrote it has committed. Kept out of
    // the listing, which is polled every few seconds, and fetched for a page
    // somebody has actually opened.
    if (request.method === "GET" && url.pathname.startsWith("/context/builds/") && url.pathname.endsWith("/page")) {
      const buildId = url.pathname.slice("/context/builds/".length, -"/page".length);
      const documentPath = requiredDerivationProgressDocumentPath(url.searchParams.get("path"), "path");
      if (!buildId) throw invalidRequest("build id is required");
      await reload();
      const build = contextBoardBuildForPrincipal(intakeState.board, principal.tenantId, buildId);
      if (!build) throw notFound("build not found");
      const repository = requiredRepositoryName(build.metadata.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      const page = await readContextBoardCheckpointPage(
        intakeState.board,
        build,
        documentPath,
        config.contextArtifactStore
      );
      if (!page) throw notFound("page not found");
      json(response, 200, { page });
      return;
    }

    // What a build has written so far. Readable with the same scope as the
    // finished catalog, because watching a build is a read of the tenant's own
    // context rather than an administrative action.
    if (request.method === "GET" && url.pathname.startsWith("/context/builds/") && url.pathname.endsWith("/progress")) {
      const buildId = url.pathname.slice("/context/builds/".length, -"/progress".length);
      if (!buildId) throw notFound("build not found");
      await reload();
      const build = contextBoardBuildForPrincipal(intakeState.board, principal.tenantId, buildId);
      // A build id is opaque, so a miss and another tenant's build have to look
      // the same from here.
      if (!build) throw notFound("build not found");
      const repository = requiredRepositoryName(build.metadata.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      json(response, 200, {
        buildId,
        repository,
        ref: requiredString(build.metadata.ref, "build ref"),
        status: publicContextBuildStatus(build.status),
        ...(typeof build.metadata.derivationBudgetSeconds === "number"
          ? {
              derivationBudgetSeconds: build.metadata.derivationBudgetSeconds,
              derivationDeadlineAt: contextBuildDeadlineAt(build)
            }
          : {}),
        ...(typeof build.metadata.derivationTokenBudget === "number"
          ? {
              derivationTokenBudget: build.metadata.derivationTokenBudget,
              consumedModelTokens: contextBuildConsumedModelTokens(intakeState.board, build.id),
              activeModelReservedTokens: contextBuildActiveModelReservations(intakeState.board, build.id),
              remainingModelTokens: Math.max(
                0,
                build.metadata.derivationTokenBudget - contextBuildConsumedModelTokens(intakeState.board, build.id)
              )
            }
          : {}),
        ...publicContextBuildFailure(intakeState.board, build),
        stages: publicContextBoardStages(intakeState.board, build.id),
        pages: publicContextBoardCheckpointPages(intakeState.board, build.id),
        ...(isTenantAdmin(principal)
          ? {
              retryEligibility: contextBoardOperatorRetryEligibility(intakeState.board, build, nowIso())
            }
          : {}),
        updatedAt: build.updatedAt
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/context/metrics") {
      requireTenantAdmin(principal);
      json(response, 200, await contextMetrics(principal.tenantId));
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
        events: intakeState.board.events
          .filter((event) => !event.taskId || board.tasks.some((task) => task.id === event.taskId))
          .map((event) => publicBoardEvent(intakeState.board, event))
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const board = await boardView(principal);
      jsonCacheable(
        request,
        response,
        intakeState.board.events
          .filter((event) => !event.taskId || board.tasks.some((task) => task.id === event.taskId))
          .map((event) => publicBoardEvent(intakeState.board, event))
      );
      return;
    }

    const workerCompletionsBuildId = routeId(url.pathname, "/internal/context/builds/", "/worker-completions");
    if (request.method === "GET" && workerCompletionsBuildId) {
      // Internal reads are not covered by the generic public-read reload path.
      // Refresh here so a release gate on another API instance observes the
      // completion receipts committed by the worker-facing instance.
      await reload();
      const build = contextBoardBuildForPrincipal(intakeState.board, principal.tenantId, workerCompletionsBuildId);
      if (!build) throw notFound("build not found");
      const repository = requiredRepositoryName(build.metadata.repository, "repository");
      await requireRepositoryAccess(principal, repository);
      json(response, 200, contextWorkerCompletionAttestation(intakeState.board, build));
      return;
    }

    const cancelContextBuildId = routeId(url.pathname, "/internal/context/builds/", "/cancel");
    if (request.method === "POST" && cancelContextBuildId) {
      requireTenantAdmin(principal);
      const body = parseJsonObject(await readRawBody(request));
      const reason = (optionalString(body.reason) ?? "authorized operator cancellation").slice(0, 2_000);
      await reload();
      const visibleBuild = contextBoardBuildForPrincipal(intakeState.board, principal.tenantId, cancelContextBuildId);
      if (!visibleBuild) throw notFound("build not found");
      await requireRepositoryAccess(principal, requiredRepositoryName(visibleBuild.metadata.repository, "repository"));
      const canceled = await mutate(async () => {
        const build = contextBoardBuildForPrincipal(intakeState.board, principal.tenantId, cancelContextBuildId);
        if (!build) return undefined;
        if (isTerminalTaskStatus(build.status)) {
          return { status: build.status, changed: false };
        }
        const at = nowIso();
        intakeState = {
          ...intakeState,
          board: terminateContextBuild(intakeState.board, build, "canceled", "build_canceled", reason, at)
        };
        return { status: "canceled" as const, changed: true };
      });
      if (!canceled) throw new ApiError(409, "conflict", "context build cancellation raced another update");
      if (config.contextQuotaService && isTerminalTaskStatus(canceled.status)) {
        await settleTerminalReconciledModelQuotas(
          config.contextQuotaService,
          intakeState.board,
          principal.tenantId,
          cancelContextBuildId
        );
        await config.contextQuotaService.completeBuild({
          tenantId: principal.tenantId,
          buildId: cancelContextBuildId
        });
      }
      json(response, 200, {
        accepted: true,
        buildId: cancelContextBuildId,
        status: canceled.status,
        canceled: canceled.status === "canceled",
        changed: canceled.changed
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/internal/context/board/artifacts") {
      const body = parseJsonObject(await readRawBody(request, MAX_REQUEST_BYTES));
      const lease = await requireLeasedContextBoardTask(principal.tenantId, body);
      if (!config.contextArtifactStore) throw new Error("context artifact storage is not configured");
      if (!config.contextQuotaService) throw new Error("context artifact quota storage is not configured");
      if (lease.task.type === contextBoardTaskTypes.publication) {
        throw invalidRequest("publication output is created only by the authoritative publish operation");
      }
      const kind = requiredString(body.kind, "kind");
      if (!contextArtifactKinds.includes(kind as ContextArtifactKind)) {
        throw invalidRequest("unsupported context artifact kind");
      }
      const expectedKind = contextBoardArtifactKind(lease.task.type);
      if (kind !== expectedKind) throw invalidRequest(`task output must use artifact kind ${expectedKind}`);
      const name = requiredString(body.name, "name");
      if (!/^[a-z0-9][a-z0-9._-]{0,180}$/.test(name)) throw invalidRequest("artifact name is invalid");
      const contentType = requiredString(body.contentType, "contentType");
      if (contentType !== "application/json") {
        throw invalidRequest("Context Board artifacts must use application/json");
      }
      const content = strictBase64(requiredString(body.contentBase64, "contentBase64"), "contentBase64");
      if (content.byteLength > MAX_CONTEXT_BOARD_ARTIFACT_BYTES) {
        throw new ApiError(413, "payload_too_large", "Context Board artifact is too large");
      }
      const quotaArtifactId = [
        lease.buildTaskId,
        lease.task.id,
        lease.message.payload.attempt,
        expectedKind,
        name
      ].join(":");
      const quotaReservationId = `${quotaArtifactId}:${fingerprintBytes(content)}`;
      await config.contextQuotaService.reserveArtifactStorage({
        tenantId: principal.tenantId,
        reservationId: quotaReservationId,
        artifactId: quotaArtifactId,
        bytes: content.byteLength
      });
      const write = {
        tenantId: principal.tenantId,
        repository: requiredRepositoryName(lease.task.metadata.repository, "repository"),
        buildId: lease.buildTaskId,
        kind: expectedKind,
        name: `${lease.task.id}-attempt-${lease.message.payload.attempt}-${name}`,
        contentType,
        content
      } as const;
      const artifact = await config.contextArtifactStore.put(write);
      if (
        artifact.key !== contextArtifactKey(write) ||
        artifact.contentType !== contentType ||
        artifact.bytes !== content.byteLength ||
        artifact.sha256 !== fingerprintBytes(content) ||
        !artifact.uri.trim()
      ) {
        throw new Error("context artifact store returned a mismatched immutable reference");
      }
      await config.contextQuotaService.commitArtifactStorage({
        tenantId: principal.tenantId,
        reservationId: quotaReservationId,
        artifactId: quotaArtifactId,
        bytes: content.byteLength
      });
      json(response, 201, { artifact });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/board/publish") {
      const body = parseJsonObject(await readRawBody(request, MAX_REQUEST_BYTES));
      const lease = await requireLeasedContextBoardTask(principal.tenantId, body);
      if (lease.task.type !== contextBoardTaskTypes.publication) {
        throw invalidRequest("leased task is not a Context publication");
      }
      if (!contextBoardPublisher) {
        throw new Error("board Context publication is not configured");
      }
      const certificationArtifact = parseContextArtifactRef(body.certificationArtifact);
      assertBoardArtifactScope(lease.task, lease.buildTaskId, certificationArtifact);
      const commitSha = requiredGitSha(lease.task.metadata.commitSha, "publication commitSha");
      const messageId = requiredString(body.messageId, "messageId");
      const result = await contextBoardPublisher.publish({
        scope: {
          tenantId: principal.tenantId,
          repository: requiredRepositoryName(lease.task.metadata.repository, "repository"),
          ref: requiredString(lease.task.metadata.ref, "publication ref"),
          refSequence: requiredPositiveInteger(lease.task.metadata.refSequence, "publication refSequence"),
          commitSha,
          buildId: lease.buildTaskId
        },
        lease: {
          taskId: lease.task.id,
          messageId,
          attempt: lease.message.payload.attempt,
          leaseId: requiredString(body.leaseId, "leaseId"),
          writeFenceToken: requiredString(body.writeFenceToken, "writeFenceToken"),
          leaseExpiresAt: requiredString(lease.message.leaseExpiresAt, "publication leaseExpiresAt")
        },
        certificationArtifact,
        idempotencyKey: `${lease.task.id}:${certificationArtifact.sha256}`,
        publishedAt: lease.task.createdAt
      });
      json(response, 200, {
        version: 1,
        outputArtifact: result.releaseArtifact,
        releaseId: result.releaseId,
        publicSnapshotDigest: result.publicSnapshotDigest,
        publicationInputDigest: result.publicationInputDigest,
        refSequence: result.refSequence,
        commitSha: result.commitSha,
        publishedAt: result.publishedAt
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/board/pageindex/attach") {
      const body = parseJsonObject(await readRawBody(request, MAX_REQUEST_BYTES));
      const lease = await requireLeasedContextBoardTask(principal.tenantId, body);
      if (lease.task.type !== contextBoardTaskTypes.pageIndex) {
        throw invalidRequest("leased task is not a Context PageIndex attachment");
      }
      if (!config.contextArtifactStore || !config.contextBoardPageIndexAttachmentTransaction) {
        throw new Error("board Context PageIndex attachment is not configured");
      }
      const treeArtifactRef = parseContextArtifactRef(body.treeArtifact);
      assertBoardArtifactScope(lease.task, lease.buildTaskId, treeArtifactRef);
      if (treeArtifactRef.contentType !== "application/json") {
        throw invalidRequest("PageIndex tree artifact must be JSON");
      }
      const bytes = await config.contextArtifactStore.get(treeArtifactRef);
      if (bytes.byteLength !== treeArtifactRef.bytes || fingerprintBytes(bytes) !== treeArtifactRef.sha256) {
        throw invalidRequest("PageIndex tree bytes do not match their immutable artifact reference");
      }
      let treeValue: unknown;
      try {
        treeValue = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      } catch {
        throw invalidRequest("PageIndex tree artifact is not valid JSON");
      }
      const treeArtifact = parseBoardPageIndexTreeArtifact(treeValue);
      const releaseId = requiredString(body.releaseId, "releaseId");
      const scope = {
        tenantId: principal.tenantId,
        repository: requiredRepositoryName(lease.task.metadata.repository, "repository"),
        ref: requiredString(lease.task.metadata.ref, "PageIndex ref"),
        refSequence: requiredPositiveInteger(lease.task.metadata.refSequence, "PageIndex refSequence"),
        commitSha: requiredGitSha(lease.task.metadata.commitSha, "PageIndex commitSha"),
        buildId: lease.buildTaskId
      };
      const attachmentInputDigest = boardPageIndexAttachmentInputDigest({
        scope,
        releaseId,
        treeArtifactRef,
        treeDigest: treeArtifact.metrics.treeDigest,
        buildDigest: treeArtifact.metrics.buildDigest
      });
      const result = await config.contextBoardPageIndexAttachmentTransaction.attachPageIndexAtomically({
        scope,
        lease: {
          taskId: lease.task.id,
          messageId: requiredString(body.messageId, "messageId"),
          attempt: lease.message.payload.attempt,
          leaseId: requiredString(body.leaseId, "leaseId"),
          writeFenceToken: requiredString(body.writeFenceToken, "writeFenceToken"),
          leaseExpiresAt: requiredString(lease.message.leaseExpiresAt, "PageIndex leaseExpiresAt")
        },
        releaseId,
        idempotencyKey: `${lease.task.id}:${treeArtifactRef.sha256}`,
        attachmentInputDigest,
        treeArtifactRef,
        treeArtifact,
        attachedAt: lease.task.createdAt
      });
      json(response, 200, { version: 1, outputArtifact: treeArtifactRef, ...result });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context/board/artifacts/read") {
      const body = parseJsonObject(await readRawBody(request));
      const lease = await requireLeasedContextBoardTask(principal.tenantId, body);
      if (!config.contextArtifactStore) throw new Error("context artifact storage is not configured");
      const artifact = parseContextArtifactRef(body.artifact);
      const priorRelease = assertBoardArtifactReadable(lease.task, lease.buildTaskId, artifact);
      const content = await config.contextArtifactStore.get(artifact);
      if (content.byteLength !== artifact.bytes || fingerprintBytes(content) !== artifact.sha256) {
        throw new Error("context artifact bytes do not match their reference");
      }
      if (priorRelease) {
        let releaseValue: unknown;
        try {
          releaseValue = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
        } catch {
          throw invalidRequest("prior Context release artifact is not valid JSON");
        }
        assertContextPriorReleaseMatches(priorRelease, parseCertifiedContextReleaseArtifact(releaseValue));
      }
      json(response, 200, {
        artifact,
        contentBase64: Buffer.from(content).toString("base64")
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
    await acceptSignedGitHubWebhook(request, response, acceptParsedWebhook);
  }

  /**
   * Accept a GitHub delivery relayed by the original Jina API and admit only
   * Context work. The original raw body and signature are verified again here,
   * so the relay gains no authority to manufacture provider events. Unlike the
   * general webhook route this never creates a V2 review task: V1 remains the
   * sole review orchestrator while V2 owns Context derivation.
   */
  async function acceptSignedContextWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await acceptSignedGitHubWebhook(request, response, acceptParsedContextWebhook);
  }

  async function acceptSignedGitHubWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    accept: (
      webhook: ParsedGitHubWebhook,
      deliveryId: string
    ) => Promise<{
      outcome: "created" | "duplicate" | "ignored";
      createdTaskIds: readonly string[];
    }>
  ): Promise<void> {
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
      if (result.webhook && isContextTrigger(result.webhook.event)) {
        await reload();
        const identity = await resolveWebhookIdentity(result.webhook);
        const tenantId = identity?.tenantId ?? config.tenantId ?? "default";
        await reconcileContextQuotas(config.contextQuotaService, intakeState.board, tenantId);
      }
      json(response, 200, { accepted: true, duplicate: true, deliveryId: result.deliveryId });
      return;
    }
    if (!result.webhook) {
      await persist(result.deliveryId);
      json(response, result.statusCode, result);
      return;
    }
    const accepted = await accept(result.webhook, result.deliveryId);
    json(response, result.statusCode, { accepted: true, deliveryId: result.deliveryId, ...accepted });
  }

  async function acceptParsedWebhook(webhook: ParsedGitHubWebhook, deliveryId: string) {
    const identity = await resolveWebhookIdentity(webhook);
    const tenantId = identity?.tenantId ?? config.tenantId ?? "default";
    let newlyReservedBuildId: string | undefined;
    const result = await mutate(async () => {
      const accepted = ingestGitHubWebhook(intakeState, webhook, {
        deliveryId,
        now: nowIso(),
        tenantId,
        ...(identity ? { workspaceLabel: identity.githubAccountLogin, githubAccountId: identity.githubAccountId } : {})
      });
      intakeState = accepted.state;
      const createdTaskIds = [...accepted.createdTaskIds];
      const context = await admitContextWebhook(webhook, deliveryId, tenantId, identity);
      newlyReservedBuildId = context.reservedBuildId;
      createdTaskIds.push(...context.createdTaskIds);
      return {
        outcome:
          createdTaskIds.length > 0
            ? ("created" as const)
            : accepted.outcome === "duplicate" || context.outcome === "duplicate"
              ? ("duplicate" as const)
              : ("ignored" as const),
        createdTaskIds,
        supersededBuildTaskIds: context.supersededBuildTaskIds
      };
    }, deliveryId);
    if (!result && newlyReservedBuildId && config.contextQuotaService) {
      await config.contextQuotaService
        .completeBuild({ tenantId, buildId: newlyReservedBuildId })
        .catch(() => undefined);
    }
    if (result) {
      await settleSupersededContextBuildQuotas(
        config.contextQuotaService,
        intakeState.board,
        tenantId,
        result.supersededBuildTaskIds
      );
      return { outcome: result.outcome, createdTaskIds: result.createdTaskIds };
    }
    return { outcome: "duplicate" as const, createdTaskIds: [] };
  }

  async function acceptParsedContextWebhook(webhook: ParsedGitHubWebhook, deliveryId: string) {
    const identity = await resolveWebhookIdentity(webhook);
    const tenantId = identity?.tenantId ?? config.tenantId ?? "default";
    let newlyReservedBuildId: string | undefined;
    const result = await mutate(async () => {
      const context = await admitContextWebhook(webhook, deliveryId, tenantId, identity);
      newlyReservedBuildId = context.reservedBuildId;
      return {
        outcome: context.outcome,
        createdTaskIds: context.createdTaskIds,
        supersededBuildTaskIds: context.supersededBuildTaskIds
      };
    }, deliveryId);
    if (!result && newlyReservedBuildId && config.contextQuotaService) {
      await config.contextQuotaService
        .completeBuild({ tenantId, buildId: newlyReservedBuildId })
        .catch(() => undefined);
    }
    if (result) {
      await settleSupersededContextBuildQuotas(
        config.contextQuotaService,
        intakeState.board,
        tenantId,
        result.supersededBuildTaskIds
      );
      return { outcome: result.outcome, createdTaskIds: result.createdTaskIds };
    }
    return { outcome: "duplicate" as const, createdTaskIds: [] };
  }

  async function admitContextWebhook(
    webhook: ParsedGitHubWebhook,
    deliveryId: string,
    tenantId: string,
    identity: ResolvedRepositoryIdentity | undefined
  ): Promise<{
    outcome: "created" | "duplicate" | "ignored";
    createdTaskIds: TaskId[];
    supersededBuildTaskIds: readonly TaskId[];
    reservedBuildId?: string;
  }> {
    if (!isContextTrigger(webhook.event)) {
      return { outcome: "ignored", createdTaskIds: [], supersededBuildTaskIds: [] };
    }
    await reconcileContextQuotas(config.contextQuotaService, intakeState.board, tenantId);
    const repository = identity?.repository ?? webhook.repository;
    const ref = contextTriggerRef(webhook.event, identity?.defaultBranch ?? webhook.repositoryDefaultBranch);
    const priorRelease = await config.contextBoardReleaseSeedStore?.findCurrentReleaseSeed({
      tenantId,
      repository,
      ref
    });
    const admission = admitContextBoardBuild(intakeState.board, {
      source: "github",
      tenantId,
      repository,
      ...(priorRelease ? { priorRelease } : {}),
      ...(webhook.installationId ? { githubInstallationId: webhook.installationId } : {}),
      derivationBudgetSeconds: DEFAULT_DERIVATION_BUDGET_SECONDS,
      derivationTokenBudget: DEFAULT_DERIVATION_TOKEN_BUDGET,
      deliveryId,
      event: webhook.event,
      ...((identity?.defaultBranch ?? webhook.repositoryDefaultBranch)
        ? { defaultBranch: identity?.defaultBranch ?? webhook.repositoryDefaultBranch }
        : {}),
      now: nowIso()
    });
    if (admission.outcome !== "created") {
      intakeState = { ...intakeState, board: admission.state };
      return { outcome: admission.outcome, createdTaskIds: [], supersededBuildTaskIds: [] };
    }
    if (config.contextQuotaService) {
      await config.contextQuotaService.admitBuild({
        tenantId,
        buildId: admission.build.buildTaskId,
        replacesBuildIds: admission.supersededBuildTaskIds
      });
    }
    intakeState = { ...intakeState, board: admission.state };
    return {
      outcome: "created",
      createdTaskIds: [admission.build.buildTaskId, admission.build.graphTaskId, admission.build.snapshotTaskId],
      supersededBuildTaskIds: admission.supersededBuildTaskIds,
      ...(config.contextQuotaService ? { reservedBuildId: admission.build.buildTaskId } : {})
    };
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

  function tokenRequestActor(): string {
    return normalizedForwardedPrincipal(config.internalApiPrincipalId) ?? "svc:api";
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
    const requestedScopes = [...new Set(body.scopes.map((scope) => requiredString(scope, "scope")))];
    for (const scope of requestedScopes) {
      if (!isContextScope(scope)) throw invalidRequest(`unsupported scope ${scope}`);
    }
    const scopes = requestedScopes.filter(isContextScope);
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
    const { secret, token } = await storeIssuedApiToken({
      tenantId,
      principalId: principal,
      name,
      scopes,
      expiresInMinutes
    });
    // The only time the secret exists outside the caller's hands. `writeHead`
    // merges headers already set on the response, so this survives `json`.
    response.setHeader("cache-control", "no-store");
    json(response, 201, { secret, token: publicApiToken(token) });
  }

  /**
   * Gives one V1 review run direct, least-privilege access to one repository's
   * published Context. The caller is the trusted V1 API, but the credential
   * handed to its sandbox is a different, short-lived bearer that cannot build,
   * administer, or read a second repository.
   */
  async function mintReviewAccess(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const tenantId = tokenRequestTenantId(request);
    const body = parseJsonObject(await readRawBody(request));
    const reviewRunId = requiredString(body.reviewRunId, "reviewRunId");
    if (reviewRunId.length > 200) throw invalidRequest("reviewRunId must be at most 200 characters");
    const requestedRepository = requiredRepositoryName(body.repository, "repository");
    const identity = config.sharedIdentityResolver
      ? await config.sharedIdentityResolver.resolveRepository({ tenantId, repository: requestedRepository })
      : undefined;
    if (config.sharedIdentityResolver && (!identity || identity.tenantId !== tenantId)) {
      throw notFound("repository context not found");
    }
    const repository = identity?.repository ?? requestedRepository;
    const expiresInMinutes =
      body.expiresInMinutes === undefined ? 180 : requiredPositiveInteger(body.expiresInMinutes, "expiresInMinutes");
    if (expiresInMinutes < MIN_API_TOKEN_MINUTES || expiresInMinutes > 360) {
      throw invalidRequest(`expiresInMinutes must be between ${MIN_API_TOKEN_MINUTES} and 360`);
    }
    const runHash = createHash("sha256")
      .update(`${tenantId}\u0000${repository}\u0000${reviewRunId}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    const principalId = `user:review-${runHash}@runs.jina`;
    await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
    const { secret, token } = await storeIssuedApiToken({
      tenantId,
      principalId,
      name: `V1 review ${reviewRunId.slice(0, 80)}`,
      scopes: CONTEXT_CREDENTIAL_SCOPES,
      expiresInMinutes
    });
    response.setHeader("cache-control", "no-store");
    json(response, 201, {
      repository,
      mcpPath: "/mcp",
      secret,
      token: publicApiToken(token)
    });
  }

  async function storeIssuedApiToken(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly scopes: readonly ContextScope[];
    readonly expiresInMinutes: number;
  }): Promise<{ readonly secret: string; readonly token: ApiTokenRecord }> {
    const store = requireApiTokenStore();
    const secret = `jina_atk_${randomBytes(32).toString("base64url")}`;
    const createdAt = nowIso();
    try {
      const token = await store.mintApiToken({
        id: newId("atk"),
        tenantId: input.tenantId,
        principalId: input.principalId,
        name: input.name,
        secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
        scopes: input.scopes,
        createdAt,
        createdBy: tokenRequestActor(),
        expiresAt: new Date(Date.parse(createdAt) + input.expiresInMinutes * 60_000).toISOString()
      });
      return { secret, token };
    } catch {
      // The store has seen the hash at this point. Replace its exception before
      // the request logger sees it, because adapters may include bind values.
      throw new ApiError(500, "api_token_storage", "api token storage failed");
    }
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
    const revoked = await store.revokeApiToken(tenantId, tokenId, tokenRequestActor(), nowIso());
    // A token in another tenant is a 404 rather than an idempotent 200, which
    // would confirm that it exists.
    if (!revoked) throw notFound("api token not found");
    json(response, 200, { token: publicApiToken(revoked) });
  }

  async function contextMetrics(tenantId: string) {
    const repositories = await contextStore.listRepositories(tenantId);
    const generations = (
      await Promise.all(repositories.map((repository) => contextStore.listGenerations(tenantId, repository)))
    ).flat();
    const catalogMetrics = contextStore.contextCatalogMetrics
      ? await contextStore.contextCatalogMetrics(tenantId)
      : await (async () => {
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
          return {
            publishedGenerationCount: generations.filter((generation) => generation.status === "published").length,
            documentCount: revisions.length,
            fragmentCount,
            hierarchyNodeCount
          };
        })();
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
      publishedGenerationCount: catalogMetrics.publishedGenerationCount,
      documentCount: catalogMetrics.documentCount,
      fragmentCount: catalogMetrics.fragmentCount,
      hierarchyNodeCount: catalogMetrics.hierarchyNodeCount,
      embeddingCount: 0,
      query: await contextStore.queryMetrics(tenantId),
      ...(config.contextQuotaService ? { quotas: await config.contextQuotaService.snapshot(tenantId) } : {}),
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
    return tenantBoardView(intakeState, principal.tenantId, allowed);
  }

  async function permittedRepositories(principal: Principal): Promise<string[]> {
    return isTenantAdmin(principal)
      ? contextStore.listRepositories(principal.tenantId)
      : contextStore.repositoriesForPrincipal(principal.tenantId, principal.principalId);
  }

  function catalogAccess(principal: Principal, repository: string) {
    return {
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      repository,
      tenantAdmin: isTenantAdmin(principal)
    };
  }

  async function catalogCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Error &&
        /context (?:document|release).*not found|published context release not found/.test(error.message)
      ) {
        throw notFound("context not found");
      }
      throw error;
    }
  }

  async function deterministicContextSearch(
    input: Parameters<ContextCatalogService["searchContext"]>[0]
  ): Promise<Awaited<ReturnType<ContextCatalogService["searchContext"]>>> {
    return contextCatalog.searchContext(input);
  }

  async function requireRepositoryAccess(principal: Principal, repository: string): Promise<void> {
    if (isTenantAdmin(principal)) return;
    if (!(await permittedRepositories(principal)).includes(repository)) throw notFound("repository context not found");
  }

  function isTenantAdmin(principal: Principal): boolean {
    return (
      (trustsDevIdentityHeaders(config) && principal.principalId.startsWith("svc:")) ||
      principal.principalId === `tenant:${principal.tenantId}` ||
      (config.tenantAdminPrincipalIds ?? []).includes(principal.principalId)
    );
  }

  function requireTenantAdmin(principal: Principal): void {
    if (!isTenantAdmin(principal)) throw new ApiError(403, "forbidden", "tenant administrator access required");
  }

  function workerReleaseGuard(body: Record<string, unknown>): WorkerReleaseGuard | undefined {
    if (!config.requireWorkerReleaseGate) return undefined;
    const releaseId = requiredString(body.workerReleaseId, "workerReleaseId");
    const credential = requiredString(body.workerReleaseCredential, "workerReleaseCredential");
    const service = requiredString(body.workerService, "workerService");
    const revision = requiredString(body.workerRevision, "workerRevision");
    if (service !== "jina-context-worker" && service !== "jina-task-worker") {
      throw invalidRequest("workerService is not a production worker service");
    }
    if (!revision.startsWith(`${service}-`)) {
      throw invalidRequest("workerRevision does not belong to workerService");
    }
    return {
      releaseId,
      credentialSha256: createHash("sha256").update(credential, "utf8").digest("hex"),
      service,
      revision
    };
  }

  function requireWorkerServiceForTopics(
    workerRelease: WorkerReleaseGuard | undefined,
    topics: readonly string[]
  ): void {
    if (!workerRelease) return;
    const expectedService = topics.every((topic) => topic === "run-review")
      ? "jina-task-worker"
      : topics.every((topic) => CONTEXT_BOARD_TOPICS.has(topic))
        ? "jina-context-worker"
        : undefined;
    if (!expectedService || workerRelease.service !== expectedService) {
      throw new ApiError(409, "worker_release_rejected", "worker service is not allowed to process these topics");
    }
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
    const workerRelease = workerReleaseGuard(body);
    requireWorkerServiceForTopics(workerRelease, topics);
    const claimTenantIds = tenantId === "*" ? [...(await config.sharedIdentityResolver!.listTenantIds())] : [tenantId];
    let quotaModelTask: { readonly tenantId: string; readonly taskId: string } | undefined;
    const terminatedBuilds = new Map<string, string>();
    let claimed;
    try {
      claimed = await mutate(
        async () => {
          const candidateMessageIds = intakeState.board.outbox.flatMap((message) => {
            const task = findTask(intakeState.board, message.taskId);
            return task && claimTenantIds.includes(String(task.metadata.tenantId)) ? [message.id] : [];
          });
          const quotaDeniedTenantIds = new Set<string>();
          let quotaDenial: ContextQuotaExceededError | undefined;
          for (const messageId of candidateMessageIds) {
            const candidate = findOutboxMessage(intakeState.board, messageId);
            const candidateTask = candidate ? findTask(intakeState.board, candidate.taskId) : undefined;
            if (!candidate || !candidateTask || !topics.includes(candidate.topic)) continue;
            const candidateUsesModel = CONTEXT_MODEL_TOPICS.has(candidate.topic);
            const candidateTenantId = requiredString(candidateTask.metadata.tenantId, "task tenantId");

            const now = nowIso();
            const candidateBuildId =
              isContextBoardTaskType(candidateTask.type) && typeof candidateTask.metadata.contextBuildId === "string"
                ? candidateTask.metadata.contextBuildId
                : undefined;
            const candidateBuild = candidateBuildId
              ? findTask(intakeState.board, entityId<"task">(candidateBuildId))
              : undefined;
            if (candidateBuild?.type === contextBoardTaskTypes.build && !isTerminalTaskStatus(candidateBuild.status)) {
              const limitFailure = contextBuildLimitFailure(
                intakeState.board,
                candidateBuild,
                now,
                candidateUsesModel ? contextBuildModelTaskReservation(candidateBuild) : 0
              );
              if (limitFailure) {
                intakeState = {
                  ...intakeState,
                  board: terminateContextBuild(
                    intakeState.board,
                    candidateBuild,
                    "failed",
                    limitFailure,
                    limitFailure === "build_time_budget_exceeded"
                      ? "derivation deadline reached before the next stage could start"
                      : "model-token budget cannot reserve the next model-backed stage",
                    now
                  )
                };
                terminatedBuilds.set(candidateBuild.id, candidateTenantId);
                continue;
              }
            }
            const leaseId = randomUUID();
            const writeFenceToken = randomUUID();
            const initiallyLeased = leaseNextOutboxMessage(intakeState.board, {
              topics,
              messageIds: [messageId],
              leaseId,
              writeFenceToken,
              now,
              expiresAt: new Date(Date.parse(now) + WORKER_LEASE_MS).toISOString()
            });
            if (!initiallyLeased) continue;
            const leaseDurationMs = CONTEXT_BOARD_TOPICS.has(initiallyLeased.message.topic)
              ? contextWorkerLeaseMs
              : WORKER_LEASE_MS;
            const leasedState = renewOutboxLease(
              initiallyLeased.state,
              initiallyLeased.message.id,
              leaseId,
              writeFenceToken,
              now,
              new Date(Date.parse(now) + leaseDurationMs).toISOString()
            );
            const leasedMessage = leasedState ? findOutboxMessage(leasedState, initiallyLeased.message.id) : undefined;
            if (!leasedState || !leasedMessage) throw new Error("newly claimed worker lease could not be configured");
            const task = findTask(leasedState, leasedMessage.taskId);
            if (!task) throw new Error("newly claimed worker task disappeared");
            if (candidateUsesModel && config.contextQuotaService) {
              const candidateQuotaModelTask = {
                tenantId: candidateTenantId,
                taskId: contextModelQuotaTaskId(task.id, leasedMessage.payload.attempt)
              };
              try {
                await config.contextQuotaService.startModelTask({
                  ...candidateQuotaModelTask,
                  reservedTokens: DEFAULT_CONTEXT_QUOTA_LIMITS.defaultModelTaskReservationTokens,
                  recordDenial: !quotaDeniedTenantIds.has(candidateTenantId)
                });
              } catch (error) {
                if (error instanceof ContextQuotaExceededError) {
                  quotaDeniedTenantIds.add(candidateTenantId);
                  quotaDenial ??= error;
                  continue;
                }
                throw error;
              }
              quotaModelTask = candidateQuotaModelTask;
            }
            let board = leasedState;
            if (task.status === "queued") {
              board = applyCommand(
                board,
                { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" },
                { actor: { type: "run", id: workerId }, now }
              ).state;
            }
            const claimedTask = findTask(board, task.id);
            if (!claimedTask) throw new Error("newly claimed worker task disappeared");
            const claimedBuildId =
              isContextBoardTaskType(claimedTask.type) && typeof claimedTask.metadata.contextBuildId === "string"
                ? claimedTask.metadata.contextBuildId
                : undefined;
            const claimedBuild = claimedBuildId ? findTask(board, entityId<"task">(claimedBuildId)) : undefined;
            intakeState = { ...intakeState, board };
            return {
              message: { ...leasedMessage, attempt: leasedMessage.payload.attempt },
              task: isContextBoardTaskType(claimedTask.type)
                ? {
                    ...claimedTask,
                    metadata: {
                      ...claimedTask.metadata,
                      ...(claimedBuild?.type === contextBoardTaskTypes.build &&
                      typeof claimedBuild.metadata.derivationBudgetSeconds === "number"
                        ? { derivationDeadlineAt: contextBuildDeadlineAt(claimedBuild) }
                        : {}),
                      dependencyResults: contextBoardDependencyResults(board, claimedTask.id)
                    }
                  }
                : claimedTask
            };
          }
          if (quotaDenial) throw quotaDenial;
          return undefined;
        },
        undefined,
        workerRelease
      );
    } catch (error) {
      if (quotaModelTask && config.contextQuotaService) {
        await config.contextQuotaService.cancelModelTask(quotaModelTask).catch(() => undefined);
      }
      throw error;
    }
    if (!claimed && quotaModelTask && config.contextQuotaService) {
      await config.contextQuotaService.cancelModelTask(quotaModelTask).catch(() => undefined);
    }
    if (config.contextQuotaService) {
      for (const [buildId, buildTenantId] of terminatedBuilds) {
        await settleTerminalReconciledModelQuotas(
          config.contextQuotaService,
          intakeState.board,
          buildTenantId,
          buildId
        );
        await config.contextQuotaService.completeBuild({ tenantId: buildTenantId, buildId });
      }
    }
    json(response, claimed ? 200 : 204, claimed ?? {});
  }

  async function renewWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerRelease = workerReleaseGuard(body);
    const messageId = requiredString(body.messageId, "messageId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const id = entityId<"board_outbox_message">(messageId) as BoardOutboxMessageId;
    const renewed = await mutate(
      async () => {
        const message = findOutboxMessage(intakeState.board, id);
        const task = message ? findTask(intakeState.board, message.taskId) : undefined;
        if (message) requireWorkerServiceForTopics(workerRelease, [message.topic]);
        if (
          !task ||
          task.metadata.tenantId !== tenantId ||
          message?.payload.attempt !== requiredPositiveInteger(body.attempt, "attempt")
        ) {
          return { accepted: false };
        }
        const now = nowIso();
        const buildId =
          isContextBoardTaskType(task.type) && typeof task.metadata.contextBuildId === "string"
            ? task.metadata.contextBuildId
            : undefined;
        const build = buildId ? findTask(intakeState.board, entityId<"task">(buildId)) : undefined;
        if (build?.type === contextBoardTaskTypes.build && !isTerminalTaskStatus(build.status)) {
          const limitFailure = contextBuildLimitFailure(intakeState.board, build, now);
          if (limitFailure) {
            intakeState = {
              ...intakeState,
              board: terminateContextBuild(
                intakeState.board,
                build,
                "failed",
                limitFailure,
                limitFailure === "build_time_budget_exceeded"
                  ? "derivation deadline reached while a stage was running"
                  : "model-token budget was exhausted while stages were running",
                now
              )
            };
            return { accepted: false, terminatedBuildId: build.id };
          }
        }
        const board = renewOutboxLease(
          intakeState.board,
          id,
          leaseId,
          requiredString(body.writeFenceToken, "writeFenceToken"),
          now,
          new Date(
            Date.parse(now) +
              (message && CONTEXT_BOARD_TOPICS.has(message.topic) ? contextWorkerLeaseMs : WORKER_LEASE_MS)
          ).toISOString()
        );
        if (!board) return { accepted: false };
        intakeState = { ...intakeState, board };
        return { accepted: true };
      },
      undefined,
      workerRelease
    );
    if (renewed?.terminatedBuildId && config.contextQuotaService) {
      await settleTerminalReconciledModelQuotas(
        config.contextQuotaService,
        intakeState.board,
        tenantId,
        renewed.terminatedBuildId
      );
      await config.contextQuotaService.completeBuild({ tenantId, buildId: renewed.terminatedBuildId });
    }
    if (!renewed?.accepted) throw staleLease();
    if (config.contextQuotaService) {
      const message = findOutboxMessage(intakeState.board, id);
      if (message && CONTEXT_MODEL_TOPICS.has(message.topic)) {
        const task = findTask(intakeState.board, message.taskId);
        if (task) {
          await config.contextQuotaService.renewModelTask({
            tenantId,
            taskId: contextModelQuotaTaskId(task.id, message.payload.attempt)
          });
        }
      }
      if (message) {
        const task = findTask(intakeState.board, message.taskId);
        const buildId = task?.metadata.contextBuildId;
        if (typeof buildId === "string") {
          await config.contextQuotaService.renewBuild({ tenantId, buildId });
        }
      }
    }
    json(response, 200, { accepted: true });
  }

  async function releaseWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerRelease = workerReleaseGuard(body);
    const messageId = entityId<"board_outbox_message">(
      requiredString(body.messageId, "messageId")
    ) as BoardOutboxMessageId;
    const taskId = entityId<"task">(requiredString(body.taskId, "taskId")) as TaskId;
    const leaseId = requiredString(body.leaseId, "leaseId");
    const released = await mutate(
      async () => {
        const message = findOutboxMessage(intakeState.board, messageId);
        const task = findTask(intakeState.board, taskId);
        if (message) requireWorkerServiceForTopics(workerRelease, [message.topic]);
        const attempt = requiredPositiveInteger(body.attempt, "attempt");
        const writeFenceToken = requiredString(body.writeFenceToken, "writeFenceToken");
        const now = nowIso();
        if (
          !message ||
          !task ||
          message.taskId !== taskId ||
          message.payload.attempt !== attempt ||
          task.metadata.tenantId !== tenantId
        ) {
          return false;
        }
        let board = releaseOutboxLease(intakeState.board, messageId, leaseId, writeFenceToken, now);
        if (!board) return false;
        board = applyCommand(
          board,
          {
            command: "CommentTask",
            taskId,
            eventType: message.topic + ".released",
            payload: { reason: optionalString(body.reason)?.slice(0, 2_000) ?? "worker release" }
          },
          { actor: RUN_ACTOR, now }
        ).state;
        intakeState = { ...intakeState, board };
        return true;
      },
      undefined,
      workerRelease
    );
    if (!released) throw staleLease();
    if (config.contextQuotaService) {
      const message = findOutboxMessage(intakeState.board, messageId);
      if (message && CONTEXT_MODEL_TOPICS.has(message.topic)) {
        await config.contextQuotaService.cancelModelTask({
          tenantId,
          taskId: contextModelQuotaTaskId(taskId, message.payload.attempt)
        });
      }
    }
    json(response, 200, { accepted: true });
  }

  async function completeWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerRelease = workerReleaseGuard(body);
    const messageId = requiredString(body.messageId, "messageId");
    const taskId = requiredString(body.taskId, "taskId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const attempt = requiredPositiveInteger(body.attempt, "attempt");
    const writeFenceToken = requiredString(body.writeFenceToken, "writeFenceToken");
    const outcome = body.outcome;
    if (outcome !== "done" && outcome !== "failed" && outcome !== "retry") {
      throw invalidRequest("outcome must be done, failed, or retry");
    }
    const failureReason =
      outcome === "done"
        ? undefined
        : (optionalString(body.reason)?.slice(0, 2_000) ??
          (outcome === "retry" ? "worker requested retry" : "worker failed"));
    const failureCategory = outcome === "done" ? undefined : workerFailureCategory(body.failureCategory);
    const retryable =
      outcome === "retry" && failureCategory !== undefined && RETRYABLE_WORKER_FAILURE_CATEGORIES.has(failureCategory);
    const terminalOutcome: "done" | "failed" = outcome === "done" ? "done" : "failed";
    const outboxId = entityId<"board_outbox_message">(messageId) as BoardOutboxMessageId;
    const boardTaskId = entityId<"task">(taskId) as TaskId;
    const currentMessage = findOutboxMessage(intakeState.board, outboxId);
    const currentTask = findTask(intakeState.board, boardTaskId);
    const ownsCurrentLease =
      currentMessage !== undefined &&
      currentTask !== undefined &&
      currentMessage.taskId === boardTaskId &&
      currentMessage.status === "leased" &&
      currentMessage.leaseId === leaseId &&
      currentMessage.payload.attempt === attempt &&
      currentMessage.writeFenceToken === writeFenceToken &&
      currentTask.metadata.tenantId === tenantId;
    const isModelCompletion = ownsCurrentLease && CONTEXT_MODEL_TOPICS.has(currentMessage.topic);
    const modelUsage = body.modelUsage === undefined ? undefined : requiredModelUsage(body.modelUsage);
    if (ownsCurrentLease && isModelCompletion && outcome === "done" && !modelUsage) {
      throw invalidRequest("modelUsage is required for successful model-backed topics");
    }
    if (ownsCurrentLease && modelUsage && !isModelCompletion) {
      throw invalidRequest("modelUsage is accepted only for model-backed topics");
    }
    const isCompletionReplay =
      currentMessage !== undefined &&
      currentTask !== undefined &&
      currentMessage.taskId === boardTaskId &&
      currentMessage.status === "dispatched" &&
      currentMessage.dispatchedLeaseId === leaseId &&
      currentMessage.payload.attempt === attempt &&
      currentTask.metadata.tenantId === tenantId &&
      currentTask.status === terminalOutcome;
    let verifiedContextResult:
      | {
          readonly resultDigest: string;
        }
      | undefined;
    if (
      terminalOutcome === "done" &&
      currentTask &&
      isContextBoardTaskType(currentTask.type) &&
      (ownsCurrentLease || isCompletionReplay)
    ) {
      const parsed = parseContextBoardTaskResult(intakeState.board, currentTask.id, body.result);
      assertCurrentTaskOutputArtifact(
        currentTask,
        requiredString(currentTask.metadata.contextBuildId, "contextBuildId"),
        attempt,
        parsed.outputArtifact
      );
      if (!config.contextArtifactStore) throw new Error("context artifact storage is not configured");
      const content = await config.contextArtifactStore.get(parsed.outputArtifact);
      if (
        content.byteLength !== parsed.outputArtifact.bytes ||
        fingerprintBytes(content) !== parsed.outputArtifact.sha256
      ) {
        throw invalidRequest("completion artifact bytes do not match their immutable reference");
      }
      verifiedContextResult = {
        resultDigest: fingerprintBytes(Buffer.from(JSON.stringify(parsed), "utf8"))
      };
    }
    const completed = await mutate(
      async () => {
        const message = findOutboxMessage(intakeState.board, outboxId);
        const task = findTask(intakeState.board, boardTaskId);
        if (message) requireWorkerServiceForTopics(workerRelease, [message.topic]);
        const now = nowIso();
        if (retryable && message && task && task.metadata.tenantId === tenantId) {
          const retried = retryLeasedOutboxTask(intakeState.board, {
            messageId: outboxId,
            taskId: boardTaskId,
            leaseId,
            writeFenceToken,
            attempt,
            maxAttempts: contextBoardMaxAttempts,
            now,
            diagnostic: {
              category: failureCategory,
              reason: failureReason!
            }
          });
          if (!retried) return undefined;
          if (retried.replay) {
            assertModelUsageReplay(
              findModelUsageReceipt(retried.state, message.id, task.id, message.payload.attempt, "retry")?.payload,
              modelUsage
            );
          }
          const modelTaskId = CONTEXT_MODEL_TOPICS.has(message.topic)
            ? contextModelQuotaTaskId(task.id, message.payload.attempt)
            : undefined;
          let retryState = retried.replay
            ? retried.state
            : applyCommand(
                retried.state,
                {
                  command: "CommentTask",
                  taskId: task.id,
                  eventType: "task.model_usage_recorded",
                  payload: {
                    messageId: message.id,
                    attempt: message.payload.attempt,
                    outcome: "retry",
                    ...modelUsageReceipt(modelUsage)
                  }
                },
                { actor: RUN_ACTOR, now }
              ).state;
          const buildId =
            isContextBoardTaskType(task.type) && typeof task.metadata.contextBuildId === "string"
              ? task.metadata.contextBuildId
              : undefined;
          let build = buildId ? findTask(retryState, entityId<"task">(buildId)) : undefined;
          if (!retried.replay && build?.type === contextBoardTaskTypes.build && !isTerminalTaskStatus(build.status)) {
            const limitFailure = contextBuildLimitFailure(retryState, build, now);
            if (limitFailure) {
              retryState = terminateContextBuild(
                retryState,
                build,
                "failed",
                limitFailure,
                limitFailure === "build_time_budget_exceeded"
                  ? "derivation deadline reached before a retried stage completed"
                  : "model-token usage exceeded the build budget",
                now
              );
              build = findTask(retryState, build.id);
            }
          }
          intakeState = { ...intakeState, board: retryState };
          return {
            accepted: true,
            replay: retried.replay,
            ...(buildId ? { buildId } : {}),
            buildTerminal: Boolean(retried.terminal && buildId && build && isTerminalTaskStatus(build.status)),
            ...(modelTaskId ? { modelTaskId } : {})
          };
        }
        const completionReceipt =
          message !== undefined &&
          task !== undefined &&
          message.taskId === boardTaskId &&
          message.status === "dispatched" &&
          message.dispatchedLeaseId === leaseId &&
          message.payload.attempt === attempt &&
          task.metadata.tenantId === tenantId &&
          task.status === terminalOutcome &&
          findWorkerCompletionReceipt(intakeState.board, message.id, task.id, attempt, terminalOutcome);
        if (completionReceipt) {
          if (
            workerRelease &&
            (completionReceipt.payload?.workerReleaseId !== workerRelease.releaseId ||
              completionReceipt.payload.workerService !== workerRelease.service ||
              completionReceipt.payload.workerRevision !== workerRelease.revision)
          ) {
            throw new ApiError(
              409,
              "completion_replay_conflict",
              "replayed worker completion changed its release identity"
            );
          }
          const messageIsModel = CONTEXT_MODEL_TOPICS.has(message.topic);
          if (messageIsModel && terminalOutcome === "done" && !modelUsage) {
            throw invalidRequest("modelUsage is required for successful model-backed topics");
          }
          if (modelUsage && !messageIsModel) {
            throw invalidRequest("modelUsage is accepted only for model-backed topics");
          }
          assertModelUsageReplay(completionReceipt.payload, modelUsage);
          const modelTaskId = messageIsModel ? contextModelQuotaTaskId(task.id, message.payload.attempt) : undefined;
          if (
            isContextBoardTaskType(task.type) &&
            completionReceipt.payload?.resultDigest !== verifiedContextResult?.resultDigest
          ) {
            throw new ApiError(409, "completion_replay_conflict", "replayed worker completion changed its result");
          }
          const buildId =
            isContextBoardTaskType(task.type) && typeof task.metadata.contextBuildId === "string"
              ? task.metadata.contextBuildId
              : undefined;
          const build = buildId ? findTask(intakeState.board, entityId<"task">(buildId)) : undefined;
          return {
            accepted: true,
            replay: true,
            ...(buildId ? { buildId } : {}),
            buildTerminal: Boolean(build && isTerminalTaskStatus(build.status)),
            ...(modelTaskId ? { modelTaskId } : {})
          };
        }
        if (
          !message ||
          !task ||
          message.taskId !== boardTaskId ||
          message.status !== "leased" ||
          message.leaseId !== leaseId ||
          message.payload.attempt !== attempt ||
          message.writeFenceToken !== writeFenceToken ||
          task.metadata.tenantId !== tenantId
        ) {
          return undefined;
        }
        const messageIsModel = CONTEXT_MODEL_TOPICS.has(message.topic);
        if (messageIsModel && terminalOutcome === "done" && !modelUsage) {
          throw invalidRequest("modelUsage is required for successful model-backed topics");
        }
        if (modelUsage && !messageIsModel) {
          throw invalidRequest("modelUsage is accepted only for model-backed topics");
        }
        let board = intakeState.board;
        let completionPayload: Record<string, unknown>;
        let postCompletion: ContextBoardPostCompletion | undefined;
        if (terminalOutcome === "done" && isContextBoardTaskType(task.type)) {
          const applied = applyContextBoardTaskResult(board, boardTaskId, body.result, now);
          board = applied.state;
          completionPayload = applied.result;
          postCompletion = applied.postCompletion;
        } else {
          completionPayload =
            terminalOutcome === "failed"
              ? {
                  reason: failureReason!,
                  ...(failureCategory ? { failureCategory } : {})
                }
              : safeResultPayload(body.result);
        }
        board = markOutboxDispatched(board, message.id, now);
        board = applyCommand(
          board,
          {
            command: "CommentTask",
            taskId: boardTaskId,
            eventType: terminalOutcome === "failed" ? `${message.topic}.failed` : completionEventType(message.topic),
            payload: completionPayload
          },
          { actor: RUN_ACTOR, now }
        ).state;
        board = applyCommand(
          board,
          {
            command: "CommentTask",
            taskId: boardTaskId,
            eventType: "task.worker_completion_recorded",
            payload: {
              messageId: message.id,
              attempt: message.payload.attempt,
              outcome: terminalOutcome,
              ...(workerRelease
                ? {
                    workerReleaseId: workerRelease.releaseId,
                    workerService: workerRelease.service,
                    workerRevision: workerRelease.revision
                  }
                : {}),
              ...(verifiedContextResult ? { resultDigest: verifiedContextResult.resultDigest } : {}),
              ...modelUsageReceipt(modelUsage)
            }
          },
          { actor: RUN_ACTOR, now }
        ).state;
        const transitioned = applyCommand(
          board,
          {
            command: "TransitionTask",
            taskId: boardTaskId,
            toStatus: terminalOutcome
          },
          { actor: RUN_ACTOR, now }
        );
        if (!transitioned.accepted) {
          throw new Error(
            `worker completion transition was rejected: ${transitioned.rejection?.reason ?? "unknown reason"}`
          );
        }
        board = transitioned.state;
        if (postCompletion) {
          board = finalizeContextBoardTaskResult(board, postCompletion, now);
        }
        let reduced = reduceBoard(board, now);
        const buildId =
          isContextBoardTaskType(task.type) && typeof task.metadata.contextBuildId === "string"
            ? task.metadata.contextBuildId
            : undefined;
        let build = buildId ? findTask(reduced, entityId<"task">(buildId)) : undefined;
        if (build?.type === contextBoardTaskTypes.build && !isTerminalTaskStatus(build.status)) {
          const limitFailure = contextBuildLimitFailure(reduced, build, now);
          if (limitFailure) {
            reduced = terminateContextBuild(
              reduced,
              build,
              "failed",
              limitFailure,
              limitFailure === "build_time_budget_exceeded"
                ? "derivation deadline reached before the stage completion committed"
                : "model-token usage exceeded the build budget",
              now
            );
            build = findTask(reduced, build.id);
          }
        }
        const modelTaskId = messageIsModel ? contextModelQuotaTaskId(task.id, message.payload.attempt) : undefined;
        intakeState = { ...intakeState, board: reduced };
        return {
          accepted: true,
          ...(buildId ? { buildId } : {}),
          buildTerminal: Boolean(buildId && build && isTerminalTaskStatus(build.status)),
          ...(modelTaskId ? { modelTaskId } : {})
        };
      },
      undefined,
      workerRelease
    );
    if (!completed) throw staleLease();
    if ("modelTaskId" in completed && completed.modelTaskId && config.contextQuotaService) {
      await settleContextModelQuota(config.contextQuotaService, {
        tenantId,
        taskId: completed.modelTaskId,
        ...(modelUsage ? { modelUsage } : {})
      });
    }
    if ("buildId" in completed && completed.buildId && config.contextQuotaService) {
      await settleTerminalReconciledModelQuotas(
        config.contextQuotaService,
        intakeState.board,
        tenantId,
        completed.buildId
      );
    }
    if (completed.buildTerminal && "buildId" in completed && completed.buildId) {
      await config.contextQuotaService?.completeBuild({
        tenantId,
        buildId: completed.buildId
      });
    }
    json(response, 200, { accepted: true });
  }

  async function requireLeasedContextBoardTask(
    tenantId: string,
    body: Record<string, unknown>
  ): Promise<{
    task: BoardTask;
    message: BoardState["outbox"][number];
    buildTaskId: string;
  }> {
    await reload();
    const taskId = entityId<"task">(requiredString(body.taskId, "taskId")) as TaskId;
    const messageId = entityId<"board_outbox_message">(
      requiredString(body.messageId, "messageId")
    ) as BoardOutboxMessageId;
    const task = findTask(intakeState.board, taskId);
    const message = findOutboxMessage(intakeState.board, messageId);
    const attempt = requiredPositiveInteger(body.attempt, "attempt");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const writeFenceToken = requiredString(body.writeFenceToken, "writeFenceToken");
    if (
      !task ||
      !message ||
      !isContextBoardTaskType(task.type) ||
      task.kind !== "dispatchable" ||
      task.metadata.tenantId !== tenantId ||
      message.taskId !== task.id ||
      message.status !== "leased" ||
      message.payload.attempt !== attempt ||
      message.leaseId !== leaseId ||
      message.writeFenceToken !== writeFenceToken ||
      !message.leaseExpiresAt ||
      message.leaseExpiresAt <= nowIso()
    ) {
      throw staleLease();
    }
    const buildTaskId = requiredString(task.metadata.contextBuildId, "contextBuildId");
    const build = findTask(intakeState.board, entityId<"task">(buildTaskId));
    if (
      !build ||
      build.type !== contextBoardTaskTypes.build ||
      isTerminalTaskStatus(build.status) ||
      build.metadata.tenantId !== tenantId ||
      build.metadata.repository !== task.metadata.repository ||
      (typeof build.metadata.derivationBudgetSeconds === "number" && nowIso() >= contextBuildDeadlineAt(build))
    ) {
      throw staleLease();
    }
    return { task, message, buildTaskId };
  }

  async function drainOneSimulatedRun(): Promise<void> {
    const message = intakeState.board.outbox.find((candidate) => candidate.status === "pending");
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

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
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
  if (trustsDevIdentityHeaders(config)) {
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
  if (!trustsDevIdentityHeaders(config) && !principal.forwarded) {
    throw new ApiError(401, "bound_principal_required", "a bound principal is required");
  }
}

function trustsDevIdentityHeaders(config: ApiServerConfig): boolean {
  return Boolean(config.enableDevEndpoints && (config.trustDevIdentityHeaders ?? true));
}

function hasInternalApiCredential(request: IncomingMessage, config: ApiServerConfig): boolean {
  return Boolean(
    config.internalApiToken && firstHeader(request.headers.authorization) === `Bearer ${config.internalApiToken}`
  );
}

/**
 * Static credentials have their fixed union decided during authentication.
 * Issued tokens carry an explicit row-owned scope set, so each MCP tool applies
 * the same query/read distinction as its HTTP counterpart.
 */
function requireIssuedTokenScope(principal: Principal, required: ContextScope): void {
  if (principal.scopes && !principal.scopes.includes(required)) {
    throw new ApiError(403, "insufficient_scope", "token scope does not permit this tool");
  }
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
    if (pathname === "/mcp" || pathname === "/context/search") return "context:query";
    if (pathname === "/context/build") return "context:build";
    if (contextBuildRetryRoute(pathname) || contextTaskRetryRoute(pathname)) return "context:admin";
    return "internal-only";
  }
  if (method !== "GET") return "internal-only";
  if (pathname === "/context/metrics") return "context:admin";
  if (
    pathname === "/context/builds" ||
    (pathname.startsWith("/context/builds/") && (pathname.endsWith("/progress") || pathname.endsWith("/page")))
  ) {
    return "context:read";
  }
  return pathname === "/context/releases" ||
    pathname === "/context/list" ||
    pathname === "/context/read" ||
    pathname === "/context/diff"
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

function contextCredentialTenantId(value: string | undefined, config: ApiServerConfig): string | undefined {
  if (config.sharedIdentityResolver) return normalizedTenantId(value);
  const normalized = value?.trim();
  return normalized !== "" && normalized === config.tenantId ? normalized : undefined;
}

function publicContextBoardBuild(state: BoardState, buildTaskId: TaskId) {
  const task = findTask(state, buildTaskId);
  if (!task || task.type !== contextBoardTaskTypes.build) {
    throw new Error("admitted context board build disappeared");
  }
  return {
    id: task.id,
    status: task.status,
    tenantId: requiredString(task.metadata.tenantId, "context build tenantId"),
    repository: requiredRepositoryName(task.metadata.repository, "context build repository"),
    ref: requiredString(task.metadata.ref, "context build ref"),
    refSequence: requiredPositiveInteger(task.metadata.refSequence, "context build refSequence"),
    ...(typeof task.metadata.commitSha === "string" ? { commitSha: task.metadata.commitSha } : {}),
    ...(typeof task.metadata.trigger === "string" ? { trigger: task.metadata.trigger } : {}),
    ...(typeof task.metadata.derivationBudgetSeconds === "number"
      ? {
          derivationBudgetSeconds: task.metadata.derivationBudgetSeconds,
          derivationDeadlineAt: contextBuildDeadlineAt(task)
        }
      : {}),
    ...(typeof task.metadata.derivationTokenBudget === "number"
      ? {
          derivationTokenBudget: task.metadata.derivationTokenBudget,
          consumedModelTokens: contextBuildConsumedModelTokens(state, task.id),
          activeModelReservedTokens: contextBuildActiveModelReservations(state, task.id),
          remainingModelTokens: Math.max(
            0,
            task.metadata.derivationTokenBudget - contextBuildConsumedModelTokens(state, task.id)
          )
        }
      : {}),
    ...publicContextBuildFailure(state, task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function publicContextBuildStatus(status: BoardTask["status"]): "active" | "completed" | "failed" {
  if (!isTerminalTaskStatus(status)) return "active";
  return status === "done" ? "completed" : "failed";
}

function publicContextBoardStages(state: BoardState, buildTaskId: TaskId) {
  return state.tasks
    .filter(
      (task) =>
        task.id !== buildTaskId &&
        task.metadata.contextBuildId === buildTaskId &&
        task.type !== contextBoardTaskTypes.graph
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.type.localeCompare(right.type) ||
        left.id.localeCompare(right.id)
    )
    .map((task) => ({
      id: task.id,
      type: task.type,
      title: task.title,
      status: task.status,
      attempt: task.attempt,
      ...publicContextTaskRuntime(state, task),
      ...publicContextTaskFailure(state, task),
      updatedAt: task.updatedAt
    }));
}

function publicContextTaskRuntime(state: BoardState, task: BoardTask) {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const event of state.events) {
    if (
      event.taskId !== task.id ||
      (event.type !== "task.worker_completion_recorded" && event.type !== "task.model_usage_recorded") ||
      event.payload?.modelUsageObserved !== true
    ) {
      continue;
    }
    inputTokens += requiredPositiveIntegerOrZero(event.payload.modelInputTokens, "stage modelInputTokens");
    cachedInputTokens += requiredPositiveIntegerOrZero(
      event.payload.modelCachedInputTokens,
      "stage modelCachedInputTokens"
    );
    outputTokens += requiredPositiveIntegerOrZero(event.payload.modelOutputTokens, "stage modelOutputTokens");
  }
  const startedAt = [...state.events]
    .reverse()
    .find(
      (event) =>
        event.taskId === task.id && event.type === "task.transitioned" && event.payload?.toStatus === "in_progress"
    )?.at;
  const retryEvent = [...state.events]
    .reverse()
    .find((event) => event.taskId === task.id && event.type === "task.retry_scheduled");
  const retryFailure = retryEvent
    ? publicContextFailureFromCategory(retryEvent.payload?.category, retryEvent.payload?.reason)
    : undefined;
  return {
    ...(startedAt ? { startedAt } : {}),
    ...(inputTokens || outputTokens
      ? {
          modelInputTokens: inputTokens,
          modelCachedInputTokens: cachedInputTokens,
          modelOutputTokens: outputTokens,
          modelTotalTokens: inputTokens + outputTokens
        }
      : {}),
    ...(retryFailure
      ? {
          lastRetryAt: retryEvent!.at,
          lastRetryFailureCode: retryFailure.failureCode,
          lastRetryFailureReason: retryFailure.failureReason
        }
      : {})
  };
}

const PUBLIC_CONTEXT_FAILURE_REASONS = {
  github_authentication: "GitHub authentication failed for this stage.",
  github_forbidden: "GitHub refused access required by this stage.",
  github_not_found: "A required GitHub repository or object was not found.",
  github_rate_limit: "GitHub rate limiting prevented this stage from completing.",
  github_timeout: "GitHub did not respond before this stage timed out.",
  github_response: "GitHub returned a response this stage could not use.",
  git_checkout: "The requested repository revision could not be prepared.",
  daytona: "The isolated execution sandbox did not complete this stage.",
  model: "The model provider did not complete this stage.",
  codex_quota_exhausted: "Codex has no remaining credits or usage allowance.",
  model_quota_exhausted: "The model provider has no remaining quota or usage allowance.",
  model_rate_limit: "The model provider rate limit prevented this stage from completing.",
  model_authentication: "Model provider authentication failed for this stage.",
  model_unavailable: "The requested model is unsupported or unavailable from the provider.",
  context_validation: "Generated Context did not pass deterministic validation.",
  api_transport: "The worker could not reach the Context API.",
  lease: "The worker lost its fenced lease before completion.",
  worker_execution: "The worker failed before producing a valid stage result.",
  bounded_page_repair_exhausted: "Citation support remained incomplete after the bounded page-repair policy.",
  bounded_gate_repair_exhausted: "Source or maintenance gaps remained after the bounded repair policy.",
  build_time_budget_exceeded: "This Context build reached its wall-clock limit.",
  build_token_budget_exceeded: "This Context build reached its model-token limit.",
  build_canceled: "This Context build was canceled by an authorized operator.",
  build_superseded: "A newer pull request commit superseded this Context build.",
  stage_failed: "This stage failed before producing a valid checkpoint.",
  build_failed: "This Context build stopped after a stage failure."
} as const;

type PublicContextFailureCode = keyof typeof PUBLIC_CONTEXT_FAILURE_REASONS;

function publicContextBuildFailure(
  state: BoardState,
  build: BoardTask
): { readonly failureCode?: PublicContextFailureCode; readonly failureReason?: string } {
  if (build.status !== "failed" && build.status !== "canceled") return {};
  const descendants = new Map(
    state.tasks
      .filter(
        (task) => task.metadata.contextBuildId === build.id && (task.status === "failed" || task.status === "canceled")
      )
      .map((task) => [task.id, task])
  );
  for (const event of [...state.events].reverse()) {
    const task = event.taskId ? descendants.get(event.taskId) : undefined;
    if (!task) continue;
    const failure = publicContextFailureFromEvent(event);
    if (failure) return failure;
  }
  return publicContextFailure("build_failed");
}

function publicContextTaskFailure(
  state: BoardState,
  task: BoardTask
): { readonly failureCode?: PublicContextFailureCode; readonly failureReason?: string } {
  if (task.status !== "failed" && task.status !== "canceled") return {};
  for (const event of [...state.events].reverse()) {
    if (event.taskId !== task.id) continue;
    const failure = publicContextFailureFromEvent(event);
    if (failure) return failure;
  }
  return task.status === "failed" ? publicContextFailure("stage_failed") : {};
}

function publicContextFailureFromEvent(
  event: BoardState["events"][number]
): { readonly failureCode: PublicContextFailureCode; readonly failureReason: string } | undefined {
  if (event.type === "context.page_repair_exhausted") {
    return publicContextFailure("bounded_page_repair_exhausted");
  }
  if (event.type === "context.gate_repair_exhausted") {
    return publicContextFailure("bounded_gate_repair_exhausted");
  }
  if (event.type === "task.retry_exhausted") {
    return publicContextFailureFromCategory(event.payload?.category, event.payload?.reason);
  }
  if (event.type.endsWith(".failed")) {
    return publicContextFailureFromCategory(event.payload?.failureCategory, event.payload?.reason);
  }
  return undefined;
}

function publicContextFailureFromCategory(
  category: unknown,
  reason: unknown
): { readonly failureCode: PublicContextFailureCode; readonly failureReason: string } {
  const code = publicContextFailureCode(category);
  return publicContextFailure(code === "model" ? publicContextModelFailureCode(reason) : code);
}

function publicContextModelFailureCode(reason: unknown): PublicContextFailureCode {
  if (typeof reason !== "string") return "model";

  // Worker diagnostics are already bounded when recorded. Bound again at this
  // public projection boundary so imported or legacy Board events cannot make
  // classification cost depend on an untrusted payload size.
  const diagnostic = reason.slice(0, 2_000).toLowerCase();
  if (/\b0 weighted tokens left\b/.test(diagnostic)) return "codex_quota_exhausted";
  const quotaExhausted =
    /\binsufficient[ _-]+quota\b|\bquota (?:is |has been )?(?:exhausted|reached|exceeded)\b|\busage (?:limit|allowance)(?: (?:is |has been )?(?:exhausted|reached|exceeded))?\b|\bout of credits\b|\bcredits? (?:are |have been )?(?:exhausted|depleted)\b/.test(
      diagnostic
    );
  if (quotaExhausted) return "model_quota_exhausted";
  if (
    /\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b|\b(?:http(?: status)?|status(?: code)?) 429\b/.test(
      diagnostic
    )
  ) {
    return "model_rate_limit";
  }
  if (
    /\binvalid (?:api )?key\b|\bmissing (?:api )?key\b|\bunauthorized\b|\bauthentication failed\b|\btoken_expired\b|\binvalid_grant\b|\bcredentials? (?:were )?rejected\b/.test(
      diagnostic
    )
  ) {
    return "model_authentication";
  }
  if (
    /\bunknown model\b|\bunsupported model\b|\bmodel\b.{0,80}\b(?:not found|unsupported|unavailable|not available)\b|\b(?:unsupported|unavailable) model\b/.test(
      diagnostic
    )
  ) {
    return "model_unavailable";
  }
  return "model";
}

function publicContextFailureCode(value: unknown): PublicContextFailureCode {
  return typeof value === "string" && value in PUBLIC_CONTEXT_FAILURE_REASONS
    ? (value as PublicContextFailureCode)
    : "worker_execution";
}

function publicContextFailure(code: PublicContextFailureCode): {
  readonly failureCode: PublicContextFailureCode;
  readonly failureReason: string;
} {
  return {
    failureCode: code,
    // Public reasons come only from this fixed catalog. The bound remains an
    // explicit contract even if a future catalog entry is accidentally verbose.
    failureReason: PUBLIC_CONTEXT_FAILURE_REASONS[code].slice(0, 240)
  };
}

type ContextBuildLimitFailure = "build_time_budget_exceeded" | "build_token_budget_exceeded";

function contextBuildDeadlineAt(build: BoardTask): string {
  const budgetSeconds = requiredPositiveInteger(build.metadata.derivationBudgetSeconds, "derivationBudgetSeconds");
  const createdAt = Date.parse(build.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error("context build createdAt is invalid");
  return new Date(createdAt + budgetSeconds * 1_000).toISOString();
}

function contextBuildConsumedModelTokens(state: BoardState, buildId: string): number {
  let total = 0;
  for (const event of state.events) {
    if (
      (event.type !== "task.worker_completion_recorded" && event.type !== "task.model_usage_recorded") ||
      event.payload?.modelUsageObserved !== true ||
      !event.taskId
    ) {
      continue;
    }
    const task = findTask(state, event.taskId);
    if (!task || task.metadata.contextBuildId !== buildId) continue;
    const inputTokens = event.payload.modelInputTokens;
    const outputTokens = event.payload.modelOutputTokens;
    const increment =
      typeof inputTokens === "number" && typeof outputTokens === "number" ? inputTokens + outputTokens : NaN;
    if (
      typeof inputTokens !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      typeof outputTokens !== "number" ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0 ||
      !Number.isSafeInteger(increment) ||
      total > Number.MAX_SAFE_INTEGER - increment
    ) {
      throw new Error("context model usage receipt is invalid");
    }
    total += increment;
  }
  return total;
}

function contextBuildActiveModelReservations(state: BoardState, buildId: string): number {
  const active = state.outbox.filter((message) => {
    if (message.status !== "leased" || !CONTEXT_MODEL_TOPICS.has(message.topic)) return false;
    const task = findTask(state, message.taskId);
    return task?.metadata.contextBuildId === buildId;
  }).length;
  const build = findTask(state, entityId<"task">(buildId));
  return active * contextBuildModelTaskReservation(build);
}

function contextBuildModelTaskReservation(build: BoardTask | undefined): number {
  const budget = build?.metadata.derivationTokenBudget;
  return typeof budget === "number"
    ? Math.min(DEFAULT_CONTEXT_BUILD_TASK_RESERVATION_TOKENS, budget)
    : DEFAULT_CONTEXT_BUILD_TASK_RESERVATION_TOKENS;
}

function contextBuildLimitFailure(
  state: BoardState,
  build: BoardTask,
  at: IsoTimestamp,
  additionalReservedTokens = 0
): ContextBuildLimitFailure | undefined {
  if (typeof build.metadata.derivationBudgetSeconds === "number" && at >= contextBuildDeadlineAt(build)) {
    return "build_time_budget_exceeded";
  }
  if (typeof build.metadata.derivationTokenBudget !== "number") return undefined;
  const tokenBudget = requiredPositiveInteger(build.metadata.derivationTokenBudget, "derivationTokenBudget");
  const projected =
    contextBuildConsumedModelTokens(state, build.id) +
    contextBuildActiveModelReservations(state, build.id) +
    additionalReservedTokens;
  return projected > tokenBudget ? "build_token_budget_exceeded" : undefined;
}

function terminateContextBuild(
  state: BoardState,
  build: BoardTask,
  status: "failed" | "canceled",
  failureCategory: ContextBuildLimitFailure | "build_canceled",
  reason: string,
  at: IsoTimestamp
): BoardState {
  if (isTerminalTaskStatus(build.status)) return state;
  let next = applyCommand(
    state,
    {
      command: "CommentTask",
      taskId: build.id,
      eventType: `context.${failureCategory}.failed`,
      payload: { failureCategory, reason: reason.slice(0, 2_000) }
    },
    { actor: { type: "system", id: "context-build-control" }, now: at }
  ).state;
  const transitioned = applyCommand(
    next,
    { command: "TransitionTask", taskId: build.id, toStatus: status },
    { actor: { type: "system", id: "context-build-control" }, now: at }
  );
  if (!transitioned.accepted) {
    throw new Error(`context build ${status} transition was rejected: ${transitioned.rejection?.reason ?? "unknown"}`);
  }
  next = reduceBoard(transitioned.state, at);
  return next;
}

function contextBoardBuildForPrincipal(state: BoardState, tenantId: string, buildId: string): BoardTask | undefined {
  const task = state.tasks.find((candidate) => candidate.id === buildId);
  return task?.type === contextBoardTaskTypes.build && task.metadata.tenantId === tenantId ? task : undefined;
}

function contextWorkerCompletionAttestation(state: BoardState, build: BoardTask) {
  const workerTaskTypes = new Set(
    contextBoardTaskTypeDefinitions
      .filter((definition) => definition.kind === "dispatchable" && definition.dispatchTopic)
      .map((definition) => definition.type)
  );
  const workerTasks = new Map(
    state.tasks
      .filter((task) => task.metadata.contextBuildId === build.id && workerTaskTypes.has(task.type))
      .map((task) => [task.id, task])
  );
  const completions = state.events
    .flatMap((event) => {
      if (event.type !== "task.worker_completion_recorded" || !event.taskId || !event.payload) return [];
      const task = workerTasks.get(event.taskId);
      if (!task) return [];
      const attempt = event.payload.attempt;
      const outcome = event.payload.outcome;
      if (!Number.isSafeInteger(attempt) || Number(attempt) < 1 || (outcome !== "done" && outcome !== "failed")) {
        return [];
      }
      return [
        {
          taskId: task.id,
          taskType: task.type,
          attempt,
          outcome,
          ...(typeof event.payload.workerReleaseId === "string"
            ? { workerReleaseId: event.payload.workerReleaseId }
            : {}),
          ...(typeof event.payload.workerService === "string" ? { workerService: event.payload.workerService } : {}),
          ...(typeof event.payload.workerRevision === "string" ? { workerRevision: event.payload.workerRevision } : {})
        }
      ];
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || Number(left.attempt) - Number(right.attempt));
  return {
    buildId: build.id,
    repository: requiredRepositoryName(build.metadata.repository, "repository"),
    completions
  };
}

function contextBoardOperatorRetryEligibility(state: BoardState, build: BoardTask, now: ReturnType<typeof nowIso>) {
  const dispatchable = boardOperatorRetryEligibility(state, {
    buildTaskId: build.id,
    now
  });
  if (dispatchable.eligible) return dispatchable;
  if (build.status !== "failed") return dispatchable;

  const recoverablePages = state.tasks
    .filter(
      (task) =>
        task.parentTaskId === build.id &&
        task.type === contextBoardTaskTypes.page &&
        task.status === "failed" &&
        state.events.some((event) => event.taskId === task.id && event.type === "context.page_repair_exhausted")
    )
    .filter((page) => {
      const latestPass = state.tasks
        .filter(
          (task) =>
            task.parentTaskId === page.id &&
            task.type === contextBoardTaskTypes.pageAudit &&
            task.status === "done" &&
            Number.isSafeInteger(task.metadata.pass)
        )
        .reduce((maximum, task) => Math.max(maximum, Number(task.metadata.pass)), 0);
      return latestPass >= 1 && latestPass < MAX_CONTEXT_OPERATOR_REMEDIATION_PASS;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (recoverablePages.length > 0) {
    return {
      eligible: true,
      recoverableTaskIds: recoverablePages.map((page) => page.id),
      blockers: [],
      mode: "page_remediation" as const
    };
  }
  const certification = state.tasks.find(
    (task) =>
      task.parentTaskId === build.id && task.type === contextBoardTaskTypes.certification && task.status === "canceled"
  );
  const exhaustion = certification
    ? [...state.events]
        .reverse()
        .find((event) => event.taskId === certification.id && event.type === "context.gate_repair_exhausted")
    : undefined;
  const exhaustedPass = exhaustion?.payload?.pass;
  if (
    certification &&
    Number.isSafeInteger(exhaustedPass) &&
    Number(exhaustedPass) < MAX_CONTEXT_OPERATOR_REMEDIATION_PASS
  ) {
    return {
      eligible: true,
      recoverableTaskIds: [certification.id],
      blockers: [],
      mode: "gate_remediation" as const
    };
  }
  return dispatchable;
}

function assertContextOperatorRetrySafety(state: BoardState, build: BoardTask, target: BoardTask): void {
  const buildTasks = state.tasks.filter((task) => task.metadata.contextBuildId === build.id);
  const publication = buildTasks.find((task) => task.type === contextBoardTaskTypes.publication);
  const pageIndex = buildTasks.find((task) => task.type === contextBoardTaskTypes.pageIndex);
  const hasNewerRefSequence = state.tasks.some(
    (task) =>
      task.type === contextBoardTaskTypes.build &&
      task.id !== build.id &&
      task.metadata.tenantId === build.metadata.tenantId &&
      task.metadata.repository === build.metadata.repository &&
      task.metadata.ref === build.metadata.ref &&
      typeof task.metadata.refSequence === "number" &&
      typeof build.metadata.refSequence === "number" &&
      task.metadata.refSequence > build.metadata.refSequence
  );

  if (target.type === contextBoardTaskTypes.publication) {
    if (publication?.id !== target.id || pageIndex?.status === "done" || hasNewerRefSequence) {
      throw new ApiError(
        409,
        "operator_retry_unsafe",
        "publication retry is stale or is not the build's stable publication task"
      );
    }
    // The authoritative publication transaction uses the stable task id plus
    // certification digest as its idempotency key and rejects a newer admitted
    // ref sequence. Requeueing that exact task is therefore safe even if the
    // previous transaction committed and only its response was lost.
    return;
  }

  if (target.type === contextBoardTaskTypes.pageIndex) {
    if (
      pageIndex?.id !== target.id ||
      publication?.status !== "done" ||
      pageIndex.status === "done" ||
      hasNewerRefSequence
    ) {
      throw new ApiError(
        409,
        "operator_retry_unsafe",
        "PageIndex retry requires this build's current completed publication"
      );
    }
    // Attachment is also an idempotent transaction and verifies the release,
    // ref sequence, commit, immutable tree digest, and live Board lease.
    return;
  }

  if (publication?.status === "done" || pageIndex?.status === "done") {
    throw new ApiError(409, "operator_retry_unsafe", "published Context derivation tasks cannot be reopened");
  }
}

function publicContextBoardCheckpointPages(state: BoardState, buildTaskId: TaskId) {
  return state.tasks
    .filter(
      (task) =>
        task.type === contextBoardTaskTypes.page &&
        task.parentTaskId === buildTaskId &&
        typeof task.metadata.documentPath === "string"
    )
    .sort((left, right) => String(left.metadata.documentPath).localeCompare(String(right.metadata.documentPath)))
    .map((task) => {
      const output = latestCompletedContextOutput(
        state,
        state.tasks.filter(
          (candidate) =>
            candidate.parentTaskId === task.id &&
            (candidate.type === contextBoardTaskTypes.pageWrite || candidate.type === contextBoardTaskTypes.pageRepair)
        )
      );
      const documentPath = String(task.metadata.documentPath);
      const diagnostics = contextPageDiagnostics(state, task.id);
      return {
        documentPath: documentPath.endsWith(".md") ? documentPath.slice(0, -3) : documentPath,
        title: task.title.replace(/^Write /, ""),
        bytes: output?.artifact.bytes ?? 0,
        validationStatus:
          task.status === "done"
            ? ("valid" as const)
            : task.status === "failed"
              ? ("invalid" as const)
              : ("pending" as const),
        diagnostics,
        checkpointSequence: output?.pass ?? 0,
        updatedAt: task.updatedAt
      };
    });
}

function contextPageDiagnostics(state: BoardState, pageTaskId: TaskId): readonly string[] {
  const auditTaskIds = new Set(
    state.tasks
      .filter((task) => task.type === contextBoardTaskTypes.pageAudit && task.metadata.pageTaskId === pageTaskId)
      .map((task) => task.id)
  );
  for (const event of [...state.events].reverse()) {
    if (!event.taskId || !auditTaskIds.has(event.taskId) || !Array.isArray(event.payload?.diagnostics)) continue;
    return event.payload.diagnostics
      .filter((diagnostic): diagnostic is string => typeof diagnostic === "string")
      .slice(0, 32);
  }
  return [];
}

async function readContextBoardCheckpointPage(
  state: BoardState,
  build: BoardTask,
  requestedDocumentPath: string,
  artifacts: ContextArtifactStore | undefined
) {
  if (!artifacts) return undefined;
  const target = `${requestedDocumentPath}.md`;
  const page = state.tasks.find(
    (task) =>
      task.type === contextBoardTaskTypes.page &&
      task.parentTaskId === build.id &&
      task.metadata.documentPath === target
  );
  const pageTasks = page
    ? state.tasks.filter(
        (task) =>
          task.parentTaskId === page.id &&
          (task.type === contextBoardTaskTypes.pageWrite || task.type === contextBoardTaskTypes.pageRepair)
      )
    : [];
  const globalTasks = state.tasks.filter(
    (task) => task.parentTaskId === build.id && task.type === contextBoardTaskTypes.gapRepair
  );
  const candidates = completedContextOutputs(state, [...pageTasks, ...globalTasks]);
  for (const candidate of candidates) {
    assertBoardArtifactScope(candidate.task, build.id, candidate.artifact);
    const content = await artifacts.get(candidate.artifact);
    if (content.byteLength !== candidate.artifact.bytes || fingerprintBytes(content) !== candidate.artifact.sha256) {
      throw new Error("context checkpoint artifact bytes do not match their reference");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
    } catch {
      continue;
    }
    const container = isRecord(parsed) ? parsed : undefined;
    const values: readonly unknown[] = container
      ? Array.isArray(container.pages)
        ? container.pages
        : [container]
      : [];
    const found = values.find((value) => isRecord(value) && value.documentPath === target);
    if (!isRecord(found) || typeof found.bodyMarkdown !== "string" || typeof found.title !== "string") {
      continue;
    }
    return {
      documentPath: requestedDocumentPath,
      title: found.title,
      bodyMarkdown: found.bodyMarkdown,
      bytes: Buffer.byteLength(found.bodyMarkdown, "utf8"),
      validationStatus: page?.status === "failed" ? ("invalid" as const) : ("valid" as const),
      diagnostics: page ? contextPageDiagnostics(state, page.id) : [],
      checkpointSequence: candidate.pass,
      updatedAt: candidate.task.updatedAt,
      unpublished: true
    };
  }
  return undefined;
}

function latestCompletedContextOutput(state: BoardState, tasks: readonly BoardTask[]) {
  return completedContextOutputs(state, tasks)[0];
}

function completedContextOutputs(state: BoardState, tasks: readonly BoardTask[]) {
  return tasks
    .flatMap((task) => {
      const event = [...state.events]
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === task.id &&
            candidate.type.endsWith(".completed") &&
            isRecord(candidate.payload?.outputArtifact)
        );
      if (!event?.payload) return [];
      try {
        return [
          {
            task,
            artifact: parseContextArtifactRef(event.payload.outputArtifact),
            pass: typeof task.metadata.pass === "number" ? task.metadata.pass : 0,
            eventSequence: event.seq
          }
        ];
      } catch {
        return [];
      }
    })
    .sort(
      (left, right) =>
        right.pass - left.pass ||
        right.eventSequence - left.eventSequence ||
        right.task.updatedAt.localeCompare(left.task.updatedAt)
    );
}

function contextTriggerRef(event: GitHubWebhookEvent, defaultBranch?: string): string {
  if (event.type === "push") return event.ref.slice("refs/heads/".length);
  if (event.type === "pull_request.opened" || event.type === "pull_request.synchronize") {
    return `pull/${event.pullRequestNumber}/head`;
  }
  const ref = defaultBranch?.trim();
  if (!ref) throw invalidRequest("authoritative default branch is required for an issue-triggered context build");
  return ref;
}

function contextBoardDependencyResults(state: BoardState, taskId: TaskId) {
  const discovered = new Set<TaskId>();
  const pending = state.dependencies
    .filter((dependency) => dependency.taskId === taskId && dependency.required)
    .map((dependency) => dependency.dependsOnTaskId);
  while (pending.length > 0 && discovered.size < 256) {
    const dependencyId = pending.shift()!;
    if (discovered.has(dependencyId)) continue;
    discovered.add(dependencyId);
    pending.push(
      ...state.dependencies
        .filter((dependency) => dependency.taskId === dependencyId && dependency.required)
        .map((dependency) => dependency.dependsOnTaskId)
    );
  }
  return [...discovered].sort().flatMap((dependencyId) => {
    const task = findTask(state, dependencyId);
    if (!task || !isContextBoardTaskType(task.type)) return [];
    const event = [...state.events]
      .reverse()
      .find(
        (candidate) =>
          candidate.taskId === dependencyId &&
          candidate.type.endsWith(".completed") &&
          candidate.payload?.version === 1 &&
          candidate.payload.outputArtifact
      );
    return event
      ? [
          {
            taskId: dependencyId,
            taskType: task.type,
            ...(typeof task.metadata.pass === "number" ? { pass: task.metadata.pass } : {}),
            ...(typeof task.metadata.pageTaskId === "string" ? { pageTaskId: task.metadata.pageTaskId } : {}),
            ...(typeof task.metadata.documentPath === "string" ? { documentPath: task.metadata.documentPath } : {}),
            result: event.payload
          }
        ]
      : [];
  });
}

function contextBoardArtifactKind(taskType: string): ContextArtifactKind {
  switch (taskType) {
    case contextBoardTaskTypes.snapshot:
      return "evidence-snapshot";
    case contextBoardTaskTypes.researchPlan:
      return "research-plan";
    case contextBoardTaskTypes.research:
      return "research-report";
    case contextBoardTaskTypes.publicationPlan:
      return "publication-plan";
    case contextBoardTaskTypes.pageWrite:
    case contextBoardTaskTypes.pageRepair:
      return "context-page";
    case contextBoardTaskTypes.gapRepair:
      return "context-draft";
    case contextBoardTaskTypes.pageAudit:
      return "citation-audit";
    case contextBoardTaskTypes.sourceChallenge:
    case contextBoardTaskTypes.taskEvaluation:
      return "gate-evaluation";
    case contextBoardTaskTypes.certification:
      return "certification";
    case contextBoardTaskTypes.publication:
      return "context-release";
    case contextBoardTaskTypes.pageIndex:
      return "pageindex-tree";
    default:
      throw new Error(`context board task ${taskType} does not produce an artifact`);
  }
}

function parseContextArtifactRef(value: unknown): ContextArtifactRef {
  const input = isRecord(value) ? value : undefined;
  if (!input) throw invalidRequest("artifact must be an object");
  const bytes = requiredPositiveIntegerOrZero(input.bytes, "artifact.bytes");
  const sha256 = requiredString(input.sha256, "artifact.sha256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw invalidRequest("artifact.sha256 must be a SHA-256 digest");
  const objectGeneration = optionalString(input.objectGeneration);
  return {
    uri: requiredString(input.uri, "artifact.uri"),
    key: requiredString(input.key, "artifact.key"),
    contentType: requiredString(input.contentType, "artifact.contentType"),
    bytes,
    sha256,
    ...(objectGeneration ? { objectGeneration } : {})
  };
}

function assertBoardArtifactScope(task: BoardTask, buildTaskId: string, artifact: ContextArtifactRef): void {
  const repository = requiredRepositoryName(task.metadata.repository, "repository");
  if (
    artifact.contentType !== "application/json" ||
    !isContextArtifactKeyInScope(artifact.key, {
      tenantId: requiredString(task.metadata.tenantId, "tenantId"),
      repository,
      buildId: buildTaskId
    })
  ) {
    throw invalidRequest("artifact does not belong to the leased context build");
  }
}

function assertBoardArtifactReadable(
  task: BoardTask,
  buildTaskId: string,
  artifact: ContextArtifactRef
): ReturnType<typeof parseContextPriorReleaseSeed> | undefined {
  try {
    assertBoardArtifactScope(task, buildTaskId, artifact);
    return undefined;
  } catch {
    // The admission-bound prior release is the sole cross-build artifact read.
  }
  if (task.metadata.priorRelease === undefined) {
    throw invalidRequest("artifact does not belong to the leased context build");
  }
  let priorRelease: ReturnType<typeof parseContextPriorReleaseSeed>;
  try {
    priorRelease = parseContextPriorReleaseSeed(task.metadata.priorRelease);
  } catch {
    throw invalidRequest("leased Context build has an invalid prior-release seed");
  }
  if (
    priorRelease.tenantId !== task.metadata.tenantId ||
    priorRelease.repository !== task.metadata.repository ||
    priorRelease.ref !== task.metadata.ref ||
    !sameArtifactIdentity(priorRelease.releaseArtifact, artifact)
  ) {
    throw invalidRequest("artifact is outside the leased Context build and its prior-release seed");
  }
  return priorRelease;
}

function sameArtifactIdentity(left: ContextArtifactRef, right: ContextArtifactRef): boolean {
  return (
    left.uri === right.uri &&
    left.key === right.key &&
    left.contentType === right.contentType &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.objectGeneration === right.objectGeneration
  );
}

function assertCurrentTaskOutputArtifact(
  task: BoardTask,
  buildTaskId: string,
  attempt: number,
  artifact: ContextArtifactRef
): void {
  assertBoardArtifactScope(task, buildTaskId, artifact);
  const prefix = `${contextArtifactScopePrefix({
    tenantId: requiredString(task.metadata.tenantId, "tenantId"),
    repository: requiredRepositoryName(task.metadata.repository, "repository"),
    buildId: buildTaskId
  })}/${contextBoardArtifactKind(task.type)}/`;
  const relative = artifact.key.slice(prefix.length);
  if (
    !artifact.key.startsWith(prefix) ||
    !/^[a-z0-9][a-z0-9._-]{0,480}$/.test(relative) ||
    (task.type !== contextBoardTaskTypes.publication && !relative.startsWith(`${task.id}-attempt-${attempt}-`))
  ) {
    throw invalidRequest("completion artifact was not uploaded by the current task attempt");
  }
}

function tenantBoardView(state: GitHubIntakeState, tenantId: string, allowedRepositories?: ReadonlySet<string>) {
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
  return {
    tasks: state.board.tasks.filter((task) => taskIds.has(task.id)).map(publicBoardTask),
    dependencies: state.board.dependencies.filter(
      (dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)
    ),
    outbox: state.board.outbox.filter((message) => taskIds.has(message.taskId)).map(publicBoardOutboxMessage),
    pullRequests: state.pullRequests.filter(
      (pullRequest) =>
        pullRequest.tenantId === tenantId && (!allowedRepositories || allowedRepositories.has(pullRequest.repository))
    )
  };
}

function publicBoardTask(task: BoardTask): BoardTask {
  if (!isContextBoardTaskType(task.type)) return task;
  const metadata = Object.fromEntries(
    [
      "tenantId",
      "repository",
      "ref",
      "refSequence",
      "commitSha",
      "trigger",
      "contextBuildId",
      "documentPath",
      "pageKey",
      "pass"
    ].flatMap((key) => (task.metadata[key] === undefined ? [] : [[key, task.metadata[key]]]))
  );
  return { ...task, metadata };
}

function publicBoardEvent(state: BoardState, event: BoardState["events"][number]) {
  const task = event.taskId ? findTask(state, event.taskId) : undefined;
  if (!task || !isContextBoardTaskType(task.type) || !event.payload) return event;
  const payload = Object.fromEntries(
    ["verdict", "unsupportedCitationCount", "blockingGapCount", "releaseId", "reason"].flatMap((key) => {
      const value = event.payload?.[key];
      if (value === undefined) return [];
      return [[key, key === "reason" && typeof value === "string" ? value.slice(0, 500) : value]];
    })
  );
  const { payload: _payload, ...withoutPayload } = event;
  return Object.keys(payload).length > 0 ? { ...withoutPayload, payload } : withoutPayload;
}

function publicBoardOutboxMessage(message: BoardState["outbox"][number]) {
  const {
    leaseId: _leaseId,
    writeFenceToken: _writeFenceToken,
    dispatchedLeaseId: _dispatchedLeaseId,
    ...publicMessage
  } = message;
  return publicMessage;
}

function findWorkerCompletionReceipt(
  state: BoardState,
  messageId: BoardOutboxMessageId,
  taskId: TaskId,
  attempt: number,
  outcome: "done" | "failed"
): BoardState["events"][number] | undefined {
  return state.events.find(
    (event) =>
      event.taskId === taskId &&
      event.type === "task.worker_completion_recorded" &&
      event.payload?.messageId === messageId &&
      event.payload.attempt === attempt &&
      event.payload.outcome === outcome
  );
}

function findModelUsageReceipt(
  state: BoardState,
  messageId: BoardOutboxMessageId,
  taskId: TaskId,
  attempt: number,
  outcome: "retry"
): BoardState["events"][number] | undefined {
  return state.events.find(
    (event) =>
      event.taskId === taskId &&
      event.type === "task.model_usage_recorded" &&
      event.payload?.messageId === messageId &&
      event.payload.attempt === attempt &&
      event.payload.outcome === outcome
  );
}

function modelUsageReceipt(
  modelUsage:
    | {
        readonly inputTokens: number;
        readonly cachedInputTokens: number;
        readonly outputTokens: number;
      }
    | undefined
): Readonly<Record<string, unknown>> {
  return modelUsage
    ? {
        modelUsageObserved: true,
        modelUsageDigest: modelUsageDigest(modelUsage),
        modelInputTokens: modelUsage.inputTokens,
        modelCachedInputTokens: modelUsage.cachedInputTokens,
        modelOutputTokens: modelUsage.outputTokens
      }
    : { modelUsageObserved: false };
}

function assertModelUsageReplay(
  receipt: Readonly<Record<string, unknown>> | undefined,
  modelUsage:
    | {
        readonly inputTokens: number;
        readonly cachedInputTokens: number;
        readonly outputTokens: number;
      }
    | undefined
): void {
  const expectedObserved = receipt?.modelUsageObserved;
  const suppliedObserved = modelUsage !== undefined;
  if (
    typeof expectedObserved !== "boolean" ||
    expectedObserved !== suppliedObserved ||
    (modelUsage && receipt?.modelUsageDigest !== modelUsageDigest(modelUsage))
  ) {
    throw new ContextQuotaInvariantError(
      "reservation_conflict",
      "replayed worker completion changed the model usage settlement"
    );
  }
}

function modelUsageDigest(modelUsage: {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}): string {
  return createHash("sha256")
    .update(`${modelUsage.inputTokens}:${modelUsage.cachedInputTokens}:${modelUsage.outputTokens}`, "utf8")
    .digest("hex");
}

function workerFailureCategory(value: unknown): string {
  if (value === undefined) return "worker_execution";
  const category = requiredString(value, "failureCategory");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(category)) {
    throw invalidRequest("failureCategory must be a stable lowercase identifier");
  }
  return category;
}

function completionEventType(topic: string): string {
  return topic === "run-review" ? "review.completed" : `${topic}.completed`;
}

function parseDevWebhook(body: Record<string, unknown>): ParsedGitHubWebhook {
  const repository = requiredRepositoryName(body.repository, "repository");
  const defaultBranch = optionalString(body.defaultBranch);
  const common = {
    repository,
    ...(defaultBranch ? { repositoryDefaultBranch: defaultBranch } : {})
  };
  if (body.ref !== undefined || body.push === true) {
    return {
      ...common,
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
      ...common,
      event: {
        type: "issue.opened",
        issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber"),
        title: optionalString(body.title) ?? "Dev issue"
      }
    };
  }
  return {
    ...common,
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
    [...taskTypeDefinitions, ...RUNTIME_CONTEXT_TASK_TYPE_DEFINITIONS].map((definition) => definition.type)
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
  "/context/webhooks/github",
  "/dev/webhooks/github",
  "/mcp",
  "/board",
  "/overview",
  "/events",
  "/context/build",
  "/context/search",
  "/context/releases",
  "/context/list",
  "/context/read",
  "/context/diff",
  "/context/metrics",
  "/internal/context/access/sync",
  "/internal/context/review-access",
  "/internal/context/tokens",
  "/internal/context/builds/:id/worker-completions",
  "/internal/context/builds/:id/cancel",
  "/internal/context/board/artifacts",
  "/internal/context/board/publish",
  "/internal/context/board/pageindex/attach",
  "/internal/context/board/artifacts/read",
  "/internal/worker/claim",
  "/internal/worker/renew",
  "/internal/worker/release",
  "/internal/worker/complete",
  "/internal/observability"
]);

function metricsRoute(pathname: string): string {
  if (pathname === "/context/builds") return "/context/builds";
  if (pathname.startsWith("/context/builds/") && pathname.endsWith("/progress")) return "/context/builds/:id/progress";
  if (contextBuildRetryRoute(pathname)) return "/context/builds/:id/retry";
  if (contextTaskRetryRoute(pathname)) return "/context/builds/:id/tasks/:taskId/retry";
  if (routeId(pathname, "/internal/context/builds/", "/worker-completions")) {
    return "/internal/context/builds/:id/worker-completions";
  }
  if (routeId(pathname, "/internal/context/builds/", "/cancel")) {
    return "/internal/context/builds/:id/cancel";
  }
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
    (method === "POST" && (pathname === "/context/search" || pathname === "/mcp"))
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

function contextTaskRetryRoute(pathname: string): { readonly buildId: string; readonly taskId: string } | undefined {
  const match = /^\/context\/builds\/([^/]+)\/tasks\/([^/]+)\/retry$/.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return { buildId: match[1], taskId: match[2] };
}

function contextBuildRetryRoute(pathname: string): string | undefined {
  const match = /^\/context\/builds\/([^/]+)\/retry$/.exec(pathname);
  return match?.[1];
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

function strictBase64(value: string, name: string): Uint8Array {
  // Avoid a repeated-group RegExp here. V8's RegExp engine can exhaust the
  // JavaScript stack while validating the multi-megabyte snapshot artifacts
  // accepted by this route. Decode and require an exact canonical round trip
  // instead; Buffer's base64 decoder is iterative and the request is already
  // bounded by MAX_REQUEST_BYTES.
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new ApiError(400, "invalid_request", `${name} must be canonical base64`);
  }
  return decoded;
}

function fingerprintBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function requiredDerivationProgressDocumentPath(value: unknown, field: string): string {
  const candidate = requiredString(value, field);
  try {
    return derivationProgressDocumentPath(candidate);
  } catch {
    throw invalidRequest(`${field} must be a safe extensionless relative path`);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function requiredPositiveIntegerOrZero(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest(`${field} must be a non-negative integer`);
  }
  return value;
}

function requiredModelUsage(value: unknown): {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
} {
  if (!isRecord(value)) {
    throw invalidRequest("modelUsage is required for successful model-backed topics");
  }
  const allowed = new Set(["inputTokens", "cachedInputTokens", "outputTokens"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidRequest("modelUsage contains unsupported fields");
  }
  const inputTokens = requiredPositiveIntegerOrZero(value.inputTokens, "modelUsage.inputTokens");
  const cachedInputTokens = requiredPositiveIntegerOrZero(value.cachedInputTokens, "modelUsage.cachedInputTokens");
  const outputTokens = requiredPositiveIntegerOrZero(value.outputTokens, "modelUsage.outputTokens");
  if (cachedInputTokens > inputTokens) {
    throw invalidRequest("modelUsage.cachedInputTokens cannot exceed inputTokens");
  }
  return { inputTokens, cachedInputTokens, outputTokens };
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
  if (error instanceof BoardContextPublicationError) {
    const status = error.code === "invalid_publication" || error.code === "certification_mismatch" ? 400 : 409;
    return new ApiError(status, error.code, error.message);
  }
  if (error instanceof BoardPageIndexAttachmentError) {
    const status = error.code === "invalid_pageindex_attachment" ? 400 : 409;
    return new ApiError(status, error.code, error.message);
  }
  if (error instanceof ContextQuotaExceededError) {
    return new ApiError(429, error.code, error.message);
  }
  if (error instanceof ContextQuotaInvariantError) {
    return new ApiError(409, error.code, error.message);
  }
  return new ApiError(500, "internal_error", "internal server error", false);
}

function quotaRequestId(request: IncomingMessage): string {
  const supplied = firstHeader(request.headers["x-request-id"])?.trim();
  if (supplied && /^[a-zA-Z0-9._:@/-]{1,240}$/.test(supplied)) return supplied;
  return randomUUID();
}

function contextModelQuotaTaskId(taskId: string, attempt: number): string {
  return `${taskId}:attempt:${attempt}`;
}

async function settleContextModelQuota(
  quota: ContextQuotaService,
  input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly modelUsage?: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
    };
  }
): Promise<void> {
  if (input.modelUsage) {
    await quota.finishModelTask({
      tenantId: input.tenantId,
      taskId: input.taskId,
      ...input.modelUsage
    });
    return;
  }
  try {
    await quota.cancelModelTask({
      tenantId: input.tenantId,
      taskId: input.taskId
    });
  } catch (error) {
    // The Board receipt is the durable idempotency record. If the process died
    // after releasing quota but before replying to the worker, replay observes
    // no active reservation and is already settled.
    if (error instanceof ContextQuotaInvariantError && error.reason === "reservation_not_found") return;
    throw error;
  }
}

async function reconcileActiveContextBuildQuotas(
  quota: ContextQuotaService | undefined,
  state: BoardState,
  tenantId: string
): Promise<void> {
  if (!quota) return;
  const activeBuildIds = state.tasks.flatMap((task) =>
    task.type === contextBoardTaskTypes.build &&
    task.metadata.tenantId === tenantId &&
    !isTerminalTaskStatus(task.status)
      ? [task.id]
      : []
  );
  await quota.reconcileActiveBuilds({ tenantId, activeBuildIds });
}

async function reconcileContextQuotas(
  quota: ContextQuotaService | undefined,
  state: BoardState,
  tenantId: string
): Promise<void> {
  if (!quota) return;
  await reconcileActiveContextBuildQuotas(quota, state, tenantId);
  for (const task of state.tasks) {
    if (
      task.type === contextBoardTaskTypes.build &&
      task.metadata.tenantId === tenantId &&
      isTerminalTaskStatus(task.status)
    ) {
      await settleTerminalReconciledModelQuotas(quota, state, tenantId, task.id);
    }
  }
}

async function settleSupersededContextBuildQuotas(
  quota: ContextQuotaService | undefined,
  state: BoardState,
  tenantId: string,
  buildIds: readonly TaskId[]
): Promise<void> {
  if (!quota || buildIds.length === 0) return;
  await reconcileActiveContextBuildQuotas(quota, state, tenantId);
  for (const buildId of buildIds) {
    await settleTerminalReconciledModelQuotas(quota, state, tenantId, buildId);
  }
}

async function settleTerminalReconciledModelQuotas(
  quota: ContextQuotaService,
  state: BoardState,
  tenantId: string,
  buildId: string
): Promise<void> {
  const messageIds = new Set<BoardOutboxMessageId>();
  for (const event of state.events) {
    if (
      event.type !== "task.aggregate_terminal_outbox_retired" ||
      event.payload?.previousStatus !== "leased" ||
      typeof event.payload.messageId !== "string" ||
      !event.taskId
    ) {
      continue;
    }
    const task = findTask(state, event.taskId);
    if (task?.metadata.contextBuildId !== buildId || task.metadata.tenantId !== tenantId) continue;
    messageIds.add(entityId<"board_outbox_message">(event.payload.messageId));
  }

  for (const messageId of messageIds) {
    const message = findOutboxMessage(state, messageId);
    if (!message || !CONTEXT_MODEL_TOPICS.has(message.topic)) continue;
    await settleContextModelQuota(quota, {
      tenantId,
      taskId: contextModelQuotaTaskId(message.taskId, message.payload.attempt)
    });
  }
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
