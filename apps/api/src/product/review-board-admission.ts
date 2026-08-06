import { createHash } from "node:crypto";

import {
  RelationalBoardRepository,
  type AdmitBoardWorkflowInput,
  type BoardAdmissionResult,
} from "@jina/db";
import { activeTraceparent, parseTraceparent } from "@jina/observability";

import { withTransaction } from "./db.js";
import {
  bindReviewRunToBoardWithClient,
  createReviewRunWithClient,
  type CreateReviewRunInput,
} from "./store.js";

export const REVIEW_BOARD_PIPELINE_VERSION = "pr_review.board.v1";

export interface BoardReviewAdmissionResult extends BoardAdmissionResult {
  readonly reviewRunId: string;
  readonly tenantId: string;
}

export async function admitBoardReview(
  input: CreateReviewRunInput,
  repository = new RelationalBoardRepository(),
): Promise<BoardReviewAdmissionResult> {
  return withTransaction(async (client) => {
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
  });
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

function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
