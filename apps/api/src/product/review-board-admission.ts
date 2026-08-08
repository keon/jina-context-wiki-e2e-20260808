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
import {
  lockReviewRequestKeyWithClient,
  resolveReviewScopeWithClient,
  type CreateReviewRunInput,
} from "./store.js";
import type { DispatchOptions } from "./board-admission-contract.js";

export const REVIEW_BOARD_PIPELINE_VERSION = "pr_review.board.v2";

export interface BoardReviewAdmissionResult extends BoardAdmissionResult {
  readonly tenantId: string;
}

export interface ReviewBoardArrival {
  readonly input: CreateReviewRunInput;
  readonly triggerPayload: Readonly<Record<string, unknown>>;
  readonly triggerOptions: Readonly<DispatchOptions>;
}

export async function admitBoardReview(
  arrival: ReviewBoardArrival,
  repository = new RelationalBoardRepository(),
): Promise<BoardReviewAdmissionResult> {
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
    return admitBoardReviewWithClient(client, arrival, scope, repository);
  });
}

async function replayExistingReviewAdmission(
  client: pg.PoolClient,
  scope: Awaited<ReturnType<typeof resolveReviewScopeWithClient>>,
  existing: ExistingBoardAdmission,
): Promise<BoardReviewAdmissionResult> {
  if (existing.pipelineVersion !== REVIEW_BOARD_PIPELINE_VERSION) {
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
  return replay;
}

async function admitBoardReviewWithClient(
  client: pg.PoolClient,
  arrival: ReviewBoardArrival,
  scope: Awaited<ReturnType<typeof resolveReviewScopeWithClient>>,
  repository: RelationalBoardRepository,
): Promise<BoardReviewAdmissionResult> {
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

  const workflowInput = buildReviewBoardAdmission({
    arrival,
    tenantId: scope.tenantId,
    ...(existingReview?.board_workflow_id
      ? { workflowId: existingReview.board_workflow_id }
      : {}),
  });
  const workflow = await repository.admitWorkflow(client, workflowInput);
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
export function buildReviewBoardAdmission(input: {
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
    pipelineVersion: REVIEW_BOARD_PIPELINE_VERSION,
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
