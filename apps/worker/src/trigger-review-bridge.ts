import { createHash } from "node:crypto";

import { configure, runs } from "@trigger.dev/sdk/v3";
import { canonicalReviewTriggerRequest } from "@jina/shared-kernel";

export const REVIEW_TRIGGER_PIPELINE_VERSION = "pr_review.board.v2";
export const REVIEW_TRIGGER_TASK_IDENTIFIER = "review";
export const REVIEW_TRIGGER_EFFECT_TYPE = "trigger.review.dispatch";
export const REVIEW_TRIGGER_EFFECT_VERSION = 1;
export const REVIEW_TRIGGER_PROVIDER = "trigger.dev";

const TRIGGER_OPTION_KEYS = new Set(["idempotencyKey", "concurrencyKey", "queue", "tags", "ttl", "machine"]);
const TRIGGER_QUEUE_KEYS = new Set(["name", "concurrencyLimit"]);
const TRIGGER_MACHINES = new Set(["micro", "small-1x", "small-2x", "medium-1x", "medium-2x", "large-1x", "large-2x"]);

type SdkRetrievedRun = Awaited<ReturnType<typeof runs.retrieve>>;
export type TriggerReviewRunStatus = SdkRetrievedRun["status"];
export type TriggerReviewRunStatusKind = "nonterminal" | "completed" | "failed";

export const TRIGGER_REVIEW_RUN_STATUS_KINDS = {
  PENDING_VERSION: "nonterminal",
  QUEUED: "nonterminal",
  DEQUEUED: "nonterminal",
  EXECUTING: "nonterminal",
  WAITING: "nonterminal",
  DELAYED: "nonterminal",
  COMPLETED: "completed",
  CANCELED: "failed",
  FAILED: "failed",
  CRASHED: "failed",
  SYSTEM_FAILURE: "failed",
  EXPIRED: "failed",
  TIMED_OUT: "failed"
} as const satisfies Record<TriggerReviewRunStatus, TriggerReviewRunStatusKind>;

export interface TriggerReviewEffectReceipt {
  readonly idempotencyKey: string;
  readonly effectType: string;
  readonly effectVersion: number;
  readonly provider: string;
  readonly status: "started" | "succeeded" | "failed" | "ambiguous";
  readonly requestDigest: string;
  readonly providerId?: string;
  readonly authorityRecordId?: string;
  readonly resultDigest?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RelationalReviewTaskMetadata {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowType: "pr_review";
  readonly pipelineVersion: typeof REVIEW_TRIGGER_PIPELINE_VERSION;
  readonly traceId: string;
  readonly spanId: string;
  readonly schemaVersion: 2;
  readonly requestDigest: string;
  readonly triggerTaskIdentifier: typeof REVIEW_TRIGGER_TASK_IDENTIFIER;
  readonly triggerPayload: Readonly<Record<string, unknown>>;
  readonly triggerOptions: Readonly<ReviewTriggerOptions>;
  readonly workflowMetadata: Readonly<Record<string, unknown>>;
  readonly effectReceipts: readonly TriggerReviewEffectReceipt[];
}

export interface TriggerReviewRun {
  readonly id: string;
  readonly status: TriggerReviewRunStatus;
  readonly output?: unknown;
  readonly error?: unknown;
}

export interface TriggerReviewClient {
  trigger(
    taskIdentifier: typeof REVIEW_TRIGGER_TASK_IDENTIFIER,
    payload: Readonly<Record<string, unknown>>,
    options: Readonly<ReviewTriggerOptions>
  ): Promise<{ readonly id: string }>;
  retrieve(runId: string): Promise<TriggerReviewRun>;
}

export interface ReviewTriggerOptions {
  readonly idempotencyKey?: string;
  readonly concurrencyKey?: string;
  readonly queue?: { readonly name: string; readonly concurrencyLimit?: number };
  readonly tags?: readonly string[];
  readonly ttl?: string;
  readonly machine?: "micro" | "small-1x" | "small-2x" | "medium-1x" | "medium-2x" | "large-1x" | "large-2x";
}

export function createTriggerReviewClient(env: NodeJS.ProcessEnv = process.env): TriggerReviewClient {
  const accessToken = requiredEnvironment(env, "TRIGGER_SECRET_KEY");
  const baseURL = (optionalEnvironment(env, "TRIGGER_API_URL") ?? "https://api.trigger.dev").replace(/\/$/, "");
  const previewBranch = optionalEnvironment(env, "TRIGGER_PREVIEW_BRANCH");
  configure({ accessToken, baseURL });
  return {
    async trigger(taskIdentifier, payload, options) {
      // Keep the original API client's wire contract. SDK 4.4.6 narrows
      // `queue` to a string and rewrites it, while the pinned review client
      // accepts {name, concurrencyLimit}; a raw control-plane request preserves
      // every admitted option exactly.
      const response = await fetch(`${baseURL}/api/v1/tasks/${encodeURIComponent(taskIdentifier)}/trigger`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          ...(previewBranch ? { "x-trigger-branch": previewBranch } : {})
        },
        body: JSON.stringify({ payload, options })
      });
      if (!response.ok) {
        throw new TriggerDispatchHttpError(response.status, (await response.text()).slice(0, 2_000));
      }
      const handle = (await response.json()) as Partial<{ id: unknown }>;
      if (typeof handle.id !== "string" || !handle.id.trim()) {
        throw new Error("Trigger.dev accepted the dispatch without returning a run id");
      }
      return { id: handle.id };
    },
    async retrieve(runId) {
      const run = await runs.retrieve(runId);
      return {
        id: run.id,
        status: run.status,
        ...(run.output === undefined ? {} : { output: run.output }),
        ...(run.error === undefined ? {} : { error: run.error })
      };
    }
  };
}

class TriggerDispatchHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Trigger.dev returned ${status}${body ? `: ${body}` : ""}`);
    this.name = "TriggerDispatchHttpError";
    this.status = status;
  }
}

export function parseRelationalReviewTaskMetadata(
  value: Readonly<Record<string, unknown>>
): RelationalReviewTaskMetadata {
  const schemaVersion = requiredPositiveInteger(value.schema_version, "task schema_version");
  if (schemaVersion !== 2) throw new Error("run-review task schema_version must be 2");
  const workflowType = requiredString(value.workflowType, "task workflowType");
  if (workflowType !== "pr_review") throw new Error("run-review task belongs to an unexpected workflow");
  const pipelineVersion = requiredString(value.pipelineVersion, "task pipelineVersion");
  if (pipelineVersion !== REVIEW_TRIGGER_PIPELINE_VERSION) {
    throw new Error(`run-review task must use ${REVIEW_TRIGGER_PIPELINE_VERSION}`);
  }
  const triggerTaskIdentifier = requiredString(value.trigger_task_id, "task trigger_task_id");
  if (triggerTaskIdentifier !== REVIEW_TRIGGER_TASK_IDENTIFIER) {
    throw new Error(`run-review must dispatch Trigger task ${REVIEW_TRIGGER_TASK_IDENTIFIER}`);
  }
  const triggerPayload = requiredRecord(value.trigger_payload, "task trigger_payload");
  const triggerOptions = parseTriggerOptions(value.trigger_options);
  const requestDigest = requiredSha256(value.request_digest, "task request_digest");
  const calculatedDigest = createHash("sha256")
    .update(
      canonicalReviewTriggerRequest({
        taskIdentifier: triggerTaskIdentifier,
        payload: triggerPayload,
        options: triggerOptions as Readonly<Record<string, unknown>>
      }),
      "utf8"
    )
    .digest("hex");
  if (requestDigest !== calculatedDigest) {
    throw new Error("run-review request digest does not match its immutable Trigger request");
  }
  return {
    tenantId: requiredString(value.tenantId, "task tenantId"),
    workflowId: requiredString(value.workflowId, "task workflowId"),
    workflowType,
    pipelineVersion,
    traceId: requiredString(value.traceId, "task traceId"),
    spanId: requiredString(value.spanId, "task spanId"),
    schemaVersion: 2,
    requestDigest,
    triggerTaskIdentifier,
    triggerPayload,
    triggerOptions,
    workflowMetadata: requiredRecord(value.workflowMetadata, "task workflowMetadata"),
    effectReceipts: parseEffectReceipts(value.effectReceipts)
  };
}

export function reviewTriggerEffectIdempotencyKey(workflowId: string): string {
  return `trigger-review:${workflowId}`;
}

export function matchingReviewTriggerReceipt(
  metadata: RelationalReviewTaskMetadata
): TriggerReviewEffectReceipt | undefined {
  const key = reviewTriggerEffectIdempotencyKey(metadata.workflowId);
  const matching = metadata.effectReceipts.filter(
    (receipt) =>
      receipt.idempotencyKey === key &&
      receipt.effectType === REVIEW_TRIGGER_EFFECT_TYPE &&
      receipt.effectVersion === REVIEW_TRIGGER_EFFECT_VERSION &&
      receipt.provider === REVIEW_TRIGGER_PROVIDER
  );
  if (matching.length > 1) throw new Error("run-review has multiple matching Trigger effect receipts");
  const receipt = matching[0];
  if (receipt && receipt.requestDigest !== metadata.requestDigest) {
    throw new Error("run-review Trigger effect receipt has a different request digest");
  }
  return receipt;
}

export function triggerReviewRunStatusKind(status: TriggerReviewRunStatus): TriggerReviewRunStatusKind {
  return TRIGGER_REVIEW_RUN_STATUS_KINDS[status];
}

export function compactCompletedReviewResult(
  run: TriggerReviewRun,
  metadata: RelationalReviewTaskMetadata
): Record<string, unknown> {
  if (run.status !== "COMPLETED") throw new Error("only a completed Trigger run can be projected");
  const output = isRecord(run.output) ? run.output : {};
  const repository = optionalString(output.repository) ?? optionalString(metadata.workflowMetadata.repository);
  const pullRequestNumber =
    optionalPositiveInteger(output.pull_request_number) ??
    optionalPositiveInteger(metadata.workflowMetadata.pull_request_number);
  return {
    status: optionalString(output.status) ?? "completed",
    trigger_run_id: run.id,
    ...(optionalString(output.review_run_id) ? { review_run_id: optionalString(output.review_run_id) } : {}),
    ...(repository ? { repository } : {}),
    ...(pullRequestNumber ? { pull_request_number: pullRequestNumber } : {})
  };
}

export function triggerRunDiagnostic(run: TriggerReviewRun): string {
  const error = isRecord(run.error) ? run.error : undefined;
  const message = optionalString(error?.message) ?? optionalString(run.error);
  return (message ?? `Trigger run ended with ${run.status}`).slice(0, 2_000);
}

export function triggerReviewPollIntervalMs(value: string | undefined): number {
  const parsed = value?.trim() ? Number(value) : 30_000;
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 300_000) {
    throw new Error("JINA_REVIEW_TRIGGER_POLL_INTERVAL_MS must be between 5000 and 300000");
  }
  return parsed;
}

function parseTriggerOptions(value: unknown): Readonly<ReviewTriggerOptions> {
  const options = requiredRecord(value, "task trigger_options");
  rejectUnknownKeys(options, TRIGGER_OPTION_KEYS, "task trigger_options");
  const parsed: {
    idempotencyKey?: string;
    concurrencyKey?: string;
    queue?: { name: string; concurrencyLimit?: number };
    tags?: string[];
    ttl?: string;
    machine?: NonNullable<ReviewTriggerOptions["machine"]>;
  } = {};
  const idempotencyKey = optionalString(options.idempotencyKey);
  const concurrencyKey = optionalString(options.concurrencyKey);
  const ttl = optionalString(options.ttl);
  const machine = optionalString(options.machine);
  if (options.idempotencyKey !== undefined && !idempotencyKey) {
    throw new Error("task trigger_options.idempotencyKey must be a non-empty string");
  }
  if (options.concurrencyKey !== undefined && !concurrencyKey) {
    throw new Error("task trigger_options.concurrencyKey must be a non-empty string");
  }
  if (options.ttl !== undefined && !ttl) {
    throw new Error("task trigger_options.ttl must be a non-empty string");
  }
  if (machine && !TRIGGER_MACHINES.has(machine)) {
    throw new Error("task trigger_options.machine is unsupported");
  }
  if (idempotencyKey) parsed.idempotencyKey = idempotencyKey;
  if (concurrencyKey) parsed.concurrencyKey = concurrencyKey;
  if (ttl) parsed.ttl = ttl;
  if (machine) parsed.machine = machine as NonNullable<ReviewTriggerOptions["machine"]>;
  if (options.tags !== undefined) {
    if (!Array.isArray(options.tags) || options.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
      throw new Error("task trigger_options.tags must contain non-empty strings");
    }
    parsed.tags = options.tags.map((tag) => String(tag));
  }
  if (options.queue !== undefined) {
    const queue = requiredRecord(options.queue, "task trigger_options.queue");
    rejectUnknownKeys(queue, TRIGGER_QUEUE_KEYS, "task trigger_options.queue");
    const name = requiredString(queue.name, "task trigger_options.queue.name");
    const concurrencyLimit =
      queue.concurrencyLimit === undefined
        ? undefined
        : requiredPositiveInteger(queue.concurrencyLimit, "task trigger_options.queue.concurrencyLimit");
    parsed.queue = { name, ...(concurrencyLimit ? { concurrencyLimit } : {}) };
  }
  return parsed;
}

function parseEffectReceipts(value: unknown): readonly TriggerReviewEffectReceipt[] {
  if (!Array.isArray(value)) throw new Error("task effectReceipts must be an array");
  return value.map((item, index) => {
    const receipt = requiredRecord(item, `task effectReceipts[${index}]`);
    const status = requiredString(receipt.status, `task effectReceipts[${index}].status`);
    if (!new Set(["started", "succeeded", "failed", "ambiguous"]).has(status)) {
      throw new Error(`task effectReceipts[${index}].status is unsupported`);
    }
    const providerId = optionalString(receipt.providerId);
    const authorityRecordId = optionalString(receipt.authorityRecordId);
    const resultDigest = optionalString(receipt.resultDigest);
    return {
      idempotencyKey: requiredString(receipt.idempotencyKey, `task effectReceipts[${index}].idempotencyKey`),
      effectType: requiredString(receipt.effectType, `task effectReceipts[${index}].effectType`),
      effectVersion: requiredPositiveInteger(receipt.effectVersion, `task effectReceipts[${index}].effectVersion`),
      provider: requiredString(receipt.provider, `task effectReceipts[${index}].provider`),
      status: status as TriggerReviewEffectReceipt["status"],
      requestDigest: requiredSha256(receipt.requestDigest, `task effectReceipts[${index}].requestDigest`),
      ...(providerId ? { providerId } : {}),
      ...(authorityRecordId ? { authorityRecordId } : {}),
      ...(resultDigest ? { resultDigest } : {}),
      metadata: requiredRecord(receipt.metadata, `task effectReceipts[${index}].metadata`)
    };
  });
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnvironment(env, name);
  if (!value) throw new Error(`${name} is required for the relational run-review bridge`);
  return value;
}

function optionalEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const normalized = optionalPositiveInteger(value);
  if (!normalized) throw new Error(`${label} must be a positive safe integer`);
  return normalized;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}
