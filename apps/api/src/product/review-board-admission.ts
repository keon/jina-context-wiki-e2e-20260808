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
    const repositoryId = requiredNumber(arrival.input.repository.githubRepoId, "repository.githubRepoId");
    const pullRequestNumber = requiredNumber(arrival.input.pullRequest.number, "pullRequest.number");
    await lockReviewScopeWithClient(client, scope.tenantId, repositoryId, pullRequestNumber);
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
    const admitted = await admitBoardReviewWithClient(client, arrival, scope, repository);
    if (!admitted.replayed && arrival.input.manualCommandTag) {
      await supersedeOlderReviewWorkflowsWithClient(client, {
        tenantId: scope.tenantId,
        repositoryId,
        pullRequestNumber,
        headSha: requiredText(arrival.input.pullRequest.headSha, "pullRequest.headSha"),
        workflowId: admitted.workflowId,
        commandTag: arrival.input.manualCommandTag,
        actorId: arrival.input.deliveryId ?? "manual-review",
      });
    }
    return admitted;
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
      ...(input.arrival.input.manualCommandTag
        ? { manual_command_tag: input.arrival.input.manualCommandTag }
        : {}),
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

interface ActiveReviewWorkflowRow {
  readonly id: string;
  readonly trace_id: string;
  readonly manual_command_tag: string | null;
  readonly task_id: string;
}

async function lockReviewScopeWithClient(
  client: pg.PoolClient,
  tenantId: string,
  repositoryId: number,
  pullRequestNumber: number,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `review-scope:${tenantId}:${repositoryId}:${pullRequestNumber}`,
  ]);
}

/**
 * A manual command is authoritative for its current PR head. It supersedes an
 * automatic review and every older manual command before any more Board work
 * can be claimed. Out-of-order delivery is resolved from the signed command
 * timestamp/id tag rather than database arrival order.
 */
async function supersedeOlderReviewWorkflowsWithClient(
  client: pg.PoolClient,
  input: {
    readonly tenantId: string;
    readonly repositoryId: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly workflowId: string;
    readonly commandTag: string;
    readonly actorId: string;
  },
): Promise<void> {
  const active = await client.query<ActiveReviewWorkflowRow>(
    `select workflow.id,workflow.trace_id,
            workflow.metadata->>'manual_command_tag' manual_command_tag,
            task.id task_id
       from jina_runtime.board_workflows workflow
       join jina_runtime.board_tasks task on task.workflow_id=workflow.id
      where workflow.tenant_id=$1
        and workflow.workflow_type='pr_review'
        and workflow.pipeline_version=$2
        and workflow.status in ('queued','running','superseding')
        and workflow.metadata->>'repository_id'=$3
        and workflow.metadata->>'pull_request_number'=$4
        and workflow.metadata->>'head_sha'=$5
        and task.task_type='review'
        and task.topic='run-review'
      order by workflow.created_at,workflow.id
      for update of workflow,task`,
    [
      input.tenantId,
      REVIEW_BOARD_PIPELINE_VERSION,
      String(input.repositoryId),
      String(input.pullRequestNumber),
      input.headSha,
    ],
  );
  const current = active.rows.find((workflow) => workflow.id === input.workflowId);
  if (!current) throw new Error(`manual review workflow ${input.workflowId} is not active after admission`);

  const newestManual = active.rows
    .filter((workflow): workflow is ActiveReviewWorkflowRow & { manual_command_tag: string } =>
      Boolean(workflow.manual_command_tag),
    )
    .sort((left, right) => compareManualCommandTags(left.manual_command_tag, right.manual_command_tag))
    .at(-1);
  const winner = newestManual && compareManualCommandTags(newestManual.manual_command_tag, input.commandTag) > 0
    ? newestManual
    : current;
  const winnerTag = winner.manual_command_tag ?? input.commandTag;
  const winnerCommentId = manualCommandIdentity(winnerTag).commentId;
  const targets = active.rows.filter((workflow) => workflow.id !== winner.id);

  for (const target of targets) {
    const targetIdentity = target.manual_command_tag
      ? manualCommandIdentity(target.manual_command_tag)
      : undefined;
    const reason = targetIdentity
      ? `a newer @usejina comment (${winnerCommentId}) superseded comment ${targetIdentity.commentId}`
      : `@usejina comment ${winnerCommentId} superseded the automatic review for this pull request head`;
    const supersession = {
      schema_version: 1,
      reason,
      superseded_by_workflow_id: winner.id,
      superseded_by_manual_command_tag: winnerTag,
      newer_comment_id: winnerCommentId,
      ...(targetIdentity ? { requested_comment_id: targetIdentity.commentId } : {}),
    };

    await client.query(
      `update jina_runtime.board_attempts
          set status='fenced',finished_at=clock_timestamp(),failure_category='superseded',diagnostic=$2
        where workflow_id=$1 and status='leased'`,
      [target.id, reason],
    );
    await client.query(
      `update jina_runtime.board_tasks
          set status='superseded',current_attempt_id=null,available_at=null,
              completed_at=coalesce(completed_at,clock_timestamp()),updated_at=clock_timestamp()
        where workflow_id=$1
          and status not in ('succeeded','failed','canceled','superseded')`,
      [target.id],
    );
    await client.query(
      `update jina_runtime.board_workflows
          set status='superseded',completed_at=coalesce(completed_at,clock_timestamp()),
              updated_at=clock_timestamp(),metadata=metadata || $2::jsonb
        where id=$1 and status in ('queued','running','superseding')`,
      [target.id, JSON.stringify(supersession)],
    );
    const supersededRuns = await client.query<{ id: string; trigger_run_id: string | null }>(
      `update review_runs
          set status='superseded',bot_status='superseded',finished_at=coalesce(finished_at,now()),updated_at=now()
        where board_workflow_id=$1
          and status not in ('completed','completed_superseded','failed','superseded','cancelled','canceled','blocked_insufficient_credits')
        returning id,trigger_run_id`,
      [target.id],
    );
    for (const review of supersededRuns.rows) {
      await client.query(
        `insert into review_run_events (review_run_id,status,payload_json,trigger_run_id)
         values ($1,'review_superseded',$2::jsonb,$3)`,
        [review.id, JSON.stringify(supersession), review.trigger_run_id],
      );
    }
    await client.query(
      `insert into jina_runtime.board_events
         (tenant_id,workflow_id,task_id,event_type,source_event_id,actor_type,actor_id,trace_id,payload)
       values ($1,$2,$3,'task.superseded',$4,'github',$5,$6,$7::jsonb)
       on conflict (workflow_id,source_event_id) where source_event_id is not null do nothing`,
      [
        input.tenantId,
        target.id,
        target.task_id,
        `review-superseded:${winner.id}:task:${target.task_id}`,
        input.actorId,
        target.trace_id,
        JSON.stringify(supersession),
      ],
    );
    await client.query(
      `insert into jina_runtime.board_events
         (tenant_id,workflow_id,event_type,source_event_id,actor_type,actor_id,trace_id,payload)
       values ($1,$2,'workflow.superseded',$3,'github',$4,$5,$6::jsonb)
       on conflict (workflow_id,source_event_id) where source_event_id is not null do nothing`,
      [
        input.tenantId,
        target.id,
        `review-superseded:${winner.id}:workflow`,
        input.actorId,
        target.trace_id,
        JSON.stringify(supersession),
      ],
    );
  }
}

function manualCommandIdentity(tag: string): { readonly requestedAtMs: number; readonly event: string; readonly commentId: number } {
  const match = /^manual-command:(\d+):(issue_comment|pull_request_review_comment):(\d+)$/.exec(tag);
  if (!match) throw new Error("manual command tag is invalid");
  const requestedAtMs = Number(match[1]);
  const commentId = Number(match[3]);
  if (!Number.isSafeInteger(requestedAtMs) || !Number.isSafeInteger(commentId)) {
    throw new Error("manual command tag contains an unsafe integer");
  }
  return { requestedAtMs, event: match[2], commentId };
}

export function compareManualCommandTags(leftTag: string, rightTag: string): number {
  const left = manualCommandIdentity(leftTag);
  const right = manualCommandIdentity(rightTag);
  return left.requestedAtMs - right.requestedAtMs ||
    left.event.localeCompare(right.event) ||
    left.commentId - right.commentId;
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
