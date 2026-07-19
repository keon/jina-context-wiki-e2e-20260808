import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyCommand,
  findTask,
  markOutboxDispatched,
  nextPendingOutboxMessage,
  reduceBoard,
  taskTypeDefinitions,
  type CommandActor
} from "@jina/board";
import type { ParsedGitHubWebhook } from "@jina/github";
import {
  MemoryOntologyGraphStore,
  ontologyTaskTypeDefinitions,
  type OntologyExecutor,
  type OntologyGraphStore
} from "@jina/ontology";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { entityId, nowIso } from "@jina/shared-kernel";
import {
  createGitHubIntakeState,
  ingestGitHubWebhook,
  type GitHubIntakeState
} from "./github-intake.js";
import { handleGitHubWebhook } from "./routes/github-webhooks.js";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const RUN_ACTOR: CommandActor = { type: "run", id: "simulated-run" };

export interface ApiServerConfig {
  readonly githubWebhookSecret?: string;
  readonly tenantId?: string;
  readonly enableDevEndpoints?: boolean;
  readonly simulateRuns?: boolean;
  readonly seedDemo?: boolean;
  readonly deliveryCacheSize?: number;
  readonly stateStore?: ApiStateStore;
  readonly ontologyExecutor?: OntologyExecutor;
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

/**
 * Create the HTTP API without binding a port. Production and tests can choose
 * their own listener; the executable entry point lives in dev-server.ts.
 */
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
    mutations = result.then(
      () => undefined,
      () => undefined
    );
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
      if (deliveryId) {
        deliveries.add(deliveryId);
      }
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

  async function drainOneSimulatedRun(): Promise<void> {
    await ready;
    const message = nextPendingOutboxMessage(intakeState.board);
    if (!message) {
      return;
    }

    let board = markOutboxDispatched(intakeState.board, message.id, nowIso());
    const task = findTask(board, message.payload.taskId);
    if (!task || task.status !== "queued") {
      intakeState = { ...intakeState, board };
      await persist();
      return;
    }

    const repository = String(task.metadata.repository ?? "");
    const pullRequestNumber = Number(task.metadata.pullRequestNumber ?? 0);
    const tenantId = String(task.metadata.tenantId ?? "");
    const pullRequest = intakeState.pullRequests.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.repository === repository &&
        candidate.number === pullRequestNumber
    );
    if (pullRequest && task.epoch !== undefined && task.epoch !== pullRequest.epoch) {
      intakeState = { ...intakeState, board };
      await persist();
      return;
    }

    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" },
      { actor: RUN_ACTOR, now: nowIso() }
    ).state;

    if (message.topic === "run-ontology") {
      if (!config.ontologyExecutor) {
        board = applyCommand(
          board,
          {
            command: "CommentTask",
            taskId: task.id,
            eventType: "ontology.failed",
            payload: { reason: "ontology_executor_not_configured" }
          },
          { actor: RUN_ACTOR, now: nowIso() }
        ).state;
        board = applyCommand(
          board,
          { command: "TransitionTask", taskId: task.id, toStatus: "failed" },
          { actor: RUN_ACTOR, now: nowIso() }
        ).state;
        intakeState = { ...intakeState, board: reduceBoard(board, nowIso()) };
        await persist();
        return;
      }

      try {
        const graph = await config.ontologyExecutor.build({
          tenantId: String(task.metadata.tenantId ?? config.tenantId ?? "default"),
          repository: String(task.metadata.repository ?? ""),
          ref: String(task.metadata.ref ?? "main"),
          taskId: task.id
        });
        await ontologyStore.save(graph);
        board = applyCommand(
          board,
          {
            command: "CommentTask",
            taskId: task.id,
            eventType: "ontology.graph_created",
            payload: {
              graphId: graph.id,
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
              commitSha: graph.commitSha,
              sandboxId: graph.generator.sandboxId ?? ""
            }
          },
          { actor: RUN_ACTOR, now: nowIso() }
        ).state;
      } catch (error) {
        board = applyCommand(
          board,
          {
            command: "CommentTask",
            taskId: task.id,
            eventType: "ontology.failed",
            payload: { reason: error instanceof Error ? error.message : String(error) }
          },
          { actor: RUN_ACTOR, now: nowIso() }
        ).state;
        board = applyCommand(
          board,
          { command: "TransitionTask", taskId: task.id, toStatus: "failed" },
          { actor: RUN_ACTOR, now: nowIso() }
        ).state;
        intakeState = { ...intakeState, board: reduceBoard(board, nowIso()) };
        await persist();
        return;
      }
    }

    if (message.topic === "run-publish") {
      const headSha = String(task.metadata.headSha ?? "");
      const key = buildPublicationKey(`${repository}#${pullRequestNumber}`, headSha, "summary");
      publications = upsertPublication(publications, { key, headSha, target: "summary" }).records;
    }

    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "done" },
      { actor: RUN_ACTOR, now: nowIso() }
    ).state;
    intakeState = { ...intakeState, board: reduceBoard(board, nowIso()) };
    await persist();
  }

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const isTooLarge = error instanceof RequestBodyTooLargeError;
      const statusCode = isTooLarge ? 413 : 500;
      json(response, statusCode, {
        accepted: false,
        error: isTooLarge ? error.message : "internal server error"
      });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await ready;
    await mutations;
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
        ontologyExecutorConfigured: Boolean(config.ontologyExecutor)
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/board") {
      json(response, 200, {
        tasks: intakeState.board.tasks,
        dependencies: intakeState.board.dependencies,
        outbox: intakeState.board.outbox,
        publications,
        pullRequests: intakeState.pullRequests
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/task-types") {
      json(response, 200, [...taskTypeDefinitions, ...ontologyTaskTypeDefinitions]);
      return;
    }
    if (request.method === "GET" && url.pathname === "/ontology") {
      const graphs = await ontologyStore.list(config.tenantId);
      json(response, 200, { latest: graphs[0] ?? null, graphs });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/ontology/graphs/")) {
      const graphId = decodeURIComponent(url.pathname.slice("/ontology/graphs/".length));
      const graph = await ontologyStore.get(graphId);
      json(response, graph ? 200 : 404, graph ?? { error: "ontology graph not found" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      json(response, 200, intakeState.board.events);
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
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
          return {
            statusCode: 200,
            payload: { accepted: true, duplicate: true, deliveryId: result.deliveryId }
          };
        }

        if (!result.webhook) {
          await persist(result.deliveryId!);
          return { statusCode: result.statusCode, payload: result };
        }

        const intake = acceptWebhook(result.webhook, result.deliveryId!);
        if (!(await persist(result.deliveryId!))) {
          await reload();
          return {
            statusCode: 200,
            payload: { accepted: true, duplicate: true, deliveryId: result.deliveryId }
          };
        }
        return {
          statusCode: result.statusCode,
          payload: {
            accepted: true,
            deliveryId: result.deliveryId,
            outcome: intake.outcome,
            createdTaskIds: intake.createdTaskIds
          }
        };
      });
      json(response, committed.statusCode, committed.payload);
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
      json(response, 202, {
        accepted: true,
        deliveryId,
        outcome: intake.outcome,
        createdTaskIds: intake.createdTaskIds
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/ontology/build") {
      if (!config.enableDevEndpoints && !isAuthorizedInternalRequest(request, config.internalApiToken)) {
        json(response, 401, { accepted: false, error: "unauthorized" });
        return;
      }
      const body = parseJsonObject(await readRawBody(request));
      const repository = requiredString(body.repository, "repository");
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        json(response, 400, { accepted: false, error: "repository must be owner/name" });
        return;
      }
      const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : "main";
      const tenantId = typeof body.tenantId === "string" && body.tenantId.trim()
        ? body.tenantId.trim()
        : config.tenantId ?? "default";
      devDeliverySequence += 1;
      const nonce = typeof body.requestKey === "string" && body.requestKey.trim()
        ? body.requestKey.trim()
        : `${Date.now()}-${devDeliverySequence}`;
      const taskId = entityId<"task">(`task_ontology:${tenantId}:${repository}:${ref}:${nonce}`);
      const created = await mutate(async () => {
        let board = applyCommand(
          intakeState.board,
          {
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
          },
          { actor: { type: "user", id: "ontology-api" }, now: nowIso() }
        ).state;
        board = reduceBoard(board, nowIso());
        intakeState = { ...intakeState, board };
        await persist();
        return board.tasks.find((task) => task.id === taskId);
      });
      json(response, 202, { accepted: true, task: created });
      return;
    }

    json(response, 404, {
      error: "not found",
      routes: ["GET /health", "GET /board", "GET /task-types", "GET /events", "GET /ontology", "POST /ontology/build", "POST /webhooks/github"]
    });
  }

  if (config.simulateRuns) {
    const timer = setInterval(() => {
      void mutate(drainOneSimulatedRun).catch((error: unknown) => {
        console.error("simulated run failed", error);
      });
    }, 1500);
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }

  if (config.stateStore) {
    server.once("close", () => void config.stateStore?.close());
  }
  server.once("close", () => void ontologyStore.close());

  return server;
}

function isAuthorizedInternalRequest(request: IncomingMessage, token?: string): boolean {
  if (!token) return false;
  const authorization = firstHeader(request.headers.authorization);
  return authorization === `Bearer ${token}`;
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
  return {
    repository,
    event: { type: "pull_request.opened", pullRequestNumber, headSha }
  };
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_WEBHOOK_BYTES) {
      throw new RequestBodyTooLargeError(`request body exceeds ${MAX_WEBHOOK_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(rawBody: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-github-event, x-github-delivery, x-hub-signature-256",
    "access-control-allow-methods": "GET, POST, OPTIONS"
  });
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload, null, 2));
}

class RequestBodyTooLargeError extends Error {}

class DeliveryCache {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(deliveryId: string): boolean {
    return this.ids.has(deliveryId);
  }

  add(deliveryId: string): void {
    if (this.ids.has(deliveryId)) {
      return;
    }
    if (this.ids.size >= Math.max(1, this.capacity)) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
      }
    }
    this.ids.add(deliveryId);
  }
}
