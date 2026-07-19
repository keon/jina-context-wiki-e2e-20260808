import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyCommand,
  findOutboxMessage,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
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
  MemoryOntologyGraphStore,
  ontologyTaskTypeDefinitions,
  parseGeneratedOntology,
  type OntologyGraph,
  type OntologyGraphStore
} from "@jina/ontology";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { entityId, nowIso } from "@jina/shared-kernel";
import { createGitHubIntakeState, ingestGitHubWebhook, type GitHubIntakeState } from "./github-intake.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const WORKER_LEASE_MS = 35 * 60 * 1000;
const RUN_ACTOR: CommandActor = { type: "run", id: "worker" };

export interface ApiServerConfig {
  readonly githubWebhookSecret?: string;
  readonly tenantId?: string;
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
      intakeState = stored.intakeState;
      publications = stored.publications;
      devDeliverySequence = stored.devDeliverySequence;
      return;
    }
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
      (candidate) => candidate.status === "pending" && candidate.topic !== "run-ontology"
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
      const graphs = await ontologyStore.list(tenantId);
      json(response, 200, { latest: graphs[0] ?? null, graphs });
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
    if (request.method === "POST" && url.pathname === "/internal/worker/claim") {
      await claimOntologyWork(request, response, tenantId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/worker/complete") {
      await completeOntologyWork(request, response, tenantId);
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
    const taskId = entityId<"task">(`task_ontology:${tenantId}:${repository}:${ref}:${nonce}`);
    const created = await mutate(async () => {
      let board = applyCommand(intakeState.board, {
        command: "CreateTask",
        task: {
          id: taskId,
          type: "ontology_build",
          kind: "dispatchable",
          title: `Build Ontology for ${repository}@${ref}`,
          assigneeRole: "ontology_worker",
          dedupeKey: `ontology:${tenantId}:${repository}:${ref}:${nonce}`,
          dispatchTopic: "run-ontology",
          required: true,
          metadata: { tenantId, repository, ref, requestKey: nonce }
        },
        blocksParentCompletion: false
      }, { actor: { type: "user", id: "ontology-api" }, now: nowIso() }).state;
      board = reduceBoard(board, nowIso());
      intakeState = { ...intakeState, board };
      await persist();
      return findTask(board, taskId);
    });
    json(response, 202, { accepted: true, task: created });
  }

  async function claimOntologyWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const workerId = requiredString(body.workerId, "workerId");
    const claimed = await mutate(async () => {
      const taskIds = [...tenantTaskIds(intakeState, tenantId)];
      const now = nowIso();
      const leaseId = randomUUID();
      const leased = leaseNextOutboxMessage(intakeState.board, {
        topics: ["run-ontology"],
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

  async function completeOntologyWork(request: IncomingMessage, response: ServerResponse, tenantId: string): Promise<void> {
    const body = parseJsonObject(await readRawBody(request));
    const messageId = entityId<"board_outbox_message">(requiredString(body.messageId, "messageId")) as BoardOutboxMessageId;
    const leaseId = requiredString(body.leaseId, "leaseId");
    const outcome = body.outcome;
    if (outcome !== "done" && outcome !== "failed") throw new Error("outcome must be done or failed");
    const task = findTask(intakeState.board, entityId<"task">(requiredString(body.taskId, "taskId")) as TaskId);
    if (!task || task.metadata.tenantId !== tenantId) {
      json(response, 404, { accepted: false, error: "task not found" });
      return;
    }
    const graph = outcome === "done" ? parseCompletedGraph(body.graph, task, tenantId) : undefined;
    const result = await mutate(async () => {
      const message = findOutboxMessage(intakeState.board, messageId);
      if (!message || message.taskId !== task.id || message.status !== "leased" || message.leaseId !== leaseId) {
        return false;
      }
      if (graph) await ontologyStore.save(graph);
      const now = nowIso();
      let board = markOutboxDispatched(intakeState.board, message.id, now);
      board = applyCommand(board, {
        command: "CommentTask",
        taskId: task.id,
        eventType: graph ? "ontology.graph_created" : "ontology.failed",
        payload: graph
          ? { graphId: graph.id, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, commitSha: graph.commitSha }
          : { reason: String(body.reason ?? "worker failed").slice(0, 2000) }
      }, { actor: RUN_ACTOR, now }).state;
      board = applyCommand(board, {
        command: "TransitionTask",
        taskId: task.id,
        toStatus: graph ? "done" : "failed"
      }, { actor: RUN_ACTOR, now }).state;
      intakeState = { ...intakeState, board: reduceBoard(board, now) };
      await persist();
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

function parseCompletedGraph(value: unknown, task: BoardTask, tenantId: string): OntologyGraph {
  if (!isRecord(value) || !isRecord(value.generator)) throw new Error("graph must be an object");
  const executor = value.generator.executor;
  if (executor !== "daytona" && executor !== "fixture") throw new Error("unsupported graph executor");
  return createOntologyGraph({
    request: {
      tenantId,
      repository: requiredString(task.metadata.repository, "task.repository"),
      ref: requiredString(task.metadata.ref, "task.ref"),
      taskId: task.id
    },
    commitSha: requiredString(value.commitSha, "graph.commitSha"),
    generatedAt: requiredString(value.generatedAt, "graph.generatedAt"),
    executor,
    model: requiredString(value.generator.model, "graph.generator.model"),
    ...(typeof value.generator.sandboxId === "string" ? { sandboxId: value.generator.sandboxId } : {}),
    generated: parseGeneratedOntology({ summary: value.summary, nodes: value.nodes, edges: value.edges })
  });
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

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_WEBHOOK_BYTES) throw new RequestBodyTooLargeError(`request body exceeds ${MAX_WEBHOOK_BYTES} bytes`);
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
