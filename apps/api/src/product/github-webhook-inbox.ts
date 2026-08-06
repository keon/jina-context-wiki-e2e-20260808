import { createHmac } from "node:crypto";

import type { AppConfig, GithubWebhookInboxConfig } from "./config.js";
import { ApiError } from "./errors.js";
import {
  decryptGithubWebhookPayload,
  encryptGithubWebhookPayload,
  githubWebhookPayloadDigest,
} from "./github-webhook-inbox-crypto.js";
import {
  GithubWebhookDeliveryConflictError,
  type GithubWebhookInboxLease,
  type GithubWebhookInboxMode,
  type GithubWebhookInboxRepository,
  type GithubWebhookInboxSnapshot,
  PostgresGithubWebhookInboxRepository,
} from "./github-webhook-inbox-store.js";
import { verifyGithubSignature, type WebhookResponse } from "./github.js";

export interface CapturedGithubWebhook {
  readonly deliveryId: string;
  readonly event: string;
  readonly action?: string;
  readonly inserted: boolean;
  readonly status: string;
}

interface GithubWebhookProcessInput {
  readonly deliveryId: string;
  readonly event: string;
  readonly rawBody: Buffer;
  readonly headers: Headers;
}

export interface GithubWebhookProcessResult {
  readonly deliveryId: string;
  readonly disposition: "not_claimed" | "completed" | "retry_wait";
  readonly mode?: Exclude<GithubWebhookInboxMode, "capture_only">;
  readonly response?: WebhookResponse;
}

export type GithubWebhookProcessor = (
  input: GithubWebhookProcessInput,
) => Promise<WebhookResponse>;

export class GithubWebhookInboxService {
  constructor(
    private readonly appConfig: Pick<AppConfig, "githubWebhookSecret" | "reviewBoardPipeline">,
    private readonly inboxConfig: GithubWebhookInboxConfig,
    private readonly repository: GithubWebhookInboxRepository =
      new PostgresGithubWebhookInboxRepository(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async capture(headers: Headers, rawBody: Buffer): Promise<CapturedGithubWebhook> {
    if (rawBody.length > this.inboxConfig.maxBodyBytes) {
      throw new ApiError(413, "GitHub webhook body exceeds the configured limit");
    }
    const event = requiredHeader(headers, "x-github-event", 128);
    const deliveryId = requiredHeader(headers, "x-github-delivery", 128);
    const signature = requiredHeader(headers, "x-hub-signature-256", 256);
    if (!/^[a-z0-9_]+$/.test(event)) throw new ApiError(400, "invalid GitHub event name");
    if (!/^[A-Za-z0-9._:-]+$/.test(deliveryId)) {
      throw new ApiError(400, "invalid GitHub delivery ID");
    }
    verifyGithubSignature(this.appConfig.githubWebhookSecret, rawBody, signature);

    const payload = parseObjectPayload(rawBody);
    const metadata = captureMetadata(payload);
    const payloadSha256 = githubWebhookPayloadDigest(rawBody);
    const binding = {
      deliveryId,
      event,
      payloadSha256,
      encryptionKeyVersion: this.inboxConfig.encryptionKeyVersion,
    };
    const payloadCiphertext = encryptGithubWebhookPayload(
      rawBody,
      this.inboxConfig.encryptionKey,
      binding,
    );
    try {
      const captured = await this.repository.capture({
        deliveryId,
        event,
        ...(metadata.action ? { action: metadata.action } : {}),
        ...(metadata.installationId ? { installationId: metadata.installationId } : {}),
        ...(metadata.repositoryId ? { repositoryId: metadata.repositoryId } : {}),
        ...(metadata.repositoryFullName
          ? { repositoryFullName: metadata.repositoryFullName }
          : {}),
        ...(metadata.pullRequestNumber
          ? { pullRequestNumber: metadata.pullRequestNumber }
          : {}),
        payloadSha256,
        payloadCiphertext,
        encryptionKeyVersion: this.inboxConfig.encryptionKeyVersion,
      });
      return {
        deliveryId,
        event,
        ...(metadata.action ? { action: metadata.action } : {}),
        inserted: captured.inserted,
        status: captured.status,
      };
    } catch (error) {
      if (error instanceof GithubWebhookDeliveryConflictError) {
        throw new ApiError(409, "GitHub delivery ID was replayed with a different event or bytes");
      }
      throw error;
    }
  }

  async processOne(
    deliveryId: string,
    processor: GithubWebhookProcessor,
  ): Promise<GithubWebhookProcessResult> {
    const lease = await this.repository.claim({
      deliveryId,
      leaseMs: this.inboxConfig.leaseMs,
      canaryRepositories: this.appConfig.reviewBoardPipeline.v2Repositories,
    });
    if (!lease) return { deliveryId, disposition: "not_claimed" };

    try {
      const rawBody = this.decryptLease(lease);
      let response: WebhookResponse | undefined;
      if (lease.mode === "legacy_forward") {
        response = await this.forwardLegacy(lease, rawBody);
      } else {
        response = await processor({
          deliveryId: lease.deliveryId,
          event: lease.event,
          rawBody,
          headers: processingHeaders(
            this.appConfig.githubWebhookSecret,
            lease.deliveryId,
            lease.event,
            rawBody,
          ),
        });
      }
      await this.repository.complete({
        lease,
        ...(response?.workflow_id || response?.run_id
          ? { processedWorkflowId: response.workflow_id ?? response.run_id }
          : {}),
      });
      return {
        deliveryId,
        disposition: "completed",
        mode: lease.mode,
        ...(response ? { response } : {}),
      };
    } catch (error) {
      await this.repository.retry({
        lease,
        errorCode: processingErrorCode(error),
        retryAfterMs: retryDelayMs(lease.attemptCount),
      });
      console.warn("github_webhook_inbox_processing_deferred", {
        delivery_id: lease.deliveryId,
        event: lease.event,
        mode: lease.mode,
        attempt_count: lease.attemptCount,
        error_code: processingErrorCode(error),
      });
      return { deliveryId, disposition: "retry_wait", mode: lease.mode };
    }
  }

  async drain(
    limit: number,
    processor: GithubWebhookProcessor,
  ): Promise<GithubWebhookProcessResult[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const results: GithubWebhookProcessResult[] = [];
    for (let index = 0; index < boundedLimit; index += 1) {
      const lease = await this.repository.claim({
        leaseMs: this.inboxConfig.leaseMs,
        canaryRepositories: this.appConfig.reviewBoardPipeline.v2Repositories,
      });
      if (!lease) break;
      results.push(await this.processLease(lease, processor));
    }
    return results;
  }

  async transitionMode(input: {
    readonly expectedGeneration: number;
    readonly mode: GithubWebhookInboxMode;
    readonly updatedBy: string;
  }) {
    if (input.mode === "legacy_forward" && !this.inboxConfig.legacyForwardUrl) {
      throw new ApiError(409, "legacy_forward target is not configured");
    }
    return this.repository.transitionMode(input);
  }

  snapshot(): Promise<GithubWebhookInboxSnapshot> {
    return this.repository.snapshot();
  }

  private async processLease(
    lease: GithubWebhookInboxLease,
    processor: GithubWebhookProcessor,
  ): Promise<GithubWebhookProcessResult> {
    try {
      const rawBody = this.decryptLease(lease);
      const response = lease.mode === "legacy_forward"
        ? await this.forwardLegacy(lease, rawBody)
        : await processor({
            deliveryId: lease.deliveryId,
            event: lease.event,
            rawBody,
            headers: processingHeaders(
              this.appConfig.githubWebhookSecret,
              lease.deliveryId,
              lease.event,
              rawBody,
            ),
          });
      await this.repository.complete({
        lease,
        ...(response.workflow_id || response.run_id
          ? { processedWorkflowId: response.workflow_id ?? response.run_id }
          : {}),
      });
      return {
        deliveryId: lease.deliveryId,
        disposition: "completed",
        mode: lease.mode,
        response,
      };
    } catch (error) {
      await this.repository.retry({
        lease,
        errorCode: processingErrorCode(error),
        retryAfterMs: retryDelayMs(lease.attemptCount),
      });
      return {
        deliveryId: lease.deliveryId,
        disposition: "retry_wait",
        mode: lease.mode,
      };
    }
  }

  private decryptLease(lease: GithubWebhookInboxLease): Buffer {
    if (lease.encryptionKeyVersion !== this.inboxConfig.encryptionKeyVersion) {
      throw new Error("webhook_inbox_key_version_unavailable");
    }
    const binding = {
      deliveryId: lease.deliveryId,
      event: lease.event,
      payloadSha256: lease.payloadSha256,
      encryptionKeyVersion: lease.encryptionKeyVersion,
    };
    const rawBody = decryptGithubWebhookPayload(
      lease.payloadCiphertext,
      this.inboxConfig.encryptionKey,
      binding,
    );
    if (githubWebhookPayloadDigest(rawBody) !== lease.payloadSha256) {
      throw new Error("webhook_inbox_payload_digest_mismatch");
    }
    return rawBody;
  }

  private async forwardLegacy(
    lease: GithubWebhookInboxLease,
    rawBody: Buffer,
  ): Promise<WebhookResponse> {
    const target = this.inboxConfig.legacyForwardUrl;
    if (!target) throw new Error("legacy_forward_target_unavailable");
    const response = await this.fetchImpl(target, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": lease.deliveryId,
        "x-github-event": lease.event,
        "x-hub-signature-256": githubSignature(this.appConfig.githubWebhookSecret, rawBody),
        "x-jina-inbox-forward-generation": String(lease.leaseGeneration),
      },
      body: Uint8Array.from(rawBody).buffer,
    });
    if (!response.ok) throw new Error(`legacy_forward_http_${response.status}`);
    const body = await response.json().catch(() => ({})) as Partial<WebhookResponse>;
    return {
      accepted: body.accepted === true,
      event: typeof body.event === "string" ? body.event : lease.event,
      ...(typeof body.action === "string" ? { action: body.action } : {}),
      ...(typeof body.task_id === "string" ? { task_id: body.task_id } : {}),
      ...(typeof body.run_id === "string" ? { run_id: body.run_id } : {}),
      ...(typeof body.workflow_id === "string" ? { workflow_id: body.workflow_id } : {}),
      ...(typeof body.ignored_reason === "string"
        ? { ignored_reason: body.ignored_reason }
        : {}),
    };
  }
}

function parseObjectPayload(rawBody: Buffer): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new ApiError(400, "GitHub webhook payload is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "GitHub webhook payload must be an object");
  }
  return payload as Record<string, unknown>;
}

function captureMetadata(payload: Record<string, unknown>): {
  action?: string;
  installationId?: number;
  repositoryId?: number;
  repositoryFullName?: string;
  pullRequestNumber?: number;
} {
  const action = boundedString(payload.action, 128);
  const installation = objectValue(payload.installation);
  const repository = objectValue(payload.repository);
  const pullRequest = objectValue(payload.pull_request);
  const issue = objectValue(payload.issue);
  return {
    ...(action ? { action } : {}),
    ...(positiveSafeInteger(installation?.id)
      ? { installationId: positiveSafeInteger(installation?.id) }
      : {}),
    ...(positiveSafeInteger(repository?.id)
      ? { repositoryId: positiveSafeInteger(repository?.id) }
      : {}),
    ...(boundedRepositoryName(repository?.full_name)
      ? { repositoryFullName: boundedRepositoryName(repository?.full_name) }
      : {}),
    ...(positiveSafeInteger(pullRequest?.number ?? issue?.number)
      ? { pullRequestNumber: positiveSafeInteger(pullRequest?.number ?? issue?.number) }
      : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function boundedRepositoryName(value: unknown): string | undefined {
  const name = boundedString(value, 300);
  return name && /^[^/\s]+\/[^/\s]+$/.test(name) ? name : undefined;
}

function requiredHeader(headers: Headers, name: string, maximum: number): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new ApiError(400, `Missing required header ${name}`);
  if (value.length > maximum) throw new ApiError(400, `${name} is too long`);
  return value;
}

function processingHeaders(
  secret: string,
  deliveryId: string,
  event: string,
  rawBody: Buffer,
): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-hub-signature-256": githubSignature(secret, rawBody),
  });
}

function githubSignature(secret: string, rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 6));
}

function processingErrorCode(error: unknown): string {
  if (error instanceof ApiError) return `api_${error.status}`;
  if (
    error instanceof Error &&
    (
      /^legacy_forward_http_[1-5][0-9]{2}$/.test(error.message) ||
      [
        "legacy_forward_target_unavailable",
        "webhook_inbox_key_version_unavailable",
        "webhook_inbox_payload_digest_mismatch",
      ].includes(error.message)
    )
  ) return error.message;
  return error instanceof Error
    ? error.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_")
    : "processing_failed";
}
