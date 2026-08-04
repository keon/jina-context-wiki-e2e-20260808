import { createHmac, timingSafeEqual } from "node:crypto";

import type { BillingService } from "./billing.js";
import { ApiError } from "./errors.js";
import { REVIEW_TASK_ID, isReviewTaskTriggerAllowed } from "./review-task-routing.js";
import { handleReviewCommand, type ReviewCommandGithub } from "./review-command.js";
import {
  getReviewTriggerModeForInstallation,
  recordGithubEvent,
  updateGithubInstallationLifecycle,
  type ReviewTriggerMode,
} from "./store.js";
import type { DispatchOptions, WorkflowDispatcher } from "./workflow-dispatcher.js";
import type { AppConfig } from "./config.js";
import { INSTALLATION_BACKFILL_TASK_ID } from "./installation-board-admission.js";

const pullRequestReviewActions = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export type WebhookResponse = {
  accepted: boolean;
  event: string;
  action?: string;
  task_id?: string;
  run_id?: string;
  ignored_reason?: string;
};

export async function handleGithubWebhook(input: {
  config: AppConfig;
  trigger: WorkflowDispatcher;
  headers: Headers;
  rawBody: string;
  billing?: BillingService;
  reviewCommandGithub?: ReviewCommandGithub;
  reviewTriggerModeForInstallation?: (installationId: number) => Promise<ReviewTriggerMode>;
  installationLifecycleUpdater?: typeof updateGithubInstallationLifecycle;
}): Promise<WebhookResponse> {
  const event = requiredHeader(input.headers, "x-github-event");
  const deliveryId = requiredHeader(input.headers, "x-github-delivery");
  const signature = requiredHeader(input.headers, "x-hub-signature-256");

  verifyGithubSignature(input.config.githubWebhookSecret, input.rawBody, signature);

  const payload = parsePayload(input.rawBody);
  const action = stringAt(payload, ["action"]);

  // Comment bodies may contain private run-specific instructions; the review
  // payload carries them to the worker without copying them into the generic
  // GitHub event table.
  if (event !== "issue_comment" && event !== "pull_request_review_comment") {
    try {
      await recordGithubEvent(deliveryId, event, action, payload);
    } catch (error) {
      console.warn("github_event_persist_failed", {
        event,
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (event === "pull_request") {
    return handlePullRequest({
      config: input.config,
      trigger: input.trigger,
      deliveryId,
      payload,
      action,
      billing: input.billing,
      reviewTriggerModeForInstallation:
        input.reviewTriggerModeForInstallation ?? getReviewTriggerModeForInstallation,
    });
  }

  if (event === "installation" || event === "installation_repositories") {
    if (event === "installation" && (action === "suspended" || action === "deleted")) {
      const installationId = requiredNumber(payload, ["installation", "id"]);
      await (input.installationLifecycleUpdater ?? updateGithubInstallationLifecycle)(
        installationId,
        action,
      );
    }
    return handleInstallationEvent({
      config: input.config,
      trigger: input.trigger,
      event,
      deliveryId,
      payload,
      action,
    });
  }

  if (event === "issue_comment" || event === "pull_request_review_comment") {
    return handleReviewCommand({
      event,
      trigger: input.trigger,
      deliveryId,
      payload,
      action,
      billing: input.billing,
      github: input.reviewCommandGithub,
    });
  }

  console.info("ignored_github_event", { event, deliveryId });
  return {
    accepted: false,
    event,
    action,
    ignored_reason: "event is not used by this service",
  };
}

export function verifyGithubSignature(secret: string, body: string | Buffer, signature: string): void {
  const signatureHex = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : undefined;
  if (!signatureHex) {
    throw new ApiError(401, "invalid GitHub signature prefix");
  }

  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(signatureHex, "hex");

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ApiError(401, "GitHub signature mismatch");
  }
}

async function handlePullRequest(input: {
  config: AppConfig;
  trigger: WorkflowDispatcher;
  deliveryId: string;
  payload: JsonObject;
  action?: string;
  billing?: BillingService;
  reviewTriggerModeForInstallation: (installationId: number) => Promise<ReviewTriggerMode>;
}): Promise<WebhookResponse> {
  if (!input.action) {
    throw new ApiError(400, "pull_request action is missing");
  }

  if (!pullRequestReviewActions.has(input.action)) {
    return {
      accepted: false,
      event: "pull_request",
      action: input.action,
      ignored_reason: "pull request action does not trigger reviews",
    };
  }

  const draft = booleanAt(input.payload, ["pull_request", "draft"]) ?? false;
  if (draft && input.action !== "ready_for_review") {
    return {
      accepted: false,
      event: "pull_request",
      action: input.action,
      ignored_reason: "draft pull requests are ignored until ready_for_review",
    };
  }

  const repositoryFullName = requiredString(input.payload, ["repository", "full_name"]);
  if (!isReviewTaskTriggerAllowed(repositoryFullName)) {
    return {
      accepted: false,
      event: "pull_request",
      action: input.action,
      ignored_reason: "review trigger task is disabled for repository",
    };
  }

  const repositoryId = requiredNumber(input.payload, ["repository", "id"]);
  const prNumber = requiredNumber(input.payload, ["pull_request", "number"]);
  const headSha = requiredString(input.payload, ["pull_request", "head", "sha"]);
  const installationId = requiredNumber(input.payload, ["installation", "id"]);
  // The PR author login drives the author-harness billing classification. It lives on the webhook
  // payload (no review_run row exists yet) and is threaded into the dispatch billing context so a BYOH
  // author gates as "harness" (own subscription), not managed — mirroring runtime credential precedence.
  const authorLogin = stringAt(input.payload, ["pull_request", "user", "login"]);

  const triggerMode = await input.reviewTriggerModeForInstallation(installationId);
  if (triggerMode === "manual_only") {
    return {
      accepted: false,
      event: "pull_request",
      action: input.action,
      ignored_reason: "review trigger mode is manual_only; use @usejina in a pull request comment",
    };
  }
  if (triggerMode === "first_commit" && input.action === "synchronize") {
    return {
      accepted: false,
      event: "pull_request",
      action: input.action,
      ignored_reason: "review trigger mode is first_commit; a PR update does not re-trigger a review",
    };
  }

  // FINDING 2: PREPARE is the single billing enforcement point, so every blocked review is PR-visible
  // (a terminal blocked_insufficient_credits run + a progress comment, produced by prepare's 402 path).
  // The webhook therefore ALWAYS dispatches — a hard block here would silently drop the review (no run
  // row, no PR comment). gateDispatch is now advisory-only (dispatch-phase observability logging), so
  // we invoke it for its logs but never branch on it.
  if (input.billing) {
    await input.billing.gateDispatch(installationId, authorLogin);
  }

  const idempotencyKey = `${REVIEW_TASK_ID}:${installationId}:${repositoryId}:${prNumber}:${headSha}:code_review`;
  const concurrencyKey = idempotencyKey;

  const triggerPayload = {
    delivery_id: input.deliveryId,
    review_idempotency_key: idempotencyKey,
    source_event: "pull_request",
    action: input.action,
    github_installation_id: installationId,
    repository: {
      github_repo_id: repositoryId,
      owner: stringAt(input.payload, ["repository", "owner", "login"]),
      owner_id: numberAt(input.payload, ["repository", "owner", "id"]),
      owner_type: stringAt(input.payload, ["repository", "owner", "type"]),
      name: stringAt(input.payload, ["repository", "name"]),
      full_name: repositoryFullName,
      default_branch: stringAt(input.payload, ["repository", "default_branch"]),
      private: booleanAt(input.payload, ["repository", "private"]),
    },
    pull_request: {
      number: prNumber,
      title: stringAt(input.payload, ["pull_request", "title"]),
      html_url: stringAt(input.payload, ["pull_request", "html_url"]),
      draft,
      head_sha: headSha,
      base_sha: stringAt(input.payload, ["pull_request", "base", "sha"]),
      head_ref: stringAt(input.payload, ["pull_request", "head", "ref"]),
      base_ref: stringAt(input.payload, ["pull_request", "base", "ref"]),
      author: stringAt(input.payload, ["pull_request", "user", "login"]),
    },
    trigger: "webhook",
  };

  const options: DispatchOptions = {
    idempotencyKey,
    concurrencyKey,
    tags: [
      `installation:${installationId}`,
      `repo:${repositoryId}`,
      `pr:${prNumber}`,
      "bot:code_review",
    ],
    ttl: "30m",
  };

  const run = await input.trigger.triggerTask(REVIEW_TASK_ID, triggerPayload, options);
  return {
    accepted: true,
    event: "pull_request",
    action: input.action,
    task_id: REVIEW_TASK_ID,
    run_id: run.id,
  };
}

async function handleInstallationEvent(input: {
  config: AppConfig;
  trigger: WorkflowDispatcher;
  event: "installation" | "installation_repositories";
  deliveryId: string;
  payload: JsonObject;
  action?: string;
}): Promise<WebhookResponse> {
  const action = input.action ?? "unknown";
  const shouldBackfill =
    (
      input.event === "installation"
      && ["created", "unsuspended", "suspended", "deleted"].includes(action)
    ) ||
    (input.event === "installation_repositories" && (action === "added" || action === "removed"));

  if (!shouldBackfill) {
    return {
      accepted: false,
      event: input.event,
      action,
      ignored_reason: "installation action does not trigger backfill",
    };
  }

  const installationId = requiredNumber(input.payload, ["installation", "id"]);
  const idempotencyKey = `installation-backfill:${installationId}:${input.deliveryId}`;

  const triggerPayload = {
    delivery_id: input.deliveryId,
    source_event: input.event,
    action,
    github_installation_id: installationId,
    account: {
      github_account_id: numberAt(input.payload, ["installation", "account", "id"]),
      login: stringAt(input.payload, ["installation", "account", "login"]),
      type: stringAt(input.payload, ["installation", "account", "type"]),
    },
    // The admin who performed the install — grants them the org tenant membership even when the org's
    // OAuth App restrictions hide the org from the dashboard's /user/orgs sync.
    sender: {
      github_user_id: numberAt(input.payload, ["sender", "id"]),
      login: stringAt(input.payload, ["sender", "login"]),
    },
    repositories: arrayAt(input.payload, ["repositories"]) ?? [],
    repositories_added: arrayAt(input.payload, ["repositories_added"]) ?? [],
    repositories_removed: arrayAt(input.payload, ["repositories_removed"]) ?? [],
    trigger: "webhook",
  };

  const run = await input.trigger.triggerTask(INSTALLATION_BACKFILL_TASK_ID, triggerPayload, {
    idempotencyKey,
    concurrencyKey: `installation:${installationId}`,
    tags: [`installation:${installationId}`, "task:backfill"],
    ttl: "2h",
  });

  return {
    accepted: true,
    event: input.event,
    action,
    task_id: INSTALLATION_BACKFILL_TASK_ID,
    run_id: run.id,
  };
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new ApiError(400, `missing required GitHub header ${name}`);
  }

  return value;
}

function parsePayload(rawBody: string): JsonObject {
  try {
    const payload = JSON.parse(rawBody) as unknown;
    if (!isObject(payload)) {
      throw new Error("payload is not an object");
    }

    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new ApiError(400, `invalid GitHub payload: ${message}`);
  }
}

function requiredString(payload: JsonObject, path: string[]): string {
  const value = stringAt(payload, path);
  if (!value) {
    throw new ApiError(400, `${path.join(".")} is missing or not a string`);
  }

  return value;
}

function requiredNumber(payload: JsonObject, path: string[]): number {
  const value = numberAt(payload, path);
  if (value === undefined) {
    throw new ApiError(400, `${path.join(".")} is missing or not a number`);
  }

  return value;
}

function stringAt(payload: JsonObject, path: string[]): string | undefined {
  const value = valueAt(payload, path);
  return typeof value === "string" ? value : undefined;
}

function numberAt(payload: JsonObject, path: string[]): number | undefined {
  const value = valueAt(payload, path);
  return typeof value === "number" ? value : undefined;
}

function booleanAt(payload: JsonObject, path: string[]): boolean | undefined {
  const value = valueAt(payload, path);
  return typeof value === "boolean" ? value : undefined;
}

function arrayAt(payload: JsonObject, path: string[]): unknown[] | undefined {
  const value = valueAt(payload, path);
  return Array.isArray(value) ? value : undefined;
}

function valueAt(payload: JsonObject, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!isObject(current)) {
      return undefined;
    }

    return current[key];
  }, payload);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonObject = Record<string, unknown>;
