import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyCommand,
  findOutboxMessage,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  renewOutboxLease,
  reduceBoard,
  supersedeTaskTree,
  taskTypeDefinitions,
  type BoardTask,
  type BoardOutboxMessageId,
  type TaskId,
  type CommandActor
} from "@jina/board";
import type { ParsedGitHubWebhook } from "@jina/github";
import {
  createOntologyGraph,
  assertionsFromGeneratedOntology,
  MemoryOntologyGraphStore,
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  RepositoryContextOrchestrator,
  retrievalTemplateNames,
  ontologyNodeKinds,
  ontologyTaskTypeDependencies,
  ontologyTaskTypeDefinitions,
  ontologyTaskTypeTriggers,
  planOntologyBuild,
  parseGeneratedOntology,
  type BlobAnalysis,
  type RepositorySourceObservation,
  type OntologyCommand,
  type OntologyAssertionBatch,
  type OntologyGraph,
  type OntologyGraphStore,
  type OntologyNodeKind,
  type RepositoryContextOperation,
  type RepositorySnapshot
} from "@jina/ontology";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { prReviewTaskTypeDependencies, prReviewTaskTypeTriggers } from "@jina/review";
import { DomainError, entityId, nowIso } from "@jina/shared-kernel";
import { createGitHubIntakeState, ingestGitHubWebhook, type GitHubIntakeState } from "./github-intake.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";
import { buildTaskTypeCatalog } from "./task-type-catalog.js";
import { handleGraphMcpRequest, publicGraphQueryResult } from "./mcp.js";
import { publicGraph, publicGraphQueryResult as publicRestGraphQueryResult, publicGraphSummary } from "./graph-api.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_ONTOLOGY_SNAPSHOT_BYTES = 25 * 1024 * 1024;
// Ontology writes for large repositories can hold the durable mutation transaction
// for several minutes. Keep the lease comfortably beyond that transaction so the
// owning worker is not fenced while its write is still committing.
const WORKER_LEASE_MS = 30 * 60 * 1000;
const RUN_ACTOR: CommandActor = { type: "run", id: "worker" };
const WORKER_TOPICS = [
  "run-review",
  "run-research",
  "run-publish",
  "run-cleanup",
  "run-ontology-ingest",
  "run-ontology-assert",
  "run-ontology-project"
] as const;
const LEGACY_ONTOLOGY_TOPICS = new Set(["run-ontology", "run-ontology-prepare", "run-ontology-generate"]);

export interface ApiServerConfig {
  readonly githubWebhookSecret?: string;
  readonly tenantId?: string;
  readonly tenantAliases?: readonly string[];
  readonly enableDevEndpoints?: boolean;
  readonly simulateRuns?: boolean;
  readonly seedDemo?: boolean;
  readonly deliveryCacheSize?: number;
  readonly stateStore?: ApiStateStore;
  readonly ontologyStore?: OntologyGraphStore;
  readonly internalApiToken?: string;
  /** Narrow server-to-server credential accepted only by public graph routes and ACL synchronization. */
  readonly graphApiToken?: string;
  readonly principalId?: string;
  readonly tenantAdminPrincipalIds?: readonly string[];
  /** Browser origins allowed to call the MCP endpoint. Non-browser clients normally omit Origin. */
  readonly mcpAllowedOrigins?: readonly string[];
}

export interface ApiSnapshot {
  readonly intakeState: GitHubIntakeState;
  readonly publications: readonly PublicationRecord[];
  readonly devDeliverySequence: number;
  readonly pendingOntologyCompletions?: readonly PendingOntologyCompletion[];
}

interface PendingOntologyCompletion {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly leaseId: string;
  readonly taskId: string;
  readonly topic: "run-ontology-assert" | "run-ontology-project";
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ApiStateStore {
  load(): Promise<ApiSnapshot | undefined>;
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
  let intakeState: GitHubIntakeState = createGitHubIntakeState();
  let publications: readonly PublicationRecord[] = [];
  let devDeliverySequence = 0;
  let pendingOntologyCompletions: readonly PendingOntologyCompletion[] = [];
  const deliveries = new DeliveryCache(config.deliveryCacheSize ?? 10_000);
  const ontologyStore = config.ontologyStore ?? new MemoryOntologyGraphStore();
  const ready = initializeState();
  let mutations = Promise.resolve();
  let transactionActive = false;

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
    mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  function restore(stored: ApiSnapshot): void {
    intakeState = stored.intakeState;
    publications = stored.publications;
    devDeliverySequence = stored.devDeliverySequence;
    pendingOntologyCompletions = stored.pendingOntologyCompletions ?? [];
  }

  async function synchronize(): Promise<void> {
    if (!config.stateStore) return;
    const result = mutations.then(reload);
    mutations = result.then(() => undefined, () => undefined);
    await result;
  }

  async function initializeState(): Promise<void> {
    const stored = await config.stateStore?.load();
    if (stored) {
      const migrated = migrateSnapshotTenantAliases(stored, config.tenantId, config.tenantAliases ?? []);
      intakeState = migrated.snapshot.intakeState;
      publications = migrated.snapshot.publications;
      devDeliverySequence = migrated.snapshot.devDeliverySequence;
      pendingOntologyCompletions = migrated.snapshot.pendingOntologyCompletions ?? [];
      const retiredIntakeState = retireLegacyOntologyWork(intakeState, nowIso());
      const retiredLegacyWork = retiredIntakeState !== intakeState;
      intakeState = retiredIntakeState;
      if (migrated.changed || retiredLegacyWork) await persist();
      if (config.tenantId) await ontologyStore.migrateTenantAliases(config.tenantId, config.tenantAliases ?? []);
      return;
    }
    if (config.tenantId) await ontologyStore.migrateTenantAliases(config.tenantId, config.tenantAliases ?? []);
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
    await ontologyStore.planIngestion(snapshot);
    await ontologyStore.applyBlobAnalyses(snapshot, [{
      blobSha,
      parserVersion: ONTOLOGY_PARSER_VERSION,
      language: "typescript",
      symbols: [{
        moniker: "src/server.ts#handleWebhook",
        name: "handleWebhook",
        kind: "function",
        signatureHash: "dev-handle-webhook",
        startLine: 12,
        endLine: 34
      }],
      imports: [],
      edges: []
    }]);
    await ontologyStore.save(createOntologyGraph({
      request: { tenantId, repository: snapshot.repository, ref: snapshot.ref, taskId: snapshot.taskId },
      commitSha,
      generatedAt: snapshot.recordedAt,
      executor: "fixture",
      model: "dev-seed",
      contentAddressed: true,
      generated: {
        summary: "Local MCP development graph",
        nodes: [
          { id: "repo", kind: "Repository", label: snapshot.repository, description: "Demo repository", evidence: ["src/server.ts:1"] },
          { id: "file:src/server.ts", kind: "File", label: "server.ts", description: "Demo API server", path: "src/server.ts", evidence: ["src/server.ts:1"] },
          { id: "symbol:handleWebhook", kind: "Symbol", label: "handleWebhook", description: "function in src/server.ts", path: "src/server.ts", evidence: ["src/server.ts:12-34"] }
        ],
        edges: [
          { source: "repo", target: "file:src/server.ts", predicate: "CONTAINS", plane: "code", evidence: ["src/server.ts:1"] },
          { source: "file:src/server.ts", target: "symbol:handleWebhook", predicate: "DECLARES", plane: "code", evidence: ["src/server.ts:12-34"] }
        ]
      }
    }));
  }

  function snapshot(): ApiSnapshot {
    return { intakeState, publications, devDeliverySequence, pendingOntologyCompletions };
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
    const stored = await config.stateStore?.load();
    if (stored) restore(stored);
  }

  async function hasDelivery(deliveryId: string): Promise<boolean> {
    return config.stateStore ? config.stateStore.hasDelivery(deliveryId) : deliveries.has(deliveryId);
  }

  function acceptWebhook(webhook: ParsedGitHubWebhook, deliveryId: string) {
    const result = ingestGitHubWebhook(intakeState, webhook, {
      deliveryId,
      now: nowIso(),
      ...(config.tenantId ? { tenantId: config.tenantId } : {})
    });
    intakeState = result.state;
    return result;
  }

  /** Local demo runner only. Ontology work is always claimed by the durable worker. */
  async function drainOneSimulatedRun(): Promise<void> {
    const message = intakeState.board.outbox.find(
      (candidate) => candidate.status === "pending" && !candidate.topic.startsWith("run-ontology")
    );
    if (!message) return;
    let board = markOutboxDispatched(intakeState.board, message.id, nowIso());
    const task = findTask(board, message.taskId);
    if (!task || task.status !== "queued") {
      intakeState = { ...intakeState, board };
      await persist();
      return;
    }
    board = applyCommand(board, { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" }, {
      actor: RUN_ACTOR,
      now: nowIso()
    }).state;
    if (message.topic === "run-publish") {
      const repository = String(task.metadata.repository ?? "");
      const pullRequestNumber = Number(task.metadata.pullRequestNumber ?? 0);
      const headSha = String(task.metadata.headSha ?? "");
      const key = buildPublicationKey(`${repository}#${pullRequestNumber}`, headSha, "summary");
      publications = upsertPublication(publications, { key, headSha, target: "summary" }).records;
    }
    board = applyCommand(board, { command: "TransitionTask", taskId: task.id, toStatus: "done" }, {
      actor: RUN_ACTOR,
      now: nowIso()
    }).state;
    intakeState = { ...intakeState, board: reduceBoard(board, nowIso()) };
    await persist();
  }

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const apiError = httpError(error);
      console.error("API request failed", message);
      json(response, apiError.statusCode, {
        accepted: false,
        error: apiError.expose ? apiError.message : "internal server error",
        ...(apiError.expose ? { code: apiError.code } : {})
      });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await ready;
    await synchronize();
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return;
    }
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      await config.stateStore?.ping();
      json(response, 200, {
        ok: true,
        githubWebhookConfigured: Boolean(config.githubWebhookSecret),
        storage: config.stateStore ? "postgres" : "memory",
        durableWorker: true
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/task-types") {
      json(response, 200, buildTaskTypeCatalog(
        [...taskTypeDefinitions, ...ontologyTaskTypeDefinitions],
        [...prReviewTaskTypeDependencies, ...ontologyTaskTypeDependencies],
        [...prReviewTaskTypeTriggers, ...ontologyTaskTypeTriggers]
      ));
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

    if (request.method === "POST" && url.pathname === "/internal/graph/access/sync") {
      if (!config.graphApiToken || firstHeader(request.headers.authorization) !== `Bearer ${config.graphApiToken}` || !config.tenantId) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      let principalId: string;
      let repositories: string[];
      try {
        const body = parseJsonObject(await readRawBody(request));
        principalId = requiredTenantPrincipal(body.principalId);
        if (!Array.isArray(body.repositories) || body.repositories.length > 5_000) {
          throw new Error("repositories must be an array with at most 5000 entries");
        }
        repositories = [...new Set(body.repositories.map((repository) => requiredRepositoryName(repository, "repository")))].sort();
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : "invalid graph access sync" });
        return;
      }
      await ontologyStore.replaceRepositoryAccess(config.tenantId, principalId, repositories);
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
    const requiresBoundGraphPrincipal = isPublicGraphRoute(url.pathname) ||
      (url.pathname === "/ontology/build" && usesGraphCredential);
    if (requiresBoundGraphPrincipal && !config.enableDevEndpoints && !config.principalId &&
      !normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"]))) {
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
      await handleGraphMcpRequest(request, response, async ({ repository, query, ref }) => {
        const allowedRepositories = await repositoriesForPrincipal(principal);
        const context = await new RepositoryContextOrchestrator(ontologyStore).answer({
          tenantId,
          allowedRepositories,
          repository,
          question: query,
          ...(ref ? { ref } : {})
        });
        return publicGraphQueryResult(context);
      }, parsedBody);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/graphs") {
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const requestedRepository = url.searchParams.get("repository")?.trim();
      if (requestedRepository && !allowedRepositories.includes(requestedRepository)) {
        json(response, 404, { error: "graph not found" });
        return;
      }
      const graphs = (await ontologyStore.listSummaries(tenantId))
        .filter((graph) => allowedRepositories.includes(graph.repository))
        .filter((graph) => !requestedRepository || graph.repository === requestedRepository)
        .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
        .map(publicGraphSummary);
      json(response, 200, { graphs });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/graphs/")) {
      const graphId = decodeURIComponent(url.pathname.slice("/v1/graphs/".length));
      const graph = await ontologyStore.get(graphId, tenantId);
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
      const graph = await ontologyStore.get(graphId, tenantId);
      const allowedRepositories = await repositoriesForPrincipal(principal);
      if (!graph || !allowedRepositories.includes(graph.repository)) {
        json(response, 404, { error: "graph not found" });
        return;
      }
      const context = await new RepositoryContextOrchestrator(ontologyStore).answer({
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
      const allowedRepositories = isTenantAdmin(principal) ? undefined : new Set(await repositoriesForPrincipal(principal));
      json(response, 200, tenantBoardView(intakeState, publications, tenantId, allowedRepositories));
      return;
    }
    if (request.method === "GET" && url.pathname === "/ontology") {
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const [latest, graphValues] = await Promise.all([
        ontologyStore.latest(tenantId),
        ontologyStore.listSummaries(tenantId)
      ]);
      const graphs = graphValues.filter((graph) => allowedRepositories.includes(graph.repository));
      json(response, 200, { latest: latest && allowedRepositories.includes(latest.repository) ? latest : null, graphs });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/ontology/graphs/")) {
      const graphId = decodeURIComponent(url.pathname.slice("/ontology/graphs/".length));
      const graph = await ontologyStore.get(graphId, tenantId);
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const permitted = graph && allowedRepositories.includes(graph.repository) ? graph : undefined;
      json(response, permitted ? 200 : 404, permitted ?? { error: "ontology graph not found" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/ontology/metrics") {
      if (!isTenantAdmin(principal)) {
        json(response, 403, { error: "tenant administrator access required" });
        return;
      }
      json(response, 200, await ontologyStore.operationalMetrics(tenantId, nowIso()));
      return;
    }
    if (request.method === "POST" && url.pathname === "/ontology/retrieve") {
      const body = parseJsonObject(await readRawBody(request));
      const repository = requiredString(body.repository, "repository");
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const template = requiredString(body.template, "template");
      if (!retrievalTemplateNames.includes(template as typeof retrievalTemplateNames[number])) {
        throw invalidRequest("unsupported retrieval template");
      }
      const result = await ontologyStore.retrieve({
        tenantId, allowedRepositories, repository, template: template as typeof retrievalTemplateNames[number],
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        ...(typeof body.query === "string" ? { query: body.query } : {}),
        ...(typeof body.symbol === "string" ? { symbol: body.symbol } : {}),
        ...(typeof body.path === "string" ? { path: requiredRepositoryPath(body.path, "path") } : {}),
        ...(typeof body.pullRequestNumber === "number" ? { pullRequestNumber: requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber") } : {}),
        ...(typeof body.issueEntityId === "string" ? { issueEntityId: requiredString(body.issueEntityId, "issueEntityId") } : {}),
        ...(typeof body.issueNumber === "number" ? { issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber") } : {}),
        ...(typeof body.issueText === "string" ? { issueText: requiredIssueText(body.issueText, "issueText") } : {}),
        ...(typeof body.featureText === "string" ? { featureText: requiredFeatureText(body.featureText, "featureText") } : {}),
        ...(typeof body.rootText === "string" ? { rootText: requiredFeatureText(body.rootText, "rootText") } : {}),
        ...(typeof body.rootEntityId === "string" ? { rootEntityId: requiredString(body.rootEntityId, "rootEntityId") } : {}),
        ...(typeof body.commitSha === "string" ? { commitSha: requiredGitShaPrefix(body.commitSha, "commitSha") } : {}),
        ...(typeof body.limit === "number" ? { limit: requiredPositiveInteger(body.limit, "limit") } : {})
      });
      json(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/ontology/ask") {
      const body = parseJsonObject(await readRawBody(request));
      const allowedRepositories = await repositoriesForPrincipal(principal);
      const orchestrator = new RepositoryContextOrchestrator(ontologyStore);
      json(response, 200, await orchestrator.answer({
        tenantId, allowedRepositories, repository: requiredString(body.repository, "repository"),
        question: requiredString(body.question, "question"),
        ...(typeof body.operation === "string" ? { operation: requiredContextOperation(body.operation) } : {}),
        ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        ...(typeof body.symbol === "string" ? { symbol: body.symbol } : {}),
        ...(typeof body.path === "string" ? { path: requiredRepositoryPath(body.path, "path") } : {}),
        ...(typeof body.pullRequestNumber === "number" ? { pullRequestNumber: requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber") } : {}),
        ...(typeof body.issueEntityId === "string" ? { issueEntityId: requiredString(body.issueEntityId, "issueEntityId") } : {}),
        ...(typeof body.issueNumber === "number" ? { issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber") } : {}),
        ...(typeof body.issueText === "string" ? { issueText: requiredIssueText(body.issueText, "issueText") } : {}),
        ...(typeof body.featureText === "string" ? { featureText: requiredFeatureText(body.featureText, "featureText") } : {}),
        ...(typeof body.rootText === "string" ? { rootText: requiredFeatureText(body.rootText, "rootText") } : {}),
        ...(typeof body.rootEntityId === "string" ? { rootEntityId: requiredString(body.rootEntityId, "rootEntityId") } : {}),
        ...(typeof body.commitSha === "string" ? { commitSha: requiredGitShaPrefix(body.commitSha, "commitSha") } : {}),
        ...(typeof body.tokenBudget === "number" ? { tokenBudget: requiredPositiveInteger(body.tokenBudget, "tokenBudget") } : {})
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/ontology/assertions") {
      const repository = requiredString(url.searchParams.get("repository"), "repository");
      const allowedRepositories = await repositoriesForPrincipal(principal);
      if (!allowedRepositories.includes(repository)) throw new DomainError("repository access denied", "forbidden");
      const statusValue = url.searchParams.get("status");
      const status = statusValue === null ? undefined : requiredAssertionStatus(statusValue);
      const predicate = url.searchParams.get("predicate")?.trim().toUpperCase() || undefined;
      const entityKindValue = url.searchParams.get("entityKind")?.trim();
      const entityKind = entityKindValue && ontologyNodeKinds.includes(entityKindValue as typeof ontologyNodeKinds[number])
        ? entityKindValue as typeof ontologyNodeKinds[number]
        : undefined;
      if (entityKindValue && !entityKind) throw invalidRequest("unsupported ontology entity kind");
      json(response, 200, { assertions: await ontologyStore.listAssertions(tenantId, repository, {
        ...(status ? { status } : {}), ...(predicate ? { predicate } : {}), ...(entityKind ? { entityKind } : {})
      }) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/ontology/commands") {
      const body = parseJsonObject(await readRawBody(request));
      json(response, 200, await ontologyStore.executeCommand(
        tenantId,
        principal.principalId,
        parseOntologyCommand(body),
        nowIso(),
        isTenantAdmin(principal)
      ));
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const allowedRepositories = isTenantAdmin(principal) ? undefined : new Set(await repositoriesForPrincipal(principal));
      const taskIds = tenantTaskIds(intakeState, tenantId, allowedRepositories);
      json(response, 200, intakeState.board.events.filter((event) => event.taskId && taskIds.has(event.taskId)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/ontology/build") {
      const allowedRepositories = isTenantAdmin(principal) ? undefined : new Set(await repositoriesForPrincipal(principal));
      await createOntologyTask(request, response, tenantId, allowedRepositories);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/ingest/plan") {
      await planOntologyIngestion(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/ingest/known") {
      await findKnownOntologyCommits(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/ingest/blobs") {
      await applyOntologyBlobAnalyses(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/ingest/github") {
      await applyOntologyGitHubObservations(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/assertions/cached") {
      await findCachedOntologyAssertions(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/assertions/evidence") {
      await loadOntologyAssertionEvidence(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/outbox/drain") {
      await readRawBody(request);
      json(response, 200, await ontologyStore.drainDerivedProjectionEvents(tenantId, nowIso()));
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/claim") {
      await reconcilePendingOntologyCompletions();
      await claimWork(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/renew") {
      await renewWork(request, response, tenantId);
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
    const committed = await mutate(async () => {
      if (!result.webhook) {
        await persist(result.deliveryId!);
        return { statusCode: result.statusCode, payload: result };
      }
      const intake = acceptWebhook(result.webhook, result.deliveryId!);
      await persist(result.deliveryId!);
      return {
        statusCode: result.statusCode,
        payload: { accepted: true, deliveryId: result.deliveryId, outcome: intake.outcome, createdTaskIds: intake.createdTaskIds }
      };
    }, result.deliveryId);
    if (!committed) {
      json(response, 200, { accepted: true, duplicate: true, deliveryId: result.deliveryId });
      return;
    }
    json(response, committed.statusCode, committed.payload);
  }

  async function createOntologyTask(
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
    const suppliedRequestKey = typeof body.requestKey === "string" && body.requestKey.trim() ? body.requestKey.trim() : undefined;
    const created = await mutate(async () => {
      devDeliverySequence += 1;
      const nonce = suppliedRequestKey ?? `${Date.now()}-${devDeliverySequence}`;
      const plan = planOntologyBuild({ tenantId, repository, ref, requestKey: nonce });
      const createdAt = nowIso();
      let board = supersedeTaskTree(intakeState.board, createdAt, (task) =>
        task.type.startsWith("ontology_") &&
        task.metadata.tenantId === tenantId &&
        task.metadata.repository === repository &&
        task.metadata.ref === ref &&
        task.metadata.requestKey !== nonce
      );
      for (const task of plan.tasks) {
        board = applyCommand(board, {
          command: "CreateTask",
          task: { ...task, required: true },
          ...(task.id === plan.rootTaskId ? { blocksParentCompletion: false } : {})
        }, { actor: { type: "user", id: "ontology-api" }, now: createdAt }).state;
      }
      for (const dependency of plan.dependencies) {
        board = applyCommand(board, { command: "LinkTask", dependency }, {
          actor: { type: "user", id: "ontology-api" }, now: createdAt
        }).state;
      }
      board = reduceBoard(board, createdAt);
      intakeState = { ...intakeState, board };
      await persist();
      return findTask(board, plan.rootTaskId);
    });
    json(response, 202, { accepted: true, task: created });
  }

  async function planOntologyIngestion(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request, MAX_ONTOLOGY_SNAPSHOT_BYTES));
    const snapshot = parseRepositorySnapshot(body.snapshot, tenantId);
    const plan = await mutate(async () => {
      const task = requireLeasedOntologyTask(body, snapshot.taskId, tenantId, "ontology_ingest");
      if (snapshot.repository !== task.metadata.repository || snapshot.ref !== task.metadata.ref) {
        throw invalidRequest("repository snapshot does not match ontology task");
      }
      return ontologyStore.planIngestion(snapshot);
    });
    json(response, 200, plan);
  }

  async function findKnownOntologyCommits(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_ingest");
    if (!Array.isArray(body.commitShas)) throw invalidRequest("commitShas must be an array");
    const commitShas = body.commitShas.map((sha) => requiredGitSha(sha, "commitSha"));
    json(response, 200, {
      knownCommitShas: await ontologyStore.knownCommits(tenantId, requiredString(task.metadata.repository, "task.repository"), commitShas)
    });
  }

  async function applyOntologyBlobAnalyses(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const commitSha = requiredGitSha(body.commitSha, "commitSha");
    const analyses = parseBlobAnalyses(body.analyses);
    await mutate(async () => {
      const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_ingest");
      await ontologyStore.applyBlobAnalyses({
        tenantId,
        repository: requiredString(task.metadata.repository, "task.repository"),
        commitSha
      }, analyses);
    });
    json(response, 200, { accepted: true, count: analyses.length });
  }

  async function applyOntologyGitHubObservations(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    if (!Array.isArray(body.observations)) throw invalidRequest("observations must be an array");
    const observations = body.observations.map((value) => parseRepositorySourceObservation(value, tenantId));
    const result = await mutate(async () => {
      const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_ingest");
      const repository = requiredString(task.metadata.repository, "task.repository");
      if (observations.some((observation) => observation.repository !== repository)) {
        throw invalidRequest("GitHub observation repository does not match task");
      }
      return ontologyStore.applyGitHubObservations(observations);
    });
    json(response, 200, result);
  }

  async function findCachedOntologyAssertions(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_assert");
    const cached = await ontologyStore.hasAssertionGeneration(
      tenantId,
      requiredString(task.metadata.repository, "task.repository"),
      requiredGitSha(body.commitSha, "commitSha"),
      ONTOLOGY_GENERATOR_VERSION,
      ONTOLOGY_REGISTRY_VERSION,
      requiredString(body.evidenceFingerprint, "evidenceFingerprint")
    );
    json(response, 200, { cached: cached ?? null });
  }

  async function loadOntologyAssertionEvidence(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_assert");
    const repository = requiredString(task.metadata.repository, "task.repository");
    const observationIds = Array.isArray(task.metadata.sourceObservationIds)
      ? task.metadata.sourceObservationIds.map((id) => requiredString(id, "task.sourceObservationIds"))
      : [];
    const evidence = await ontologyStore.loadAssertionEvidence(tenantId, repository, observationIds);
    json(response, 200, { evidence });
  }

  function requireOntologyTask(taskId: string, tenantId: string, type: string): BoardTask {
    const task = findTask(intakeState.board, entityId<"task">(taskId) as TaskId);
    if (!task || task.metadata.tenantId !== tenantId || task.type !== type) {
      throw new ApiError(404, "not_found", "ontology task not found");
    }
    return task;
  }

  function requireLeasedOntologyTask(
    body: Record<string, unknown>,
    taskId: string,
    tenantId: string,
    type: string
  ): BoardTask {
    const task = requireOntologyTask(taskId, tenantId, type);
    const messageId = entityId<"board_outbox_message">(requiredString(body.messageId, "messageId")) as BoardOutboxMessageId;
    const message = findOutboxMessage(intakeState.board, messageId);
    const leaseId = requiredString(body.leaseId, "leaseId");
    if (
      !message || message.taskId !== task.id || message.status !== "leased" || message.leaseId !== leaseId ||
      !message.leaseExpiresAt || message.leaseExpiresAt <= nowIso() || task.status !== "in_progress"
    ) {
      throw new ApiError(409, "stale_lease", "stale ontology worker lease");
    }
    return task;
  }

  async function claimWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerId = requiredString(body.workerId, "workerId");
    if (!Array.isArray(body.topics) || body.topics.length === 0) throw invalidRequest("at least one supported topic is required");
    const topics = body.topics.map((topic) => requiredString(topic, "topics"));
    const unsupportedTopics = topics.filter((topic) => !WORKER_TOPICS.includes(topic as typeof WORKER_TOPICS[number]));
    if (unsupportedTopics.length > 0) throw invalidRequest(`unsupported worker topics: ${unsupportedTopics.join(", ")}`);
    const requestedTopics = topics as (typeof WORKER_TOPICS)[number][];
    const claimed = await mutate(async () => {
      const taskIds = intakeState.board.tasks
        .filter((task) => task.metadata.tenantId === tenantId && (task.status === "queued" || task.status === "in_progress"))
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
        board = applyCommand(board, { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" }, {
          actor: { type: "run", id: workerId },
          now
        }).state;
      }
      intakeState = { ...intakeState, board };
      await persist();
      return { message: leased.message, task: findTask(board, task.id) };
    });
    json(response, claimed ? 200 : 204, claimed ?? {});
  }

  async function renewWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = entityId<"board_outbox_message">(requiredString(body.messageId, "messageId")) as BoardOutboxMessageId;
    const leaseId = requiredString(body.leaseId, "leaseId");
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

  async function completeWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = entityId<"board_outbox_message">(requiredString(body.messageId, "messageId")) as BoardOutboxMessageId;
    const leaseId = requiredString(body.leaseId, "leaseId");
    const outcome = body.outcome;
    if (outcome !== "done" && outcome !== "failed") throw invalidRequest("outcome must be done or failed");
    const taskId = entityId<"task">(requiredString(body.taskId, "taskId")) as TaskId;
    const task = findTask(intakeState.board, taskId);
    if (!task || task.metadata.tenantId !== tenantId) {
      throw new ApiError(404, "not_found", "task not found");
    }
    if (outcome === "done") {
      const pending = await stageOntologyCompletion(body, messageId, leaseId, taskId, tenantId);
      if (pending) {
        const completedGraph = await processPendingOntologyCompletion(pending);
        json(response, 200, { accepted: true, graphId: completedGraph?.id });
        return;
      }
    }
    let graph: OntologyGraph | undefined;
    const result = await mutate(async () => {
      const message = findOutboxMessage(intakeState.board, messageId);
      const currentTask = findTask(intakeState.board, taskId);
      const now = nowIso();
      if (
        !message || !currentTask || message.taskId !== taskId || message.status !== "leased" ||
        message.leaseId !== leaseId || !message.leaseExpiresAt || message.leaseExpiresAt <= now ||
        currentTask.status !== "in_progress" || currentTask.metadata.tenantId !== tenantId
      ) {
        return false;
      }
      const previousIntakeState = intakeState;
      const previousPublications = publications;
      let board = markOutboxDispatched(intakeState.board, message.id, now);
      if (outcome === "done" && message.topic === "run-ontology-ingest") {
        const resultPayload = isRecord(body.result) ? body.result : {};
        const commitSha = requiredGitSha(resultPayload.commitSha, "result.commitSha");
        const analysisPaths = Array.isArray(resultPayload.analysisPaths)
          ? resultPayload.analysisPaths.map((path) => requiredRepositoryPath(path, "result.analysisPaths"))
          : [];
        const sourceObservationIds = Array.isArray(resultPayload.sourceObservationIds)
          ? resultPayload.sourceObservationIds.map((id) => requiredString(id, "result.sourceObservationIds"))
          : [];
        const problemEvidencePullRequestNumbers = Array.isArray(resultPayload.problemEvidencePullRequestNumbers)
          ? resultPayload.problemEvidencePullRequestNumbers.map((number) =>
              requiredPositiveInteger(number, "result.problemEvidencePullRequestNumber")
            )
          : [];
        const sourcePullRequestNumbers = Array.isArray(resultPayload.sourcePullRequestNumbers)
          ? resultPayload.sourcePullRequestNumbers.map((number) => requiredPositiveInteger(number, "result.sourcePullRequestNumber"))
          : [];
        const resolvedPullRequestNumbers = Array.isArray(resultPayload.resolvedPullRequestNumbers)
          ? resultPayload.resolvedPullRequestNumbers.map((number) => requiredPositiveInteger(number, "result.resolvedPullRequestNumber"))
          : [];
        const children = board.tasks.filter((candidate) => candidate.parentTaskId === currentTask.parentTaskId);
        for (const childType of ["ontology_assert", "ontology_project"] as const) {
          const child = children.find((candidate) => candidate.type === childType);
          if (!child) throw new Error(`${childType} task not found`);
          board = applyCommand(board, {
            command: "UpdateTask",
            taskId: child.id,
            metadata: {
              commitSha,
              codeCheckpoint: requiredString(resultPayload.codeCheckpoint, "result.codeCheckpoint"),
              evidenceFingerprint: requiredString(resultPayload.evidenceFingerprint, "result.evidenceFingerprint"),
              ...(childType === "ontology_assert"
                ? { analysisPaths, problemEvidencePullRequestNumbers, sourceObservationIds, sourcePullRequestNumbers, resolvedPullRequestNumbers }
                : {})
            }
          }, { actor: RUN_ACTOR, now }).state;
        }
      }
      let eventPayload = safeResultPayload(body.result);
      if (outcome === "done" && message.topic === "run-ontology-assert") {
        const cached = isRecord(body.result) && isRecord(body.result.cached) ? body.result.cached : undefined;
        const assertionResult = cached
          ? safeResultPayload(cached)
          : await ontologyStore.saveAssertionBatch(parseOntologyAssertionBatch(body.assertionBatch, currentTask, tenantId));
        eventPayload = {
          ...safeResultPayload(assertionResult),
          effect: assertionResult.cached ? "confirmed" : "changed"
        };
        const projectionTask = board.tasks.find((candidate) =>
          candidate.parentTaskId === currentTask.parentTaskId && candidate.type === "ontology_project"
        );
        if (!projectionTask) throw new Error("ontology_project task not found");
        board = applyCommand(board, {
          command: "UpdateTask",
          taskId: projectionTask.id,
          metadata: { knowledgeCheckpoint: requiredString(assertionResult.knowledgeCheckpoint, "knowledgeCheckpoint") }
        }, { actor: RUN_ACTOR, now }).state;
      }
      if (outcome === "done" && message.topic === "run-ontology-project") {
        const existingGraphIds = new Set((await ontologyStore.listSummaries(tenantId)).map((summary) => summary.id));
        // Repository-wide assertion and source events can affect every tracked ref.
        // Drain them through the all-ref fanout before completing this ref's task;
        // otherwise the first per-ref rebuild would acknowledge the event early.
        const drained = await ontologyStore.drainDerivedProjectionEvents(tenantId, now);
        eventPayload = { ...await ontologyStore.rebuildDerivedProjections(
          tenantId,
          requiredString(currentTask.metadata.repository, "task.repository"),
          requiredString(currentTask.metadata.ref, "task.ref"),
          now
        ), drainedEventCount: drained.processedEventCount, rebuiltRepositories: drained.rebuiltRepositories };
        graph = await ontologyStore.project({
          tenantId,
          repository: requiredString(currentTask.metadata.repository, "task.repository"),
          ref: requiredString(currentTask.metadata.ref, "task.ref"),
          commitSha: requiredGitSha(currentTask.metadata.commitSha, "task.commitSha"),
          taskId: currentTask.id,
          generatedAt: now
        });
        eventPayload = { ...eventPayload, effect: eventPayload.rebuilt || !existingGraphIds.has(graph.id) ? "changed" : "noop" };
      }
      board = applyCommand(board, {
        command: "CommentTask",
        taskId,
        eventType: outcome === "failed" ? `${message.topic}.failed` : completionEventType(message.topic),
        payload: outcome === "failed"
          ? { reason: String(body.reason ?? "worker failed").slice(0, 2000) }
          : graph
          ? { ...eventPayload, graphId: graph.id, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, commitSha: graph.commitSha }
          : eventPayload
      }, { actor: RUN_ACTOR, now }).state;
      if (outcome === "done" && message.topic === "run-publish") {
        const repository = String(currentTask.metadata.repository ?? "");
        const pullRequestNumber = Number(currentTask.metadata.pullRequestNumber ?? 0);
        const headSha = String(currentTask.metadata.headSha ?? "");
        const key = buildPublicationKey(`${repository}#${pullRequestNumber}`, headSha, "summary");
        publications = upsertPublication(publications, { key, headSha, target: "summary" }).records;
      }
      board = applyCommand(board, {
        command: "TransitionTask",
        taskId,
        toStatus: outcome
      }, { actor: RUN_ACTOR, now }).state;
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
    json(response, 200, { accepted: true, graphId: graph?.id });
  }

  async function stageOntologyCompletion(
    body: Readonly<Record<string, unknown>>,
    messageId: BoardOutboxMessageId,
    leaseId: string,
    taskId: TaskId,
    tenantId: string
  ): Promise<PendingOntologyCompletion | undefined> {
    return mutate(async () => {
      const message = findOutboxMessage(intakeState.board, messageId);
      const currentTask = findTask(intakeState.board, taskId);
      const now = nowIso();
      if (!message || !currentTask || message.taskId !== taskId || message.status !== "leased" ||
        message.leaseId !== leaseId || !message.leaseExpiresAt || message.leaseExpiresAt <= now ||
        currentTask.status !== "in_progress" || currentTask.metadata.tenantId !== tenantId) {
        throw staleLease();
      }
      if (message.topic !== "run-ontology-assert" && message.topic !== "run-ontology-project") return undefined;
      const id = `${message.id}:${leaseId}:${taskId}`;
      const existing = pendingOntologyCompletions.find((candidate) => candidate.id === id);
      if (existing) return existing;
      const pending: PendingOntologyCompletion = {
        id,
        tenantId,
        messageId: message.id,
        leaseId,
        taskId,
        topic: message.topic,
        body: structuredClone(body),
        createdAt: now
      };
      intakeState = { ...intakeState, board: markOutboxDispatched(intakeState.board, message.id, now) };
      pendingOntologyCompletions = [...pendingOntologyCompletions, pending];
      await persist();
      return pending;
    });
  }

  async function reconcilePendingOntologyCompletions(): Promise<void> {
    for (const pending of [...pendingOntologyCompletions]) await processPendingOntologyCompletion(pending);
  }

  async function processPendingOntologyCompletion(pending: PendingOntologyCompletion): Promise<OntologyGraph | undefined> {
    if (!pendingOntologyCompletions.some((candidate) => candidate.id === pending.id)) return undefined;
    const currentTask = findTask(intakeState.board, entityId<"task">(pending.taskId) as TaskId);
    if (!currentTask || currentTask.metadata.tenantId !== pending.tenantId) {
      throw new ApiError(404, "not_found", "pending ontology completion task not found");
    }
    const now = nowIso();
    let graph: OntologyGraph | undefined;
    let eventPayload: Record<string, unknown>;
    if (pending.topic === "run-ontology-assert") {
      const cached = isRecord(pending.body.result) && isRecord(pending.body.result.cached) ? pending.body.result.cached : undefined;
      const assertionResult = cached
        ? safeResultPayload(cached)
        : await ontologyStore.saveAssertionBatch(parseOntologyAssertionBatch(pending.body.assertionBatch, currentTask, pending.tenantId));
      eventPayload = {
        ...safeResultPayload(assertionResult),
        effect: assertionResult.cached ? "confirmed" : "changed"
      };
    } else {
      const existingGraphIds = new Set((await ontologyStore.listSummaries(pending.tenantId)).map((summary) => summary.id));
      const drained = await ontologyStore.drainDerivedProjectionEvents(pending.tenantId, now);
      eventPayload = { ...await ontologyStore.rebuildDerivedProjections(
        pending.tenantId,
        requiredString(currentTask.metadata.repository, "task.repository"),
        requiredString(currentTask.metadata.ref, "task.ref"),
        now
      ), drainedEventCount: drained.processedEventCount, rebuiltRepositories: drained.rebuiltRepositories };
      graph = await ontologyStore.project({
        tenantId: pending.tenantId,
        repository: requiredString(currentTask.metadata.repository, "task.repository"),
        ref: requiredString(currentTask.metadata.ref, "task.ref"),
        commitSha: requiredGitSha(currentTask.metadata.commitSha, "task.commitSha"),
        taskId: currentTask.id,
        generatedAt: now
      });
      eventPayload = { ...eventPayload, effect: eventPayload.rebuilt || !existingGraphIds.has(graph.id) ? "changed" : "noop" };
    }

    await mutate(async () => {
      if (!pendingOntologyCompletions.some((candidate) => candidate.id === pending.id)) return;
      const taskId = entityId<"task">(pending.taskId) as TaskId;
      const task = findTask(intakeState.board, taskId);
      if (!task || task.status !== "in_progress") throw new DomainError("pending ontology completion is no longer applicable", "conflict");
      let board = intakeState.board;
      if (pending.topic === "run-ontology-assert") {
        const projectionTask = board.tasks.find((candidate) =>
          candidate.parentTaskId === task.parentTaskId && candidate.type === "ontology_project"
        );
        if (!projectionTask) throw new Error("ontology_project task not found");
        board = applyCommand(board, {
          command: "UpdateTask",
          taskId: projectionTask.id,
          metadata: { knowledgeCheckpoint: requiredString(eventPayload.knowledgeCheckpoint, "knowledgeCheckpoint") }
        }, { actor: RUN_ACTOR, now }).state;
      }
      board = applyCommand(board, {
        command: "CommentTask",
        taskId,
        eventType: completionEventType(pending.topic),
        payload: graph
          ? { ...eventPayload, graphId: graph.id, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, commitSha: graph.commitSha }
          : eventPayload
      }, { actor: RUN_ACTOR, now }).state;
      board = applyCommand(board, { command: "TransitionTask", taskId, toStatus: "done" }, { actor: RUN_ACTOR, now }).state;
      intakeState = { ...intakeState, board: reduceBoard(board, now) };
      pendingOntologyCompletions = pendingOntologyCompletions.filter((candidate) => candidate.id !== pending.id);
      await persist();
    });
    return graph;
  }

  function isTenantAdmin(principal: { readonly principalId: string }): boolean {
    return principal.principalId.startsWith("svc:") || (config.tenantAdminPrincipalIds ?? []).includes(principal.principalId);
  }

  async function repositoriesForPrincipal(principal: { readonly tenantId: string; readonly principalId: string }): Promise<readonly string[]> {
    return ontologyStore.repositoriesForPrincipal(
      principal.tenantId,
      isTenantAdmin(principal) ? "svc:tenant-admin" : principal.principalId
    );
  }

  if (config.simulateRuns) {
    const timer = setInterval(() => void mutate(drainOneSimulatedRun).catch((error) => console.error("simulated run failed", error)), 1500);
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }
  if (config.stateStore) server.once("close", () => void config.stateStore?.close());
  server.once("close", () => void ontologyStore.close());
  return server;
}

function authenticatedPrincipal(
  request: IncomingMessage,
  config: ApiServerConfig,
  pathname: string
): { readonly tenantId: string; readonly principalId: string } | undefined {
  if (config.enableDevEndpoints) {
    return {
      tenantId: firstHeader(request.headers["x-jina-tenant-id"]) ?? config.tenantId ?? "default",
      principalId: config.principalId ?? "svc:dev"
    };
  }
  const authorization = firstHeader(request.headers.authorization);
  const hasInternalAccess = Boolean(config.internalApiToken && authorization === `Bearer ${config.internalApiToken}`);
  const hasGraphAccess = Boolean(
    config.graphApiToken &&
    authorization === `Bearer ${config.graphApiToken}` &&
    (isPublicGraphRoute(pathname) || pathname === "/ontology/build")
  );
  if (!hasInternalAccess && !hasGraphAccess) return undefined;
  if (!config.tenantId) return undefined;
  const principalId = normalizedForwardedPrincipal(firstHeader(request.headers["x-jina-principal-id"]))
    ?? config.principalId
    ?? "svc:api";
  return { tenantId: config.tenantId, principalId };
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
    config.graphApiToken &&
    firstHeader(request.headers.authorization) === `Bearer ${config.graphApiToken}`
  );
}

function isPublicGraphRoute(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/v1/graphs" || pathname.startsWith("/v1/graphs/") || pathname === "/v1/graph/query";
}

function tenantTaskIds(
  state: GitHubIntakeState,
  tenantId: string,
  allowedRepositories?: ReadonlySet<string>
): Set<TaskId> {
  return new Set(state.board.tasks.filter((task) =>
    task.metadata.tenantId === tenantId &&
    (!allowedRepositories || (typeof task.metadata.repository === "string" && allowedRepositories.has(task.metadata.repository)))
  ).map((task) => task.id));
}

function tenantBoardView(
  state: GitHubIntakeState,
  publications: readonly PublicationRecord[],
  tenantId: string,
  allowedRepositories?: ReadonlySet<string>
) {
  const taskIds = tenantTaskIds(state, tenantId, allowedRepositories);
  const pullRequests = state.pullRequests.filter((pullRequest) =>
    pullRequest.tenantId === tenantId && (!allowedRepositories || allowedRepositories.has(pullRequest.repository))
  );
  const publicationSubjects = pullRequests.map((pullRequest) => `pr:${pullRequest.repository}#${pullRequest.number}:`);
  return {
    tasks: state.board.tasks.filter((task) => taskIds.has(task.id)),
    dependencies: state.board.dependencies.filter((dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)),
    outbox: state.board.outbox.filter((message) => taskIds.has(message.taskId)),
    publications: publications.filter((record) => publicationSubjects.some((subject) => record.key.startsWith(subject))),
    pullRequests
  };
}

function completionEventType(topic: string): string {
  switch (topic) {
    case "run-review": return "review.completed";
    case "run-research": return "context.collected";
    case "run-publish": return "publish.completed";
    case "run-cleanup": return "cleanup.completed";
    case "run-ontology-ingest": return "ontology.code_ingested";
    case "run-ontology-assert": return "ontology.assertions_recorded";
    case "run-ontology-project": return "ontology.graph_projected";
    default: return "worker.completed";
  }
}

function safeResultPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => {
    if (item === null || typeof item === "boolean" || typeof item === "number") return [key, item];
    if (typeof item === "string") return [key, item.slice(0, 5_000)];
    return [key, JSON.stringify(item).slice(0, 5_000)];
  }));
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
    if (!aliasSet.has(String(task.metadata.tenantId ?? ""))) return task;
    changed = true;
    return { ...task, metadata: { ...task.metadata, tenantId } };
  });
  const pullRequests = snapshot.intakeState.pullRequests.map((pullRequest) => {
    if (!aliasSet.has(pullRequest.tenantId)) return pullRequest;
    changed = true;
    return { ...pullRequest, tenantId };
  });
  const pendingOntologyCompletions = snapshot.pendingOntologyCompletions?.map((pending) => {
    if (!aliasSet.has(pending.tenantId)) return pending;
    changed = true;
    return { ...pending, tenantId };
  });
  return changed
    ? {
        changed,
        snapshot: {
          ...snapshot,
          intakeState: {
            board: { ...snapshot.intakeState.board, tasks },
            pullRequests
          },
          ...(pendingOntologyCompletions ? { pendingOntologyCompletions } : {})
        }
      }
    : { snapshot, changed };
}

function retireLegacyOntologyWork(state: GitHubIntakeState, now: string): GitHubIntakeState {
  const messages = state.board.outbox.filter((message) =>
    message.status !== "dispatched" && LEGACY_ONTOLOGY_TOPICS.has(message.topic)
  );
  if (messages.length === 0) return state;
  const workflowRootIds = new Set<TaskId>();
  for (const message of messages) {
    let task = findTask(state.board, message.taskId);
    while (task?.parentTaskId) task = findTask(state.board, task.parentTaskId);
    if (task) workflowRootIds.add(task.id);
  }
  let board = state.board;
  for (const message of messages) board = markOutboxDispatched(board, message.id, now);
  board = supersedeTaskTree(board, now, (task) => workflowRootIds.has(task.id));
  return { ...state, board: reduceBoard(board, now) };
}

function parseRepositorySnapshot(value: unknown, tenantId: string): RepositorySnapshot {
  if (!isRecord(value) || !Array.isArray(value.files) || !Array.isArray(value.parents)) {
    throw invalidRequest("snapshot must include files and parents");
  }
  return {
    tenantId,
    repository: requiredString(value.repository, "snapshot.repository"),
    ref: requiredString(value.ref, "snapshot.ref"),
    commitSha: requiredGitSha(value.commitSha, "snapshot.commitSha"),
    treeSha: requiredGitSha(value.treeSha, "snapshot.treeSha"),
    parents: value.parents.map((parent) => requiredGitSha(parent, "snapshot.parent")),
    ...(typeof value.authorExternalId === "string" && value.authorExternalId.trim() ? { authorExternalId: value.authorExternalId.trim() } : {}),
    ...(typeof value.authorGitHubLogin === "string" && value.authorGitHubLogin.trim() ? { authorGitHubLogin: value.authorGitHubLogin.trim() } : {}),
    ...(typeof value.authorName === "string" && value.authorName.trim() ? { authorName: value.authorName.trim() } : {}),
    ...(typeof value.committedAt === "string" && value.committedAt.trim() ? { committedAt: value.committedAt.trim() } : {}),
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
      tenantId, repository: requiredString(value.repository, "observation.repository"), kind,
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
      tenantId, repository: requiredString(value.repository, "observation.repository"), kind,
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
    const dependsOnServices = Array.isArray(value.dependsOnServices) ? value.dependsOnServices.map((dependency) => {
      if (!isRecord(dependency)) throw invalidRequest("service dependency must be an object");
      return {
        source: requiredString(dependency.source, "observation.dependency.source"),
        externalId: requiredString(dependency.externalId, "observation.dependency.externalId"),
        name: requiredString(dependency.name, "observation.dependency.name")
      };
    }) : [];
    return {
      tenantId, repository: requiredString(value.repository, "observation.repository"), kind,
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      path: requiredRepositoryPath(value.path, "observation.path"), source: requiredString(value.source, "observation.source"),
      externalId: requiredString(value.externalId, "observation.externalId"), name: requiredString(value.name, "observation.name"),
      ...(dependsOnServices.length > 0 ? { dependsOnServices } : {}),
      ...(value.removed === true ? { removed: true } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "deployment") {
    const service = isRecord(value.service) ? {
      source: requiredString(value.service.source, "observation.service.source"),
      externalId: requiredString(value.service.externalId, "observation.service.externalId"),
      name: requiredString(value.service.name, "observation.service.name")
    } : undefined;
    return {
      tenantId, repository: requiredString(value.repository, "observation.repository"), kind,
      source: requiredString(value.source, "observation.source"), externalId: requiredString(value.externalId, "observation.externalId"),
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"), environment: requiredString(value.environment, "observation.environment"),
      status: requiredString(value.status, "observation.status"), ...(service ? { service } : {}),
      ...(typeof value.occurredAt === "string" ? { occurredAt: value.occurredAt } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "incident") {
    const impactedService = isRecord(value.impactedService) ? {
      source: requiredString(value.impactedService.source, "observation.impactedService.source"),
      externalId: requiredString(value.impactedService.externalId, "observation.impactedService.externalId"),
      name: requiredString(value.impactedService.name, "observation.impactedService.name")
    } : undefined;
    return {
      tenantId, repository: requiredString(value.repository, "observation.repository"), kind,
      source: requiredString(value.source, "observation.source"), externalId: requiredString(value.externalId, "observation.externalId"),
      title: requiredString(value.title, "observation.title"),
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.issueNumber === "number" ? { issueNumber: requiredPositiveInteger(value.issueNumber, "observation.issueNumber") } : {}),
      ...(impactedService ? { impactedService } : {}),
      ...(typeof value.occurredAt === "string" ? { occurredAt: value.occurredAt } : {}),
      ...(value.removed === true ? { removed: true } : {}),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind === "move_candidate") {
    if (!Array.isArray(value.candidates)) throw invalidRequest("move candidates must be an array");
    return {
      tenantId, repository: requiredString(value.repository, "observation.repository"), kind,
      commitSha: requiredGitSha(value.commitSha, "observation.commitSha"),
      candidates: value.candidates.map((candidate) => {
        if (!isRecord(candidate) || !Array.isArray(candidate.matchingSignatureHashes)) throw invalidRequest("move candidate is invalid");
        const similarity = typeof candidate.similarity === "number" ? candidate.similarity : Number.NaN;
        if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) throw invalidRequest("move candidate similarity is invalid");
        return {
          oldPath: requiredRepositoryPath(candidate.oldPath, "candidate.oldPath"),
          newPath: requiredRepositoryPath(candidate.newPath, "candidate.newPath"), similarity,
          matchingSignatureHashes: candidate.matchingSignatureHashes.map((signature) => requiredString(signature, "candidate.signature"))
        };
      }),
      recordedAt: requiredString(value.recordedAt, "observation.recordedAt")
    };
  }
  if (kind !== "pull_request" && kind !== "issue") {
    throw invalidRequest("repository source observation kind is unsupported");
  }
  const positiveIntegerArray = (input: unknown, name: string): number[] => Array.isArray(input)
    ? input.map((item) => requiredPositiveInteger(item, name))
    : [];
  return {
    tenantId,
    repository: requiredString(value.repository, "observation.repository"),
    kind,
    number: requiredPositiveInteger(value.number, "observation.number"),
    title: requiredString(value.title, "observation.title"),
    ...(typeof value.body === "string" ? { body: value.body } : {}),
    state: requiredString(value.state, "observation.state"),
    url: requiredString(value.url, "observation.url"),
    ...(typeof value.authorLogin === "string" && value.authorLogin.trim() ? { authorLogin: value.authorLogin.trim() } : {}),
    ...(typeof value.occurredAt === "string" ? { occurredAt: value.occurredAt } : {}),
    ...(typeof value.mergedAt === "string" && value.mergedAt ? { mergedAt: value.mergedAt } : {}),
    ...(typeof value.mergeCommitSha === "string" ? { mergeCommitSha: requiredGitSha(value.mergeCommitSha, "observation.mergeCommitSha") } : {}),
    recordedAt: requiredString(value.recordedAt, "observation.recordedAt"),
    commitShas: Array.isArray(value.commitShas) ? value.commitShas.map((sha) => requiredGitSha(sha, "observation.commitSha")) : [],
    resolvesIssueNumbers: positiveIntegerArray(value.resolvesIssueNumbers, "observation.resolvesIssueNumber"),
    referencesIssueNumbers: positiveIntegerArray(value.referencesIssueNumbers, "observation.referencesIssueNumber")
  };
}

function parseOntologyCommand(value: Record<string, unknown>): OntologyCommand {
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
      if (!rejectionCode || !["incorrect_relationship", "insufficient_evidence", "unsupported_explanation", "other"].includes(rejectionCode)) {
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
      ...(rejectionCode ? { rejectionCode: rejectionCode as "incorrect_relationship" | "insufficient_evidence" | "unsupported_explanation" | "other" } : {})
    };
  }
  if (type === "relate_assertions") {
    const relation = requiredString(value.relation, "command.relation");
    if (relation !== "supports" && relation !== "contradicts") throw invalidRequest("unsupported assertion relation");
    return {
      type, relation,
      sourceAssertionId: requiredString(value.sourceAssertionId, "command.sourceAssertionId"),
      targetAssertionId: requiredString(value.targetAssertionId, "command.targetAssertionId"),
      evidenceObservationId: requiredString(value.evidenceObservationId, "command.evidenceObservationId"),
      ...(reason ? { reason } : {})
    };
  }
  if (type === "merge_entities" || type === "unmerge_entities") {
    return {
      type, fromEntityId: requiredString(value.fromEntityId, "command.fromEntityId"),
      toEntityId: requiredString(value.toEntityId, "command.toEntityId"), ...(reason ? { reason } : {})
    };
  }
  if (type === "redact_observation") {
    if (!reason) throw invalidRequest("redaction reason is required");
    return {
      type, observationId: requiredString(value.observationId, "command.observationId"), reason,
      ...(Array.isArray(value.commitShas) ? { commitShas: value.commitShas.map((sha) => requiredGitSha(sha, "command.commitSha")) } : {})
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
      type, repository: requiredString(value.repository, "command.repository"),
      principalId: requiredString(value.principalId, "command.principalId"), role
    };
  }
  if (type === "assign_relationship") {
    if (!reason) throw new Error("relationship explanation is required");
    const entity = (input: unknown, name: string) => {
      if (!isRecord(input)) throw invalidRequest(`${name} must be an object`);
      const kind = requiredString(input.kind, `${name}.kind`);
      if (!ontologyNodeKinds.includes(kind as OntologyNodeKind)) {
        throw invalidRequest(`${name}.kind is unsupported`);
      }
      return {
        kind: kind as OntologyNodeKind,
        key: requiredString(input.key, `${name}.key`),
        ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {})
      };
    };
    const qualifiers = isRecord(value.qualifiers)
      ? Object.fromEntries(Object.entries(value.qualifiers).map(([key, item]) => {
          if (!["string", "number", "boolean"].includes(typeof item)) {
            throw invalidRequest(`qualifier ${key} has an unsupported value`);
          }
          return [key, item as string | number | boolean];
        }))
      : undefined;
    return {
      type, ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
      subject: entity(value.subject, "command.subject"), predicate: requiredString(value.predicate, "command.predicate"),
      object: entity(value.object, "command.object"), ...(qualifiers ? { qualifiers } : {}), reason
    };
  }
  throw invalidRequest("unsupported ontology command");
}

function parseBlobAnalyses(value: unknown): readonly BlobAnalysis[] {
  if (!Array.isArray(value)) throw invalidRequest("analyses must be an array");
  return value.map((analysis) => {
    if (!isRecord(analysis) || !Array.isArray(analysis.symbols) || !Array.isArray(analysis.imports) || !Array.isArray(analysis.edges)) {
      throw invalidRequest("blob analysis must include symbols, imports, and edges");
    }
    const parserVersion = requiredString(analysis.parserVersion, "analysis.parserVersion");
    if (parserVersion !== ONTOLOGY_PARSER_VERSION) throw invalidRequest("unsupported ontology parser version");
    return {
      blobSha: requiredGitSha(analysis.blobSha, "analysis.blobSha"),
      parserVersion,
      ...(typeof analysis.language === "string" && analysis.language.trim() ? { language: analysis.language.trim() } : {}),
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
        return { specifier: requiredString(item.specifier, "import.specifier"), line: requiredPositiveInteger(item.line, "import.line") };
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

function parseOntologyAssertionBatch(value: unknown, task: BoardTask, tenantId: string): OntologyAssertionBatch {
  if (!isRecord(value)) throw invalidRequest("assertionBatch must be an object");
  const commitSha = requiredGitSha(value.commitSha, "assertionBatch.commitSha");
  if (commitSha !== task.metadata.commitSha) throw invalidRequest("assertion batch commit does not match task source");
  const evidenceFingerprint = requiredString(value.evidenceFingerprint, "assertionBatch.evidenceFingerprint");
  if (evidenceFingerprint !== task.metadata.evidenceFingerprint) throw invalidRequest("assertion batch evidence does not match task source");
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
  const rawOutput = parseGeneratedOntology(value.rawOutput);
  const sourcePullRequestNumbers = Array.isArray(task.metadata.sourcePullRequestNumbers)
    ? task.metadata.sourcePullRequestNumbers.map((number) => requiredPositiveInteger(number, "task.sourcePullRequestNumber"))
    : [];
  const resolvedPullRequestNumbers = Array.isArray(task.metadata.resolvedPullRequestNumbers)
    ? task.metadata.resolvedPullRequestNumbers.map((number) => requiredPositiveInteger(number, "task.resolvedPullRequestNumber"))
    : [];
  return {
    tenantId,
    repository,
    ref: requiredString(task.metadata.ref, "task.ref"),
    commitSha,
    taskId: task.id,
    generatedAt: requiredString(value.generatedAt, "assertionBatch.generatedAt"),
    generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    evidenceFingerprint,
    evidenceObservationIds,
    model: requiredString(value.model, "assertionBatch.model"),
    ...(typeof value.sandboxId === "string" && value.sandboxId ? { sandboxId: value.sandboxId } : {}),
    summary: requiredString(value.summary, "assertionBatch.summary"),
    ...(value.modelOutputRaw !== undefined ? { modelOutputRaw: value.modelOutputRaw } : {}),
    rawOutput,
    assertions: assertionsFromGeneratedOntology(rawOutput, repository, { sourcePullRequestNumbers, resolvedPullRequestNumbers })
  };
}

function requiredRepositoryPath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (path.startsWith("/") || path.split("/").includes("..")) throw invalidRequest(`${field} must be repository-relative`);
  return path;
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
  if (value === "proposed" || value === "active" || value === "rejected" || value === "superseded" || value === "retracted") return value;
  throw invalidRequest("unsupported assertion status");
}

function requiredContextOperation(value: string): RepositoryContextOperation {
  if (value === "lookup" || value === "counterfactual") return value;
  throw invalidRequest("operation must be lookup or counterfactual");
}

function parseDevWebhook(body: Record<string, unknown>): ParsedGitHubWebhook {
  const repository = requiredString(body.repository, "repository");
  if (body.issueNumber !== undefined) {
    return { repository, event: { type: "issue.opened", issueNumber: requiredPositiveInteger(body.issueNumber, "issueNumber"), title: typeof body.title === "string" ? body.title : "Dev issue" } };
  }
  return devPullRequestWebhook(repository, requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber"), requiredString(body.headSha, "headSha"));
}

function devPullRequestWebhook(repository: string, pullRequestNumber: number, headSha: string): ParsedGitHubWebhook {
  return { repository, event: { type: "pull_request.opened", pullRequestNumber, headSha } };
}

async function readRawBody(request: IncomingMessage, maximumBytes = MAX_WEBHOOK_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
  try { value = JSON.parse(Buffer.from(rawBody).toString("utf8")); } catch { throw invalidRequest("request body is not valid JSON"); }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalidRequest(`${field} must be a non-empty string`);
  return value.trim();
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
    segments.length !== 2 || segments.some((segment) =>
      !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9_.-]+$/.test(segment)
    )
  ) {
    throw invalidRequest(`${field} must be owner/name without traversal segments`);
  }
  return repository;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalidRequest(`${field} must be a positive integer`);
  return value;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-jina-tenant-id, x-jina-principal-id, x-github-event, x-github-delivery, x-hub-signature-256",
    "access-control-allow-methods": "GET, POST, OPTIONS"
  });
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload, null, 2));
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
    const statusCode = error.code === "invalid_argument" ? 400
      : error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : 409;
    return new ApiError(statusCode, error.code, error.message);
  }
  return new ApiError(500, "internal_error", "internal server error", false);
}

class DeliveryCache {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity: number) {}
  has(deliveryId: string): boolean { return this.ids.has(deliveryId); }
  add(deliveryId: string): void {
    if (this.ids.has(deliveryId)) return;
    if (this.ids.size >= Math.max(1, this.capacity)) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(deliveryId);
  }
}
