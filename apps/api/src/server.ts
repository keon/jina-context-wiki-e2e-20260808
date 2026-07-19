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
  ontologyTaskTypeDefinitions,
  parseGeneratedOntology,
  type BlobAnalysis,
  type OntologyAssertionBatch,
  type OntologyGraph,
  type OntologyGraphStore,
  type RepositorySnapshot
} from "@jina/ontology";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { entityId, nowIso } from "@jina/shared-kernel";
import { createGitHubIntakeState, ingestGitHubWebhook, type GitHubIntakeState } from "./github-intake.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_ONTOLOGY_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const WORKER_LEASE_MS = 5 * 60 * 1000;
const RUN_ACTOR: CommandActor = { type: "run", id: "worker" };
const WORKER_TOPICS = [
  "run-review",
  "run-research",
  "run-publish",
  "run-cleanup",
  "run-ontology",
  "run-ontology-prepare",
  "run-ontology-generate",
  "run-ontology-ingest",
  "run-ontology-assert",
  "run-ontology-project"
] as const;

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
}

export interface ApiSnapshot {
  readonly intakeState: GitHubIntakeState;
  readonly publications: readonly PublicationRecord[];
  readonly devDeliverySequence: number;
}

export interface ApiStateStore {
  load(): Promise<ApiSnapshot | undefined>;
  ping(): Promise<void>;
  hasDelivery(deliveryId: string): Promise<boolean>;
  save(snapshot: ApiSnapshot, deliveryId?: string): Promise<boolean>;
  saveWithOntologyGraph?(snapshot: ApiSnapshot, graph: OntologyGraph): Promise<void>;
  close(): Promise<void>;
}

/** Creates the HTTP API without binding a port. */
export function createApiServer(config: ApiServerConfig = {}): Server {
  let intakeState: GitHubIntakeState = createGitHubIntakeState();
  let publications: readonly PublicationRecord[] = [];
  let devDeliverySequence = 0;
  const deliveries = new DeliveryCache(config.deliveryCacheSize ?? 10_000);
  const ontologyStore = config.ontologyStore ?? new MemoryOntologyGraphStore();
  const ready = initializeState();
  let mutations = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation);
    mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async function initializeState(): Promise<void> {
    const stored = await config.stateStore?.load();
    if (stored) {
      const migrated = migrateSnapshotTenantAliases(stored, config.tenantId, config.tenantAliases ?? []);
      intakeState = migrated.snapshot.intakeState;
      publications = migrated.snapshot.publications;
      devDeliverySequence = migrated.snapshot.devDeliverySequence;
      if (migrated.changed) await persist();
      if (config.tenantId) await ontologyStore.migrateTenantAliases(config.tenantId, config.tenantAliases ?? []);
      return;
    }
    if (config.tenantId) await ontologyStore.migrateTenantAliases(config.tenantId, config.tenantAliases ?? []);
    if (config.seedDemo) {
      devDeliverySequence += 1;
      acceptWebhook(devPullRequestWebhook("omlabs/example", 42, "abc123"), `dev-seed-${devDeliverySequence}`);
      await persist();
    }
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
    const stored = await config.stateStore?.load();
    if (stored) {
      intakeState = stored.intakeState;
      publications = stored.publications;
      devDeliverySequence = stored.devDeliverySequence;
    }
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
      const isTooLarge = error instanceof RequestBodyTooLargeError;
      console.error("API request failed", error instanceof Error ? error.message : String(error));
      json(response, isTooLarge ? 413 : 500, {
        accepted: false,
        error: isTooLarge ? error.message : "internal server error"
      });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await ready;
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
      json(response, 200, [...taskTypeDefinitions, ...ontologyTaskTypeDefinitions]);
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      await handleWebhook(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/dev/webhooks/github" && config.enableDevEndpoints) {
      const body = parseJsonObject(await readRawBody(request));
      const webhook = parseDevWebhook(body);
      devDeliverySequence += 1;
      const deliveryId = `dev-${devDeliverySequence}`;
      const intake = await mutate(async () => {
        const accepted = acceptWebhook(webhook, deliveryId);
        await persist(deliveryId);
        return accepted;
      });
      json(response, 202, { accepted: true, deliveryId, outcome: intake.outcome, createdTaskIds: intake.createdTaskIds });
      return;
    }

    const tenantId = authenticatedTenant(request, config);
    if (!tenantId) {
      json(response, 401, { accepted: false, error: "unauthorized" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/board") {
      json(response, 200, tenantBoardView(intakeState, publications, tenantId));
      return;
    }
    if (request.method === "GET" && url.pathname === "/ontology") {
      const [latest, graphs] = await Promise.all([
        ontologyStore.latest(tenantId),
        ontologyStore.listSummaries(tenantId)
      ]);
      json(response, 200, { latest: latest ?? null, graphs });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/ontology/graphs/")) {
      const graphId = decodeURIComponent(url.pathname.slice("/ontology/graphs/".length));
      const graph = await ontologyStore.get(graphId, tenantId);
      json(response, graph ? 200 : 404, graph ?? { error: "ontology graph not found" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const taskIds = tenantTaskIds(intakeState, tenantId);
      json(response, 200, intakeState.board.events.filter((event) => event.taskId && taskIds.has(event.taskId)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/ontology/build") {
      await createOntologyTask(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/ingest/plan") {
      await planOntologyIngestion(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/ingest/blobs") {
      await applyOntologyBlobAnalyses(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/ontology/assertions/cached") {
      await findCachedOntologyAssertions(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/claim") {
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
    const committed = await mutate(async () => {
      if (await hasDelivery(result.deliveryId!)) {
        return { statusCode: 200, payload: { accepted: true, duplicate: true, deliveryId: result.deliveryId } };
      }
      if (!result.webhook) {
        await persist(result.deliveryId!);
        return { statusCode: result.statusCode, payload: result };
      }
      const intake = acceptWebhook(result.webhook, result.deliveryId!);
      if (!(await persist(result.deliveryId!))) {
        await reload();
        return { statusCode: 200, payload: { accepted: true, duplicate: true, deliveryId: result.deliveryId } };
      }
      return {
        statusCode: result.statusCode,
        payload: { accepted: true, deliveryId: result.deliveryId, outcome: intake.outcome, createdTaskIds: intake.createdTaskIds }
      };
    });
    json(response, committed.statusCode, committed.payload);
  }

  async function createOntologyTask(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const repository = requiredString(body.repository, "repository");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      json(response, 400, { accepted: false, error: "repository must be owner/name" });
      return;
    }
    const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : "main";
    devDeliverySequence += 1;
    const nonce = typeof body.requestKey === "string" && body.requestKey.trim()
      ? body.requestKey.trim()
      : `${Date.now()}-${devDeliverySequence}`;
    const taskKey = `task_ontology:${tenantId}:${repository}:${ref}:${nonce}`;
    const taskId = entityId<"task">(`${taskKey}:root`);
    const ingestTaskId = entityId<"task">(`${taskKey}:ingest`);
    const assertionTaskId = entityId<"task">(`${taskKey}:assert`);
    const projectionTaskId = entityId<"task">(`${taskKey}:project`);
    const created = await mutate(async () => {
      let board = applyCommand(intakeState.board, {
        command: "CreateTask",
        task: {
          id: taskId,
          type: "ontology_build",
          kind: "aggregate",
          title: `Build Ontology for ${repository}@${ref}`,
          assigneeRole: "system",
          dedupeKey: `ontology:${tenantId}:${repository}:${ref}:${nonce}:root`,
          required: true,
          metadata: { tenantId, repository, ref, requestKey: nonce }
        },
        blocksParentCompletion: false
      }, { actor: { type: "user", id: "ontology-api" }, now: nowIso() }).state;
      board = applyCommand(board, {
        command: "CreateTask",
        task: {
          id: ingestTaskId,
          type: "ontology_ingest",
          kind: "dispatchable",
          title: `Aggregate raw repository data for ${repository}@${ref}`,
          assigneeRole: "ontology_worker",
          dedupeKey: `ontology:${tenantId}:${repository}:${ref}:${nonce}:ingest`,
          dispatchTopic: "run-ontology-ingest",
          parentTaskId: taskId,
          required: true,
          metadata: { tenantId, repository, ref, requestKey: nonce }
        }
      }, { actor: { type: "user", id: "ontology-api" }, now: nowIso() }).state;
      board = applyCommand(board, {
        command: "CreateTask",
        task: {
          id: assertionTaskId,
          type: "ontology_assert",
          kind: "dispatchable",
          title: `Derive assertions for ${repository}@${ref}`,
          assigneeRole: "ontology_worker",
          dedupeKey: `ontology:${tenantId}:${repository}:${ref}:${nonce}:assert`,
          dispatchTopic: "run-ontology-assert",
          parentTaskId: taskId,
          required: true,
          metadata: { tenantId, repository, ref, requestKey: nonce }
        },
        dependencies: [{
          taskId: assertionTaskId,
          dependsOnTaskId: ingestTaskId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }]
      }, { actor: { type: "user", id: "ontology-api" }, now: nowIso() }).state;
      board = applyCommand(board, {
        command: "CreateTask",
        task: {
          id: projectionTaskId,
          type: "ontology_project",
          kind: "dispatchable",
          title: `Project Ontology for ${repository}@${ref}`,
          assigneeRole: "ontology_worker",
          dedupeKey: `ontology:${tenantId}:${repository}:${ref}:${nonce}:project`,
          dispatchTopic: "run-ontology-project",
          parentTaskId: taskId,
          required: true,
          metadata: { tenantId, repository, ref, requestKey: nonce }
        },
        dependencies: [{
          taskId: projectionTaskId,
          dependsOnTaskId: assertionTaskId,
          relationship: "blocks",
          required: true,
          blocksParentCompletion: true
        }]
      }, { actor: { type: "user", id: "ontology-api" }, now: nowIso() }).state;
      board = reduceBoard(board, nowIso());
      intakeState = { ...intakeState, board };
      await persist();
      return findTask(board, taskId);
    });
    json(response, 202, { accepted: true, task: created });
  }

  async function planOntologyIngestion(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request, MAX_ONTOLOGY_SNAPSHOT_BYTES));
    const snapshot = parseRepositorySnapshot(body.snapshot, tenantId);
    const task = requireLeasedOntologyTask(body, snapshot.taskId, tenantId, "ontology_ingest");
    if (snapshot.repository !== task.metadata.repository || snapshot.ref !== task.metadata.ref) {
      throw new Error("repository snapshot does not match ontology task");
    }
    const plan = await ontologyStore.planIngestion(snapshot);
    json(response, 200, plan);
  }

  async function applyOntologyBlobAnalyses(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_ingest");
    const commitSha = requiredGitSha(body.commitSha, "commitSha");
    const analyses = parseBlobAnalyses(body.analyses);
    await ontologyStore.applyBlobAnalyses({
      tenantId,
      repository: requiredString(task.metadata.repository, "task.repository"),
      commitSha
    }, analyses);
    json(response, 200, { accepted: true, count: analyses.length });
  }

  async function findCachedOntologyAssertions(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const taskId = requiredString(body.taskId, "taskId");
    const task = requireLeasedOntologyTask(body, taskId, tenantId, "ontology_assert");
    const cached = await ontologyStore.hasAssertionGeneration(
      tenantId,
      requiredString(task.metadata.repository, "task.repository"),
      requiredGitSha(body.commitSha, "commitSha"),
      ONTOLOGY_GENERATOR_VERSION
    );
    json(response, 200, { cached: cached ?? null });
  }

  function requireOntologyTask(taskId: string, tenantId: string, type: string): BoardTask {
    const task = findTask(intakeState.board, entityId<"task">(taskId) as TaskId);
    if (!task || task.metadata.tenantId !== tenantId || task.type !== type) throw new Error("ontology task not found");
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
      throw new Error("stale ontology worker lease");
    }
    return task;
  }

  async function claimWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerId = requiredString(body.workerId, "workerId");
    const requestedTopics = Array.isArray(body.topics)
      ? body.topics.filter((topic): topic is string => typeof topic === "string" && WORKER_TOPICS.includes(topic as typeof WORKER_TOPICS[number]))
      : [];
    if (requestedTopics.length === 0) {
      json(response, 400, { accepted: false, error: "at least one supported topic is required" });
      return;
    }
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
    json(response, renewed ? 200 : 409, renewed ? { accepted: true } : { accepted: false, error: "stale lease" });
  }

  async function completeWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = entityId<"board_outbox_message">(requiredString(body.messageId, "messageId")) as BoardOutboxMessageId;
    const leaseId = requiredString(body.leaseId, "leaseId");
    const outcome = body.outcome;
    if (outcome !== "done" && outcome !== "failed") throw new Error("outcome must be done or failed");
    const taskId = entityId<"task">(requiredString(body.taskId, "taskId")) as TaskId;
    const task = findTask(intakeState.board, taskId);
    if (!task || task.metadata.tenantId !== tenantId) {
      json(response, 404, { accepted: false, error: "task not found" });
      return;
    }
    const initialMessage = findOutboxMessage(intakeState.board, messageId);
    let graph = outcome === "done" && (initialMessage?.topic === "run-ontology" || initialMessage?.topic === "run-ontology-generate")
      ? parseCompletedGraph(body.graph, task, tenantId)
      : undefined;
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
      if (outcome === "done" && message.topic === "run-ontology-prepare") {
        const resultPayload = isRecord(body.result) ? body.result : {};
        const commitSha = requiredGitSha(resultPayload.commitSha, "result.commitSha");
        const generationTask = board.tasks.find((candidate) =>
          candidate.parentTaskId === currentTask.parentTaskId && candidate.type === "ontology_generate"
        );
        if (!generationTask) throw new Error("ontology generation task not found");
        board = applyCommand(board, {
          command: "UpdateTask",
          taskId: generationTask.id,
          metadata: { commitSha }
        }, { actor: RUN_ACTOR, now }).state;
      }
      if (outcome === "done" && message.topic === "run-ontology-ingest") {
        const resultPayload = isRecord(body.result) ? body.result : {};
        const commitSha = requiredGitSha(resultPayload.commitSha, "result.commitSha");
        const analysisPaths = Array.isArray(resultPayload.analysisPaths)
          ? resultPayload.analysisPaths.map((path) => requiredRepositoryPath(path, "result.analysisPaths"))
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
              ...(childType === "ontology_assert" ? { analysisPaths } : {})
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
        eventPayload = safeResultPayload(assertionResult);
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
        graph = await ontologyStore.project({
          tenantId,
          repository: requiredString(currentTask.metadata.repository, "task.repository"),
          ref: requiredString(currentTask.metadata.ref, "task.ref"),
          commitSha: requiredGitSha(currentTask.metadata.commitSha, "task.commitSha"),
          taskId: currentTask.id,
          generatedAt: now
        });
      }
      board = applyCommand(board, {
        command: "CommentTask",
        taskId,
        eventType: outcome === "failed" ? `${message.topic}.failed` : completionEventType(message.topic),
        payload: outcome === "failed"
          ? { reason: String(body.reason ?? "worker failed").slice(0, 2000) }
          : graph
          ? { graphId: graph.id, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, commitSha: graph.commitSha }
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
        if (graph && config.stateStore && message.topic !== "run-ontology-project") {
          if (!config.stateStore.saveWithOntologyGraph) throw new Error("state store does not support atomic ontology completion");
          await config.stateStore.saveWithOntologyGraph(snapshot(), graph);
        } else {
          if (graph && message.topic !== "run-ontology-project") await ontologyStore.save(graph);
          await persist();
        }
      } catch (error) {
        intakeState = previousIntakeState;
        publications = previousPublications;
        throw error;
      }
      return true;
    });
    json(response, result ? 200 : 409, result ? { accepted: true, graphId: graph?.id } : { accepted: false, error: "stale lease" });
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

function authenticatedTenant(request: IncomingMessage, config: ApiServerConfig): string | undefined {
  if (config.enableDevEndpoints) {
    return firstHeader(request.headers["x-jina-tenant-id"]) ?? config.tenantId ?? "default";
  }
  if (!config.internalApiToken || firstHeader(request.headers.authorization) !== `Bearer ${config.internalApiToken}`) return undefined;
  return config.tenantId;
}

function tenantTaskIds(state: GitHubIntakeState, tenantId: string): Set<TaskId> {
  return new Set(state.board.tasks.filter((task) => task.metadata.tenantId === tenantId).map((task) => task.id));
}

function tenantBoardView(state: GitHubIntakeState, publications: readonly PublicationRecord[], tenantId: string) {
  const taskIds = tenantTaskIds(state, tenantId);
  const pullRequests = state.pullRequests.filter((pullRequest) => pullRequest.tenantId === tenantId);
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
    case "run-ontology": return "ontology.graph_created";
    case "run-ontology-prepare": return "ontology.source_prepared";
    case "run-ontology-generate": return "ontology.graph_created";
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

function parseCompletedGraph(value: unknown, task: BoardTask, tenantId: string): OntologyGraph {
  if (!isRecord(value) || !isRecord(value.generator)) throw new Error("graph must be an object");
  const executor = value.generator.executor;
  if (executor !== "daytona" && executor !== "fixture") throw new Error("unsupported graph executor");
  const commitSha = requiredString(value.commitSha, "graph.commitSha");
  const preparedCommitSha = typeof task.metadata.commitSha === "string" ? task.metadata.commitSha : undefined;
  if (preparedCommitSha && commitSha !== preparedCommitSha) throw new Error("graph commit does not match prepared source");
  return createOntologyGraph({
    request: {
      tenantId,
      repository: requiredString(task.metadata.repository, "task.repository"),
      ref: requiredString(task.metadata.ref, "task.ref"),
      taskId: task.id
    },
    commitSha,
    generatedAt: requiredString(value.generatedAt, "graph.generatedAt"),
    executor,
    model: requiredString(value.generator.model, "graph.generator.model"),
    ...(typeof value.generator.sandboxId === "string" ? { sandboxId: value.generator.sandboxId } : {}),
    generated: parseGeneratedOntology({ summary: value.summary, nodes: value.nodes, edges: value.edges })
  });
}

function parseRepositorySnapshot(value: unknown, tenantId: string): RepositorySnapshot {
  if (!isRecord(value) || !Array.isArray(value.files) || !Array.isArray(value.parents)) {
    throw new Error("snapshot must include files and parents");
  }
  return {
    tenantId,
    repository: requiredString(value.repository, "snapshot.repository"),
    ref: requiredString(value.ref, "snapshot.ref"),
    commitSha: requiredGitSha(value.commitSha, "snapshot.commitSha"),
    treeSha: requiredGitSha(value.treeSha, "snapshot.treeSha"),
    parents: value.parents.map((parent) => requiredGitSha(parent, "snapshot.parent")),
    recordedAt: requiredString(value.recordedAt, "snapshot.recordedAt"),
    taskId: requiredString(value.taskId, "snapshot.taskId"),
    files: value.files.map((file) => {
      if (!isRecord(file)) throw new Error("snapshot file must be an object");
      const path = requiredRepositoryPath(file.path, "snapshot.file.path");
      const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0;
      return { path, blobSha: requiredGitSha(file.blobSha, "snapshot.file.blobSha"), size };
    })
  };
}

function parseBlobAnalyses(value: unknown): readonly BlobAnalysis[] {
  if (!Array.isArray(value)) throw new Error("analyses must be an array");
  return value.map((analysis) => {
    if (!isRecord(analysis) || !Array.isArray(analysis.symbols) || !Array.isArray(analysis.imports)) {
      throw new Error("blob analysis must include symbols and imports");
    }
    const parserVersion = requiredString(analysis.parserVersion, "analysis.parserVersion");
    if (parserVersion !== ONTOLOGY_PARSER_VERSION) throw new Error("unsupported ontology parser version");
    return {
      blobSha: requiredGitSha(analysis.blobSha, "analysis.blobSha"),
      parserVersion,
      ...(typeof analysis.language === "string" && analysis.language.trim() ? { language: analysis.language.trim() } : {}),
      symbols: analysis.symbols.map((symbol) => {
        if (!isRecord(symbol)) throw new Error("symbol must be an object");
        return {
          moniker: requiredString(symbol.moniker, "symbol.moniker"),
          name: requiredString(symbol.name, "symbol.name"),
          kind: requiredString(symbol.kind, "symbol.kind"),
          startLine: requiredPositiveInteger(symbol.startLine, "symbol.startLine"),
          endLine: requiredPositiveInteger(symbol.endLine, "symbol.endLine")
        };
      }),
      imports: analysis.imports.map((item) => {
        if (!isRecord(item)) throw new Error("import must be an object");
        return { specifier: requiredString(item.specifier, "import.specifier"), line: requiredPositiveInteger(item.line, "import.line") };
      })
    };
  });
}

function parseOntologyAssertionBatch(value: unknown, task: BoardTask, tenantId: string): OntologyAssertionBatch {
  if (!isRecord(value)) throw new Error("assertionBatch must be an object");
  const commitSha = requiredGitSha(value.commitSha, "assertionBatch.commitSha");
  if (commitSha !== task.metadata.commitSha) throw new Error("assertion batch commit does not match task source");
  const repository = requiredString(task.metadata.repository, "task.repository");
  const rawOutput = parseGeneratedOntology(value.rawOutput);
  return {
    tenantId,
    repository,
    ref: requiredString(task.metadata.ref, "task.ref"),
    commitSha,
    taskId: task.id,
    generatedAt: requiredString(value.generatedAt, "assertionBatch.generatedAt"),
    generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    model: requiredString(value.model, "assertionBatch.model"),
    ...(typeof value.sandboxId === "string" && value.sandboxId ? { sandboxId: value.sandboxId } : {}),
    summary: requiredString(value.summary, "assertionBatch.summary"),
    rawOutput,
    assertions: assertionsFromGeneratedOntology(rawOutput, repository)
  };
}

function requiredRepositoryPath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`${field} must be repository-relative`);
  return path;
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
  let value: unknown;
  try { value = JSON.parse(Buffer.from(rawBody).toString("utf8")); } catch { throw new Error("request body is not valid JSON"); }
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function requiredGitSha(value: unknown, field: string): string {
  const sha = requiredString(value, field);
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`${field} must be a full Git SHA`);
  return sha;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-jina-tenant-id, x-github-event, x-github-delivery, x-hub-signature-256",
    "access-control-allow-methods": "GET, POST, OPTIONS"
  });
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload, null, 2));
}

class RequestBodyTooLargeError extends Error {}

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
