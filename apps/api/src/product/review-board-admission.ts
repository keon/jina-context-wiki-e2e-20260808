import { createHash } from "node:crypto";

import {
  RelationalBoardRepository,
  type AdmitBoardWorkflowInput,
  type BoardAdmissionResult,
  type ExistingBoardAdmission,
} from "@jina/db";
import { activeTraceparent, parseTraceparent } from "@jina/observability";
import { canonicalReviewTriggerRequest } from "@jina/shared-kernel";
import type pg from "pg";

import { withTransaction } from "./db.js";
import { markFirstV2GithubWebhookWorkflowWithClient } from "./github-webhook-inbox-store.js";
import {
  bindReviewRunToBoardWithClient,
  createReviewRunWithClient,
  lockReviewRequestKeyWithClient,
  resolveReviewScopeWithClient,
  type CreateReviewRunInput,
} from "./store.js";
import type { DispatchOptions } from "./board-admission-contract.js";

export const REVIEW_BOARD_PIPELINE_VERSION = "pr_review.board.v1";
export const REVIEW_BOARD_V2_PIPELINE_VERSION = "pr_review.board.v2";

export interface BoardReviewAdmissionResult extends BoardAdmissionResult {
  readonly reviewRunId: string;
  readonly tenantId: string;
}

export interface ReviewBoardArrival {
  readonly input: CreateReviewRunInput;
  readonly triggerPayload: Readonly<Record<string, unknown>>;
  readonly triggerOptions: Readonly<DispatchOptions>;
}

export interface BoardReviewV2AdmissionResult extends BoardAdmissionResult {
  readonly tenantId: string;
}

type ReviewBoardPipelineMode = "paused" | "v1" | "v2" | "allowlist";

export interface ReviewBoardPipelineSelection {
  readonly mode: ReviewBoardPipelineMode;
  readonly v2Repositories: ReadonlySet<string>;
}

export async function admitConfiguredBoardReview(
  arrival: ReviewBoardArrival,
  selection: ReviewBoardPipelineSelection,
  repository = new RelationalBoardRepository(),
): Promise<BoardReviewAdmissionResult | BoardReviewV2AdmissionResult> {
  return withTransaction(async (client) => {
    const scope = await resolveReviewScopeWithClient(client, arrival.input);
    await lockReviewRequestKeyWithClient(client, scope.tenantId, scope.idempotencyKey);
    const existing = await repository.findAdmissionByDedupe(client, {
      tenantId: scope.tenantId,
      dedupeKey: scope.idempotencyKey,
    });
    if (existing && existing.workflowType !== "pr_review") {
      throw new Error(
        `review request key belongs to ${existing.workflowType} workflow ${existing.workflowId}`,
      );
    }
    if (existing) return replayExistingReviewAdmission(client, scope, existing);
    const pipeline = selectedReviewPipeline(arrival, selection);
    if (pipeline === REVIEW_BOARD_PIPELINE_VERSION) {
      return admitBoardReviewV1WithClient(client, arrival.input, repository);
    }
    if (pipeline === REVIEW_BOARD_V2_PIPELINE_VERSION) {
      return admitBoardReviewV2WithClient(client, arrival, scope, repository);
    }
    throw new Error("review request selected an unsupported pipeline");
  });
}

async function replayExistingReviewAdmission(
  client: pg.PoolClient,
  scope: Awaited<ReturnType<typeof resolveReviewScopeWithClient>>,
  existing: ExistingBoardAdmission,
): Promise<BoardReviewAdmissionResult | BoardReviewV2AdmissionResult> {
  if (
    existing.pipelineVersion !== REVIEW_BOARD_PIPELINE_VERSION &&
    existing.pipelineVersion !== REVIEW_BOARD_V2_PIPELINE_VERSION
  ) {
    throw new Error(`review request uses unsupported pipeline ${existing.pipelineVersion}`);
  }
  const reviews = await client.query<{
    id: string;
    orchestrator: "trigger" | "board";
    board_workflow_id: string | null;
  }>(
    `select id,orchestrator,board_workflow_id
     from review_runs
     where idempotency_key=$1
     for update`,
    [scope.idempotencyKey],
  );
  const review = reviews.rows[0];
  if (review && (review.orchestrator !== "board" || review.board_workflow_id !== existing.workflowId)) {
    throw new ReviewOrchestratorOwnershipError(review.id, review.orchestrator);
  }
  const replay = {
    workflowId: existing.workflowId,
    traceId: existing.traceId,
    replayed: true,
    taskIds: existing.taskIds,
    tenantId: scope.tenantId,
  };
  if (existing.pipelineVersion === REVIEW_BOARD_PIPELINE_VERSION) {
    if (!review) throw new Error(`v1 Board workflow ${existing.workflowId} is missing its review run`);
    return { ...replay, reviewRunId: review.id };
  }
  return replay;
}

export async function admitBoardReviewV2(
  arrival: ReviewBoardArrival,
  repository = new RelationalBoardRepository(),
): Promise<BoardReviewV2AdmissionResult> {
  return withTransaction(async (client) => {
    const scope = await resolveReviewScopeWithClient(client, arrival.input);
    await lockReviewRequestKeyWithClient(client, scope.tenantId, scope.idempotencyKey);
    return admitBoardReviewV2WithClient(client, arrival, scope, repository);
  });
}

async function admitBoardReviewV2WithClient(
  client: pg.PoolClient,
  arrival: ReviewBoardArrival,
  scope: Awaited<ReturnType<typeof resolveReviewScopeWithClient>>,
  repository: RelationalBoardRepository,
): Promise<BoardReviewV2AdmissionResult> {
  const existingReview = (
      await client.query<{
        id: string;
        orchestrator: "trigger" | "board";
        board_workflow_id: string | null;
      }>(
        `select id,orchestrator,board_workflow_id
         from review_runs
         where idempotency_key=$1
         for update`,
        [scope.idempotencyKey],
      )
  ).rows[0];
  if (existingReview && existingReview.orchestrator !== "board") {
    throw new ReviewOrchestratorOwnershipError(existingReview.id, existingReview.orchestrator);
  }

  const workflowInput = buildReviewBoardV2Admission({
    arrival,
    tenantId: scope.tenantId,
    ...(existingReview?.board_workflow_id
      ? { workflowId: existingReview.board_workflow_id }
      : {}),
  });
  const workflow = await repository.admitWorkflow(client, workflowInput);
  await markFirstV2GithubWebhookWorkflowWithClient(client, workflow.workflowId);
  if (
    existingReview?.board_workflow_id &&
    existingReview.board_workflow_id !== workflow.workflowId
  ) {
    throw new Error(
      `review run ${existingReview.id} is bound to ${existingReview.board_workflow_id}, not ${workflow.workflowId}`,
    );
  }
  return { ...workflow, tenantId: scope.tenantId };
}

export async function admitBoardReview(
  input: CreateReviewRunInput,
  repository = new RelationalBoardRepository(),
): Promise<BoardReviewAdmissionResult> {
  return withTransaction(async (client) => {
    return admitBoardReviewV1WithClient(client, input, repository);
  });
}

async function admitBoardReviewV1WithClient(
  client: pg.PoolClient,
  input: CreateReviewRunInput,
  repository: RelationalBoardRepository,
): Promise<BoardReviewAdmissionResult> {
  const review = await createReviewRunWithClient(client, input);
    if (!review.created && review.orchestrator !== "board") {
      throw new ReviewOrchestratorOwnershipError(review.id, review.orchestrator);
    }

    const workflowInput = buildReviewBoardAdmission({
      input,
      reviewRunId: review.id,
      tenantId: review.tenantId,
      workflowId: review.boardWorkflowId,
    });
    const workflow = await repository.admitWorkflow(client, workflowInput);
    if (review.created && workflow.replayed) {
      throw new Error(
        `new review run ${review.id} collided with existing Board workflow ${workflow.workflowId}`,
      );
    }
    if (review.boardWorkflowId && review.boardWorkflowId !== workflow.workflowId) {
      throw new Error(
        `review run ${review.id} is bound to ${review.boardWorkflowId}, not ${workflow.workflowId}`,
      );
    }

    await bindReviewRunToBoardWithClient(client, {
      reviewRunId: review.id,
      tenantId: review.tenantId,
      workflowId: workflow.workflowId,
    });
  return {
    ...workflow,
    reviewRunId: review.id,
    tenantId: review.tenantId,
  };
}

function selectedReviewPipeline(
  arrival: ReviewBoardArrival,
  selection: ReviewBoardPipelineSelection,
): typeof REVIEW_BOARD_PIPELINE_VERSION | typeof REVIEW_BOARD_V2_PIPELINE_VERSION {
  if (selection.mode === "paused") throw new ReviewAdmissionPausedError();
  if (selection.mode === "v1") return REVIEW_BOARD_PIPELINE_VERSION;
  if (selection.mode === "v2") return REVIEW_BOARD_V2_PIPELINE_VERSION;
  const repository = requiredText(arrival.input.repository.fullName, "repository.fullName").toLowerCase();
  return selection.v2Repositories.has(repository)
    ? REVIEW_BOARD_V2_PIPELINE_VERSION
    : REVIEW_BOARD_PIPELINE_VERSION;
}

export class ReviewAdmissionPausedError extends Error {
  constructor() {
    super("review Board admission is paused for the run-review semantic cutover");
    this.name = "ReviewAdmissionPausedError";
  }
}

export function buildReviewBoardAdmission(input: {
  readonly input: CreateReviewRunInput;
  readonly reviewRunId: string;
  readonly tenantId: string;
  readonly workflowId?: string;
}): AdmitBoardWorkflowInput {
  const installationId = requiredNumber(input.input.installationId, "installationId");
  const repositoryId = requiredNumber(input.input.repository.githubRepoId, "repository.githubRepoId");
  const pullRequestNumber = requiredNumber(input.input.pullRequest.number, "pullRequest.number");
  const headSha = requiredText(input.input.pullRequest.headSha, "pullRequest.headSha");
  const reviewPayload = requiredRecord(input.input.orchestrationPayload, "orchestrationPayload");
  const idempotencyKey =
    input.input.idempotencyKey ??
    `review:${installationId}:${repositoryId}:${pullRequestNumber}:${headSha}:code_review`;
  const workflowId = input.workflowId ?? stableUuid(`review-workflow:${idempotencyKey}`);
  const prepare = stableUuid(`${workflowId}:prepare-review`);
  const summary = stableUuid(`${workflowId}:summary-review`);
  const runtime = stableUuid(`${workflowId}:runtime-review`);
  const finalize = stableUuid(`${workflowId}:finalize-review`);
  const publish = stableUuid(`${workflowId}:publish-review`);
  const settle = stableUuid(`${workflowId}:settle-review`);
  const admissionTraceparent = activeTraceparent();
  const admissionTrace = admissionTraceparent ? parseTraceparent(admissionTraceparent) : undefined;

  return {
    workflowId,
    tenantId: input.tenantId,
    workflowType: "pr_review",
    pipelineVersion: REVIEW_BOARD_PIPELINE_VERSION,
    subjectType: "github_pull_request",
    subjectId: `${repositoryId}:${pullRequestNumber}:${headSha}`,
    dedupeKey: idempotencyKey,
    concurrencyKey: idempotencyKey,
    triggerType: input.input.triggerSource ?? "webhook",
    ...(admissionTrace ? { traceId: admissionTrace.traceId } : {}),
    ...(admissionTraceparent ? { admissionTraceparent } : {}),
    metadata: {
      schema_version: 1,
      review_run_id: input.reviewRunId,
      delivery_id: input.input.deliveryId,
      source_event: input.input.sourceEvent,
      installation_id: installationId,
      repository_id: repositoryId,
      repository: input.input.repository.fullName,
      pull_request_number: pullRequestNumber,
      head_sha: headSha,
      review_payload: reviewPayload,
    },
    tasks: [
      reviewTask(prepare, "prepare-review", "queued", input.reviewRunId, 3),
      reviewTask(summary, "summary-review", "blocked", input.reviewRunId, 3, prepare),
      reviewTask(runtime, "runtime-review", "blocked", input.reviewRunId, 3, prepare),
      reviewTask(finalize, "finalize-review", "blocked", input.reviewRunId, 3),
      reviewTask(publish, "publish-review", "blocked", input.reviewRunId, 5),
      {
        ...reviewTask(settle, "settle-review", "blocked", input.reviewRunId, 5),
        cleanupTask: true,
      },
    ],
    dependencies: [
      dependency(summary, prepare, "success", "prepared-summary-input"),
      dependency(runtime, prepare, "success", "prepared-runtime-input"),
      dependency(finalize, summary, "terminal", "summary-outcome"),
      dependency(finalize, runtime, "terminal", "runtime-outcome"),
      dependency(publish, finalize, "success", "final-review"),
      dependency(settle, publish, "terminal", "publication-outcome"),
    ],
    actorType: "github",
    actorId: input.input.deliveryId ?? "manual-review",
  };
}

export function buildReviewBoardV2Admission(input: {
  readonly arrival: ReviewBoardArrival;
  readonly tenantId: string;
  readonly workflowId?: string;
}): AdmitBoardWorkflowInput {
  const installationId = requiredNumber(input.arrival.input.installationId, "installationId");
  const repositoryId = requiredNumber(
    input.arrival.input.repository.githubRepoId,
    "repository.githubRepoId",
  );
  const pullRequestNumber = requiredNumber(
    input.arrival.input.pullRequest.number,
    "pullRequest.number",
  );
  const headSha = requiredText(input.arrival.input.pullRequest.headSha, "pullRequest.headSha");
  const idempotencyKey =
    input.arrival.input.idempotencyKey ??
    `review:${installationId}:${repositoryId}:${pullRequestNumber}:${headSha}:code_review`;
  if (input.arrival.triggerOptions.idempotencyKey !== idempotencyKey) {
    throw new Error("Trigger and Board idempotency keys must be present and match");
  }
  const workflowId = input.workflowId ?? stableUuid(`review-workflow:${idempotencyKey}`);
  const taskId = stableUuid(`${workflowId}:review`);
  const manualCommentId = requestedCommentId(input.arrival.triggerPayload);
  const sourceEvent = input.arrival.input.sourceEvent ?? "pull_request";
  const requestIdentity = manualCommentId
    ? `${repositoryId}:${pullRequestNumber}:${sourceEvent}:${manualCommentId}`
    : `${repositoryId}:${pullRequestNumber}:${headSha}`;
  const requestDigest = createHash("sha256")
    .update(
      canonicalReviewTriggerRequest({
        taskIdentifier: "review",
        payload: input.arrival.triggerPayload,
        options: input.arrival.triggerOptions,
      }),
      "utf8",
    )
    .digest("hex");
  const admissionTraceparent = activeTraceparent();
  const admissionTrace = admissionTraceparent ? parseTraceparent(admissionTraceparent) : undefined;

  return {
    workflowId,
    tenantId: input.tenantId,
    workflowType: "pr_review",
    pipelineVersion: REVIEW_BOARD_V2_PIPELINE_VERSION,
    subjectType: "github_pull_request",
    subjectId: requestIdentity,
    dedupeKey: idempotencyKey,
    concurrencyKey: idempotencyKey,
    triggerType: input.arrival.input.triggerSource ?? "webhook",
    ...(admissionTrace ? { traceId: admissionTrace.traceId } : {}),
    ...(admissionTraceparent ? { admissionTraceparent } : {}),
    metadata: {
      schema_version: 2,
      delivery_id: input.arrival.input.deliveryId,
      source_event: sourceEvent,
      installation_id: installationId,
      repository_id: repositoryId,
      repository: input.arrival.input.repository.fullName,
      pull_request_number: pullRequestNumber,
      head_sha: headSha,
      request_identity: requestIdentity,
      request_digest: requestDigest,
    },
    tasks: [
      {
        id: taskId,
        taskType: "review",
        topic: "run-review",
        status: "queued",
        maxAttempts: 3,
        metadata: {
          schema_version: 2,
          request_digest: requestDigest,
          trigger_task_id: "review",
          trigger_payload: input.arrival.triggerPayload,
          trigger_options: input.arrival.triggerOptions,
        },
      },
    ],
    dependencies: [],
    actorType: "github",
    actorId: input.arrival.input.deliveryId ?? "manual-review",
  };
}

class ReviewOrchestratorOwnershipError extends Error {
  constructor(
    readonly reviewRunId: string,
    readonly owner: "trigger" | "board",
  ) {
    super(`review run ${reviewRunId} is already owned by ${owner}`);
    this.name = "ReviewOrchestratorOwnershipError";
  }
}

function reviewTask(
  id: string,
  taskType: string,
  status: "blocked" | "queued",
  reviewRunId: string,
  maxAttempts: number,
  parentTaskId?: string,
) {
  return {
    id,
    ...(parentTaskId ? { parentTaskId } : {}),
    taskType,
    topic: taskType,
    status,
    maxAttempts,
    metadata: { schema_version: 1, review_run_id: reviewRunId },
  } as const;
}

function dependency(
  taskId: string,
  dependsOnTaskId: string,
  condition: "success" | "terminal",
  relationship: string,
) {
  return { taskId, dependsOnTaskId, condition, relationship } as const;
}

function requiredNumber(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value!;
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requestedCommentId(payload: Readonly<Record<string, unknown>>): number | undefined {
  const requestedBy = payload.requested_by;
  if (!requestedBy || typeof requestedBy !== "object" || Array.isArray(requestedBy)) return undefined;
  const commentId = (requestedBy as Record<string, unknown>).comment_id;
  return typeof commentId === "number" && Number.isSafeInteger(commentId) && commentId > 0
    ? commentId
    : undefined;
}

function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
