import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyCommand,
  findTask,
  markOutboxDispatched,
  nextPendingOutboxMessage,
  reduceBoard,
  type CommandActor
} from "@jina/board";
import type { ParsedGitHubWebhook } from "@jina/github";
import { buildPublicationKey, upsertPublication, type PublicationRecord } from "@jina/publication";
import { nowIso } from "@jina/shared-kernel";
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

  function acceptWebhook(webhook: ParsedGitHubWebhook, deliveryId: string) {
    const result = ingestGitHubWebhook(intakeState, webhook, {
      deliveryId,
      now: nowIso(),
      ...(config.tenantId ? { tenantId: config.tenantId } : {})
    });
    intakeState = result.state;
    return result;
  }

  function drainOneSimulatedRun(): void {
    const message = nextPendingOutboxMessage(intakeState.board);
    if (!message) {
      return;
    }

    let board = markOutboxDispatched(intakeState.board, message.id, nowIso());
    const task = findTask(board, message.payload.taskId);
    if (!task || task.status !== "queued") {
      intakeState = { ...intakeState, board };
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
      return;
    }

    board = applyCommand(
      board,
      { command: "TransitionTask", taskId: task.id, toStatus: "in_progress" },
      { actor: RUN_ACTOR, now: nowIso() }
    ).state;

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
  }

  if (config.seedDemo) {
    devDeliverySequence += 1;
    acceptWebhook(devPullRequestWebhook("omlabs/example", 42, "abc123"), `dev-seed-${devDeliverySequence}`);
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
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, {
        ok: true,
        githubWebhookConfigured: Boolean(config.githubWebhookSecret),
        storage: "memory"
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/board") {
      json(response, 200, {
        tasks: intakeState.board.tasks,
        outbox: intakeState.board.outbox,
        publications,
        pullRequests: intakeState.pullRequests
      });
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
      if (deliveries.has(result.deliveryId)) {
        json(response, 200, { accepted: true, duplicate: true, deliveryId: result.deliveryId });
        return;
      }

      if (!result.webhook) {
        deliveries.add(result.deliveryId);
        json(response, result.statusCode, result);
        return;
      }

      const intake = acceptWebhook(result.webhook, result.deliveryId);
      deliveries.add(result.deliveryId);
      json(response, result.statusCode, {
        accepted: true,
        deliveryId: result.deliveryId,
        outcome: intake.outcome,
        createdTaskIds: intake.createdTaskIds
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/dev/webhooks/github" && config.enableDevEndpoints) {
      const body = parseJsonObject(await readRawBody(request));
      const webhook = parseDevWebhook(body);
      devDeliverySequence += 1;
      const deliveryId = `dev-${devDeliverySequence}`;
      const intake = acceptWebhook(webhook, deliveryId);
      json(response, 202, {
        accepted: true,
        deliveryId,
        outcome: intake.outcome,
        createdTaskIds: intake.createdTaskIds
      });
      return;
    }

    json(response, 404, {
      error: "not found",
      routes: ["GET /healthz", "GET /board", "GET /events", "POST /webhooks/github"]
    });
  }

  if (config.simulateRuns) {
    const timer = setInterval(drainOneSimulatedRun, 1500);
    timer.unref();
    server.once("close", () => clearInterval(timer));
  }

  return server;
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
