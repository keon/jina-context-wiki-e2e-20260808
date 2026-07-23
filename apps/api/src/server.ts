import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyCommand,
  findOutboxMessage,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  renewOutboxLease,
  reduceBoard,
  taskTypeDefinitions,
  type BoardTask,
  type BoardOutboxMessageId,
  type TaskId,
  type CommandActor
} from "@jina/board";
import type { ParsedGitHubWebhook } from "@jina/github";
import { isContextGraphTrigger } from "@jina/github";
import {
  createContextGraph,
  assertionsFromGeneratedContextGraph,
  MemoryContextGraphPipelineCoordinator,
  MemoryContextGraphStore,
  CONTEXT_GRAPH_GENERATOR_VERSION,
  CONTEXT_GRAPH_MAX_HISTORY_LIMIT,
  CONTEXT_GRAPH_PARSER_VERSION,
  CONTEXT_GRAPH_REGISTRY_VERSION,
  RepositoryContextOrchestrator,
  retrievalTemplateNames,
  contextGraphNodeKinds,
  contextGraphStagePrerequisites,
  contextGraphStageRequired,
  contextGraphTaskTypeDependencies,
  contextGraphTaskTypeDefinitions,
  contextGraphTaskTypeTriggers,
  parseGeneratedContextGraph,
  type BlobAnalysis,
  type RepositorySourceObservation,
  type ContextGraphCommand,
  type ContextGraphAssertionBatch,
  type ContextGraphBuildRecord,
  type ContextGraphBuildStatus,
  type ContextGraphBuildTrigger,
  type ContextGraphGlobalWorkflowFilter,
  type ContextGraph,
  type ContextGraphStore,
  type ContextGraphPipelineCoordinator,
  type ContextGraphStageLease,
  type ContextGraphStageRecord,
  type ContextGraphWorkflowCursor,
  type ContextGraphWorkerTopic,
  type ContextGraphNodeKind,
  type RepositoryContextOperation,
  type RepositorySnapshot,
  type RetrievalRequest
} from "@jina/context-graph";
import {
  createLogger,
  errorLogFields,
  MetricsRegistry,
  recordHttpRequest,
  requestTraceContext
} from "@jina/observability";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { prReviewTaskTypeDependencies, prReviewTaskTypeTriggers } from "@jina/review";
import { DomainError, entityId, nowIso } from "@jina/shared-kernel";
import type { SharedTenantSummary } from "@jina/db";
import { createGitHubIntakeState, ingestGitHubWebhook, type GitHubIntakeState } from "./github-intake.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";
import { buildTaskTypeCatalog } from "./task-type-catalog.js";
import { handleGraphMcpRequest, publicGraphQueryResult } from "./mcp.js";
import { publicGraph, publicGraphQueryResult as publicRestGraphQueryResult, publicGraphSummary } from "./graph-api.js";
import {
  graphRouteId,
  isDirectContextGraphRead,
  isPublicGraphRoute,
  isSnapshotExemptInternalRoute,
  metricsRoute
} from "./route-policy.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_GRAPH_SNAPSHOT_BYTES = 25 * 1024 * 1024;
// Context graph writes for large repositories can hold the durable mutation transaction
// for several minutes. Keep the lease comfortably beyond that transaction so the
// owning worker is not fenced while its write is still committing.
const WORKER_LEASE_MS = 30 * 60 * 1000;
const RUN_ACTOR: CommandActor = { type: "run", id: "worker" };
const WORKER_TOPICS = [
  "run-review",
  "run-research",
  "run-publish",
  "run-cleanup",
  "run-context-graph-ingest",
  "run-context-graph-assert",
  "run-context-graph-project"
] as const;

export interface ApiServerConfig {
  readonly githubWebhookSecret?: string;
  /** Emergency/transition switch. Disabled intake acknowledges deliveries without creating work. */
  readonly githubWebhookEnabled?: boolean;
  readonly tenantId?: string;
  readonly tenantAliases?: readonly string[];
  readonly enableDevEndpoints?: boolean;
  readonly simulateRuns?: boolean;
  readonly seedDemo?: boolean;
  readonly stateStore?: ApiStateStore;
  readonly contextGraphStore?: ContextGraphStore;
  readonly contextGraphCoordinator?: ContextGraphPipelineCoordinator;
  /** Read-only resolver backed by the original Jina public identity tables. */
  readonly sharedIdentityResolver?: SharedIdentityResolver;
  readonly internalApiToken?: string;
  /** Read-only credential accepted only by cross-tenant admin graph and operations routes. */
  readonly globalAdminToken?: string;
  /** Narrow server-to-server credential accepted only by public graph routes and ACL synchronization. */
  readonly graphApiToken?: string;
  readonly tenantAdminPrincipalIds?: readonly string[];
  /** Browser origins allowed to call the MCP endpoint. Non-browser clients normally omit Origin. */
  readonly mcpAllowedOrigins?: readonly string[];
}

interface ResolvedRepositoryIdentity {
  readonly tenantId: string;
  readonly githubAccountId: string;
  readonly githubAccountLogin: string;
  readonly githubAccountType: string;
  readonly githubRepositoryId?: string;
  readonly repository: string;
  readonly defaultBranch?: string;
}

interface SharedIdentityResolver {
  resolveRepository(input: {
    readonly githubRepositoryId?: number;
    readonly githubInstallationId?: number;
    readonly repository: string;
  }): Promise<ResolvedRepositoryIdentity | undefined>;
  listTenantIds(): Promise<readonly string[]>;
  listTenants(): Promise<readonly SharedTenantSummary[]>;
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
  /**
   * Optional read-path optimization: return "unchanged" instead of the full
   * snapshot when the stored version is still sinceVersion. Read-only routes
   * poll the snapshot on every request, so skipping the blob transfer and
   * parse when nothing was written dominates their cost.
   */
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

/** Creates the HTTP API without binding a port. */
export function createApiServer(config: ApiServerConfig = {}): Server {
  if (config.globalAdminToken && config.globalAdminToken === config.internalApiToken) {
    throw new Error("globalAdminToken must differ from internalApiToken");
  }
  const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-api" });
  const metrics = new MetricsRegistry();
  const startedAtIso = nowIso();
  let intakeState: GitHubIntakeState = createGitHubIntakeState();
  let publications: readonly PublicationRecord[] = [];
  let devDeliverySequence = 0;
  const deliveries = new DeliveryCache(10_000);
  const contextGraphStore = config.contextGraphStore ?? new MemoryContextGraphStore();
  const contextGraphCoordinator = config.contextGraphCoordinator ?? new MemoryContextGraphPipelineCoordinator();
  const ready = initializeState();
  let mutations = Promise.resolve();
  let transactionActive = false;
  /** Version of the last snapshot restored via loadNewer; 0 = never restored. */
  let restoredVersion = 0;

  function mutate<T>(operation: () => Promise<T>): Promise<T>;
  function mutate<T>(operation: () => Promise<T>, deliveryId: string): Promise<T | undefined>;
  function mutate<T>(operation: () => Promise<T>, deliveryId?: string): Promise<T | undefined> {
    const result = mutations.then(async () => {
      if (!config.stateStore) return operation();
      const updated = await config.stateStore.update(async (stored) => {
        if (stored) restore(stored);
        transactionActive = true;
        try {
          const value = await operation();
          return { state: snapshot(), result: value };
        } finally {
          transactionActive = false;
        }
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

  function restore(stored: ApiSnapshot): void {
    intakeState = stored.intakeState;
    publications = stored.publications;
    devDeliverySequence = stored.devDeliverySequence;
  }

  async function synchronize(): Promise<void> {
    if (!config.stateStore) return;
    const result = mutations.then(reload);
    mutations = result.then(
      () => undefined,
      () => undefined
    );
    await result;
  }

  async function initializeState(): Promise<void> {
    const stored = await config.stateStore?.load();
    if (stored) {
      const migrated = migrateSnapshotTenantAliases(stored, config.tenantId, config.tenantAliases ?? []);
      intakeState = migrated.snapshot.intakeState;
      publications = migrated.snapshot.publications;
      devDeliverySequence = migrated.snapshot.devDeliverySequence;
      if (migrated.changed) await persist();
      if (config.tenantId) await contextGraphStore.migrateTenantAliases(config.tenantId, config.tenantAliases ?? []);
      return;
    }
    if (config.tenantId) await contextGraphStore.migrateTenantAliases(config.tenantId, config.tenantAliases ?? []);
    if (config.seedDemo) {
      devDeliverySequence += 1;
      acceptWebhook(devPullRequestWebhook("omlabs/example", 42, "abc123"), `dev-seed-${devDeliverySequence}`);
      await seedDemoGraph();
      await persist();
    }
  }

  async function seedDemoGraph(): Promise<void> {
    const tenantId = config.tenantId ?? "default";
    const commitSha = "d".repeat(40);
    const blobSha = "b".repeat(40);
    const snapshot: RepositorySnapshot = {
      tenantId,
      repository: "omlabs/example",
      ref: "main",
      commitSha,
      treeSha: "e".repeat(40),
      parents: [],
      committedAt: "2026-07-21T00:00:00.000Z",
      message: "Seed the local MCP graph",
      isDefaultRef: true,
      recordedAt: "2026-07-21T00:00:00.000Z",
      taskId: "dev-mcp-seed",
      files: [{ path: "src/server.ts", blobSha, size: 640 }]
    };
    await contextGraphStore.planIngestion(snapshot);
    await contextGraphStore.applyBlobAnalyses(snapshot, [
      {
        blobSha,
        parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
        language: "typescript",
        symbols: [
          {
            moniker: "src/server.ts#handleWebhook",
            name: "handleWebhook",
            kind: "function",
            signatureHash: "dev-handle-webhook",
            startLine: 12,
            endLine: 34
          }
        ],
        imports: [],
        edges: []
      }
    ]);
    await contextGraphStore.save(
      createContextGraph({
        request: { tenantId, repository: snapshot.repository, ref: snapshot.ref, taskId: snapshot.taskId },
        commitSha,
        generatedAt: snapshot.recordedAt,
        executor: "fixture",
        model: "dev-seed",
        contentAddressed: true,
        generated: {
          summary: "Local MCP development graph",
          nodes: [
            {
              id: "repo",
              kind: "Repository",
              label: snapshot.repository,
              description: "Demo repository",
              evidence: ["src/server.ts:1"]
            },
            {
              id: "file:src/server.ts",
              kind: "File",
              label: "server.ts",
              description: "Demo API server",
              path: "src/server.ts",
              evidence: ["src/server.ts:1"]
            },
            {
              id: "symbol:handleWebhook",
              kind: "Symbol",
              label: "handleWebhook",
              description: "function in src/server.ts",
              path: "src/server.ts",
              evidence: ["src/server.ts:12-34"]
            }
          ],
          edges: [
            {
              source: "repo",
              target: "file:src/server.ts",
              predicate: "CONTAINS",
              plane: "code",
              evidence: ["src/server.ts:1"]
            },
            {
              source: "file:src/server.ts",
              target: "symbol:handleWebhook",
              predicate: "DECLARES",
              plane: "code",
              evidence: ["src/server.ts:12-34"]
            }
          ]
        }
      })
    );
  }

  function snapshot(): ApiSnapshot {
    return { intakeState, publications, devDeliverySequence };
  }

  async function persist(deliveryId?: string): Promise<boolean> {
    if (transactionActive) return true;
    if (!config.stateStore) {
      if (deliveryId) deliveries.add(deliveryId);
      return true;
    }
    return config.stateStore.save(snapshot(), deliveryId);
  }

  async function reload(): Promise<void> {
    const store = config.stateStore;
    if (!store) return;
    if (store.loadNewer) {
      // Local writes leave restoredVersion stale, so the next reload fetches
      // the full snapshot once and re-anchors the version; every later poll
      // with no intervening write is a cheap version probe.
      const result = await store.loadNewer(restoredVersion);
      if (result === "unchanged" || result === undefined) return;
      restore(result.snapshot);
      restoredVersion = result.version;
      return;
    }
    const stored = await store.load();
    if (stored) restore(stored);
  }

  async function hasDelivery(deliveryId: string): Promise<boolean> {
    return config.stateStore ? config.stateStore.hasDelivery(deliveryId) : deliveries.has(deliveryId);
  }

  function acceptWebhook(webhook: ParsedGitHubWebhook, deliveryId: string, identity?: ResolvedRepositoryIdentity) {
    const result = ingestGitHubWebhook(intakeState, webhook, {
      deliveryId,
      now: nowIso(),
      ...(identity
        ? {
            tenantId: identity.tenantId,
            workspaceLabel: identity.githubAccountLogin,
            githubAccountId: identity.githubAccountId
          }
        : config.tenantId
          ? { tenantId: config.tenantId }
          : {})
    });
    intakeState = result.state;
    return result;
  }

  /** Local demo runner only. Context graph work is always claimed by the durable worker. */
  async function drainOneSimulatedRun(): Promise<void> {
    const message = intakeState.board.outbox.find(
      (candidate) => candidate.status === "pending" && !candidate.topic.startsWith("run-context-graph")
    );
    if (!message) return;
    let board = markOutboxDispatched(intakeState.board, message.id, nowIso());
    const task = findTask(board, message.taskId);
    if (!task || task.status !== "queued") {
      intakeState = { ...intakeState, board };
      await persist();
      return;
    }
    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" },
      {
        actor: RUN_ACTOR,
        now: nowIso()
      }
    ).state;
    if (message.topic === "run-publish") {
      const repository = stringValue(task.metadata.repository);
      const pullRequestNumber = Number(task.metadata.pullRequestNumber ?? 0);
      const headSha = stringValue(task.metadata.headSha);
      const key = buildPublicationKey(`${repository}#${pullRequestNumber}`, headSha, "summary");
      publications = upsertPublication(publications, { key, headSha, target: "summary" }).records;
    }
    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "done" },
      {
        actor: RUN_ACTOR,
        now: nowIso()
      }
    ).state;
    intakeState = { ...intakeState, board: reduceBoard(board, nowIso()) };
    await persist();
  }

  const server = createServer((request, response) => {
    const requestStartedAt = Date.now();
    const trace = requestTraceContext(request.headers);
    const requestLogger = logger.withTrace(trace);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const routeLabel = metricsRoute(pathname);
    // Never retain a path this server does not serve: unauthenticated probes
    // control it, so logging it verbatim would persist attacker-chosen (and
    // potentially secret-bearing) strings and mint one unique message per
    // probe. Served routes keep the real path, which is bounded vocabulary.
    const loggedPath = routeLabel === "(unknown)" ? "(unknown)" : pathname;
    // "finish" never fires for client disconnects and incomplete uploads, so
    // "close" is the terminal backstop; the settled flag keeps the normal path
    // (finish then close) counted exactly once.
    let requestSettled = false;
    const settleRequest = (aborted: boolean) => {
      if (requestSettled) return;
      requestSettled = true;
      recordHttpRequest({
        logger: requestLogger,
        metrics,
        method: request.method ?? "GET",
        path: loggedPath,
        route: routeLabel,
        // An abort before headers were sent has no real status; the default
        // 200 on the unsent response must not masquerade as a success.
        statusCode: aborted && !response.headersSent ? 0 : response.statusCode,
        durationMs: Date.now() - requestStartedAt,
        trace,
        aborted,
        quiet: !aborted && (routeLabel === "/health" || routeLabel === "/healthz") && response.statusCode < 400
      });
    };
    response.once("finish", () => settleRequest(false));
    response.once("close", () => settleRequest(true));
    void route(request, response).catch((error: unknown) => {
      // A fully consumed request stream auto-destroys, so request.destroyed
      // does not mean the client left — only a dead response/socket does.
      if (response.destroyed || !response.socket || response.socket.destroyed) {
        // The client is gone: the handler's failure is a consequence of the
        // abort, not a server fault, and the dead response cannot be written.
        // The close-settled http.request record already accounts for it.
        requestLogger.warn("request aborted by client during handling", {
          event: "http.request.client_abort",
          method: request.method,
          path: loggedPath,
          ...errorLogFields(error)
        });
        return;
      }
      const apiError = httpError(error);
      requestLogger.error("API request failed", {
        event: "http.request.error",
        method: request.method,
        path: loggedPath,
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

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await ready;
    const url = new URL(request.url ?? "/", "http://localhost");
    // Published context graph generations and repository ACLs live in their own
    // relational store. Reads must never queue behind board/control-plane
    // mutations; they serve the last atomically published graph head.
    // Internal context graph data-plane and worker-coordination routes likewise
    // never read the JSON api_state snapshot outside mutate(), so they skip
    // the full snapshot reload; completeWork synchronizes its JSON-board
    // branch itself before validating against the snapshot.
    if (
      url.pathname !== "/internal/observability" &&
      !isDirectContextGraphRead(request.method, url.pathname) &&
      !isSnapshotExemptInternalRoute(request.method, url.pathname)
    )
      await synchronize();

    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return;
    }
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      await Promise.all([
        config.stateStore?.ping(),
        contextGraphCoordinator.ping(),
        config.sharedIdentityResolver?.ping()
      ]);
      json(response, 200, {
        ok: true,
        githubWebhookConfigured: Boolean(config.githubWebhookSecret) && config.githubWebhookEnabled !== false,
        storage: config.stateStore ? "postgres" : "memory",
        durableWorker: true
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/task-types") {
      jsonCacheable(
        request,
        response,
        buildTaskTypeCatalog(
          [...taskTypeDefinitions, ...contextGraphTaskTypeDefinitions],
          [...prReviewTaskTypeDependencies, ...contextGraphTaskTypeDependencies],
          [...prReviewTaskTypeTriggers, ...contextGraphTaskTypeTriggers]
        )
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      await handleWebhook(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/dev/webhooks/github" && config.enableDevEndpoints) {
      const body = parseJsonObject(await readRawBody(request));
      const webhook = parseDevWebhook(body);
      const result = await mutate(async () => {
        devDeliverySequence += 1;
        const deliveryId = `dev-${devDeliverySequence}`;
        const accepted = acceptWebhook(webhook, deliveryId);
        await persist(deliveryId);
        return { deliveryId, intake: accepted };
      });
      json(response, 202, {
        accepted: true,
        deliveryId: result.deliveryId,
        outcome: result.intake.outcome,
        createdTaskIds: result.intake.createdTaskIds
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/admin/context-graph") {
      if (!hasGlobalAdminCredential(request, config)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      jsonCacheable(request, response, {
        graphs: [...(await contextGraphStore.listAllSummaries())].sort((left, right) =>
          right.generatedAt.localeCompare(left.generatedAt)
        )
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/admin/context-graph/operations") {
      if (!hasGlobalAdminCredential(request, config)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const filter = adminGlobalWorkflowFilter(url);
      const page = await contextGraphCoordinator.listGlobal(filter);
      const graphTenantIds = (await contextGraphStore.listAllSummaries()).map((graph) => graph.tenantId);
      const identityTenants = config.sharedIdentityResolver ? await config.sharedIdentityResolver.listTenants() : [];
      const identityTenantById = new Map(identityTenants.map((tenant) => [tenant.tenantId, tenant]));
      const activeTenantIds =
        identityTenants.length > 0
          ? identityTenants.map((tenant) => tenant.tenantId)
          : config.tenantId
            ? [config.tenantId]
            : [];
      const tenantIds = filter.tenantId
        ? [filter.tenantId]
        : [
            ...new Set([...activeTenantIds, ...graphTenantIds, ...page.workflows.map(({ build }) => build.tenantId)])
          ].sort();
      const observedAt = nowIso();
      const [tenants, queueDepth] = await Promise.all([
        Promise.all(
          tenantIds.map(async (tenantId) => {
            const identity = identityTenantById.get(tenantId);
            return {
              tenantId,
              ...(identity
                ? {
                    name: identity.name,
                    kind: identity.kind,
                    ...(identity.githubAccountLogin ? { githubAccountLogin: identity.githubAccountLogin } : {}),
                    repositoryCount: identity.repositoryCount,
                    githubConnections: identity.githubConnections
                  }
                : {}),
              workflows: page.workflows.filter(({ build }) => build.tenantId === tenantId),
              metrics: await contextGraphStore.operationalMetrics(tenantId, observedAt)
            };
          })
        ),
        contextGraphCoordinator.countActive(filter.tenantId)
      ]);
      jsonCacheable(request, response, {
        observedAt,
        tenants,
        queueDepth,
        ...(page.nextCursor ? { nextCursor: encodeAdminWorkflowCursor(page.nextCursor) } : {})
      });
      return;
    }

    // Shared-mode workers claim and drain across all active original-Jina tenants.
    // Every request after a claim carries the concrete tenant header instead.
    if (
      config.sharedIdentityResolver &&
      !firstHeader(request.headers["x-jina-tenant-id"]) &&
      hasInternalApiCredential(request, config)
    ) {
      if (request.method === "POST" && url.pathname === "/internal/worker/claim") {
        await claimWork(request, response, await sharedTenantIdsForClaim());
        return;
      }
      if (request.method === "POST" && url.pathname === "/internal/context-graph/outbox/drain") {
        await readRawBody(request);
        const results = await Promise.all(
          (await config.sharedIdentityResolver.listTenantIds()).map((tenantId) =>
            contextGraphStore.drainDerivedProjectionEvents(tenantId, nowIso())
          )
        );
        json(response, 200, {
          processedEventCount: results.reduce((sum, result) => sum + result.processedEventCount, 0),
          rebuiltRepositories: [...new Set(results.flatMap((result) => result.rebuiltRepositories))].sort()
        });
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/internal/graph/access/sync") {
      const syncTenantId = config.sharedIdentityResolver
        ? normalizedTenantId(firstHeader(request.headers["x-jina-tenant-id"]))
        : config.tenantId;
      if (
        !config.graphApiToken ||
        firstHeader(request.headers.authorization) !== `Bearer ${config.graphApiToken}` ||
        !syncTenantId
      ) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      let principalId: string;
      let repositories: string[];
      try {
        const body = parseJsonObject(await readRawBody(request));
        principalId = requiredTenantPrincipal(body.principalId);
        if (config.sharedIdentityResolver && principalId !== `tenant:${syncTenantId}`) {
          throw new Error("principalId must match x-jina-tenant-id");
        }
        if (!Array.isArray(body.repositories) || body.repositories.length > 5_000) {
          throw new Error("repositories must be an array with at most 5000 entries");
        }
        repositories = [
          ...new Set(body.repositories.map((repository) => requiredRepositoryName(repository, "repository")))
        ].sort();
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : "invalid graph access sync" });
        return;
      }
      if (
        config.sharedIdentityResolver &&
        !(await config.sharedIdentityResolver.listTenantIds()).includes(syncTenantId)
      ) {
        json(response, 403, { error: "inactive_tenant" });
        return;
      }
      await contextGraphStore.replaceRepositoryAccess(syncTenantId, principalId, repositories);
      json(response, 200, { principalId, repositoryCount: repositories.length });
      return;
    }

    const principal = authenticatedPrincipal(request, config, url.pathname);
    if (!principal) {
      json(response, 401, { accepted: false, error: "unauthorized" });
      return;
    }
    const { tenantId } = principal;

    const usesGraphCredential = hasGraphApiCredential(request, config);
    const requiresBoundGraphPrincipal =
      isPublicGraphRoute(url.pathname) || (url.pathname === "/context-graph/build" && usesGraphCredential);
    if (
      requiresBoundGraphPrincipal &&
      !config.enableDevEndpoints &&
      !normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"]))
    ) {
      json(response, 401, { error: "a bound principal is required" });
      return;
    }

    if (url.pathname === "/mcp") {
      const origin = firstHeader(request.headers.origin);
      if (origin && !(config.mcpAllowedOrigins ?? []).includes(origin)) {
        json(response, 403, { error: "forbidden" });
        return;
      }
      const parsedBody = request.method === "POST" ? parseJsonValue(await readRawBody(request)) : undefined;
      await handleGraphMcpRequest(
        request,
        response,
        async ({ repository, query, ref }) => {
          const allowedRepositories = await repositoriesForPrincipal(principal);
          const context = await new RepositoryContextOrchestrator(contextGraphStore).answer({
            tenantId,
            allowedRepositories,
            repository,
            question: query,
            ...(ref ? { ref } : {})
          });
          return publicGraphQueryResult(context);
        },
        parsedBody
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/graphs") {
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const requestedRepository = url.searchParams.get("repository")?.trim();
      if (requestedRepository && !allowedRepositories.includes(requestedRepository)) {
        json(response, 404, { error: "graph not found" });
        return;
      }
      const graphs = (await contextGraphStore.listSummaries(tenantId))
        .filter((graph) => allowedRepositories.includes(graph.repository))
        .filter((graph) => !requestedRepository || graph.repository === requestedRepository)
        .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
        .map(publicGraphSummary);
      json(response, 200, { graphs });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/graphs/")) {
      const graphId = graphRouteId(url.pathname, "/v1/graphs/");
      if (graphId === undefined) {
        json(response, 404, { error: "graph not found" });
        return;
      }
      const graph = await contextGraphStore.get(graphId, tenantId);
      const allowedRepositories = await repositoriesForPrincipal(principal);
      if (!graph || !allowedRepositories.includes(graph.repository)) {
        json(response, 404, { error: "graph not found" });
        return;
      }
      json(response, 200, publicGraph(graph));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/graph/query") {
      const body = parseJsonObject(await readRawBody(request));
      const graphId = requiredString(body.graphId, "graphId");
      const query = requiredString(body.query, "query");
      if (query.length > 4_000) throw new Error("query must not exceed 4000 characters");
      const graph = await contextGraphStore.get(graphId, tenantId);
      const allowedRepositories = await repositoriesForPrincipal(principal);
      if (!graph || !allowedRepositories.includes(graph.repository)) {
        json(response, 404, { error: "graph not found" });
        return;
      }
      const context = await new RepositoryContextOrchestrator(contextGraphStore).answer({
        tenantId,
        allowedRepositories,
        repository: graph.repository,
        ref: graph.ref,
        question: query
      });
      json(response, 200, publicRestGraphQueryResult(graph, publicGraphQueryResult(context)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/board") {
      const allowedRepositories = isTenantAdmin(principal)
        ? undefined
        : new Set(await repositoriesForPrincipal(principal));
      const board = tenantBoardView(intakeState, publications, tenantId, allowedRepositories);
      const pipeline = await contextGraphCoordinator.list(
        tenantId,
        allowedRepositories ? { repositories: [...allowedRepositories] } : undefined
      );
      jsonCacheable(request, response, mergePipelineBoardView(board, pipeline, allowedRepositories));
      return;
    }
    if (request.method === "GET" && url.pathname === "/overview") {
      // Single round trip for the dashboard poll: the board and its event
      // history share one ACL lookup and one pipeline listing instead of the
      // separate /board + /events requests duplicating both.
      const allowedRepositories = isTenantAdmin(principal)
        ? undefined
        : new Set(await repositoriesForPrincipal(principal));
      const pipeline = await contextGraphCoordinator.list(
        tenantId,
        allowedRepositories ? { repositories: [...allowedRepositories] } : undefined
      );
      const board = mergePipelineBoardView(
        tenantBoardView(intakeState, publications, tenantId, allowedRepositories),
        pipeline,
        allowedRepositories
      );
      const events = await collectBoardEvents(tenantId, allowedRepositories, pipeline);
      jsonCacheable(request, response, { board, events });
      return;
    }
    if (request.method === "GET" && url.pathname === "/context-graph") {
      const allowedRepositories = await repositoriesForPrincipal(principal);
      // Optional repository/ref scope narrows the summary listing in the
      // store, before its row limit, so a scoped caller's graphs cannot be
      // pushed out of the page by other repositories' fresher heads.
      const repositoryFilter = url.searchParams.get("repository");
      const refFilter = url.searchParams.get("ref");
      const scoped = repositoryFilter !== null || refFilter !== null;
      const dashboardView = url.searchParams.get("view") === "dashboard";
      const includeAssertions = url.searchParams.get("include") === "assertions";
      const assertionStatusValue = url.searchParams.get("assertionStatus");
      const assertionStatus = assertionStatusValue ? requiredAssertionStatus(assertionStatusValue) : undefined;
      const assertionLimitValue = url.searchParams.get("assertionLimit");
      const assertionLimit = assertionLimitValue
        ? requiredPositiveInteger(Number(assertionLimitValue), "assertionLimit")
        : undefined;
      if (assertionLimit && assertionLimit > 500) throw invalidRequest("assertionLimit must not exceed 500");

      // The validator is derived from graph heads and mutation clocks only. Check it
      // before loading node/edge rows, summary pages, entities, or assertions.
      const revision = await contextGraphStore.readRevision(tenantId, {
        repositories: allowedRepositories,
        ...(repositoryFilter ? { repository: repositoryFilter } : {}),
        ...(refFilter ? { ref: refFilter } : {}),
        includeAssertions,
        ...(includeAssertions && repositoryFilter ? { assertionRepository: repositoryFilter } : {}),
        ...(assertionStatus ? { assertionStatus } : {})
      });
      if (respondNotModified(request, response, revision)) return;

      const graphValues = dashboardView
        ? []
        : await contextGraphStore.listSummaries(tenantId, {
            ...(repositoryFilter ? { repository: repositoryFilter } : {}),
            ...(refFilter ? { ref: refFilter } : {})
          });
      const graphs = graphValues.filter((graph) => allowedRepositories.includes(graph.repository));
      // A scoped response must be internally consistent: its latest is the
      // newest graph within the scope (summaries are ordered newest-first),
      // never the unscoped tenant-wide head, which can belong to another
      // repository entirely.
      const latest = dashboardView
        ? await contextGraphStore.latest(tenantId, allowedRepositories, {
            ...(repositoryFilter ? { repository: repositoryFilter } : {}),
            ...(refFilter ? { ref: refFilter } : {})
          })
        : scoped
          ? graphs[0]
            ? await contextGraphStore.get(graphs[0].id, tenantId)
            : undefined
          : await contextGraphStore.latest(tenantId, allowedRepositories);
      const permittedLatest = latest && allowedRepositories.includes(latest.repository) ? latest : null;
      // ?include=assertions folds the assertion-review fetch into this
      // response so the client does not need a dependent second round trip.
      const assertions = includeAssertions
        ? permittedLatest
          ? await contextGraphStore.listAssertions(tenantId, permittedLatest.repository, {
              ...(assertionStatus ? { status: assertionStatus } : {}),
              ...(assertionLimit ? { limit: assertionLimit } : {})
            })
          : []
        : undefined;
      jsonCacheableWithRevision(request, response, revision, {
        latest: permittedLatest,
        graphs,
        ...(assertions ? { assertions } : {})
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/context-graph/graphs/")) {
      const graphId = graphRouteId(url.pathname, "/context-graph/graphs/");
      if (graphId === undefined) {
        json(response, 404, { error: "contextGraph graph not found" });
        return;
      }
      const graph = await contextGraphStore.get(graphId, tenantId);
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const permitted = graph && allowedRepositories.includes(graph.repository) ? graph : undefined;
      json(response, permitted ? 200 : 404, permitted ?? { error: "contextGraph graph not found" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/context-graph/metrics") {
      if (!isTenantAdmin(principal)) {
        json(response, 403, { error: "tenant administrator access required" });
        return;
      }
      const repository = url.searchParams.has("repository")
        ? requiredString(url.searchParams.get("repository"), "repository")
        : undefined;
      const ref = url.searchParams.has("ref") ? requiredString(url.searchParams.get("ref"), "ref") : undefined;
      if (ref && !repository) throw invalidRequest("repository is required when metrics are scoped by ref");
      json(
        response,
        200,
        await contextGraphStore.operationalMetrics(
          tenantId,
          nowIso(),
          repository ? { repository, ...(ref ? { ref } : {}) } : undefined
        )
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/context-graph/retrieve") {
      const body = parseJsonObject(await readRawBody(request));
      const repository = requiredString(body.repository, "repository");
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const template = requiredString(body.template, "template");
      if (!retrievalTemplateNames.includes(template as (typeof retrievalTemplateNames)[number])) {
        throw invalidRequest("unsupported retrieval template");
      }
      const result = await contextGraphStore.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        template: template as (typeof retrievalTemplateNames)[number],
        ...parseContextGraphSelectors(body),
        ...(typeof body.query === "string" ? { query: body.query } : {}),
        ...(typeof body.limit === "number" ? { limit: requiredPositiveInteger(body.limit, "limit") } : {})
      });
      json(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/context-graph/ask") {
      const body = parseJsonObject(await readRawBody(request));
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const orchestrator = new RepositoryContextOrchestrator(contextGraphStore);
      json(
        response,
        200,
        await orchestrator.answer({
          tenantId,
          allowedRepositories,
          repository: requiredString(body.repository, "repository"),
          question: requiredString(body.question, "question"),
          ...parseContextGraphSelectors(body),
          ...(typeof body.operation === "string" ? { operation: requiredContextOperation(body.operation) } : {}),
          ...(typeof body.tokenBudget === "number"
            ? { tokenBudget: requiredPositiveInteger(body.tokenBudget, "tokenBudget") }
            : {})
        })
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/context-graph/assertions") {
      const repository = requiredString(url.searchParams.get("repository"), "repository");
      const allowedRepositories = await repositoriesForPrincipal(principal);
      if (!allowedRepositories.includes(repository)) throw new DomainError("repository access denied", "forbidden");
      const statusValue = url.searchParams.get("status");
      const status = statusValue === null ? undefined : requiredAssertionStatus(statusValue);
      const predicate = url.searchParams.get("predicate")?.trim().toUpperCase() || undefined;
      const entityKindValue = url.searchParams.get("entityKind")?.trim();
      const entityKind =
        entityKindValue && contextGraphNodeKinds.includes(entityKindValue as (typeof contextGraphNodeKinds)[number])
          ? (entityKindValue as (typeof contextGraphNodeKinds)[number])
          : undefined;
      if (entityKindValue && !entityKind) throw invalidRequest("unsupported contextGraph entity kind");
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue ? requiredPositiveInteger(Number(limitValue), "limit") : undefined;
      if (limit && limit > 500) throw invalidRequest("limit must not exceed 500");
      jsonCacheable(request, response, {
        assertions: await contextGraphStore.listAssertions(tenantId, repository, {
          ...(status ? { status } : {}),
          ...(predicate ? { predicate } : {}),
          ...(entityKind ? { entityKind } : {}),
          ...(limit ? { limit } : {})
        })
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/context-graph/commands") {
      // The svc:api fallback is a tenant admin; state-changing context graph commands
      // must carry an explicitly forwarded principal identity.
      if (!principal.forwarded) {
        json(response, 401, { accepted: false, error: "a bound principal is required" });
        return;
      }
      const body = parseJsonObject(await readRawBody(request));
      json(
        response,
        200,
        await contextGraphStore.executeCommand(
          tenantId,
          principal.principalId,
          parseContextGraphCommand(body),
          nowIso(),
          isTenantAdmin(principal)
        )
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const allowedRepositories = isTenantAdmin(principal)
        ? undefined
        : new Set(await repositoriesForPrincipal(principal));
      const workflows = await contextGraphCoordinator.list(
        tenantId,
        allowedRepositories ? { repositories: [...allowedRepositories] } : undefined
      );
      jsonCacheable(request, response, await collectBoardEvents(tenantId, allowedRepositories, workflows));
      return;
    }
    if (request.method === "POST" && url.pathname === "/context-graph/build") {
      const allowedRepositories = isTenantAdmin(principal)
        ? undefined
        : new Set(await repositoriesForPrincipal(principal));
      await createContextGraphTask(request, response, tenantId, allowedRepositories);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/ingest/plan") {
      await planContextGraphIngestion(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/assertions/save") {
      await saveContextGraphAssertions(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/project/run") {
      await runContextGraphProjection(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/ingest/known") {
      await findKnownContextGraphCommits(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/ingest/blobs") {
      await applyContextGraphBlobAnalyses(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/ingest/github") {
      await applyContextGraphGitHubObservations(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/assertions/cached") {
      await findCachedContextGraphAssertions(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/assertions/evidence") {
      await loadContextGraphAssertionEvidence(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/context-graph/outbox/drain") {
      await readRawBody(request);
      json(response, 200, await contextGraphStore.drainDerivedProjectionEvents(tenantId, nowIso()));
      return;
    }
    if (request.method === "GET" && url.pathname === "/internal/observability") {
      json(response, 200, {
        service: process.env.K_SERVICE ?? "jina-api",
        startedAt: startedAtIso,
        metrics: metrics.snapshot()
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/claim") {
      await claimWork(request, response, [tenantId]);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/renew") {
      await renewWork(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/release") {
      await releaseWork(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/complete") {
      await completeWork(request, response, tenantId);
      return;
    }

    json(response, 404, { error: "not found" });
  }

  async function handleWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readRawBody(request);
    if (config.githubWebhookEnabled === false) {
      json(response, 202, {
        accepted: false,
        reason: "GitHub webhook intake is disabled; original Jina owns review intake"
      });
      return;
    }
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
    const identity = result.webhook ? await resolveWebhookIdentity(result.webhook) : undefined;
    if (result.webhook && isContextGraphTrigger(result.webhook.event)) {
      const event = result.webhook.event;
      const ref = event.ref.slice("refs/heads/".length);
      const tenantId = identity?.tenantId ?? config.tenantId ?? "default";
      const builds = await contextGraphCoordinator.list(tenantId, {
        repositories: [result.webhook.repository]
      });
      const latest = builds
        .filter(({ build }) => build.repository === result.webhook!.repository && build.ref === ref)
        .sort((left, right) => right.build.createdAt.localeCompare(left.build.createdAt))[0];
      const duplicateHead = latest?.build.metadata.githubHeadSha === event.headSha;
      let createdTaskIds: readonly string[] = [];
      if (!duplicateHead) {
        const build = await contextGraphCoordinator.createBuild({
          tenantId,
          repository: result.webhook.repository,
          ref,
          requestKey: `push:${event.headSha}:delivery:${result.deliveryId}`,
          dedupeHeadSha: event.headSha,
          snapshotFirst: true,
          createdAt: nowIso(),
          metadata: {
            githubDeliveryId: result.deliveryId,
            githubHeadSha: event.headSha,
            ...(identity
              ? {
                  workspaceLabel: identity.githubAccountLogin,
                  githubAccountId: identity.githubAccountId,
                  githubAccountType: identity.githubAccountType
                }
              : {}),
            ...(result.webhook.repositoryId !== undefined ? { githubRepositoryId: result.webhook.repositoryId } : {}),
            ...(result.webhook.installationId !== undefined
              ? { githubInstallationId: result.webhook.installationId }
              : {})
          }
        });
        const workflow = (
          await contextGraphCoordinator.list(build.tenantId, { repositories: [build.repository] })
        ).find((candidate) => candidate.build.id === build.id);
        createdTaskIds = [build.id, ...(workflow?.stages.map((stage) => stage.id) ?? [])];
      }
      const committed = await mutate(async () => {
        if (!config.stateStore) await persist(result.deliveryId);
        return true;
      }, result.deliveryId);
      if (!committed) {
        metrics.count("github.webhooks", { outcome: "duplicate" });
        json(response, 200, { accepted: true, duplicate: true, deliveryId: result.deliveryId });
        return;
      }
      const outcome = duplicateHead ? "duplicate" : "created";
      logger.info(`github webhook ${result.deliveryId}: ${outcome}`, {
        event: "github.webhook",
        deliveryId: result.deliveryId,
        repository: result.webhook.repository,
        outcome,
        createdTaskCount: createdTaskIds.length
      });
      metrics.count("github.webhooks", { outcome });
      json(response, result.statusCode, {
        accepted: true,
        deliveryId: result.deliveryId,
        outcome,
        createdTaskIds
      });
      return;
    }
    const committed = await mutate(async () => {
      if (!result.webhook) {
        await persist(result.deliveryId);
        return { statusCode: result.statusCode, payload: result };
      }
      const intake = acceptWebhook(result.webhook, result.deliveryId!, identity);
      await persist(result.deliveryId);
      return {
        statusCode: result.statusCode,
        payload: {
          accepted: true,
          deliveryId: result.deliveryId,
          outcome: intake.outcome,
          createdTaskIds: intake.createdTaskIds
        }
      };
    }, result.deliveryId);
    if (!committed) {
      metrics.count("github.webhooks", { outcome: "duplicate" });
      json(response, 200, { accepted: true, duplicate: true, deliveryId: result.deliveryId });
      return;
    }
    if (result.webhook) {
      const payload = committed.payload as { outcome?: string; createdTaskIds?: readonly string[] };
      const outcome = payload.outcome ?? "accepted";
      logger.info(`github webhook ${result.deliveryId}: ${outcome}`, {
        event: "github.webhook",
        deliveryId: result.deliveryId,
        repository: result.webhook.repository,
        outcome,
        createdTaskCount: payload.createdTaskIds?.length ?? 0
      });
      metrics.count("github.webhooks", { outcome });
    }
    json(response, committed.statusCode, committed.payload);
  }

  async function resolveWebhookIdentity(webhook: ParsedGitHubWebhook): Promise<ResolvedRepositoryIdentity | undefined> {
    if (!config.sharedIdentityResolver) return undefined;
    const identity = await config.sharedIdentityResolver.resolveRepository({
      repository: webhook.repository,
      ...(webhook.repositoryId !== undefined ? { githubRepositoryId: webhook.repositoryId } : {}),
      ...(webhook.installationId !== undefined ? { githubInstallationId: webhook.installationId } : {})
    });
    if (!identity) {
      throw new ApiError(
        409,
        "repository_tenant_not_found",
        `repository ${webhook.repository} is not enabled for an original Jina tenant`
      );
    }
    if (identity.repository.toLowerCase() !== webhook.repository.toLowerCase()) {
      throw new ApiError(409, "repository_identity_mismatch", "resolved repository identity does not match webhook");
    }
    if (webhook.repositoryId !== undefined && identity.githubRepositoryId !== String(webhook.repositoryId)) {
      throw new ApiError(409, "repository_identity_mismatch", "resolved GitHub repository ID does not match webhook");
    }
    return identity;
  }

  async function createContextGraphTask(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string,
    allowedRepositories?: ReadonlySet<string>
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const repository = requiredRepositoryName(body.repository, "repository");
    if (allowedRepositories && !allowedRepositories.has(repository)) {
      throw new DomainError("repository access denied", "forbidden");
    }
    const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : "main";
    const suppliedRequestKey =
      typeof body.requestKey === "string" && body.requestKey.trim() ? body.requestKey.trim() : undefined;
    const requestKey = suppliedRequestKey ?? randomUUID();
    const metadata = parseContextGraphBuildMetadata(body.metadata);
    const githubInstallationId = await contextGraphInstallationId(body, metadata, tenantId, repository);
    const created = await contextGraphCoordinator.createBuild({
      tenantId,
      repository,
      ref,
      requestKey,
      snapshotFirst: body.snapshotFirst !== false,
      createdAt: nowIso(),
      metadata: { ...metadata, githubInstallationId }
    });
    json(response, 202, { accepted: true, task: pipelineBuildTask(created) });
  }

  async function contextGraphInstallationId(
    body: Record<string, unknown>,
    metadata: Readonly<Record<string, unknown>> | undefined,
    tenantId: string,
    repository: string
  ): Promise<number> {
    const supplied = [
      body.githubInstallationId,
      body.github_installation_id,
      body.installationId,
      metadata?.githubInstallationId
    ].filter((value) => value !== undefined);
    if (supplied.length > 0) {
      const installationIds = supplied.map((value) => requiredPositiveInteger(value, "githubInstallationId"));
      if (new Set(installationIds).size !== 1) throw invalidRequest("GitHub installation id fields must agree");
      const githubInstallationId = installationIds[0]!;
      if (config.sharedIdentityResolver) {
        const identity = await config.sharedIdentityResolver.resolveRepository({
          repository,
          githubInstallationId
        });
        if (
          !identity ||
          identity.tenantId !== tenantId ||
          identity.repository.toLowerCase() !== repository.toLowerCase()
        ) {
          throw new ApiError(
            409,
            "repository_installation_mismatch",
            "repository, tenant, and GitHub installation do not identify one active installation"
          );
        }
      }
      return githubInstallationId;
    }

    const latest = (await contextGraphCoordinator.list(tenantId, { repositories: [repository] }))
      .filter(({ build }) => build.repository === repository)
      .sort((left, right) => right.build.createdAt.localeCompare(left.build.createdAt))
      .find(({ build }) => {
        const value = build.metadata.githubInstallationId;
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      });
    const recorded = latest?.build.metadata.githubInstallationId;
    if (typeof recorded === "number" && Number.isSafeInteger(recorded) && recorded > 0) return recorded;
    if (config.enableDevEndpoints) return 1;
    throw invalidRequest("githubInstallationId is required for context graph builds");
  }

  /**
   * Durable stage work runs on these dedicated long-window routes so that
   * completion stays a fast status flip; the worker's 30-second completion
   * timeout no longer races multi-minute canonical writes.
   */
  async function saveContextGraphAssertions(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request, MAX_CONTEXT_GRAPH_SNAPSHOT_BYTES));
    const taskId = requiredString(body.taskId, "taskId");
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-assert");
    const result = await contextGraphStore.saveAssertionBatch(
      parseContextGraphAssertionBatch(body.assertionBatch, { id: task.stageId, metadata: task.metadata }, tenantId),
      { stageId: task.stageId, leaseId: task.leaseId }
    );
    json(response, 200, result);
  }

  async function runContextGraphProjection(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-project");
    const now = nowIso();
    const repository = requiredString(task.metadata.repository, "task.repository");
    const ref = requiredString(task.metadata.ref, "task.ref");
    const existingGraphIds = new Set((await contextGraphStore.listSummaries(tenantId)).map((summary) => summary.id));
    // Drain and rebuild produce disposable, rebuildable read models, so a lease
    // lost mid-run cannot corrupt canonical state; the graph save below is the
    // only publication and stays fenced. Still, re-check the lease between the
    // expensive steps so a superseded worker stops early instead of spending
    // minutes on work whose publication will be rejected.
    const drained = await contextGraphStore.drainDerivedProjectionEvents(tenantId, now);
    await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-project");
    const rebuilt = await contextGraphStore.rebuildDerivedProjections(tenantId, repository, ref, now);
    await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-project");
    const graph = await contextGraphStore.project({
      tenantId,
      repository,
      ref,
      commitSha: requiredGitSha(task.metadata.commitSha, "task.commitSha"),
      taskId: task.stageId,
      generatedAt: now,
      writeFence: { stageId: task.stageId, leaseId: task.leaseId }
    });
    json(response, 200, {
      ...rebuilt,
      drainedEventCount: drained.processedEventCount,
      rebuiltRepositories: drained.rebuiltRepositories,
      effect: rebuilt.rebuilt || !existingGraphIds.has(graph.id) ? "changed" : "noop",
      graphId: graph.id,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      commitSha: graph.commitSha
    });
  }

  async function planContextGraphIngestion(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request, MAX_CONTEXT_GRAPH_SNAPSHOT_BYTES));
    const snapshot = parseRepositorySnapshot(body.snapshot, tenantId);
    const task = await requireLeasedContextGraphTask(body, snapshot.taskId, tenantId, "run-context-graph-ingest");
    if (snapshot.repository !== task.metadata.repository || snapshot.ref !== task.metadata.ref) {
      throw invalidRequest("repository snapshot does not match contextGraph task");
    }
    const plan = await contextGraphStore.planIngestion(snapshot, { stageId: task.stageId, leaseId: task.leaseId });
    json(response, 200, plan);
  }

  async function findKnownContextGraphCommits(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-ingest");
    if (!Array.isArray(body.commitShas)) throw invalidRequest("commitShas must be an array");
    const commitShas = body.commitShas.map((sha) => requiredGitSha(sha, "commitSha"));
    json(response, 200, {
      knownCommitShas: await contextGraphStore.knownCommits(
        tenantId,
        requiredString(task.metadata.repository, "task.repository"),
        commitShas
      )
    });
  }

  async function applyContextGraphBlobAnalyses(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const commitSha = requiredGitSha(body.commitSha, "commitSha");
    const analyses = parseBlobAnalyses(body.analyses);
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-ingest");
    await contextGraphStore.applyBlobAnalyses(
      {
        tenantId,
        repository: requiredString(task.metadata.repository, "task.repository"),
        commitSha
      },
      analyses,
      { stageId: task.stageId, leaseId: task.leaseId }
    );
    json(response, 200, { accepted: true, count: analyses.length });
  }

  async function applyContextGraphGitHubObservations(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    if (!Array.isArray(body.observations)) throw invalidRequest("observations must be an array");
    const observations = body.observations.map((value) => parseRepositorySourceObservation(value, tenantId));
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-ingest");
    const repository = requiredString(task.metadata.repository, "task.repository");
    if (observations.some((observation) => observation.repository !== repository)) {
      throw invalidRequest("GitHub observation repository does not match task");
    }
    const result = await contextGraphStore.applyGitHubObservations(observations, {
      stageId: task.stageId,
      leaseId: task.leaseId
    });
    json(response, 200, result);
  }

  async function findCachedContextGraphAssertions(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-assert");
    // Generations are content-addressed by (commit, generator, registry, evidence
    // fingerprint), so a batch persisted by a worker that later lost its lease is
    // byte-identical to what a retry would produce; serving it here is safe reuse.
    const cached = await contextGraphStore.hasAssertionGeneration(
      tenantId,
      requiredString(task.metadata.repository, "task.repository"),
      requiredGitSha(body.commitSha, "commitSha"),
      CONTEXT_GRAPH_GENERATOR_VERSION,
      CONTEXT_GRAPH_REGISTRY_VERSION,
      requiredString(body.evidenceFingerprint, "evidenceFingerprint")
    );
    json(response, 200, { cached: cached ?? null });
  }

  async function loadContextGraphAssertionEvidence(
    request: IncomingMessage,
    response: ServerResponse,
    tenantId: string
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = await requireLeasedContextGraphTask(body, taskId, tenantId, "run-context-graph-assert");
    const repository = requiredString(task.metadata.repository, "task.repository");
    const observationIds = Array.isArray(task.metadata.sourceObservationIds)
      ? task.metadata.sourceObservationIds.map((id) => requiredString(id, "task.sourceObservationIds"))
      : [];
    const evidence = await contextGraphStore.loadAssertionEvidence(tenantId, repository, observationIds);
    json(response, 200, { evidence });
  }

  async function requireLeasedContextGraphTask(
    body: Record<string, unknown>,
    taskId: string,
    tenantId: string,
    topic: ContextGraphWorkerTopic
  ): Promise<ContextGraphStageLease & { readonly id: string }> {
    const messageId = requiredString(body.messageId, "messageId");
    if (messageId !== taskId) throw new ApiError(409, "stale_lease", "stale contextGraph worker lease");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const stage = await contextGraphCoordinator.leasedStage({
      tenantId,
      stageId: taskId,
      leaseId,
      topic,
      now: nowIso()
    });
    if (!stage) throw new ApiError(409, "stale_lease", "stale contextGraph worker lease");
    return { ...stage, id: stage.stageId };
  }

  async function sharedTenantIdsForClaim(): Promise<readonly string[]> {
    return [...new Set(await config.sharedIdentityResolver!.listTenantIds())].sort();
  }

  async function claimWork(
    request: IncomingMessage,
    response: ServerResponse,
    tenantIds: readonly string[]
  ): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerId = requiredString(body.workerId, "workerId");
    if (!Array.isArray(body.topics) || body.topics.length === 0)
      throw invalidRequest("at least one supported topic is required");
    const topics = body.topics.map((topic) => requiredString(topic, "topics"));
    const unsupportedTopics = topics.filter(
      (topic) => !WORKER_TOPICS.includes(topic as (typeof WORKER_TOPICS)[number])
    );
    if (unsupportedTopics.length > 0)
      throw invalidRequest(`unsupported worker topics: ${unsupportedTopics.join(", ")}`);
    const requestedTopics = topics as (typeof WORKER_TOPICS)[number][];
    const contextGraphTopics = requestedTopics.filter(isContextGraphWorkerTopic);
    if (contextGraphTopics.length > 0 && tenantIds.length > 0) {
      const now = nowIso();
      const claimed = await contextGraphCoordinator.claim({
        tenantId: tenantIds[0]!,
        ...(tenantIds.length > 1 ? { tenantIds } : {}),
        workerId,
        topics: contextGraphTopics,
        now,
        leaseExpiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString()
      });
      if (claimed) {
        json(response, 200, claimed);
        return;
      }
    }
    if (contextGraphTopics.length === requestedTopics.length) {
      json(response, 204, {});
      return;
    }
    const tenantIdSet = new Set(tenantIds);
    const claimed = await mutate(async () => {
      const taskIds = intakeState.board.tasks
        .filter(
          (task) =>
            typeof task.metadata.tenantId === "string" &&
            tenantIdSet.has(task.metadata.tenantId) &&
            (task.status === "queued" || task.status === "in_progress")
        )
        .map((task) => task.id);
      const now = nowIso();
      const leaseId = randomUUID();
      const leased = leaseNextOutboxMessage(intakeState.board, {
        topics: requestedTopics,
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
          {
            actor: { type: "run", id: workerId },
            now
          }
        ).state;
      }
      intakeState = { ...intakeState, board };
      await persist();
      return { message: leased.message, task: findTask(board, task.id) };
    });
    json(response, claimed ? 200 : 204, claimed ?? {});
  }

  async function renewWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const rawMessageId = requiredString(body.messageId, "messageId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    if (rawMessageId.startsWith("context-graph-stage_")) {
      const now = nowIso();
      const renewed = await contextGraphCoordinator.renew({
        tenantId,
        stageId: rawMessageId,
        leaseId,
        now,
        leaseExpiresAt: new Date(Date.now() + WORKER_LEASE_MS).toISOString()
      });
      if (!renewed) throw staleLease();
      json(response, 200, { accepted: true });
      return;
    }
    const messageId = entityId<"board_outbox_message">(rawMessageId) as BoardOutboxMessageId;
    const renewed = await mutate(async () => {
      const message = findOutboxMessage(intakeState.board, messageId);
      const task = message ? findTask(intakeState.board, message.taskId) : undefined;
      if (!task || task.metadata.tenantId !== tenantId || task.status !== "in_progress") return false;
      const now = nowIso();
      const board = renewOutboxLease(
        intakeState.board,
        messageId,
        leaseId,
        now,
        new Date(Date.now() + WORKER_LEASE_MS).toISOString()
      );
      if (!board) return false;
      intakeState = { ...intakeState, board };
      await persist();
      return true;
    });
    if (!renewed) throw staleLease();
    json(response, 200, { accepted: true });
  }

  async function releaseWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = requiredString(body.messageId, "messageId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const reason = requiredString(body.reason, "reason").slice(0, 500);
    if (!messageId.startsWith("context-graph-stage_")) {
      throw invalidRequest("only contextGraph task-board leases can be released");
    }
    const released = await contextGraphCoordinator.release({
      tenantId,
      stageId: messageId,
      leaseId,
      now: nowIso(),
      reason
    });
    if (!released) throw staleLease();
    json(response, 200, { accepted: true });
  }

  async function completeWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const rawMessageId = requiredString(body.messageId, "messageId");
    const leaseId = requiredString(body.leaseId, "leaseId");
    const outcome = body.outcome;
    if (outcome !== "done" && outcome !== "failed") throw invalidRequest("outcome must be done or failed");
    const rawTaskId = requiredString(body.taskId, "taskId");
    if (rawMessageId.startsWith("context-graph-stage_") || rawTaskId.startsWith("context-graph-stage_")) {
      if (rawMessageId !== rawTaskId) throw staleLease();
      const graph = await completeContextGraphStage(body, tenantId, rawTaskId, leaseId, outcome);
      json(response, 200, { accepted: true, graphId: graph?.id });
      return;
    }
    const messageId = entityId<"board_outbox_message">(rawMessageId) as BoardOutboxMessageId;
    const taskId = entityId<"task">(rawTaskId) as TaskId;
    // JSON-board completions validate against the snapshot outside mutate(),
    // so reload it here; the route-level gate skips it for worker routes.
    await synchronize();
    const task = findTask(intakeState.board, taskId);
    if (!task || task.metadata.tenantId !== tenantId) {
      throw new ApiError(404, "not_found", "task not found");
    }
    const result = await mutate(async () => {
      const message = findOutboxMessage(intakeState.board, messageId);
      const currentTask = findTask(intakeState.board, taskId);
      const now = nowIso();
      if (
        !message ||
        !currentTask ||
        message.taskId !== taskId ||
        message.status !== "leased" ||
        message.leaseId !== leaseId ||
        !message.leaseExpiresAt ||
        message.leaseExpiresAt <= now ||
        currentTask.status !== "in_progress" ||
        currentTask.metadata.tenantId !== tenantId
      ) {
        return false;
      }
      const previousIntakeState = intakeState;
      const previousPublications = publications;
      let board = markOutboxDispatched(intakeState.board, message.id, now);
      const eventPayload = safeResultPayload(body.result);
      board = applyCommand(
        board,
        {
          command: "CommentTask",
          taskId,
          eventType: outcome === "failed" ? `${message.topic}.failed` : completionEventType(message.topic),
          payload:
            outcome === "failed" ? { reason: stringValue(body.reason, "worker failed").slice(0, 2000) } : eventPayload
        },
        { actor: RUN_ACTOR, now }
      ).state;
      if (outcome === "done" && message.topic === "run-publish") {
        const repository = stringValue(currentTask.metadata.repository);
        const pullRequestNumber = Number(currentTask.metadata.pullRequestNumber ?? 0);
        const headSha = stringValue(currentTask.metadata.headSha);
        const key = buildPublicationKey(`${repository}#${pullRequestNumber}`, headSha, "summary");
        publications = upsertPublication(publications, { key, headSha, target: "summary" }).records;
      }
      board = applyCommand(
        board,
        {
          command: "TransitionTask",
          taskId,
          toStatus: outcome
        },
        { actor: RUN_ACTOR, now }
      ).state;
      intakeState = { ...intakeState, board: reduceBoard(board, now) };
      try {
        await persist();
      } catch (error) {
        intakeState = previousIntakeState;
        publications = previousPublications;
        throw error;
      }
      return true;
    });
    if (!result) throw staleLease();
    json(response, 200, { accepted: true });
  }

  async function completeContextGraphStage(
    body: Readonly<Record<string, unknown>>,
    tenantId: string,
    stageId: string,
    leaseId: string,
    outcome: "done" | "failed"
  ): Promise<ContextGraph | undefined> {
    const now = nowIso();
    const stage = await contextGraphCoordinator.leasedStage({ tenantId, stageId, leaseId, now });
    if (!stage) throw staleLease();
    if (outcome === "failed") {
      const completed = await contextGraphCoordinator.complete({
        tenantId,
        stageId,
        leaseId,
        outcome,
        now,
        reason: stringValue(body.reason, "worker failed").slice(0, 2_000)
      });
      if (!completed) throw staleLease();
      return undefined;
    }

    const rawResult = isRecord(body.result) ? body.result : {};
    let result: Record<string, unknown> = safeResultPayload(rawResult);
    let nextMetadata: Record<string, unknown> = {};
    let graph: ContextGraph | undefined;
    if (stage.topic === "run-context-graph-ingest") {
      nextMetadata = contextGraphIngestCompletionMetadata(rawResult);
      result = { ...result, ...nextMetadata };
    } else if (stage.topic === "run-context-graph-assert") {
      if (body.assertionBatch !== undefined) {
        // Legacy in-request save for workers deployed before the API.
        await contextGraphStore.saveAssertionBatch(
          parseContextGraphAssertionBatch(
            body.assertionBatch,
            { id: stage.stageId, metadata: stage.metadata },
            tenantId
          ),
          { stageId, leaseId }
        );
      }
      // The completion receipt is derived from durable state bound to this
      // stage's own commit and evidence fingerprint; caller-supplied result
      // payloads are never trusted for canonical fields.
      const generation = await contextGraphStore.hasAssertionGeneration(
        tenantId,
        requiredString(stage.metadata.repository, "task.repository"),
        requiredGitSha(stage.metadata.commitSha, "task.commitSha"),
        CONTEXT_GRAPH_GENERATOR_VERSION,
        CONTEXT_GRAPH_REGISTRY_VERSION,
        requiredString(stage.metadata.evidenceFingerprint, "task.evidenceFingerprint")
      );
      if (!generation) throw invalidRequest("assertion generation is not durable for this stage");
      const assertionResult = safeResultPayload(generation);
      result = { ...assertionResult, effect: isRecord(rawResult.cached) ? "confirmed" : "changed" };
      nextMetadata = {
        commitSha: requiredGitSha(stage.metadata.commitSha, "task.commitSha"),
        knowledgeCheckpoint: requiredString(assertionResult.knowledgeCheckpoint, "knowledgeCheckpoint")
      };
    } else if (isRecord(rawResult.projected)) {
      // Thin completion: verify the projection is durably published for this
      // stage's ref and commit before recording it; canonical fields come from
      // the graph head, not the caller.
      const headState = await contextGraphStore.currentGraphHead(tenantId, stage.repository, stage.ref);
      if (!headState || headState.commitSha !== requiredGitSha(stage.metadata.commitSha, "task.commitSha")) {
        throw invalidRequest("projected graph head is not durable for this stage");
      }
      result = {
        ...safeResultPayload(rawResult.projected),
        graphId: headState.graphId,
        commitSha: headState.commitSha
      };
    } else {
      const existingGraphIds = new Set((await contextGraphStore.listSummaries(tenantId)).map((summary) => summary.id));
      const drained = await contextGraphStore.drainDerivedProjectionEvents(tenantId, now);
      const rebuilt = await contextGraphStore.rebuildDerivedProjections(tenantId, stage.repository, stage.ref, now);
      graph = await contextGraphStore.project({
        tenantId,
        repository: stage.repository,
        ref: stage.ref,
        commitSha: requiredGitSha(stage.metadata.commitSha, "task.commitSha"),
        taskId: stage.stageId,
        generatedAt: now,
        writeFence: { stageId, leaseId }
      });
      result = {
        ...rebuilt,
        drainedEventCount: drained.processedEventCount,
        rebuiltRepositories: drained.rebuiltRepositories,
        effect: rebuilt.rebuilt || !existingGraphIds.has(graph.id) ? "changed" : "noop",
        graphId: graph.id,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        commitSha: graph.commitSha
      };
    }
    const completed = await contextGraphCoordinator.complete({
      tenantId,
      stageId,
      leaseId,
      outcome: "done",
      now: nowIso(),
      result,
      nextMetadata
    });
    if (!completed) throw staleLease();
    return graph;
  }

  function isTenantAdmin(principal: { readonly tenantId?: string; readonly principalId: string }): boolean {
    return (
      principal.principalId.startsWith("svc:") ||
      (principal.tenantId !== undefined && principal.principalId === `tenant:${principal.tenantId}`) ||
      (config.tenantAdminPrincipalIds ?? []).includes(principal.principalId)
    );
  }

  async function collectBoardEvents(
    tenantId: string,
    allowedRepositories: ReadonlySet<string> | undefined,
    workflows: readonly {
      readonly build: ContextGraphBuildRecord;
      readonly stages: readonly ContextGraphStageRecord[];
    }[]
  ) {
    const taskIds = tenantTaskIds(intakeState, tenantId, allowedRepositories);
    const pipelineTaskIds = new Set(
      workflows.flatMap(({ build, stages }) => [build.id, ...stages.map((stage) => stage.id)])
    );
    const pipelineEvents = (await contextGraphCoordinator.listEvents(tenantId, { taskIds: [...pipelineTaskIds] }))
      .filter((event) => pipelineTaskIds.has(event.taskId))
      .map((event, index) => ({ ...event, seq: index + 1 }));
    return [
      ...intakeState.board.events.filter((event) => event.taskId && taskIds.has(event.taskId)),
      ...pipelineEvents
    ].sort((left, right) => left.at.localeCompare(right.at));
  }

  async function repositoriesForPrincipal(principal: {
    readonly tenantId: string;
    readonly principalId: string;
  }): Promise<readonly string[]> {
    return contextGraphStore.repositoriesForPrincipal(
      principal.tenantId,
      isTenantAdmin(principal) ? "svc:tenant-admin" : principal.principalId
    );
  }

  if (config.simulateRuns) {
    const timer = setInterval(
      () =>
        void mutate(drainOneSimulatedRun).catch((error) => logger.error("simulated run failed", errorLogFields(error))),
      1500
    );
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }
  if (config.stateStore) server.once("close", () => void config.stateStore?.close());
  if (config.sharedIdentityResolver) server.once("close", () => void config.sharedIdentityResolver?.close());
  server.once("close", () => void contextGraphCoordinator.close());
  server.once("close", () => void contextGraphStore.close());
  return server;
}

function parseContextGraphBuildMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidRequest("metadata must be an object");
  const allowed = new Set([
    "source",
    "githubDeliveryId",
    "githubRepositoryId",
    "githubInstallationId",
    "pullRequestNumber",
    "pullRequestUrl",
    "reviewRunId",
    "reviewSourceEvent",
    "reviewTriggerRunId",
    "workspaceLabel",
    "githubAccountId",
    "githubAccountType",
    "authorGithubUserId",
    "authorLogin",
    "authorAccountType",
    "senderGithubUserId",
    "senderLogin",
    "senderAccountType",
    "historyLimit"
  ]);
  const metadata: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) throw invalidRequest(`unsupported metadata field: ${key}`);
    if (typeof item !== "string" && typeof item !== "number") {
      throw invalidRequest(`metadata.${key} must be a string or number`);
    }
    if (
      key === "historyLimit" &&
      (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0 || item > CONTEXT_GRAPH_MAX_HISTORY_LIMIT)
    ) {
      throw invalidRequest(`metadata.historyLimit must be an integer from 1 to ${CONTEXT_GRAPH_MAX_HISTORY_LIMIT}`);
    }
    metadata[key] = typeof item === "string" ? item.slice(0, 500) : item;
  }
  return metadata;
}

function adminGlobalWorkflowFilter(url: URL): ContextGraphGlobalWorkflowFilter {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue ? requiredPositiveInteger(Number(limitValue), "limit") : 100;
  if (limit > 500) throw invalidRequest("limit must not exceed 500");
  const tenantId = url.searchParams.get("tenantId")?.trim();
  if (tenantId && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(tenantId)) {
    throw invalidRequest("invalid tenant ID");
  }
  const repositoryValue = url.searchParams.get("repository")?.trim();
  const query = url.searchParams.get("query")?.trim();
  if (query && query.length > 200) throw invalidRequest("query must not exceed 200 characters");
  const statusesValue = url.searchParams.get("statuses")?.trim();
  const statuses = statusesValue
    ? statusesValue.split(",").map((status) => requiredContextGraphBuildStatus(status))
    : undefined;
  const triggerValue = url.searchParams.get("trigger")?.trim();
  const trigger = triggerValue ? requiredContextGraphBuildTrigger(triggerValue) : undefined;
  const createdAfterValue = url.searchParams.get("createdAfter")?.trim();
  const activityAfterValue = url.searchParams.get("activityAfter")?.trim();
  return {
    limit,
    ...(url.searchParams.get("cursor") ? { cursor: decodeAdminWorkflowCursor(url.searchParams.get("cursor")!) } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(repositoryValue ? { repository: requiredRepositoryName(repositoryValue, "repository") } : {}),
    ...(statuses ? { statuses } : {}),
    ...(trigger ? { trigger } : {}),
    ...(query ? { query } : {}),
    ...(createdAfterValue ? { createdAfter: requiredIsoInstant(createdAfterValue, "createdAfter") } : {}),
    ...(activityAfterValue ? { activityAfter: requiredIsoInstant(activityAfterValue, "activityAfter") } : {})
  };
}

function requiredContextGraphBuildStatus(value: string): ContextGraphBuildStatus {
  if (["queued", "in_progress", "enriching", "done", "failed", "superseded"].includes(value)) {
    return value as ContextGraphBuildStatus;
  }
  throw invalidRequest("unsupported context graph build status");
}

function requiredContextGraphBuildTrigger(value: string): ContextGraphBuildTrigger {
  if (["webhook", "manual", "scheduled", "api"].includes(value)) {
    return value as ContextGraphBuildTrigger;
  }
  throw invalidRequest("unsupported context graph build trigger");
}

function requiredIsoInstant(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalidRequest(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function encodeAdminWorkflowCursor(cursor: ContextGraphWorkflowCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAdminWorkflowCursor(value: string): ContextGraphWorkflowCursor {
  if (value.length > 1_000) throw invalidRequest("invalid operations cursor");
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isRecord(cursor) || typeof cursor.id !== "string" || typeof cursor.createdAt !== "string") {
      throw new Error("invalid cursor shape");
    }
    return {
      id: requiredString(cursor.id, "cursor.id"),
      createdAt: requiredIsoInstant(cursor.createdAt, "cursor.createdAt")
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidRequest("invalid operations cursor");
  }
}

function authenticatedPrincipal(
  request: IncomingMessage,
  config: ApiServerConfig,
  pathname: string
): { readonly tenantId: string; readonly principalId: string; readonly forwarded: boolean } | undefined {
  if (config.enableDevEndpoints) {
    return {
      tenantId: firstHeader(request.headers["x-jina-tenant-id"]) ?? config.tenantId ?? "default",
      principalId: "svc:dev",
      forwarded: true
    };
  }
  const authorization = firstHeader(request.headers.authorization);
  const hasInternalAccess = Boolean(config.internalApiToken && authorization === `Bearer ${config.internalApiToken}`);
  const hasGraphAccess = Boolean(
    config.graphApiToken &&
    authorization === `Bearer ${config.graphApiToken}` &&
    (isPublicGraphRoute(pathname) || pathname === "/context-graph/build" || pathname === "/overview")
  );
  if (!hasInternalAccess && !hasGraphAccess) return undefined;
  const tenantId = config.sharedIdentityResolver
    ? normalizedTenantId(firstHeader(request.headers["x-jina-tenant-id"]))
    : config.tenantId;
  if (!tenantId) return undefined;
  const forwarded = normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"]));
  if (config.sharedIdentityResolver && forwarded?.startsWith("tenant:") && forwarded !== `tenant:${tenantId}`) {
    return undefined;
  }
  return { tenantId, principalId: forwarded ?? "svc:api", forwarded: forwarded !== undefined };
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
  if (/^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value.toLowerCase();
  }
  return undefined;
}

function hasGraphApiCredential(request: IncomingMessage, config: ApiServerConfig): boolean {
  return Boolean(
    config.graphApiToken && firstHeader(request.headers.authorization) === `Bearer ${config.graphApiToken}`
  );
}

function hasInternalApiCredential(request: IncomingMessage, config: ApiServerConfig): boolean {
  return Boolean(
    config.internalApiToken && firstHeader(request.headers.authorization) === `Bearer ${config.internalApiToken}`
  );
}

function hasGlobalAdminCredential(request: IncomingMessage, config: ApiServerConfig): boolean {
  return Boolean(
    config.globalAdminToken && firstHeader(request.headers.authorization) === `Bearer ${config.globalAdminToken}`
  );
}

function tenantTaskIds(
  state: GitHubIntakeState,
  tenantId: string,
  allowedRepositories?: ReadonlySet<string>
): Set<TaskId> {
  return new Set(
    state.board.tasks
      .filter(
        (task) =>
          task.metadata.tenantId === tenantId &&
          (!allowedRepositories ||
            (typeof task.metadata.repository === "string" && allowedRepositories.has(task.metadata.repository)))
      )
      .map((task) => task.id)
  );
}

function tenantBoardView(
  state: GitHubIntakeState,
  publications: readonly PublicationRecord[],
  tenantId: string,
  allowedRepositories?: ReadonlySet<string>
) {
  const taskIds = tenantTaskIds(state, tenantId, allowedRepositories);
  const pullRequests = state.pullRequests.filter(
    (pullRequest) =>
      pullRequest.tenantId === tenantId && (!allowedRepositories || allowedRepositories.has(pullRequest.repository))
  );
  const publicationSubjects = pullRequests.map((pullRequest) => `pr:${pullRequest.repository}#${pullRequest.number}:`);
  return {
    tasks: state.board.tasks.filter((task) => taskIds.has(task.id)),
    dependencies: state.board.dependencies.filter(
      (dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)
    ),
    outbox: state.board.outbox.filter((message) => taskIds.has(message.taskId)),
    publications: publications.filter((record) =>
      publicationSubjects.some((subject) => record.key.startsWith(subject))
    ),
    pullRequests
  };
}

function mergePipelineBoardView(
  board: ReturnType<typeof tenantBoardView>,
  pipeline: readonly { readonly build: ContextGraphBuildRecord; readonly stages: readonly ContextGraphStageRecord[] }[],
  allowedRepositories?: ReadonlySet<string>
) {
  const visible = pipeline.filter(({ build }) => !allowedRepositories || allowedRepositories.has(build.repository));
  const pipelineTasks = visible.flatMap(({ build, stages }) => [
    pipelineBuildTask(build),
    ...stages.map((stage) => pipelineStageTask(build, stage))
  ]);
  const dependencies = visible.flatMap(({ build, stages }) =>
    stages.flatMap((stage) =>
      contextGraphStagePrerequisites(stage, build.snapshotFirst).map((prerequisite) => {
        const dependency = stages.find(
          (candidate) => candidate.phase === prerequisite.phase && candidate.stage === prerequisite.stage
        );
        if (!dependency)
          throw new Error(`missing contextGraph stage prerequisite ${prerequisite.phase}:${prerequisite.stage}`);
        return {
          taskId: stage.id,
          dependsOnTaskId: dependency.id,
          relationship: "blocks",
          required: contextGraphStageRequired(stage),
          blocksParentCompletion: contextGraphStageRequired(stage)
        };
      })
    )
  );
  return {
    ...board,
    tasks: [...board.tasks.filter((task) => !task.type.startsWith("context_graph_")), ...pipelineTasks],
    dependencies: [
      ...board.dependencies.filter(
        (dependency) =>
          !board.tasks.some((task) => task.id === dependency.taskId && task.type.startsWith("context_graph_"))
      ),
      ...dependencies
    ],
    outbox: [
      ...board.outbox.filter(
        (message) => !board.tasks.some((task) => task.id === message.taskId && task.type.startsWith("context_graph_"))
      ),
      ...visible.flatMap(({ stages }) =>
        stages
          .filter((stage) => stage.status !== "triage")
          .map((stage) => ({
            id: stage.id,
            taskId: stage.id,
            topic: stage.topic,
            idempotencyKey: `${stage.id}:${stage.attempt}`,
            status: stage.status === "queued" ? "pending" : stage.status === "in_progress" ? "leased" : "dispatched",
            payload: { taskId: stage.id, attempt: stage.attempt },
            createdAt: stage.createdAt,
            ...(stage.leaseId ? { leaseId: stage.leaseId, leasedAt: stage.updatedAt } : {}),
            ...(stage.leaseExpiresAt ? { leaseExpiresAt: stage.leaseExpiresAt } : {}),
            ...(["done", "failed", "canceled", "superseded"].includes(stage.status)
              ? { dispatchedAt: stage.updatedAt }
              : {})
          }))
      )
    ]
  };
}

function pipelineBuildTask(build: ContextGraphBuildRecord): BoardTask {
  return {
    id: entityId<"task">(build.id),
    type: "context_graph_build",
    title: `Build context graph for ${build.repository}@${build.ref}`,
    status: pipelineBuildBoardStatus(build.status),
    assigneeRole: "system",
    dedupeKey: `contextGraph:${build.tenantId}:${build.repository}:${build.ref}:${build.requestKey}:root`,
    required: true,
    attempt: 0,
    metadata: {
      ...build.metadata,
      tenantId: build.tenantId,
      repository: build.repository,
      ref: build.ref,
      requestKey: build.requestKey,
      snapshotFirst: build.snapshotFirst
    },
    kind: "aggregate",
    createdAt: build.createdAt,
    updatedAt: build.updatedAt
  };
}

function pipelineStageTask(build: ContextGraphBuildRecord, stage: ContextGraphStageRecord): BoardTask {
  const timing = {
    ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
    ...(stage.completedAt ? { completedAt: stage.completedAt } : {}),
    ...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {})
  };
  return {
    id: entityId<"task">(stage.id),
    parentTaskId: entityId<"task">(build.id),
    type: `context_graph_${stage.stage}`,
    title: `${stage.stage === "ingest" ? "Ingest" : stage.stage === "assert" ? "Derive assertions for" : "Project graph for"} ${stage.repository}@${stage.ref} (${stage.phase})`,
    status: stage.status,
    assigneeRole: "context_graph_worker",
    dedupeKey: `contextGraph:${stage.buildId}:${stage.phase}:${stage.stage}`,
    required: contextGraphStageRequired(stage),
    attempt: stage.attempt,
    metadata: {
      ...stage.metadata,
      ...(Object.keys(timing).length > 0 ? { timing } : {})
    },
    kind: "dispatchable",
    dispatchTopic: stage.topic,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt
  };
}

function pipelineBuildBoardStatus(status: ContextGraphBuildRecord["status"]): BoardTask["status"] {
  if (status === "queued") return "queued";
  if (status === "done" || status === "failed") return status;
  if (status === "superseded") return "superseded";
  if (status === "enriching") return "done";
  return "in_progress";
}

function isContextGraphWorkerTopic(topic: string): topic is ContextGraphWorkerTopic {
  return (
    topic === "run-context-graph-ingest" ||
    topic === "run-context-graph-assert" ||
    topic === "run-context-graph-project"
  );
}

function contextGraphIngestCompletionMetadata(result: Record<string, unknown>): Record<string, unknown> {
  const positiveIntegers = (value: unknown, field: string) =>
    Array.isArray(value) ? value.map((item) => requiredPositiveInteger(item, field)) : [];
  const strings = (value: unknown, field: string) =>
    Array.isArray(value) ? value.map((item) => requiredString(item, field)) : [];
  return {
    commitSha: requiredGitSha(result.commitSha, "result.commitSha"),
    codeCheckpoint: requiredString(result.codeCheckpoint, "result.codeCheckpoint"),
    evidenceFingerprint: requiredString(result.evidenceFingerprint, "result.evidenceFingerprint"),
    analysisPaths: Array.isArray(result.analysisPaths)
      ? result.analysisPaths.map((path) => requiredRepositoryPath(path, "result.analysisPath"))
      : [],
    sourceObservationIds: strings(result.sourceObservationIds, "result.sourceObservationId"),
    problemEvidencePullRequestNumbers: positiveIntegers(
      result.problemEvidencePullRequestNumbers,
      "result.problemEvidencePullRequestNumber"
    ),
    sourcePullRequestNumbers: positiveIntegers(result.sourcePullRequestNumbers, "result.sourcePullRequestNumber"),
    resolvedPullRequestNumbers: positiveIntegers(result.resolvedPullRequestNumbers, "result.resolvedPullRequestNumber")
  };
}

function completionEventType(topic: string): string {
  switch (topic) {
    case "run-review":
      return "review.completed";
    case "run-research":
      return "context.collected";
    case "run-publish":
      return "publish.completed";
    case "run-cleanup":
      return "cleanup.completed";
    default:
      return "worker.completed";
  }
}

function safeResultPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, item]): [string, unknown] => {
        if (item === null || typeof item === "boolean" || typeof item === "number") return [key, item];
        if (typeof item === "string") return [key, item.slice(0, 5_000)];
        return [key, (JSON.stringify(item) ?? "").slice(0, 5_000)];
      })
  );
}

function migrateSnapshotTenantAliases(
  snapshot: ApiSnapshot,
  tenantId: string | undefined,
  aliases: readonly string[]
): { readonly snapshot: ApiSnapshot; readonly changed: boolean } {
  if (!tenantId) return { snapshot, changed: false };
  const aliasSet = new Set(aliases.filter((alias) => alias && alias !== tenantId));
  if (aliasSet.size === 0) return { snapshot, changed: false };
  let changed = false;
  const tasks = snapshot.intakeState.board.tasks.map((task) => {
    if (!aliasSet.has(stringValue(task.metadata.tenantId))) return task;
    changed = true;
    return { ...task, metadata: { ...task.metadata, tenantId } };
  });
  const pullRequests = snapshot.intakeState.pullRequests.map((pullRequest) => {
    if (!aliasSet.has(pullRequest.tenantId)) return pullRequest;
    changed = true;
    return { ...pullRequest, tenantId };
  });
  return changed
    ? {
        changed,
        snapshot: {
          ...snapshot,
          intakeState: {
            board: { ...snapshot.intakeState.board, tasks },
            pullRequests
          }
        }
      }
    : { snapshot, changed };
}

function parseRepositorySnapshot(value: unknown, tenantId: string): RepositorySnapshot {
  if (!isRecord(value) || !Array.isArray(value.files) || !Array.isArray(value.parents)) {
    throw invalidRequest("snapshot must include files and parents");
  }
  if (value.mode !== undefined && value.mode !== "tree" && value.mode !== "delta") {
    throw invalidRequest("snapshot.mode must be tree or delta");
  }
  const isDelta = value.mode === "delta";
  if (isDelta) {
    if (!Array.isArray(value.deltas)) throw invalidRequest("delta snapshot must include deltas");
    if (value.files.length > 0) throw invalidRequest("delta snapshot must not carry a full tree");
  }
  const deltas = isDelta
    ? (value.deltas as unknown[]).map((delta) => {
        if (!isRecord(delta)) throw invalidRequest("snapshot delta must be an object");
        const size =
          typeof delta.size === "number" && Number.isSafeInteger(delta.size) && delta.size >= 0 ? delta.size : 0;
        return {
          path: requiredRepositoryPath(delta.path, "snapshot.delta.path"),
          blobSha: delta.blobSha === null ? null : requiredGitSha(delta.blobSha, "snapshot.delta.blobSha"),
          size
        };
      })
    : undefined;
  return {
    ...(isDelta && deltas ? { mode: "delta" as const, deltas } : {}),
    tenantId,
    repository: requiredString(value.repository, "snapshot.repository"),
    ref: requiredString(value.ref, "snapshot.ref"),
    commitSha: requiredGitSha(value.commitSha, "snapshot.commitSha"),
    treeSha: requiredGitSha(value.treeSha, "snapshot.treeSha"),
    parents: value.parents.map((parent) => requiredGitSha(parent, "snapshot.parent")),
    ...(typeof value.authorExternalId === "string" && value.authorExternalId.trim()
      ? { authorExternalId: value.authorExternalId.trim() }
      : {}),
    ...(typeof value.authorGitHubLogin === "string" && value.authorGitHubLogin.trim()
      ? { authorGitHubLogin: value.authorGitHubLogin.trim() }
      : {}),
    ...(typeof value.authorName === "string" && value.authorName.trim() ? { authorName: value.authorName.trim() } : {}),
    ...(typeof value.committedAt === "string" && value.committedAt.trim()
      ? { committedAt: value.committedAt.trim() }
      : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.isDefaultRef === "boolean" ? { isDefaultRef: value.isDefaultRef } : {}),
    ...(typeof value.updateRef === "boolean" ? { updateRef: value.updateRef } : {}),
    recordedAt: requiredString(value.recordedAt, "snapshot.recordedAt"),
    taskId: requiredString(value.taskId, "snapshot.taskId"),
    files: value.files.map((file) => {
      if (!isRecord(file)) throw invalidRequest("snapshot file must be an object");
      const path = requiredRepositoryPath(file.path, "snapshot.file.path");
      const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0;
      return { path, blobSha: requiredGitSha(file.blobSha, "snapshot.file.blobSha"), size };
    })
  };
}

function parseRepositorySourceObservation(value: unknown, tenantId: string): RepositorySourceObservation {
  if (!isRecord(value)) throw invalidRequest("GitHub observation must be an object");
  const kind = requiredString(value.kind, "observation.kind");
  if (kind === "codeowners") {
    if (!Array.isArray(value.entries)) throw invalidRequest("CODEOWNERS observation entries must be an array");
    return {
      tenantId,
      repository: requiredString(value.repository, "observation.repository"),
      kind,
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      path: requiredRepositoryPath(value.path, "observation.path"),
      entries: value.entries.map((entry) => {
        if (!isRecord(entry) || !Array.isArray(entry.owners)) throw invalidRequest("CODEOWNERS entry is invalid");
        return {
          pattern: requiredString(entry.pattern, "entry.pattern"),
          owners: entry.owners.map((owner) => requiredString(owner, "entry.owner"))
        };
      }),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "package_manifest") {
    if (!Array.isArray(value.dependencies)) throw invalidRequest("package manifest dependencies must be an array");
    return {
      tenantId,
      repository: requiredString(value.repository, "observation.repository"),
      kind,
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      path: requiredRepositoryPath(value.path, "observation.path"),
      ecosystem: requiredString(value.ecosystem, "observation.ecosystem"),
      dependencies: value.dependencies.map((dependency) => {
        if (!isRecord(dependency)) throw invalidRequest("package dependency must be an object");
        return {
          name: requiredString(dependency.name, "dependency.name"),
          ...(typeof dependency.version === "string" ? { version: dependency.version } : {})
        };
      }),
      ...(value.removed === true ? { removed: true } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "service_definition") {
    const dependsOnServices = Array.isArray(value.dependsOnServices)
      ? value.dependsOnServices.map((dependency) => {
          if (!isRecord(dependency)) throw invalidRequest("service dependency must be an object");
          return {
            source: requiredString(dependency.source, "observation.dependency.source"),
            externalId: requiredString(dependency.externalId, "observation.dependency.externalId"),
            name: requiredString(dependency.name, "observation.dependency.name")
          };
        })
      : [];
    return {
      tenantId,
      repository: requiredString(value.repository, "observation.repository"),
      kind,
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      path: requiredRepositoryPath(value.path, "observation.path"),
      source: requiredString(value.source, "observation.source"),
      externalId: requiredString(value.externalId, "observation.externalId"),
      name: requiredString(value.name, "observation.name"),
      ...(dependsOnServices.length > 0 ? { dependsOnServices } : {}),
      ...(value.removed === true ? { removed: true } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "deployment") {
    const service = isRecord(value.service)
      ? {
          source: requiredString(value.service.source, "observation.service.source"),
          externalId: requiredString(value.service.externalId, "observation.service.externalId"),
          name: requiredString(value.service.name, "observation.service.name")
        }
      : undefined;
    return {
      tenantId,
      repository: requiredString(value.repository, "observation.repository"),
      kind,
      source: requiredString(value.source, "observation.source"),
      externalId: requiredString(value.externalId, "observation.externalId"),
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      environment: requiredString(value.environment, "observation.environment"),
      status: requiredString(value.status, "observation.status"),
      ...(service ? { service } : {}),
      ...(typeof value.occurredAt === "string" ? { occurredAt: value.occurredAt } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "incident") {
    const impactedService = isRecord(value.impactedService)
      ? {
          source: requiredString(value.impactedService.source, "observation.impactedService.source"),
          externalId: requiredString(value.impactedService.externalId, "observation.impactedService.externalId"),
          name: requiredString(value.impactedService.name, "observation.impactedService.name")
        }
      : undefined;
    if (value.deploymentRelations !== undefined && !Array.isArray(value.deploymentRelations)) {
      throw invalidRequest("incident deployment relations must be an array");
    }
    const deploymentRelations = Array.isArray(value.deploymentRelations)
      ? value.deploymentRelations.map((relation) => {
          if (!isRecord(relation)) throw invalidRequest("incident deployment relation must be an object");
          const predicateValue = requiredString(relation.predicate, "observation.deploymentRelation.predicate");
          if (predicateValue !== "INTRODUCED_BY" && predicateValue !== "RESOLVED_BY") {
            throw invalidRequest("incident deployment relation predicate is unsupported");
          }
          const predicate: "INTRODUCED_BY" | "RESOLVED_BY" = predicateValue;
          const evidenceStartLine = requiredPositiveInteger(
            relation.evidenceStartLine,
            "observation.deploymentRelation.evidenceStartLine"
          );
          const evidenceEndLine = requiredPositiveInteger(
            relation.evidenceEndLine,
            "observation.deploymentRelation.evidenceEndLine"
          );
          if (evidenceEndLine < evidenceStartLine) {
            throw invalidRequest("incident deployment relation evidence range is invalid");
          }
          return {
            source: requiredString(relation.source, "observation.deploymentRelation.source"),
            externalId: requiredString(relation.externalId, "observation.deploymentRelation.externalId"),
            predicate,
            evidencePath: requiredRepositoryPath(relation.evidencePath, "observation.deploymentRelation.evidencePath"),
            evidenceStartLine,
            evidenceEndLine
          };
        })
      : [];
    return {
      tenantId,
      repository: requiredString(value.repository, "observation.repository"),
      kind,
      source: requiredString(value.source, "observation.source"),
      externalId: requiredString(value.externalId, "observation.externalId"),
      title: requiredString(value.title, "observation.title"),
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.issueNumber === "number"
        ? { issueNumber: requiredPositiveInteger(value.issueNumber, "observation.issueNumber") }
        : {}),
      ...(impactedService ? { impactedService } : {}),
      ...(deploymentRelations.length > 0 ? { deploymentRelations } : {}),
      ...(typeof value.occurredAt === "string" ? { occurredAt: value.occurredAt } : {}),
      ...(value.removed === true ? { removed: true } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "move_candidate") {
    if (!Array.isArray(value.candidates)) throw invalidRequest("move candidates must be an array");
    return {
      tenantId,
      repository: requiredString(value.repository, "observation.repository"),
      kind,
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      candidates: value.candidates.map((candidate) => {
        if (!isRecord(candidate) || !Array.isArray(candidate.matchingSignatureHashes))
          throw invalidRequest("move candidate is invalid");
        const similarity = typeof candidate.similarity === "number" ? candidate.similarity : Number.NaN;
        if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1)
          throw invalidRequest("move candidate similarity is invalid");
        return {
          oldPath: requiredRepositoryPath(candidate.oldPath, "candidate.oldPath"),
          newPath: requiredRepositoryPath(candidate.newPath, "candidate.newPath"),
          similarity,
          matchingSignatureHashes: candidate.matchingSignatureHashes.map((signature) =>
            requiredString(signature, "candidate.signature")
          )
        };
      }),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind !== "pull_request" && kind !== "issue") {
    throw invalidRequest("repository source observation kind is unsupported");
  }
  const positiveIntegerArray = (input: unknown, name: string): number[] =>
    Array.isArray(input) ? input.map((item) => requiredPositiveInteger(item, name)) : [];
  return {
    tenantId,
    repository: requiredString(value.repository, "observation.repository"),
    kind,
    number: requiredPositiveInteger(value.number, "observation.number"),
    title: requiredString(value.title, "observation.title"),
    ...(typeof value.body === "string" ? { body: value.body } : {}),
    state: requiredString(value.state, "observation.state"),
    url: requiredString(value.url, "observation.url"),
    ...(typeof value.authorId === "number"
      ? { authorId: requiredPositiveInteger(value.authorId, "observation.authorId") }
      : {}),
    ...(typeof value.authorLogin === "string" && value.authorLogin.trim()
      ? { authorLogin: value.authorLogin.trim() }
      : {}),
    ...(typeof value.authorName === "string" && value.authorName.trim() ? { authorName: value.authorName.trim() } : {}),
    ...(typeof value.authorAccountType === "string" && value.authorAccountType.trim()
      ? { authorAccountType: value.authorAccountType.trim() }
      : {}),
    ...(typeof value.occurredAt === "string" ? { occurredAt: value.occurredAt } : {}),
    ...(typeof value.mergedAt === "string" && value.mergedAt ? { mergedAt: value.mergedAt } : {}),
    ...(typeof value.mergeCommitSha === "string"
      ? { mergeCommitSha: requiredGitSha(value.mergeCommitSha, "observation.mergeCommitSha") }
      : {}),
    recordedAt: requiredString(value.recordedAt, "observation.recordedAt"),
    commitShas: Array.isArray(value.commitShas)
      ? value.commitShas.map((sha) => requiredGitSha(sha, "observation.commitSha"))
      : [],
    resolvesIssueNumbers: positiveIntegerArray(value.resolvesIssueNumbers, "observation.resolvesIssueNumber"),
    referencesIssueNumbers: positiveIntegerArray(value.referencesIssueNumbers, "observation.referencesIssueNumber")
  };
}

function parseContextGraphCommand(value: Record<string, unknown>): ContextGraphCommand {
  const type = requiredString(value.type, "command.type");
  const reason = typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : undefined;
  if (type === "review_assertion") {
    const decision = requiredString(value.decision, "command.decision");
    if (decision !== "accept" && decision !== "reject" && decision !== "retract") {
      throw invalidRequest("unsupported assertion review decision");
    }
    const rejectionCode = typeof value.rejectionCode === "string" ? value.rejectionCode : undefined;
    if (decision === "reject") {
      if (!reason) throw invalidRequest("assertion rejection reason is required");
      if (
        !rejectionCode ||
        !["incorrect_relationship", "insufficient_evidence", "unsupported_explanation", "other"].includes(rejectionCode)
      ) {
        throw invalidRequest("assertion rejection code is required");
      }
    } else if (rejectionCode) {
      throw invalidRequest("assertion rejection code is only valid for rejection decisions");
    }
    return {
      type,
      assertionId: requiredString(value.assertionId, "command.assertionId"),
      decision,
      ...(reason ? { reason } : {}),
      ...(rejectionCode
        ? {
            rejectionCode: rejectionCode as
              "incorrect_relationship" | "insufficient_evidence" | "unsupported_explanation" | "other"
          }
        : {})
    };
  }
  if (type === "relate_assertions") {
    const relation = requiredString(value.relation, "command.relation");
    if (relation !== "supports" && relation !== "contradicts") throw invalidRequest("unsupported assertion relation");
    return {
      type,
      relation,
      sourceAssertionId: requiredString(value.sourceAssertionId, "command.sourceAssertionId"),
      targetAssertionId: requiredString(value.targetAssertionId, "command.targetAssertionId"),
      evidenceObservationId: requiredString(value.evidenceObservationId, "command.evidenceObservationId"),
      ...(reason ? { reason } : {})
    };
  }
  if (type === "merge_entities" || type === "unmerge_entities") {
    return {
      type,
      fromEntityId: requiredString(value.fromEntityId, "command.fromEntityId"),
      toEntityId: requiredString(value.toEntityId, "command.toEntityId"),
      ...(reason ? { reason } : {})
    };
  }
  if (type === "redact_observation") {
    if (!reason) throw invalidRequest("redaction reason is required");
    return {
      type,
      observationId: requiredString(value.observationId, "command.observationId"),
      reason,
      ...(Array.isArray(value.commitShas)
        ? { commitShas: value.commitShas.map((sha) => requiredGitSha(sha, "command.commitSha")) }
        : {})
    };
  }
  if (type === "erase_person") {
    if (!reason) throw invalidRequest("erasure reason is required");
    return { type, entityId: requiredString(value.entityId, "command.entityId"), reason };
  }
  if (type === "tombstone_repository") {
    if (!reason) throw invalidRequest("tombstone reason is required");
    return { type, repository: requiredString(value.repository, "command.repository"), reason };
  }
  if (type === "grant_repository_access") {
    const role = requiredString(value.role, "command.role");
    if (role !== "reader" && role !== "writer" && role !== "admin") throw invalidRequest("unsupported repository role");
    return {
      type,
      repository: requiredString(value.repository, "command.repository"),
      principalId: requiredString(value.principalId, "command.principalId"),
      role
    };
  }
  if (type === "assign_relationship") {
    if (!reason) throw new Error("relationship explanation is required");
    const entity = (input: unknown, name: string) => {
      if (!isRecord(input)) throw invalidRequest(`${name} must be an object`);
      const kind = requiredString(input.kind, `${name}.kind`);
      if (!contextGraphNodeKinds.includes(kind as ContextGraphNodeKind)) {
        throw invalidRequest(`${name}.kind is unsupported`);
      }
      return {
        kind: kind as ContextGraphNodeKind,
        key: requiredString(input.key, `${name}.key`),
        ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {})
      };
    };
    const qualifiers = isRecord(value.qualifiers)
      ? Object.fromEntries(
          Object.entries(value.qualifiers).map(([key, item]) => {
            if (!["string", "number", "boolean"].includes(typeof item)) {
              throw invalidRequest(`qualifier ${key} has an unsupported value`);
            }
            return [key, item as string | number | boolean];
          })
        )
      : undefined;
    return {
      type,
      ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
      subject: entity(value.subject, "command.subject"),
      predicate: requiredString(value.predicate, "command.predicate"),
      object: entity(value.object, "command.object"),
      ...(qualifiers ? { qualifiers } : {}),
      reason
    };
  }
  throw invalidRequest("unsupported contextGraph command");
}

function parseBlobAnalyses(value: unknown): readonly BlobAnalysis[] {
  if (!Array.isArray(value)) throw invalidRequest("analyses must be an array");
  return value.map((analysis) => {
    if (
      !isRecord(analysis) ||
      !Array.isArray(analysis.symbols) ||
      !Array.isArray(analysis.imports) ||
      !Array.isArray(analysis.edges)
    ) {
      throw invalidRequest("blob analysis must include symbols, imports, and edges");
    }
    const parserVersion = requiredString(analysis.parserVersion, "analysis.parserVersion");
    if (parserVersion !== CONTEXT_GRAPH_PARSER_VERSION) throw invalidRequest("unsupported contextGraph parser version");
    return {
      blobSha: requiredGitSha(analysis.blobSha, "analysis.blobSha"),
      parserVersion,
      ...(typeof analysis.language === "string" && analysis.language.trim()
        ? { language: analysis.language.trim() }
        : {}),
      symbols: analysis.symbols.map((symbol) => {
        if (!isRecord(symbol)) throw invalidRequest("symbol must be an object");
        return {
          moniker: requiredString(symbol.moniker, "symbol.moniker"),
          name: requiredString(symbol.name, "symbol.name"),
          kind: requiredString(symbol.kind, "symbol.kind"),
          signatureHash: requiredString(symbol.signatureHash, "symbol.signatureHash"),
          startLine: requiredPositiveInteger(symbol.startLine, "symbol.startLine"),
          endLine: requiredPositiveInteger(symbol.endLine, "symbol.endLine")
        };
      }),
      imports: analysis.imports.map((item) => {
        if (!isRecord(item)) throw invalidRequest("import must be an object");
        return {
          specifier: requiredString(item.specifier, "import.specifier"),
          line: requiredPositiveInteger(item.line, "import.line")
        };
      }),
      edges: analysis.edges.map((edge) => {
        if (!isRecord(edge)) throw invalidRequest("symbol edge must be an object");
        const kind = requiredString(edge.kind, "edge.kind");
        if (!(["calls", "imports", "references", "extends"] as const).includes(kind as "calls")) {
          throw invalidRequest("unsupported symbol edge kind");
        }
        return {
          fromMoniker: requiredString(edge.fromMoniker, "edge.fromMoniker"),
          kind: kind as "calls" | "imports" | "references" | "extends",
          toMoniker: requiredString(edge.toMoniker, "edge.toMoniker"),
          startLine: requiredPositiveInteger(edge.startLine, "edge.startLine"),
          endLine: requiredPositiveInteger(edge.endLine, "edge.endLine")
        };
      })
    };
  });
}

function parseContextGraphAssertionBatch(
  value: unknown,
  task: { readonly id: string; readonly metadata: Readonly<Record<string, unknown>> },
  tenantId: string
): ContextGraphAssertionBatch {
  if (!isRecord(value)) throw invalidRequest("assertionBatch must be an object");
  const commitSha = requiredGitSha(value.commitSha, "assertionBatch.commitSha");
  if (commitSha !== task.metadata.commitSha) throw invalidRequest("assertion batch commit does not match task source");
  const evidenceFingerprint = requiredString(value.evidenceFingerprint, "assertionBatch.evidenceFingerprint");
  if (evidenceFingerprint !== task.metadata.evidenceFingerprint)
    throw invalidRequest("assertion batch evidence does not match task source");
  const repository = requiredString(task.metadata.repository, "task.repository");
  const evidenceObservationIds = Array.isArray(value.evidenceObservationIds)
    ? value.evidenceObservationIds.map((id) => requiredString(id, "assertionBatch.evidenceObservationIds"))
    : [];
  const expectedObservationIds = Array.isArray(task.metadata.sourceObservationIds)
    ? task.metadata.sourceObservationIds.map((id) => requiredString(id, "task.sourceObservationIds"))
    : [];
  if (JSON.stringify([...evidenceObservationIds].sort()) !== JSON.stringify([...expectedObservationIds].sort())) {
    throw invalidRequest("assertion batch source evidence does not match task source");
  }
  const rawOutput = parseGeneratedContextGraph(value.rawOutput);
  const sourcePullRequestNumbers = Array.isArray(task.metadata.sourcePullRequestNumbers)
    ? task.metadata.sourcePullRequestNumbers.map((number) =>
        requiredPositiveInteger(number, "task.sourcePullRequestNumber")
      )
    : [];
  const resolvedPullRequestNumbers = Array.isArray(task.metadata.resolvedPullRequestNumbers)
    ? task.metadata.resolvedPullRequestNumbers.map((number) =>
        requiredPositiveInteger(number, "task.resolvedPullRequestNumber")
      )
    : [];
  return {
    tenantId,
    repository,
    ref: requiredString(task.metadata.ref, "task.ref"),
    commitSha,
    taskId: task.id,
    generatedAt: requiredString(value.generatedAt, "assertionBatch.generatedAt"),
    generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
    registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
    evidenceFingerprint,
    evidenceObservationIds,
    model: requiredString(value.model, "assertionBatch.model"),
    ...(typeof value.sandboxId === "string" && value.sandboxId ? { sandboxId: value.sandboxId } : {}),
    summary: requiredString(value.summary, "assertionBatch.summary"),
    ...(value.modelOutputRaw !== undefined ? { modelOutputRaw: value.modelOutputRaw } : {}),
    rawOutput,
    assertions: assertionsFromGeneratedContextGraph(rawOutput, repository, {
      sourcePullRequestNumbers,
      resolvedPullRequestNumbers
    })
  };
}

function requiredRepositoryPath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (path.startsWith("/") || path.split("/").includes(".."))
    throw invalidRequest(`${field} must be repository-relative`);
  return path;
}

type ContextGraphRequestSelectors = Pick<
  RetrievalRequest,
  | "ref"
  | "symbol"
  | "path"
  | "pullRequestNumber"
  | "issueEntityId"
  | "issueNumber"
  | "issueText"
  | "featureText"
  | "rootText"
  | "rootEntityId"
  | "commitSha"
>;

function parseContextGraphSelectors(body: Record<string, unknown>): ContextGraphRequestSelectors {
  return {
    ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
    ...(typeof body.symbol === "string" ? { symbol: body.symbol } : {}),
    ...(typeof body.path === "string" ? { path: requiredRepositoryPath(body.path, "path") } : {}),
    ...(typeof body.pullRequestNumber === "number"
      ? { pullRequestNumber: requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber") }
      : {}),
    ...(typeof body.issueEntityId === "string"
      ? { issueEntityId: requiredString(body.issueEntityId, "issueEntityId") }
      : {}),
    ...(typeof body.issueNumber === "number"
      ? { issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber") }
      : {}),
    ...(typeof body.issueText === "string" ? { issueText: requiredIssueText(body.issueText, "issueText") } : {}),
    ...(typeof body.featureText === "string"
      ? { featureText: requiredFeatureText(body.featureText, "featureText") }
      : {}),
    ...(typeof body.rootText === "string" ? { rootText: requiredFeatureText(body.rootText, "rootText") } : {}),
    ...(typeof body.rootEntityId === "string"
      ? { rootEntityId: requiredString(body.rootEntityId, "rootEntityId") }
      : {}),
    ...(typeof body.commitSha === "string" ? { commitSha: requiredGitShaPrefix(body.commitSha, "commitSha") } : {})
  };
}

function requiredIssueText(value: unknown, field: string): string {
  const text = requiredString(value, field).replace(/\s+/g, " ");
  if (text.length > 500) throw invalidRequest(`${field} must not exceed 500 characters`);
  return text;
}

function requiredFeatureText(value: unknown, field: string): string {
  const text = requiredString(value, field).replace(/\s+/g, " ");
  if (text.length > 200) throw invalidRequest(`${field} must not exceed 200 characters`);
  return text;
}

function requiredGitShaPrefix(value: unknown, field: string): string {
  const sha = requiredString(value, field).toLowerCase();
  if (!/^[a-f0-9]{7,40}$/.test(sha)) throw invalidRequest(`${field} must be a 7-40 character Git SHA`);
  return sha;
}

function requiredAssertionStatus(value: string): "proposed" | "active" | "rejected" | "superseded" | "retracted" {
  if (
    value === "proposed" ||
    value === "active" ||
    value === "rejected" ||
    value === "superseded" ||
    value === "retracted"
  )
    return value;
  throw invalidRequest("unsupported assertion status");
}

function requiredContextOperation(value: string): RepositoryContextOperation {
  if (value === "lookup" || value === "counterfactual") return value;
  throw invalidRequest("operation must be lookup or counterfactual");
}

function parseDevWebhook(body: Record<string, unknown>): ParsedGitHubWebhook {
  const repository = requiredString(body.repository, "repository");
  if (body.issueNumber !== undefined) {
    return {
      repository,
      event: {
        type: "issue.opened",
        issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber"),
        title: typeof body.title === "string" ? body.title : "Dev issue"
      }
    };
  }
  return devPullRequestWebhook(
    repository,
    requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber"),
    requiredString(body.headSha, "headSha")
  );
}

function devPullRequestWebhook(repository: string, pullRequestNumber: number, headSha: string): ParsedGitHubWebhook {
  return { repository, event: { type: "pull_request.opened", pullRequestNumber, headSha } };
}

async function readRawBody(request: IncomingMessage, maximumBytes = MAX_WEBHOOK_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new RequestBodyTooLargeError(`request body exceeds ${maximumBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(rawBody: Uint8Array): Record<string, unknown> {
  const value = parseJsonValue(rawBody);
  if (!isRecord(value)) throw invalidRequest("request body must be a JSON object");
  return value;
}

function parseJsonValue(rawBody: Uint8Array): unknown {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw invalidRequest("request body is not valid JSON");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw invalidRequest(`${field} must be a non-empty string`);
  return value.trim();
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function requiredTenantPrincipal(value: unknown): string {
  const principalId = requiredString(value, "principalId").toLowerCase();
  if (!/^tenant:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(principalId)) {
    throw invalidRequest("principalId must be tenant:<uuid>");
  }
  return principalId;
}

function requiredGitSha(value: unknown, field: string): string {
  const sha = requiredString(value, field);
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw invalidRequest(`${field} must be a full Git SHA`);
  return sha;
}

function requiredRepositoryName(value: unknown, field: string): string {
  const repository = requiredString(value, field);
  const segments = repository.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9_.-]+$/.test(segment))
  ) {
    throw invalidRequest(`${field} must be owner/name without traversal segments`);
  }
  return repository;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw invalidRequest(`${field} must be a positive integer`);
  return value;
}

const JSON_RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type, authorization, x-jina-tenant-id, x-jina-principal-id, x-github-event, x-github-delivery, x-hub-signature-256",
  "access-control-allow-methods": "GET, POST, OPTIONS"
} as const;

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, JSON_RESPONSE_HEADERS);
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload));
}

/**
 * Success response for polled read routes. Dashboard clients revalidate every
 * few seconds, so a matching ETag turns an unchanged multi-megabyte payload
 * (board snapshot, full context graph) into an empty 304.
 */
function jsonCacheable(request: IncomingMessage, response: ServerResponse, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = { ...JSON_RESPONSE_HEADERS, etag, "cache-control": "no-cache" };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(body);
}

function revisionEtag(revision: string): string {
  return `"${revision}"`;
}

function respondNotModified(request: IncomingMessage, response: ServerResponse, revision: string): boolean {
  const etag = revisionEtag(revision);
  if (request.headers["if-none-match"] !== etag) return false;
  response.writeHead(304, { ...JSON_RESPONSE_HEADERS, etag, "cache-control": "no-cache" });
  response.end();
  return true;
}

function jsonCacheableWithRevision(
  request: IncomingMessage,
  response: ServerResponse,
  revision: string,
  payload: unknown
): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  const etag = revisionEtag(revision);
  const headers = { ...JSON_RESPONSE_HEADERS, etag, "cache-control": "no-cache" };
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

class RequestBodyTooLargeError extends ApiError {
  constructor(message: string) {
    super(413, "payload_too_large", message);
    this.name = "RequestBodyTooLargeError";
  }
}

function invalidRequest(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

function staleLease(): ApiError {
  return new ApiError(409, "stale_lease", "stale worker lease");
}

function httpError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DomainError) {
    const statusCode =
      error.code === "invalid_argument"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "forbidden"
            ? 403
            : 409;
    return new ApiError(statusCode, error.code, error.message);
  }
  return new ApiError(500, "internal_error", "internal server error", false);
}

class DeliveryCache {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity: number) {}
  has(deliveryId: string): boolean {
    return this.ids.has(deliveryId);
  }
  add(deliveryId: string): void {
    if (this.ids.has(deliveryId)) return;
    if (this.ids.size >= Math.max(1, this.capacity)) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(deliveryId);
  }
}
