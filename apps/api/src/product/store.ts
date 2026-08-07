import { createHash } from "node:crypto";

import type pg from "pg";

import type { DashboardSession } from "./auth.js";
import { exactDecimalSum } from "./billing-math.js";
import { coerceStoredHarnessModel, type HarnessModel } from "./codex-harness.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { databaseConfigured, query, queryOne, withTransaction } from "./db.js";
import {
  type FindingRecord,
  type ProjectRecord,
  type ReviewEvent,
  type ReviewRunRecord,
} from "./records.js";
import { parseScenarioJson, parseScenarios, scenarioStepType, type ParsedScenario } from "./historical-scenarios.js";
import {
  linkClerkUserIdentity as linkClerkUserIdentityWithClient,
  upsertGithubUserIdentity as upsertGithubUserIdentityWithClient,
  type ClerkIdentityLinkResult,
  type ClerkIdentityProfile,
  type GithubIdentityProfile,
  type InternalUserIdentity,
} from "./internal-user.js";

export interface CreateReviewRunInput {
  triggerRunId?: string;
  idempotencyKey?: string;
  deliveryId?: string;
  sourceEvent?: string;
  triggerSource?: string;
  manualCommandTag?: string;
  reviewInstructions?: string;
  orchestrationPayload?: Readonly<Record<string, unknown>>;
  installationId?: number;
  account?: { id?: number; login?: string; type?: string };
  repository: {
    githubRepoId?: number;
    owner?: string;
    name?: string;
    fullName?: string;
    defaultBranch?: string;
    private?: boolean;
  };
  pullRequest: {
    number?: number;
    title?: string;
    htmlUrl?: string;
    author?: string;
    headSha?: string;
    baseSha?: string;
    headRef?: string;
    baseRef?: string;
    draft?: boolean;
  };
}

export interface CreatedReviewRun {
  id: string;
  tenantId: string;
  created: boolean;
  orchestrator: "trigger" | "board";
  boardWorkflowId?: string;
  triggerRunId?: string;
}

export interface ResolvedReviewScope {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly pullRequestId?: string;
  readonly headSha: string;
  readonly idempotencyKey: string;
}

export interface InstallationRepository {
  githubRepoId?: number;
  owner?: string;
  name?: string;
  fullName?: string;
  defaultBranch?: string;
  private?: boolean;
}

export type InstallationLifecycle = "active" | "suspended" | "deleted";

/** Immediately apply security-sensitive installation state from a signed webhook. */
export async function updateGithubInstallationLifecycle(
  githubInstallationId: number,
  lifecycle: Exclude<InstallationLifecycle, "active">,
): Promise<boolean> {
  if (!databaseConfigured()) return false;
  return withTransaction(async (client) => {
    const installation = await client.query<{ id: string }>(
      `update installations
          set suspended_at = coalesce(suspended_at, now()),
              deleted_at = case
                when $2 = 'deleted' then coalesce(deleted_at, now())
                else deleted_at
              end
        where github_installation_id = $1
        returning id`,
      [githubInstallationId, lifecycle],
    );
    const installationId = installation.rows[0]?.id;
    if (!installationId) return false;
    if (lifecycle === "deleted") {
      await client.query(
        "update repositories set enabled = false where installation_id = $1",
        [installationId],
      );
    }
    return true;
  });
}

/** Persist a review run and all of its parent rows (tenant/installation/repo/PR). Returns the review_run id. */
export async function createReviewRun(input: CreateReviewRunInput): Promise<string> {
  const result = await withTransaction((client) => createReviewRunWithClient(client, input));
  return result.id;
}

const REVIEW_BOARD_WORKFLOW_TYPE = "pr_review";
const REVIEW_BOARD_V1_PIPELINE = "pr_review.board.v1";
const REVIEW_BOARD_V2_PIPELINE = "pr_review.board.v2";
const REVIEW_TRIGGER_EFFECT_TYPE = "trigger.review.dispatch";
const REVIEW_TRIGGER_EFFECT_VERSION = 1;
const REVIEW_TRIGGER_PROVIDER = "trigger.dev";

function reviewTriggerEffectKey(workflowId: string): string {
  return `trigger-review:${workflowId}`;
}

function receiptClosesPrepare(metadata: unknown): boolean {
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).prepare_closed === true,
  );
}

export async function prepareReviewRun(input: CreateReviewRunInput): Promise<string> {
  return withTransaction(async (client) => {
    const scope = await resolveReviewScopeWithClient(client, input);
    await lockReviewRequestKeyWithClient(client, scope.tenantId, scope.idempotencyKey);
    const workflowRows = await client.query<{
      workflow_id: string;
      workflow_type: string;
      pipeline_version: string;
    }>(
      `select id workflow_id,workflow_type,pipeline_version
       from jina_runtime.board_workflows
       where tenant_id=$1 and dedupe_key=$2
       for update`,
      [scope.tenantId, scope.idempotencyKey],
    );
    if (workflowRows.rows.length === 0) {
      return (await createReviewRunWithClient(client, input)).id;
    }
    if (workflowRows.rows.length !== 1) {
      throw new ReviewDispatchProvenanceError("review request resolves to multiple Board workflows");
    }
    const workflow = workflowRows.rows[0];
    if (workflow.workflow_type !== REVIEW_BOARD_WORKFLOW_TYPE) {
      throw new ReviewDispatchProvenanceError(
        `Board workflow ${workflow.workflow_id} is not a review workflow`,
      );
    }

    const triggerRunId = input.triggerRunId?.trim();
    if (workflow.pipeline_version === REVIEW_BOARD_V1_PIPELINE) {
      const legacyRows = await client.query<{
        id: string;
        trigger_run_id: string | null;
      }>(
        `select id,trigger_run_id
         from review_runs
         where idempotency_key=$1
           and tenant_id=$2::uuid
           and orchestrator='board'
           and board_workflow_id=$3
         for update`,
        [scope.idempotencyKey, scope.tenantId, workflow.workflow_id],
      );
      if (legacyRows.rows.length !== 1) {
        throw new ReviewDispatchProvenanceError(
          `v1 Board workflow ${workflow.workflow_id} does not resolve to exactly one Board-owned review run`,
        );
      }
      const legacy = legacyRows.rows[0];
      if (legacy.trigger_run_id && triggerRunId && legacy.trigger_run_id !== triggerRunId) {
        throw new ReviewDispatchProvenanceError(`review run ${legacy.id} belongs to another Trigger run`);
      }
      if (triggerRunId && !legacy.trigger_run_id) {
        await client.query(
          `update review_runs set trigger_run_id=$2,updated_at=now() where id=$1`,
          [legacy.id, triggerRunId],
        );
      }
      return legacy.id;
    }

    if (workflow.pipeline_version !== REVIEW_BOARD_V2_PIPELINE) {
      throw new ReviewDispatchProvenanceError(
        `Board workflow ${workflow.workflow_id} does not use a supported review pipeline`,
      );
    }
    if (!triggerRunId) {
      throw new ReviewDispatchProvenanceError("Board-owned prepare requires trigger_run_id");
    }

    const taskRows = await client.query<{
      task_id: string;
      request_digest: string | null;
    }>(
      `select id task_id,metadata->>'request_digest' request_digest
       from jina_runtime.board_tasks
       where workflow_id=$1
         and task_type='review'
         and topic='run-review'
         and metadata->>'trigger_task_id'='review'
         and metadata->'trigger_payload'=$2::jsonb
       for update`,
      [workflow.workflow_id, JSON.stringify(input.orchestrationPayload ?? null)],
    );
    if (taskRows.rows.length !== 1 || !taskRows.rows[0]?.request_digest) {
      throw new ReviewDispatchProvenanceError("Board review dispatch payload does not match prepare payload");
    }
    const task = taskRows.rows[0];
    const receipt = (
      await client.query<{
        idempotency_key: string;
        status: string;
        provider_id: string | null;
        authority_record_id: string | null;
        metadata: unknown;
      }>(
        `select idempotency_key,status,provider_id,authority_record_id,metadata
         from jina_runtime.board_effect_receipts
         where idempotency_key=$1
           and workflow_id=$2
           and task_id=$3
           and effect_type=$4
           and effect_version=$5
           and provider=$6
           and request_digest=$7
         for update`,
        [
          reviewTriggerEffectKey(workflow.workflow_id),
          workflow.workflow_id,
          task.task_id,
          REVIEW_TRIGGER_EFFECT_TYPE,
          REVIEW_TRIGGER_EFFECT_VERSION,
          REVIEW_TRIGGER_PROVIDER,
          task.request_digest,
        ],
      )
    ).rows[0];
    if (!receipt) {
      throw new ReviewDispatchProvenanceError("Board review dispatch receipt is missing");
    }
    if (receiptClosesPrepare(receipt.metadata)) {
      throw new ReviewDispatchProvenanceError(
        "Trigger run became terminal before review prepare committed",
      );
    }
    if (!receipt.provider_id) throw new ReviewDispatchNotBoundError();
    if (receipt.status !== "succeeded" || receipt.provider_id !== triggerRunId) {
      throw new ReviewDispatchProvenanceError("Trigger run does not own the Board review dispatch receipt");
    }

    const review = await createReviewRunWithClient(client, input);
    if (!review.created && review.orchestrator !== "board") {
      throw new ReviewDispatchProvenanceError(`review run ${review.id} is already owned by Trigger`);
    }
    if (review.triggerRunId && review.triggerRunId !== triggerRunId) {
      throw new ReviewDispatchProvenanceError(`review run ${review.id} belongs to another Trigger run`);
    }
    if (review.boardWorkflowId && review.boardWorkflowId !== workflow.workflow_id) {
      throw new ReviewDispatchProvenanceError(`review run ${review.id} belongs to another Board workflow`);
    }
    await bindReviewRunToBoardWithClient(client, {
      reviewRunId: review.id,
      tenantId: scope.tenantId,
      workflowId: workflow.workflow_id,
    });
    const authority = await client.query(
      `update jina_runtime.board_effect_receipts
          set authority_record_id=$2,updated_at=clock_timestamp()
        where idempotency_key=$1
          and (authority_record_id is null or authority_record_id=$2)
        returning idempotency_key`,
      [receipt.idempotency_key, review.id],
    );
    if (authority.rowCount !== 1) {
      throw new ReviewDispatchProvenanceError("Board review dispatch receipt belongs to another authority record");
    }
    return review.id;
  });
}

export class ReviewDispatchNotBoundError extends Error {
  constructor() {
    super("Board review dispatch has not persisted its Trigger run ID yet");
    this.name = "ReviewDispatchNotBoundError";
  }
}

export class ReviewDispatchProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewDispatchProvenanceError";
  }
}

export async function createReviewRunWithClient(
  client: pg.PoolClient,
  input: CreateReviewRunInput,
): Promise<CreatedReviewRun> {
  const scope = await resolveReviewScopeWithClient(client, input);
  await lockReviewRequestKeyWithClient(client, scope.tenantId, scope.idempotencyKey);
  const { tenantId, repositoryId, pullRequestId, headSha, idempotencyKey } = scope;

  const inserted = await client.query<{ id: string; tenant_id: string }>(
    `insert into review_runs
         (tenant_id, repository_id, pull_request_id, trigger, status, idempotency_key,
          trigger_run_id, head_sha, delivery_id, source_event, bot_type, bot_status,
          manual_command_tag,review_instructions,started_at, created_at, updated_at)
       values ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,'code_review','queued',$10,$11,now(), now(), now())
       on conflict (idempotency_key) do nothing
       returning id,tenant_id`,
    [
      tenantId,
      repositoryId,
      pullRequestId ?? null,
      input.triggerSource ?? "webhook",
      idempotencyKey,
      input.triggerRunId ?? null,
      headSha,
      input.deliveryId ?? null,
      input.sourceEvent ?? null,
      input.manualCommandTag ?? null,
      input.reviewInstructions ?? null,
    ],
  );

  const created = inserted.rows[0];
  const existing = created
    ? undefined
    : (
        await client.query<{
          id: string;
          tenant_id: string;
          orchestrator: "trigger" | "board";
          board_workflow_id: string | null;
          trigger_run_id: string | null;
        }>(
          `select id,tenant_id,orchestrator,board_workflow_id,trigger_run_id
           from review_runs
           where idempotency_key=$1
           for update`,
          [idempotencyKey],
        )
      ).rows[0];
  if (!created && !existing) {
    throw new Error("review run idempotency conflict disappeared during admission");
  }

  const reviewRunId = created?.id ?? existing!.id;
  if (created) {
    await client.query(
      `insert into review_run_events (review_run_id, status, payload_json, trigger_run_id)
       values ($1, 'queued', $2, $3)`,
      [reviewRunId, jsonOrNull({ trigger_run_id: input.triggerRunId }), input.triggerRunId ?? null],
    );
  } else {
    await client.query(
      `update review_runs
          set updated_at=now(), trigger_run_id=coalesce(trigger_run_id,$2)
        where id=$1`,
      [reviewRunId, input.triggerRunId ?? null],
    );
  }

  return {
    id: reviewRunId,
    tenantId: created?.tenant_id ?? existing!.tenant_id,
    created: Boolean(created),
    orchestrator: existing?.orchestrator ?? "trigger",
    ...(existing?.board_workflow_id ? { boardWorkflowId: existing.board_workflow_id } : {}),
    ...((existing?.trigger_run_id ?? input.triggerRunId)
      ? { triggerRunId: existing?.trigger_run_id ?? input.triggerRunId }
      : {}),
  };
}

export async function resolveReviewScopeWithClient(
  client: pg.PoolClient,
  input: CreateReviewRunInput,
): Promise<ResolvedReviewScope> {
  const githubRepoId = input.repository.githubRepoId;
  const repoOwner = input.repository.owner ?? input.repository.fullName?.split("/")[0];
  const repoName = input.repository.name ?? input.repository.fullName?.split("/")[1];
  if (!githubRepoId || !repoOwner || !repoName) {
    throw new Error("review run is missing repository identity");
  }

  const tenantId = await resolveTenantId(client, {
    installationId: input.installationId,
    accountId: input.account?.id,
    accountLogin: input.account?.login ?? repoOwner,
    accountType: input.account?.type ?? "Organization",
  });

  let installationRecordId: string | undefined;
  if (input.installationId) {
    installationRecordId = await upsertInstallation(client, tenantId, input.installationId, input.account);
  }

  const repositoryId = await upsertRepository(client, {
    tenantId,
    installationRecordId,
    githubRepoId,
    owner: repoOwner,
    name: repoName,
    defaultBranch: input.repository.defaultBranch,
    private: input.repository.private,
  });

  let pullRequestId: string | undefined;
  if (typeof input.pullRequest.number === "number" && input.pullRequest.headSha) {
    pullRequestId = await upsertPullRequest(client, {
      tenantId,
      repositoryId,
      number: input.pullRequest.number,
      title: input.pullRequest.title,
      author: input.pullRequest.author,
      headSha: input.pullRequest.headSha,
      baseSha: input.pullRequest.baseSha,
      headRef: input.pullRequest.headRef,
      baseRef: input.pullRequest.baseRef,
      htmlUrl: input.pullRequest.htmlUrl,
      draft: input.pullRequest.draft,
    });
  }

  const headSha = input.pullRequest.headSha;
  if (!headSha) {
    // head_sha is NOT NULL and is the basis for dedupe; never persist an empty placeholder.
    throw new Error("review run is missing pull request head_sha");
  }

  // Prefer a caller-provided logical idempotency key. Trigger run ids are a
  // fallback for legacy task shapes, but retryable workflows should pass a key
  // derived from repository + PR + head so retry attempts reuse the same row.
  const idempotencyKey =
    input.idempotencyKey ??
    input.triggerRunId ??
    `review:${input.installationId ?? "none"}:${githubRepoId}:${input.pullRequest.number ?? "none"}:${headSha}:code_review`;

  return {
    tenantId,
    repositoryId,
    ...(pullRequestId ? { pullRequestId } : {}),
    headSha,
    idempotencyKey,
  };
}

export async function lockReviewRequestKeyWithClient(
  client: pg.PoolClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${tenantId}:${idempotencyKey}`,
  ]);
}

export async function listManualReviewRuns(scopeTag: string): Promise<{
  runs: { tags: string[]; createdAt: string }[];
}> {
  const match = /^manual-pr:([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)$/.exec(scopeTag);
  if (!match) throw new Error("manual review scope tag is invalid");
  const rows = await query<{ manual_command_tag: string; created_at: Date | string }>(
    `select run.manual_command_tag,run.created_at
     from review_runs run
     join repositories repository on repository.id=run.repository_id
     join installations installation on installation.id=repository.installation_id
     join pull_requests pull_request on pull_request.id=run.pull_request_id
     where installation.github_installation_id=$1
       and repository.github_repo_id=$2
       and pull_request.pr_number=$3
       and run.manual_command_tag is not null
     order by run.created_at desc,run.id desc
     limit 100`,
    [Number(match[1]), Number(match[2]), Number(match[3])],
  );
  return {
    runs: rows.map((row) => ({
      tags: [row.manual_command_tag],
      createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    })),
  };
}

export async function bindReviewRunToBoardWithClient(
  client: pg.PoolClient,
  input: { reviewRunId: string; tenantId: string; workflowId: string },
): Promise<void> {
  const bound = await client.query(
    `update review_runs
        set orchestrator='board', board_workflow_id=$3, updated_at=now()
      where id=$1
        and tenant_id=$2::uuid
        and (board_workflow_id is null or board_workflow_id=$3)
      returning id`,
    [input.reviewRunId, input.tenantId, input.workflowId],
  );
  if (bound.rowCount !== 1) {
    throw new Error(`review run ${input.reviewRunId} could not be bound to Board workflow ${input.workflowId}`);
  }
}

export type BoardReviewTerminalReconciliationOutcome = "updated" | "already_terminal" | "no_row";

export async function reconcileBoardReviewTerminal(input: {
  readonly boardWorkflowId: string;
  readonly triggerRunId: string;
  readonly providerStatus: string;
  readonly status: "failed" | "canceled";
  readonly diagnostic: string;
}): Promise<{
  readonly outcome: BoardReviewTerminalReconciliationOutcome;
  readonly reviewRunId?: string;
}> {
  return withTransaction(async (client) => {
    const identityRows = await client.query<{
      tenant_id: string;
      dedupe_key: string;
      task_id: string;
      request_digest: string | null;
    }>(
      `select workflow.tenant_id,workflow.dedupe_key,task.id task_id,
              task.metadata->>'request_digest' request_digest
       from jina_runtime.board_workflows workflow
       join jina_runtime.board_tasks task on task.workflow_id=workflow.id
       where workflow.id=$1
         and workflow.workflow_type=$2
         and workflow.pipeline_version=$3
         and task.task_type='review'
         and task.topic='run-review'
         and task.metadata->>'trigger_task_id'='review'`,
      [input.boardWorkflowId, REVIEW_BOARD_WORKFLOW_TYPE, REVIEW_BOARD_V2_PIPELINE],
    );
    if (identityRows.rows.length !== 1 || !identityRows.rows[0]?.request_digest) {
      throw new ReviewDispatchProvenanceError(
        "terminal reconciliation does not resolve to exactly one v2 Board review task",
      );
    }
    const identity = identityRows.rows[0];
    await lockReviewRequestKeyWithClient(client, identity.tenant_id, identity.dedupe_key);

    const lockedIdentity = await client.query<{
      task_id: string;
      request_digest: string | null;
    }>(
      `select task.id task_id,task.metadata->>'request_digest' request_digest
       from jina_runtime.board_workflows workflow
       join jina_runtime.board_tasks task on task.workflow_id=workflow.id
       where workflow.id=$1
         and workflow.tenant_id=$2
         and workflow.dedupe_key=$3
         and workflow.workflow_type=$4
         and workflow.pipeline_version=$5
         and task.id=$6
         and task.task_type='review'
         and task.topic='run-review'
         and task.metadata->>'trigger_task_id'='review'
       for update of workflow,task`,
      [
        input.boardWorkflowId,
        identity.tenant_id,
        identity.dedupe_key,
        REVIEW_BOARD_WORKFLOW_TYPE,
        REVIEW_BOARD_V2_PIPELINE,
        identity.task_id,
      ],
    );
    if (
      lockedIdentity.rows.length !== 1 ||
      lockedIdentity.rows[0]?.request_digest !== identity.request_digest
    ) {
      throw new ReviewDispatchProvenanceError("Board review identity changed during terminal reconciliation");
    }

    const receiptRows = await client.query<{
      idempotency_key: string;
      status: string;
      provider_id: string | null;
      authority_record_id: string | null;
    }>(
      `select idempotency_key,status,provider_id,authority_record_id
       from jina_runtime.board_effect_receipts
       where idempotency_key=$1
         and workflow_id=$2
         and task_id=$3
         and effect_type=$4
         and effect_version=$5
         and provider=$6
         and request_digest=$7
       for update`,
      [
        reviewTriggerEffectKey(input.boardWorkflowId),
        input.boardWorkflowId,
        identity.task_id,
        REVIEW_TRIGGER_EFFECT_TYPE,
        REVIEW_TRIGGER_EFFECT_VERSION,
        REVIEW_TRIGGER_PROVIDER,
        identity.request_digest,
      ],
    );
    if (receiptRows.rows.length !== 1) {
      throw new ReviewDispatchProvenanceError("Board review dispatch receipt is missing");
    }
    const receipt = receiptRows.rows[0];
    if (receipt.status !== "succeeded" || receipt.provider_id !== input.triggerRunId) {
      throw new ReviewDispatchProvenanceError(
        "terminal Trigger run does not own the Board review dispatch receipt",
      );
    }

    const candidates = await client.query<{
      id: string;
      orchestrator: "trigger" | "board";
      board_workflow_id: string | null;
      trigger_run_id: string | null;
      status: string;
    }>(
      `select id,orchestrator,board_workflow_id,trigger_run_id,status
       from review_runs
       where board_workflow_id=$1 or trigger_run_id=$2
       for update`,
      [input.boardWorkflowId, input.triggerRunId],
    );
    if (candidates.rows.length === 0) {
      if (receipt.authority_record_id) {
        throw new ReviewDispatchProvenanceError(
          "Board review dispatch receipt names an authority record that does not exist",
        );
      }
      const closed = await client.query(
        `update jina_runtime.board_effect_receipts
            set metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
                  'prepare_closed',true,
                  'terminal_provider_status',$2::text,
                  'terminal_observed_at',clock_timestamp()
                ),
                updated_at=clock_timestamp()
          where idempotency_key=$1
          returning idempotency_key`,
        [receipt.idempotency_key, input.providerStatus],
      );
      if (closed.rowCount !== 1) {
        throw new ReviewDispatchProvenanceError("Board review dispatch receipt could not close prepare");
      }
      return { outcome: "no_row" };
    }
    const matching = candidates.rows.filter(
      (row) =>
        row.orchestrator === "board" &&
        row.board_workflow_id === input.boardWorkflowId &&
        row.trigger_run_id === input.triggerRunId,
    );
    if (matching.length !== 1 || candidates.rows.length !== 1) {
      throw new ReviewDispatchProvenanceError(
        "terminal reconciliation identities do not resolve to exactly one Board-owned review run",
      );
    }
    const review = matching[0];
    if (receipt.authority_record_id !== review.id) {
      throw new ReviewDispatchProvenanceError(
        "Board review dispatch receipt does not name the reconciled authority record",
      );
    }
    if (isTerminalReviewRunStatus(review.status)) {
      return { outcome: "already_terminal", reviewRunId: review.id };
    }
    const botStatus = input.status === "canceled" ? "canceled" : "failed";
    const updated = await client.query<{ id: string }>(
      `update review_runs
          set status=$2,bot_status=$3,error=$4,finished_at=now(),updated_at=now()
        where id=$1 and status <> all($5)
        returning id`,
      [review.id, input.status, botStatus, input.diagnostic.slice(0, 2_000), TERMINAL_RUN_STATUSES],
    );
    if (updated.rowCount !== 1) {
      return { outcome: "already_terminal", reviewRunId: review.id };
    }
    await client.query(
      `insert into review_run_events (review_run_id,status,payload_json,trigger_run_id)
       values ($1,'review_terminal_reconciled',$2::jsonb,$3)`,
      [
        review.id,
        JSON.stringify({
          schema_version: 1,
          board_workflow_id: input.boardWorkflowId,
          provider: "trigger.dev",
          provider_status: input.providerStatus,
          product_status: input.status,
          diagnostic: input.diagnostic.slice(0, 2_000),
        }),
        input.triggerRunId,
      ],
    );
    return { outcome: "updated", reviewRunId: review.id };
  });
}

// Statuses that represent a finished run. Once a run reaches one, later non-terminal
// events (which can arrive out of order on retries) must not revert its status.
// 'blocked_insufficient_credits' (FINDING 5) is terminal: a prepare-time 402 completes the run
// here so it never orbits as 'queued'. It bills nothing — its bot_status ('blocked') flows through
const TERMINAL_RUN_STATUSES = [
  "completed",
  "completed_superseded",
  "failed",
  "superseded",
  "cancelled",
  "canceled",
  "blocked_insufficient_credits",
];

export function isTerminalReviewRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export async function recordReviewEvent(
  reviewRunId: string,
  status: string,
  botStatus: string,
  payload: unknown,
  triggerRunId?: string,
): Promise<void> {
  await query(
    `update review_runs set status = $2, bot_status = $3, updated_at = now()
     where id = $1 and status <> all($4)`,
    [reviewRunId, status, botStatus, TERMINAL_RUN_STATUSES],
  );
  // Always append the audit event even when the status update was skipped.
  await query(
    `insert into review_run_events
       (review_run_id, status, payload_json, dashboard_payload_json, trigger_run_id)
     select $1, $2, $3, $4, $5 where exists (select 1 from review_runs where id = $1)`,
    [reviewRunId, status, jsonOrNull(payload), jsonOrNull(projectDashboardEventPayload(status, payload)), triggerRunId ?? null],
  );
}

export async function completeReviewRun(
  reviewRunId: string,
  status: string,
  botStatus: string,
  result: unknown,
  error: string | undefined,
  triggerRunId?: string,
): Promise<boolean> {
  const updated = await queryOne<{ id: string }>(
    `update review_runs
       set status = $2, bot_status = $3, result_json = $4, dashboard_result_json = $5,
           error = $6, finished_at = now(), updated_at = now()
     where id = $1 and status <> all($7)
     returning id`,
    [
      reviewRunId,
      status,
      botStatus,
      jsonOrNull(result),
      jsonOrNull(projectDashboardRunResult(result)),
      error ?? null,
      TERMINAL_RUN_STATUSES,
    ],
  );
  if (!updated) {
    await query(
      `insert into review_run_events (review_run_id, status, payload_json, trigger_run_id)
       select $1, 'review_completion_ignored_terminal', $2, $3
       where exists (select 1 from review_runs where id = $1)`,
      [reviewRunId, jsonOrNull(result), triggerRunId ?? null],
    );
    return false;
  }
  await query(
    `insert into review_run_events
       (review_run_id, status, payload_json, dashboard_payload_json, trigger_run_id)
     select $1, $2, $3, $4, $5 where exists (select 1 from review_runs where id = $1)`,
    [reviewRunId, status, jsonOrNull(result), jsonOrNull(projectDashboardEventPayload(status, result)), triggerRunId ?? null],
  );
  return true;
}

/**
 * FINDING 4: reopen a run that reused a blocked idempotency key. A rerun of the SAME PR head reuses
 * the idempotency key, so createReviewRun's `on conflict` returns the SAME row. If that row is terminal
 * 'blocked_insufficient_credits' (blocked at prepare for billing), it is a DEAD row: prepare may pass
 * and work starts, but every event/completion write is dropped by the terminal-status guard. When the
 * key resolves to such a run (e.g. after the user buys credits), reopen it — reset status/bot_status to
 * 'queued', clear finished_at/error — so this attempt proceeds on a live row. Only 'blocked' runs are
 * reopenable; other terminal statuses keep their existing reuse behavior (the WHERE clause enforces it).
 * The pinned review_run_billing row is dropped so prepareRunBilling re-pins the rate mode/key source for
 * the new attempt (a post-top-up rerun may resolve 'included' where the blocked attempt pinned
 * 'overage'). A blocked run never dispatched work, so it has no usage rows and its infra charge was
 * never billed — dropping the billing row loses nothing. Returns true iff a blocked run was reopened.
 */
export async function reopenBlockedReviewRun(reviewRunId: string): Promise<boolean> {
  if (!databaseConfigured()) {
    return false;
  }
  return withTransaction(async (client) => {
    const updated = await client.query<{ id: string }>(
      `update review_runs
          set status = 'queued', bot_status = 'queued', finished_at = null, error = null, updated_at = now()
        where id = $1 and status = 'blocked_insufficient_credits'
        returning id`,
      [reviewRunId],
    );
    if (updated.rows.length === 0) {
      return false;
    }
    await client.query(`delete from review_run_billing where review_run_id = $1`, [reviewRunId]);
    await client.query(
      `insert into review_run_events (review_run_id, status, payload_json, trigger_run_id)
       values ($1, 'billing_block_reopened', null, null)`,
      [reviewRunId],
    );
    return true;
  });
}

/** Upsert a tenant + installation + the set of repositories seen during installation backfill. */
export async function recordInstallation(input: {
  installationId?: number;
  account?: { id?: number; login?: string; type?: string };
  /** The webhook sender who performed the installation — an org admin by definition. */
  installer?: { id?: number; login?: string };
  lifecycle?: InstallationLifecycle;
  repositories: InstallationRepository[];
  removedRepositories?: InstallationRepository[];
}): Promise<string | undefined> {
  if (!input.account?.id && !input.installationId) {
    return undefined;
  }

  return withTransaction(async (client) => {
    const tenantId = await resolveTenantId(client, {
      installationId: input.installationId,
      accountId: input.account?.id,
      accountLogin: input.account?.login,
      accountType: input.account?.type ?? "Organization",
    });

    const installationRecordId = input.installationId
      ? await upsertInstallation(
          client,
          tenantId,
          input.installationId,
          input.account,
          input.lifecycle === "suspended" || input.lifecycle === "deleted"
            ? undefined
            : input.installer?.id,
          input.lifecycle,
        )
      : undefined;

    // Grant the installing admin an org membership immediately (source 'installer'): the OAuth sync can't
    // see orgs that restrict OAuth apps, so without this the installer gets no org switcher — and their
    // plan/settings land on the personal tenant. Personal installs skip it (implicit admin of own tenant).
    if (
      input.lifecycle !== "suspended"
      && input.lifecycle !== "deleted"
      && (input.account?.type ?? "Organization") === "Organization"
      && input.installer?.id
      && input.installer.login
    ) {
      await upsertInstallerMembership(client, tenantId, { id: input.installer.id, login: input.installer.login });
    }

    if (installationRecordId && input.lifecycle === "deleted") {
      await client.query(
        `update repositories set enabled = false where installation_id = $1`,
        [installationRecordId],
      );
    } else if (installationRecordId && input.lifecycle === "active") {
      await client.query(
        `update repositories set enabled = true where installation_id = $1`,
        [installationRecordId],
      );
    }

    for (const repo of input.repositories) {
      const owner = repo.owner ?? repo.fullName?.split("/")[0] ?? input.account?.login;
      const name = repo.name ?? repo.fullName?.split("/")[1];
      if (!repo.githubRepoId || !owner || !name) {
        continue;
      }
      await upsertRepository(client, {
        tenantId,
        installationRecordId,
        githubRepoId: repo.githubRepoId,
        owner,
        name,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
      });
    }

    const removedRepositoryIds = (input.removedRepositories ?? [])
      .map((repository) => repository.githubRepoId)
      .filter((repositoryId): repositoryId is number => typeof repositoryId === "number");
    if (removedRepositoryIds.length > 0) {
      await client.query(
        `delete from repositories
          where tenant_id = $1
            and github_repo_id = any($2::bigint[])
            and ($3::uuid is null or installation_id = $3::uuid)`,
        [tenantId, removedRepositoryIds, installationRecordId ?? null],
      );
    }

    return tenantId;
  });
}

export class InstallationTenantMoveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationTenantMoveConflictError";
  }
}

export interface ConnectGithubInstallationInput {
  tenantId: string;
  installationId: number;
  account: { id: number; login: string; type: string };
  repositories: InstallationRepository[];
  movedByUserId?: string;
  movedByGithubUserId: number;
}

const FRESH_INSTALLATION_MOVE_WINDOW_MS = 60 * 60 * 1_000;

/**
 * Attach one GitHub App installation to an existing Jina tenant.
 *
 * This is deliberately stricter than webhook backfill. An installation with
 * review/project history cannot be silently moved because that would also
 * change the billing owner of historical work. Fresh installation shells may
 * be reassigned transactionally; every move is recorded for rollback.
 */
export async function connectGithubInstallationToTenant(
  input: ConnectGithubInstallationInput,
): Promise<{ tenantId: string; moved: boolean }> {
  if (!databaseConfigured()) {
    return { tenantId: input.tenantId, moved: false };
  }
  return withTransaction(async (client) => {
    const target = await client.query<{ id: string }>(
      `select id
         from tenants
        where id = $1
          and merged_into_tenant_id is null
        for update`,
      [input.tenantId],
    );
    if (!target.rows[0]) {
      throw new InstallationTenantMoveConflictError("target Jina tenant does not exist");
    }

    const existing = await client.query<{ id: string; tenant_id: string; created_at: Date | string }>(
      `select id, tenant_id, created_at
         from installations
        where github_installation_id = $1
        for update`,
      [input.installationId],
    );

    let installationRecordId: string;
    let moved = false;
    let moveId: string | undefined;
    const current = existing.rows[0];
    if (!current) {
      installationRecordId = await upsertInstallation(
        client,
        input.tenantId,
        input.installationId,
        input.account,
        input.movedByGithubUserId,
        "active",
      );
    } else {
      installationRecordId = current.id;
      if (current.tenant_id !== input.tenantId) {
        if (Date.now() - new Date(current.created_at).getTime() > FRESH_INSTALLATION_MOVE_WINDOW_MS) {
          throw new InstallationTenantMoveConflictError(
            "GitHub installation already belongs to an established Jina workspace; use an explicit workspace merge",
          );
        }
        const unresolvedRepositories = await client.query<{ id: string }>(
          `select id
             from repositories
            where tenant_id = $1
              and installation_id is null
            for update`,
          [current.tenant_id],
        );
        if (unresolvedRepositories.rowCount) {
          throw new InstallationTenantMoveConflictError(
            "source workspace has unresolved legacy repositories; run the identity transition before moving it",
          );
        }
        await client.query(
          `select id
             from repositories
            where installation_id = $1
            for update`,
          [installationRecordId],
        );
        const history = await client.query<{ found: boolean }>(
          `select exists (
             select 1
               from repositories repository
              where repository.installation_id = $1
                and (
                  exists (select 1 from review_runs run where run.repository_id = repository.id)
                  or exists (select 1 from pull_requests pull where pull.repository_id = repository.id)
                  or exists (select 1 from bots bot where bot.repository_id = repository.id)
                  or exists (select 1 from scenario_lineages lineage where lineage.repository_id = repository.id)
                )
           ) as found`,
          [installationRecordId],
        );
        if (history.rows[0]?.found) {
          throw new InstallationTenantMoveConflictError(
            "GitHub installation already has Jina history; merge the workspaces explicitly instead of changing its billing owner",
          );
        }

        await client.query(
          `update repositories set tenant_id = $2 where installation_id = $1`,
          [installationRecordId, input.tenantId],
        );
        await client.query(
          `update installations
              set tenant_id = $2,
                  github_account_id = $3,
                  github_account_login = $4,
                  github_account_type = $5,
                  installed_by_github_user_id = coalesce(installed_by_github_user_id, $6),
                  installer_verified_at = now()
            where id = $1`,
          [
            installationRecordId,
            input.tenantId,
            input.account.id,
            input.account.login,
            input.account.type,
            input.movedByGithubUserId,
          ],
        );
        const move = await client.query<{ id: string }>(
          `insert into installation_tenant_moves
             (installation_id, github_installation_id, from_tenant_id, to_tenant_id,
              moved_by_user_id, moved_by_github_user_id)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [
            installationRecordId,
            input.installationId,
            current.tenant_id,
            input.tenantId,
            input.movedByUserId ?? null,
            input.movedByGithubUserId,
          ],
        );
        moveId = move.rows[0].id;
        // The webhook creates an account-derived org tenant before the setup
        // callback knows which Jina workspace the user selected. Hide that
        // temporary shell only when it owns no data or workspace settings.
        // Keeping the row makes rollback lossless and lets reinstalls follow
        // the explicit workspace connection.
        await client.query(
          `update tenants source
              set merged_into_tenant_id = $2
            where source.id = $1
              and source.merged_into_tenant_id is null
              and not exists (select 1 from installations where tenant_id = source.id)
              and not exists (select 1 from repositories where tenant_id = source.id)
              and not exists (select 1 from tenant_integrations where tenant_id = source.id)
              and not exists (select 1 from tenant_model_settings where tenant_id = source.id)
              and not exists (select 1 from tenant_billing_policy where tenant_id = source.id)
              and not exists (select 1 from github_events where tenant_id = source.id)
              and not exists (select 1 from bots where tenant_id = source.id)
              and not exists (select 1 from pull_requests where tenant_id = source.id)
              and not exists (select 1 from review_runs where tenant_id = source.id)
              and not exists (select 1 from review_findings where tenant_id = source.id)
              and not exists (select 1 from scenarios where tenant_id = source.id)
              and not exists (select 1 from simulations where tenant_id = source.id)
              and not exists (select 1 from scenario_lineages where tenant_id = source.id)
              and not exists (select 1 from review_llm_usage where tenant_id = source.id)
              and not exists (select 1 from review_run_billing where tenant_id = source.id)`,
          [current.tenant_id, input.tenantId],
        );
        moved = true;
      } else {
        await upsertInstallation(
          client,
          input.tenantId,
          input.installationId,
          input.account,
          input.movedByGithubUserId,
          "active",
        );
      }
    }

    for (const repository of input.repositories) {
      const owner = repository.owner ?? repository.fullName?.split("/")[0] ?? input.account.login;
      const name = repository.name ?? repository.fullName?.split("/")[1];
      if (!repository.githubRepoId || !owner || !name) continue;
      await upsertRepository(client, {
        tenantId: input.tenantId,
        installationRecordId,
        githubRepoId: repository.githubRepoId,
        owner,
        name,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
      });
    }

    if (moveId) {
      await client.query(
        `insert into installation_tenant_move_repositories
           (move_id, repository_id, github_repo_id)
         select $1, repository.id, repository.github_repo_id
           from repositories repository
          where repository.installation_id = $2`,
        [moveId, installationRecordId],
      );
    }

    return { tenantId: input.tenantId, moved };
  });
}

export async function recordGithubEvent(
  deliveryId: string,
  event: string,
  action: string | undefined,
  payload: unknown,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into github_events (github_delivery_id, github_event, action, payload_json)
     values ($1, $2, $3, $4)
     on conflict (github_delivery_id) do nothing`,
    [deliveryId, event, action ?? null, jsonOrNull(payload) ?? "{}"],
  );
}

export interface ReviewRunRecordPage {
  records: ReviewRunRecord[];
  limit: number;
  nextCursor?: string;
}

const DEFAULT_REVIEW_RUN_LIMIT = 50;
const MAX_REVIEW_RUN_LIMIT = 100;
const LIST_ERROR_PREVIEW_LENGTH = 500;
const LIST_URL_PREVIEW_LENGTH = 2_048;
export const DASHBOARD_LIST_EVENT_LIMIT = 100;

/**
 * Dashboard list reads expose only the latest bounded timeline for each run.
 * The detail route remains the full-fidelity audit-history boundary.
 *
 * The lateral query lets PostgreSQL use the per-run event index and enforce
 * the limit before rows from different runs are combined.
 */
export const DASHBOARD_LIST_EVENTS_SQL = `
  select recent.review_run_id, recent.status,
         recent.dashboard_payload_json as payload_json,
         recent.trigger_run_id, recent.recorded_at
  from unnest($1::uuid[]) requested(review_run_id)
  cross join lateral (
    select e.id, e.review_run_id, e.status, e.dashboard_payload_json,
           e.trigger_run_id, e.recorded_at
    from review_run_events e
    where e.review_run_id = requested.review_run_id
    order by e.recorded_at desc, e.id desc
    limit $2
  ) recent
  order by recent.review_run_id, recent.recorded_at asc, recent.id asc`;

const DASHBOARD_RUNTIME_PUBLISH_STATUSES = new Set([
  "github_runtime_review_published",
  "github_runtime_review_publish_skipped",
  "github_runtime_review_publish_failed",
]);

/**
 * Project the large source-of-truth result onto the bounded shape consumed by
 * dashboard list presentation. Detail reads continue to use `result_json`.
 */
export function projectDashboardRunResult(result: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(result)) {
    return undefined;
  }

  const simulation = isObjectRecord(result.simulation) ? result.simulation : undefined;
  const finalReview = isObjectRecord(result.final_review) ? result.final_review : undefined;
  const reviewGate = isObjectRecord(result.review_gate) ? result.review_gate : undefined;

  return compactRecord({
    status: boundedText(result.status),
    github_comment_url: boundedText(result.github_comment_url, LIST_URL_PREVIEW_LENGTH),
    github_check_run_url: boundedText(result.github_check_run_url, LIST_URL_PREVIEW_LENGTH),
    review_gate: reviewGate
      ? compactRecord({
          blocking_level: boundedText(reviewGate.blocking_level),
          conclusion: boundedText(reviewGate.conclusion),
          blocking: booleanValue(reviewGate.blocking),
          blocking_count: numberValue(reviewGate.blocking_count),
          scenario_counts: compactNumberRecord(reviewGate.scenario_counts, ["total", "high", "medium", "low", "unknown"]),
        })
      : undefined,
    publish_error: boundedText(result.publish_error),
    simulation_error: boundedText(result.simulation_error),
    final_review_error: boundedText(result.final_review_error),
    error: boundedText(result.error),
    simulation: simulation
      ? compactRecord({
          status: boundedText(simulation.status),
          duration_ms: numberValue(simulation.duration_ms),
          counts: compactNumberRecord(simulation.counts, ["total", "pass", "fail", "warn"]),
          scenarios: [],
          error: boundedText(simulation.error),
        })
      : undefined,
    final_review: finalReview
      ? compactRecord({
          status: boundedText(finalReview.status),
          summary: boundedText(finalReview.summary),
          findings: [],
        })
      : undefined,
  });
}

/**
 * Project an audit event onto the small payload needed by list presentation.
 * Event status/timestamps are returned for the list route's latest bounded
 * timeline; the detail route retains the complete event history.
 */
export function projectDashboardEventPayload(status: string, payload: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(payload)) {
    return undefined;
  }

  if (status === "runtime_review_completed") {
    return compactRecord({
      status: boundedText(payload.status),
      summary: boundedText(payload.summary),
      findings_count: numberValue(payload.findings_count),
      comments_count: numberValue(payload.comments_count),
      publishable_findings_count: numberValue(payload.publishable_findings_count),
      inline_comment_count: numberValue(payload.inline_comment_count),
      file_comment_count: numberValue(payload.file_comment_count),
      unanchored_findings_count: numberValue(payload.unanchored_findings_count),
      low_confidence_findings_held_back: numberValue(payload.low_confidence_findings_held_back),
      areas_count: numberValue(payload.areas_count),
      tasks_count: numberValue(payload.tasks_count),
      blocked_count: numberValue(payload.blocked_count),
      error: boundedText(payload.error),
    });
  }

  if (DASHBOARD_RUNTIME_PUBLISH_STATUSES.has(status)) {
    return compactRecord({
      publication_status: boundedText(payload.publication_status),
      reason: boundedText(payload.reason),
      error: boundedText(payload.error),
      github_review_url: boundedText(payload.github_review_url, LIST_URL_PREVIEW_LENGTH),
      publishable_findings_count: numberValue(payload.publishable_findings_count),
      inline_comment_count: numberValue(payload.inline_comment_count),
      file_comment_count: numberValue(payload.file_comment_count),
    });
  }

  return undefined;
}

// The shared review-run projection + joins. Only the result/error expressions
// differ between the list view (truncated preview) and the detail view (full
// row), so they are passed in; the caller appends its own WHERE/ORDER/LIMIT.
function reviewRunSelectSql(resultExpr: string, errorExpr: string): string {
  return `select
        r.id, r.trigger_run_id, r.delivery_id, r.source_event, r.trigger, r.status,
        r.bot_type, r.bot_status, r.head_sha as run_head_sha, ${resultExpr} as result_json,
        ${errorExpr} as error,
        r.created_at, r.updated_at, r.finished_at,
        repo.github_repo_id, repo.owner, repo.name, repo.private,
        inst.github_installation_id,
        pr.pr_number, pr.title as pr_title, pr.html_url as pr_html_url, pr.author_login,
        pr.head_sha as pr_head_sha, pr.base_sha, pr.head_ref, pr.base_ref,
        b.key_source as billing_key_source, b.rate_mode as billing_rate_mode,
        b.infra_credits_charged as billing_infra_credits, b.ai_credits_charged_total as billing_ai_credits,
        b.infra_billing_status as billing_infra_status
     from review_runs r
       join repositories repo on repo.id = r.repository_id
       left join installations inst on inst.id = repo.installation_id
       left join pull_requests pr on pr.id = r.pull_request_id
       left join review_run_billing b on b.review_run_id = r.id`;
}

function toReviewEvent(event: EventRow): ReviewEvent {
  return {
    status: event.status,
    payload: event.payload_json ?? undefined,
    trigger_run_id: event.trigger_run_id ?? undefined,
    recorded_at: toIso(event.recorded_at),
  };
}

export async function getReviewRunRecords(options: {
  tenantId?: string;
  allowedFullNames?: string[] | null;
  project?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<ReviewRunRecordPage> {
  if (!databaseConfigured()) {
    return { records: [], limit: normalizeReviewRunLimit(options.limit) };
  }

  const allowed = options.allowedFullNames ?? null;
  const limit = normalizeReviewRunLimit(options.limit);
  const cursor = decodeReviewRunCursor(options.cursor);
  const rows = await query<ReviewRunRow>(
    `${reviewRunSelectSql("r.dashboard_result_json", `left(r.error, ${LIST_ERROR_PREVIEW_LENGTH})`)}
     where ($1::uuid is null or r.tenant_id = $1)
       and ($2::text[] is null or lower(repo.owner || '/' || repo.name) = any($2))
       and ($3::text is null or lower(repo.owner || '/' || repo.name) = lower($3))
       and ($4::timestamptz is null or (r.created_at, r.id) < ($4::timestamptz, $5::uuid))
     order by r.created_at desc, r.id desc
     limit $6`,
    [
      options.tenantId ?? null,
      allowed,
      options.project ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );

  if (rows.length === 0) {
    return { records: [], limit };
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const ids = pageRows.map((row) => row.id);
  const eventRows = await query<EventRow>(
    DASHBOARD_LIST_EVENTS_SQL,
    [ids, DASHBOARD_LIST_EVENT_LIMIT],
  );
  const eventsByRun = new Map<string, ReviewEvent[]>();
  for (const event of eventRows) {
    const list = eventsByRun.get(event.review_run_id) ?? [];
    list.push(toReviewEvent(event));
    eventsByRun.set(event.review_run_id, list);
  }

  const lastRow = pageRows[pageRows.length - 1];
  return {
    records: pageRows.map((row) => toReviewRunRecord(row, eventsByRun.get(row.id) ?? [])),
    limit,
    nextCursor: hasNextPage && lastRow ? encodeReviewRunCursor(lastRow) : undefined,
  };
}

export async function getReviewRunRecord(options: {
  reviewRunId: string;
  tenantId?: string;
  allowedFullNames?: string[] | null;
}): Promise<ReviewRunRecord | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }

  const allowed = options.allowedFullNames ?? null;
  const rows = await query<ReviewRunRow>(
    `${reviewRunSelectSql("r.result_json", "r.error")}
     where r.id = $1
       and ($2::uuid is null or r.tenant_id = $2)
       and ($3::text[] is null or lower(repo.owner || '/' || repo.name) = any($3))
     limit 1`,
    [options.reviewRunId, options.tenantId ?? null, allowed],
  );
  const row = rows[0];
  if (!row) {
    return undefined;
  }

  const eventRows = await query<EventRow>(
    `select review_run_id, status, payload_json, trigger_run_id, recorded_at
     from review_run_events where review_run_id = $1 order by recorded_at asc`,
    [row.id],
  );
  const events = eventRows.map(toReviewEvent);
  return toReviewRunRecord(row, events);
}

export async function getScenarioLineageReviewRunRecords(options: {
  reviewRunId: string;
  lineageKey: string;
  tenantId?: string;
  allowedFullNames?: string[] | null;
  limit?: number;
}): Promise<ReviewRunRecord[]> {
  if (!databaseConfigured()) {
    return [];
  }

  const allowed = options.allowedFullNames ?? null;
  const limit = normalizeReviewRunLimit(options.limit);
  const rows = await query<ReviewRunRow>(
    `with current_run as (
       select r.repository_id, pr.pr_number
       from review_runs r
         join repositories repo on repo.id = r.repository_id
       left join pull_requests pr on pr.id = r.pull_request_id
       where r.id = $1
         and ($3::uuid is null or r.tenant_id = $3)
         and ($4::text[] is null or lower(repo.owner || '/' || repo.name) = any($4))
       limit 1
     ),
     normalized_run_ids as (
       select distinct s.review_run_id
       from current_run cr
         join scenario_lineages sl on sl.repository_id = cr.repository_id
          and sl.pr_number = cr.pr_number
          and sl.lineage_key = $2
         join scenarios s on s.lineage_id = sl.id
       union
       select distinct sim.review_run_id
       from current_run cr
         join scenario_lineages sl on sl.repository_id = cr.repository_id
          and sl.pr_number = cr.pr_number
          and sl.lineage_key = $2
         join simulations sim on sim.lineage_id = sl.id
     ),
     json_run_ids as (
       select r.id as review_run_id
       from current_run cr
         join review_runs r on r.repository_id = cr.repository_id
         left join pull_requests pr on pr.id = r.pull_request_id
       where pr.pr_number is not distinct from cr.pr_number
         and exists (
           select 1
           from jsonb_array_elements(coalesce(r.result_json#>'{simulation,scenarios}', '[]'::jsonb)) scenario
           where scenario->>'lineage_key' = $2
         )
     ),
     lineage_run_ids as (
       select review_run_id from normalized_run_ids
       union
       select review_run_id from json_run_ids
     )
     ${reviewRunSelectSql("r.result_json", "r.error")}
       join lineage_run_ids lr on lr.review_run_id = r.id
     where ($3::uuid is null or r.tenant_id = $3)
     order by r.created_at desc, r.id desc
     limit $5`,
    [options.reviewRunId, options.lineageKey, options.tenantId ?? null, allowed, limit],
  );

  return rows.map((row) => toReviewRunRecord(row, []));
}

export async function getReviewFindingRecords(options: {
  tenantId?: string;
  allowedFullNames?: string[] | null;
  project?: string;
  reviewRunId?: string;
} = {}): Promise<FindingRecord[]> {
  if (!databaseConfigured()) {
    return [];
  }

  const allowed = options.allowedFullNames ?? null;
  const rows = await query<FindingRow>(
    `select
        f.id, f.review_run_id, f.fingerprint, f.file_path, f.line_number, f.severity,
        f.category, f.body, f.github_comment_id, f.created_at,
        repo.owner, repo.name,
        pr.pr_number, pr.title as pr_title, pr.html_url as pr_html_url
     from review_findings f
       join review_runs r on r.id = f.review_run_id
       join repositories repo on repo.id = r.repository_id
       left join pull_requests pr on pr.id = r.pull_request_id
     where ($1::uuid is null or r.tenant_id = $1)
       and ($2::text[] is null or lower(repo.owner || '/' || repo.name) = any($2))
       and ($3::text is null or lower(repo.owner || '/' || repo.name) = lower($3))
       and ($4::uuid is null or f.review_run_id = $4)
     order by f.created_at desc
     limit 300`,
    [options.tenantId ?? null, allowed, options.project ?? null, options.reviewRunId ?? null],
  );

  return rows.map((row) => ({
    id: row.id,
    review_run_id: row.review_run_id,
    fingerprint: row.fingerprint,
    file_path: row.file_path ?? undefined,
    line_number: row.line_number ?? undefined,
    severity: row.severity,
    category: row.category,
    body: row.body,
    github_comment_id: row.github_comment_id ?? undefined,
    created_at: toIso(row.created_at),
    repository: `${row.owner}/${row.name}`,
    pull_request: row.pr_number ?? undefined,
    pull_request_title: row.pr_title ?? undefined,
    pull_request_url: row.pr_html_url ?? undefined,
  }));
}

export async function hasInstallationForAccounts(accountIds: number[]): Promise<boolean> {
  if (!databaseConfigured() || accountIds.length === 0) {
    return false;
  }
  const row = await queryOne(
    `select 1 from installations i
       join tenants t on t.id = i.tenant_id
     where t.github_account_id = any($1) and i.suspended_at is null
     limit 1`,
    [accountIds],
  );
  return Boolean(row);
}

export interface OpenRouterIntegration {
  configured: boolean;
  last4?: string;
  source?: string;
  label?: string;
  connected_at?: string;
}

// BYOK native-provider key status (OpenAI / Anthropic) surfaced to the dashboard. Manual entry only
// (no OAuth), so there is no source/label — just presence, the last 4 chars, and when it was connected.
// NEVER carries the full key.
export interface ProviderKeyIntegration {
  configured: boolean;
  last4?: string;
  connected_at?: string;
}

/** The two BYOK native providers a tenant can bring a key for, mapped to their tenant_integrations
 *  columns. The column names are a fixed whitelist (never user input) so they are safe to interpolate. */
export type NativeProvider = "openai" | "anthropic";
const PROVIDER_KEY_COLUMNS: Record<NativeProvider, { key: string; at: string }> = {
  openai: { key: "openai_api_key", at: "openai_connected_at" },
  anthropic: { key: "anthropic_api_key", at: "anthropic_connected_at" },
};

// Codex harness (BYOH) status surfaced to the dashboard. NEVER carries the auth.json blob or any
// part of it — only whether one is configured and when it was connected.
interface CodexHarnessIntegration {
  configured: boolean;
  connected_at?: string;
  reconnect_required?: boolean;
}

export interface UserIntegrations {
  openrouter: OpenRouterIntegration;
  // BYOK native-provider keys (tenant-scoped). openai is wired into the runtime; anthropic is stored/
  // surfaced only for now (see 0016_byok_provider_keys.sql).
  openai: ProviderKeyIntegration;
  anthropic: ProviderKeyIntegration;
  codex_harness: CodexHarnessIntegration;
  // The user's pinned own-harness model preference (validated HARNESS_MODELS value or null = Codex default).
  codex_harness_model: HarnessModel | null;
}

/**
 * Legacy viewer-scoped integrations read, kept working for deploy skew. OpenRouter now lives on the
 * viewer's PERSONAL tenant (tenant_integrations, resolved via tenants.github_account_id = githubUserId);
 * the Codex harness (blob presence + model preference) stays INDIVIDUAL on user_integrations. The query
 * starts from the user id so it returns a single row whether or not either row exists.
 */
export async function getUserIntegrations(githubUserId: number): Promise<UserIntegrations> {
  if (!databaseConfigured()) {
    return {
      openrouter: { configured: false },
      openai: { configured: false },
      anthropic: { configured: false },
      codex_harness: { configured: false },
      codex_harness_model: null,
    };
  }
  // codex_harness_auth is projected as a boolean presence flag only — the encrypted blob is never
  // pulled into the app on the dashboard read path, so it cannot leak into a GET response.
  const row = await queryOne<{
    openrouter_api_key: string | null;
    openrouter_key_source: string | null;
    openrouter_key_label: string | null;
    openrouter_connected_at: Date | string | null;
    openai_api_key: string | null;
    openai_connected_at: Date | string | null;
    anthropic_api_key: string | null;
    anthropic_connected_at: Date | string | null;
    codex_harness_configured: boolean;
    codex_harness_connected_at: Date | string | null;
    codex_harness_reconnect_required: boolean;
    codex_harness_model: string | null;
  }>(
    `select ti.openrouter_api_key, ti.openrouter_key_source, ti.openrouter_key_label, ti.openrouter_connected_at,
            ti.openai_api_key, ti.openai_connected_at, ti.anthropic_api_key, ti.anthropic_connected_at,
            (ui.codex_harness_auth is not null) as codex_harness_configured,
            ui.codex_harness_connected_at, ui.codex_harness_model,
            exists (
              select 1
                from pull_requests pr
                join review_runs r on r.pull_request_id = pr.id
                join review_run_events e on e.review_run_id = r.id
                left join review_run_billing b on b.review_run_id = r.id
               where ui.codex_harness_auth is not null
                 and ui.github_login is not null
                 and lower(pr.author_login) = lower(ui.github_login)
                 and e.status = 'runtime_review_completed'
                 and (
                   (
                     e.payload_json->>'codex_harness_reconnect_required' = 'true'
                     and e.payload_json->>'codex_harness_connected_at_ms' =
                         floor(extract(epoch from ui.codex_harness_connected_at) * 1000)::bigint::text
                   )
                   or (
                     coalesce(e.payload_json ? 'codex_harness_reconnect_required', false) = false
                     and e.recorded_at > coalesce(ui.codex_harness_connected_at, '-infinity'::timestamptz)
                     and b.key_source = 'harness'
                     and left(lower(coalesce(e.payload_json->>'error', '')), 8000) ~
                         '(codex_login::auth::manager: failed to refresh token:.*(because you have since logged out or signed in to another account|invalid_grant|refresh token was already used)|auth error code:[[:space:]]*token_expired|provided authentication token is expired[.] please try signing in again)'
                   )
                 )
            ) as codex_harness_reconnect_required
       from (select $1::bigint as uid) x
       left join tenants t on t.github_account_id = x.uid
       left join tenant_integrations ti on ti.tenant_id = t.id
       left join user_integrations ui on ui.github_user_id = x.uid`,
    [githubUserId],
  );
  return {
    openrouter: openRouterInfo(decryptKey(row?.openrouter_api_key), {
      source: row?.openrouter_key_source ?? null,
      label: row?.openrouter_key_label ?? null,
      connectedAt: row?.openrouter_connected_at ?? null,
    }),
    openai: providerKeyInfo(decryptKey(row?.openai_api_key), row?.openai_connected_at ?? null),
    anthropic: providerKeyInfo(decryptKey(row?.anthropic_api_key), row?.anthropic_connected_at ?? null),
    codex_harness: codexHarnessInfo(
      row?.codex_harness_configured ?? false,
      row?.codex_harness_connected_at ?? null,
      row?.codex_harness_reconnect_required ?? false,
    ),
    codex_harness_model: coerceStoredHarnessModel(row?.codex_harness_model),
  };
}

export interface SaveUserHarnessInput {
  // The Codex auth.json blob (encrypted at rest). An empty string disconnects (clears the blob and
  // connected_at); undefined leaves it unchanged. Validated by the caller before it reaches here.
  codexHarnessAuth?: string;
  // The pinned harness model. `codexHarnessModelProvided` distinguishes an omitted field (leave
  // unchanged) from an explicit null (reset to the Codex default). Validated by the caller.
  codexHarnessModel?: HarnessModel | null;
  codexHarnessModelProvided?: boolean;
  // Stamped from the dashboard session on every save when provided, so run-time author-login
  // resolution can join pull_requests.author_login to user_integrations.github_login.
  githubLogin?: string;
}

/**
 * Persist the INDIVIDUAL (author-scoped) Codex harness fields on user_integrations. OpenRouter keys are
 * no longer written here — they are tenant-scoped (see saveTenantOpenRouterIntegration). A provided
 * field (even empty string / explicit null -> cleared) is written; an omitted field is left unchanged.
 */
export async function saveUserHarnessIntegration(githubUserId: number, input: SaveUserHarnessInput): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  // Codex harness: a provided empty string disconnects (null -> clears connected_at); undefined
  // leaves the stored blob untouched. The blob is encrypted with the same SECRETS_ENCRYPTION_KEY
  // path as openrouter keys. github_login is stamped on every save when provided.
  const codexHarnessAuth = normalizeKey(input.codexHarnessAuth);
  const codexHarnessProvided = input.codexHarnessAuth !== undefined;
  const codexHarnessModel = input.codexHarnessModel ?? null;
  const codexHarnessModelProvided = input.codexHarnessModelProvided ?? false;
  const githubLogin = normalizeKey(input.githubLogin);
  const githubLoginProvided = input.githubLogin !== undefined;
  await query(
    // Explicit ::text / ::boolean casts: a bare parameter used only inside a
    // CASE ... IS NOT NULL check is type-ambiguous to Postgres ("could not
    // determine data type of parameter $2"). Casting pins every param's type.
    `insert into user_integrations
       (github_user_id, user_id, codex_harness_auth, codex_harness_connected_at,
        codex_harness_model, github_login, updated_at)
     values (
       $1,
       (select user_id from user_identities where provider = 'github' and provider_user_id = $1::bigint::text),
       $2::text,
       case when $2::text is not null then now() else null end,
       $4::text,
       $6::text,
       now()
     )
     on conflict (github_user_id) do update set
        user_id = coalesce(excluded.user_id, user_integrations.user_id),
        codex_harness_auth = case when $3::boolean then $2::text else user_integrations.codex_harness_auth end,
        codex_harness_connected_at =
          case when $3::boolean then (case when $2::text is not null then now() else null end)
               else user_integrations.codex_harness_connected_at end,
        codex_harness_model = case when $5::boolean then $4::text else user_integrations.codex_harness_model end,
        github_login = case when $7::boolean then $6::text else user_integrations.github_login end,
        updated_at = now()`,
    [
      githubUserId,
      encryptKey(codexHarnessAuth),
      codexHarnessProvided,
      codexHarnessModel,
      codexHarnessModelProvided,
      githubLogin,
      githubLoginProvided,
    ],
  );
}

/* --------------------------------------------- tenant membership + integrations --- */

export type TenantRole = "admin" | "member";

export interface GithubTenantAdminRefreshRequirement {
  account?: { id: number; login: string; type: string };
}

/** A tenant a viewer belongs to, as surfaced to the dashboard. Personal tenants sort first. */
export interface ViewerTenant {
  tenant_id: string;
  login: string;
  type: string; // 'User' | 'Organization'
  role: TenantRole;
  clerk_organization_id?: string;
}

interface ClerkOrgMembership {
  organizationId: string;
  name: string;
  role: TenantRole;
}

export interface ClerkMembershipSyncResult {
  linkedTenantIds: string[];
  ignoredOrganizations: { organizationId: string; name: string }[];
}

export interface ClerkMembershipSyncInput {
  clerkUserId: string;
  githubUserId: number;
  githubLogin: string;
  userId: string;
  memberships: ClerkOrgMembership[];
}

/**
 * Reconcile Clerk memberships only for explicitly linked Jina tenants.
 *
 * Unlinked Clerk organizations are deliberately ignored. Auto-creating a Jina
 * tenant here would duplicate live workspaces during directory migration and
 * would give arbitrary pre-existing Clerk organizations a new data boundary.
 */
export async function syncClerkTenantMemberships(
  input: ClerkMembershipSyncInput,
): Promise<ClerkMembershipSyncResult> {
  if (!databaseConfigured()) return { linkedTenantIds: [], ignoredOrganizations: [] };
  return withTransaction((client) => syncClerkTenantMembershipsWithClient(client, input));
}

export async function syncClerkTenantMembershipsWithClient(
  client: Pick<pg.PoolClient, "query">,
  input: ClerkMembershipSyncInput,
): Promise<ClerkMembershipSyncResult> {
    const organizationIds = input.memberships.map((membership) => membership.organizationId);
    const linked = organizationIds.length > 0
      ? await client.query<{ id: string; clerk_organization_id: string }>(
          `select id, clerk_organization_id
             from tenants
            where clerk_organization_id = any($1::text[])
              and merged_into_tenant_id is null`,
          [organizationIds],
        )
      : { rows: [] as { id: string; clerk_organization_id: string }[] };
    const tenantByOrganizationId = new Map(
      linked.rows.map((tenant) => [tenant.clerk_organization_id, tenant.id]),
    );
    const keepTenantIds: string[] = [];
    const ignoredOrganizations: { organizationId: string; name: string }[] = [];
    for (const membership of input.memberships) {
      const tenantId = tenantByOrganizationId.get(membership.organizationId);
      if (!tenantId) {
        ignoredOrganizations.push({
          organizationId: membership.organizationId,
          name: membership.name,
        });
        continue;
      }
      keepTenantIds.push(tenantId);
      await client.query(
        `insert into clerk_tenant_memberships
           (tenant_id, user_id, clerk_user_id, github_user_id, github_login, role, synced_at)
         values ($1, $2::uuid, $3, $4, $5, $6, now())
         on conflict (tenant_id, clerk_user_id) do update set
           user_id = excluded.user_id,
           github_user_id = excluded.github_user_id,
           github_login = excluded.github_login,
           role = excluded.role,
           synced_at = now()`,
        [tenantId, input.userId, input.clerkUserId, input.githubUserId, input.githubLogin, membership.role],
      );
    }
    await client.query(
      `delete from clerk_tenant_memberships
        where clerk_user_id = $1
          and not (tenant_id = any($2::uuid[]))`,
      [input.clerkUserId, keepTenantIds],
    );
    return { linkedTenantIds: keepTenantIds, ignoredOrganizations };
}

export interface TenantGithubConnection {
  installation_id: number;
  login: string;
  type: string;
  repository_count: number;
  status: "active" | "suspended" | "deleted";
}

/**
 * A GitHub org membership as returned by GET /user/memberships/orgs. `role` is GitHub's membership
 * role ('admin' for org owners, 'member' otherwise); `organizationId` is the org account id we match
 * against tenants.github_account_id.
 */
export interface ViewerOrgMembership {
  organizationId: number;
  login: string;
  role: TenantRole;
}

/** A desired tenant_members row computed by the pure membership planner. */
export interface DesiredMembership {
  tenantId: string;
  githubUserId: number;
  githubLogin: string;
  role: TenantRole;
}

/**
 * Pure membership planner (exported for unit testing without a database): given the viewer, their
 * personal tenant id (if any), and the set of {tenantId, role} pairs their fetched org memberships
 * resolved to, produce the exact desired tenant_members rows. The viewer is always an 'admin' of their
 * OWN personal tenant when one exists; org rows carry the GitHub membership role. Duplicate tenants
 * (a personal tenant that also appears as an org — impossible in practice, but guarded) keep the
 * personal 'admin' row. This is the set the sync upserts; any existing row for this user NOT in the
 * returned set is stale and gets deleted.
 */
export function planTenantMemberships(input: {
  githubUserId: number;
  githubLogin: string;
  personalTenantId?: string;
  orgTenants: { tenantId: string; role: TenantRole }[];
}): DesiredMembership[] {
  const byTenant = new Map<string, DesiredMembership>();
  for (const org of input.orgTenants) {
    byTenant.set(org.tenantId, {
      tenantId: org.tenantId,
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      role: org.role,
    });
  }
  // The viewer's own personal tenant always resolves to 'admin' and wins over any org-derived row.
  if (input.personalTenantId) {
    byTenant.set(input.personalTenantId, {
      tenantId: input.personalTenantId,
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      role: "admin",
    });
  }
  return [...byTenant.values()];
}

/**
 * Sync a viewer's tenant memberships from their own OAuth token's org list. Resolves each active org
 * membership to a tenant (only orgs we already know as tenants, matched by github_account_id), adds an
 * 'admin' self-membership for the viewer's personal tenant when one exists, upserts the desired rows,
 * and deletes this user's stale rows. Runs in one transaction. Called at login; a failure is the
 * caller's to swallow (stale membership beats a broken login).
 */
export async function syncTenantMemberships(
  githubUserId: number,
  githubLogin: string,
  orgs: ViewerOrgMembership[],
  userId?: string,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await withTransaction(async (client) => {
    // Resolve fetched org ids -> known tenant ids (unknown orgs are simply skipped — we only track
    // tenants that have onboarded). role travels with each match.
    const orgIds = orgs.map((org) => org.organizationId);
    const roleByOrgId = new Map(orgs.map((org) => [org.organizationId, org.role]));
    const orgTenants: { tenantId: string; role: TenantRole }[] = [];
    if (orgIds.length > 0) {
      const rows = await client.query<{ id: string; github_account_id: number }>(
        `select id, github_account_id
           from tenants
          where github_account_id = any($1)
            and merged_into_tenant_id is null`,
        [orgIds],
      );
      for (const row of rows.rows) {
        const role = roleByOrgId.get(Number(row.github_account_id)) ?? "member";
        orgTenants.push({ tenantId: row.id, role });
      }
    }
    const personal = await client.query<{ id: string }>(
      `select id
         from tenants
        where github_account_id = $1
          and merged_into_tenant_id is null`,
      [githubUserId],
    );
    const desired = planTenantMemberships({
      githubUserId,
      githubLogin,
      personalTenantId: personal.rows[0]?.id,
      orgTenants,
    });

    for (const membership of desired) {
      await client.query(
        `insert into tenant_members (tenant_id, github_user_id, github_login, user_id, role, synced_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (tenant_id, github_user_id) do update set
            github_login = excluded.github_login,
            user_id = coalesce(excluded.user_id, tenant_members.user_id),
            role = excluded.role,
            synced_at = now()`,
        [membership.tenantId, membership.githubUserId, membership.githubLogin, userId ?? null, membership.role],
      );
    }
    // Delete this user's stale OAUTH rows (memberships no longer in the fetched set — e.g. they left an
    // org). Installer-derived rows are NEVER stale-deleted here: /user/orgs cannot see orgs that restrict
    // OAuth apps, so the fetched set routinely omits orgs the user demonstrably administers (they
    // installed the App there) — deleting those rows would hide the org switcher from its own installer.
    const keepTenantIds = desired.map((membership) => membership.tenantId);
    await client.query(
      `delete from tenant_members
        where github_user_id = $1 and source = 'oauth' and not (tenant_id = any($2::uuid[]))`,
      [githubUserId, keepTenantIds],
    );
  });
}

/** Upsert the App INSTALLER's admin membership on an org tenant (source 'installer'). The webhook sender
 *  who installs on an org is definitionally an org admin, and this path works even when the org's OAuth
 *  App restrictions hide the org from /user/orgs — the gap that left installing admins without the org
 *  switcher (and subscribing on their personal tenant). */
async function upsertInstallerMembership(
  client: pg.PoolClient,
  tenantId: string,
  installer: { id: number; login: string },
): Promise<void> {
  await client.query(
    `insert into tenant_members (tenant_id, github_user_id, github_login, role, source, synced_at)
     values ($1, $2, $3, 'admin', 'installer', now())
     on conflict (tenant_id, github_user_id) do update set
        github_login = excluded.github_login, role = 'admin', source = 'installer', synced_at = now()`,
    [tenantId, installer.id, installer.login],
  );
}

/**
 * Order for the tenant switcher (exported + pure for testing): personal ('User') tenants first, then
 * organizations, each group alphabetical by login (case-insensitive). Returns a new sorted array.
 */
export function sortViewerTenants(tenants: ViewerTenant[]): ViewerTenant[] {
  return [...tenants].sort((a, b) => {
    const aPersonal = a.type === "User" ? 0 : 1;
    const bPersonal = b.type === "User" ? 0 : 1;
    if (aPersonal !== bPersonal) {
      return aPersonal - bPersonal;
    }
    return a.login.toLowerCase().localeCompare(b.login.toLowerCase());
  });
}

/**
 * Create a Jina-owned organization. GitHub remains an integration: the
 * organization starts without a GitHub account and installations are attached
 * separately through connectGithubInstallationToTenant.
 */
export async function createJinaOrganization(input: {
  name: string;
  creatorGithubUserId: number;
  creatorGithubLogin: string;
  creatorUserId?: string;
}): Promise<ViewerTenant> {
  if (!databaseConfigured()) {
    throw new Error("database is not configured");
  }
  return withTransaction(async (client) => {
    const tenant = await client.query<{ id: string; name: string }>(
      `insert into tenants (kind, name)
       values ('team', $1)
       returning id, name`,
      [input.name],
    );
    const row = tenant.rows[0];
    await client.query(
      `insert into tenant_members
         (tenant_id, github_user_id, github_login, user_id, role, source, synced_at)
       values ($1, $2, $3, $4, 'admin', 'native', now())`,
      [
        row.id,
        input.creatorGithubUserId,
        input.creatorGithubLogin,
        input.creatorUserId ?? null,
      ],
    );
    return {
      tenant_id: row.id,
      login: row.name,
      type: "Organization",
      role: "admin",
    };
  });
}

/** Update the human-readable name of a Jina organization without changing its tenant identity. */
export async function updateJinaOrganizationName(
  tenantId: string,
  name: string,
): Promise<ViewerTenant | undefined> {
  if (!databaseConfigured()) {
    throw new Error("database is not configured");
  }
  const row = await queryOne<{ id: string; name: string }>(
    `update tenants
        set name = $2
      where id = $1
        and merged_into_tenant_id is null
        and coalesce(
          kind,
          case when lower(coalesce(github_account_type, '')) = 'user' then 'personal' else 'team' end
        ) = 'team'
      returning id, name`,
    [tenantId, name],
  );
  return row
    ? {
        tenant_id: row.id,
        login: row.name,
        type: "Organization",
        role: "admin",
      }
    : undefined;
}

export type MembershipAuthority = "legacy" | "hybrid" | "clerk";

/** List the tenants a viewer belongs to, personal tenant(s) first then orgs, each alphabetical. */
export async function listViewerTenants(
  githubUserId: number,
  userId?: string,
  authority: MembershipAuthority = "legacy",
): Promise<ViewerTenant[]> {
  if (!databaseConfigured()) {
    return [];
  }
  const rows = await query<{
    tenant_id: string;
    login: string;
    type: string;
    role: string;
    clerk_organization_id: string | null;
  }>(
    `with viewer_memberships as (
       select m.tenant_id, m.role
         from tenant_members m
        where $3::text in ('legacy', 'hybrid')
          and (
            ($2::uuid is not null and m.user_id = $2::uuid)
            or (($2::uuid is null or m.user_id is null) and m.github_user_id = $1)
          )
       union all
       select m.tenant_id, m.role
         from clerk_tenant_memberships m
        where $3::text in ('clerk', 'hybrid')
          and $2::uuid is not null
          and m.user_id = $2::uuid
       union all
       select t.id, 'admin'::text
         from tenants t
        where coalesce(
                t.kind,
                case when lower(coalesce(t.github_account_type, '')) = 'user' then 'personal' else 'team' end
              ) = 'personal'
          and (
            ($2::uuid is not null and t.personal_owner_user_id = $2::uuid)
            or ($2::uuid is null and t.github_account_id = $1)
          )
     )
     select
       m.tenant_id,
       coalesce(nullif(btrim(t.name), ''), nullif(btrim(t.github_account_login), ''), t.id::text) as login,
       case
         when coalesce(t.kind, case when lower(coalesce(t.github_account_type, '')) = 'user' then 'personal' else 'team' end) = 'personal'
           then 'User'
         else 'Organization'
       end as type,
       case when bool_or(m.role = 'admin') then 'admin' else 'member' end as role,
       t.clerk_organization_id
       from viewer_memberships m
       join tenants t on t.id = m.tenant_id
      where t.merged_into_tenant_id is null
      group by m.tenant_id, t.id, t.name, t.github_account_login, t.github_account_type,
               t.kind, t.clerk_organization_id`,
    [githubUserId, userId ?? null, authority],
  );
  return sortViewerTenants(
    rows.map((row) => ({
      tenant_id: row.tenant_id,
      login: row.login,
      type: row.type,
      role: row.role === "admin" ? "admin" : "member",
      ...(row.clerk_organization_id ? { clerk_organization_id: row.clerk_organization_id } : {}),
    })),
  );
}

/** GitHub organizations/accounts connected to one Jina tenant. */
export async function listTenantGithubConnections(tenantId: string): Promise<TenantGithubConnection[]> {
  if (!databaseConfigured()) return [];
  return query<TenantGithubConnection>(
    `select
       installation.github_installation_id as installation_id,
       coalesce(
         nullif(btrim(installation.github_account_login), ''),
         'GitHub installation ' || installation.github_installation_id::text
       ) as login,
       coalesce(nullif(btrim(installation.github_account_type), ''), 'Organization') as type,
       count(repository.id) filter (where repository.enabled = true)::int as repository_count,
       case
         when installation.deleted_at is not null then 'deleted'
         when installation.suspended_at is not null then 'suspended'
         else 'active'
       end as status
     from installations installation
     left join repositories repository on repository.installation_id = installation.id
    where installation.tenant_id = $1
    group by installation.id
    order by
      case
        when installation.deleted_at is not null then 2
        when installation.suspended_at is not null then 1
        else 0
      end,
      lower(coalesce(installation.github_account_login, '')),
      installation.github_installation_id`,
    [tenantId],
  );
}

/** The viewer's role on a tenant, or undefined when they are not a member. Basis for requireTenantAccess. */
export async function getTenantMembershipRole(
  githubUserId: number,
  tenantId: string,
  userId?: string,
  authority: MembershipAuthority = "legacy",
): Promise<TenantRole | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  const row = await queryOne<{ role: string }>(
    `with viewer_memberships as (
       select member.role
         from tenant_members member
        where $4::text in ('legacy', 'hybrid')
          and member.tenant_id = $2
          and (
            ($3::uuid is not null and member.user_id = $3::uuid)
            or (($3::uuid is null or member.user_id is null) and member.github_user_id = $1)
          )
       union all
       select member.role
         from clerk_tenant_memberships member
        where $4::text in ('clerk', 'hybrid')
          and member.tenant_id = $2
          and $3::uuid is not null
          and member.user_id = $3::uuid
     )
     select case when bool_or(viewer_memberships.role = 'admin') then 'admin' else 'member' end as role
       from viewer_memberships
       join tenants tenant on tenant.id = $2
      where tenant.merged_into_tenant_id is null
      having count(*) > 0`,
    [githubUserId, tenantId, userId ?? null, authority],
  );
  if (row) {
    return row.role === "admin" ? "admin" : "member";
  }
  // No membership row: a user is ALWAYS implicitly admin of their OWN personal tenant — the tenant whose
  // github_account_id is their user id. This mirrors the legacy personal routes ("the viewer is
  // implicitly admin of their own personal tenant") and lets the tenant-scoped billing routes serve a
  // personal tenant that predates membership backfill, so switching every page to tenant-scoped access
  // (no more legacy personal fallback) can't 403 an existing single-tenant viewer.
  const own = await queryOne<{ id: string }>(
    `select id
      from tenants
      where id = $1
        and merged_into_tenant_id is null
        and (
          ($3::uuid is not null and personal_owner_user_id = $3::uuid)
          or (
            personal_owner_user_id is null
            and github_account_id = $2
            and github_account_type = 'User'
          )
        )`,
    [tenantId, githubUserId, userId ?? null],
  );
  return own ? "admin" : undefined;
}

/**
 * GitHub-derived admin grants expire after five minutes. Personal ownership
 * and future Jina-native memberships do not depend on GitHub and therefore do
 * not require this refresh.
 */
export async function getGithubTenantAdminRefreshRequirement(
  githubUserId: number,
  tenantId: string,
  userId?: string,
): Promise<GithubTenantAdminRefreshRequirement | undefined> {
  if (!databaseConfigured()) return undefined;
  const row = await queryOne<{
    refresh_required: boolean;
    github_account_id: number | null;
    github_account_login: string | null;
    github_account_type: string | null;
  }>(
    `select
       (
         member.role = 'admin'
         and member.source in ('oauth', 'installer')
         and member.synced_at < now() - interval '5 minutes'
         and not (
           coalesce(tenant.kind, '') = 'personal'
           and $3::uuid is not null
           and tenant.personal_owner_user_id = $3::uuid
         )
       ) as refresh_required,
       tenant.github_account_id,
       tenant.github_account_login,
       tenant.github_account_type
       from tenants tenant
       join tenant_members member on member.tenant_id = tenant.id
      where tenant.id = $2
        and tenant.merged_into_tenant_id is null
        and (
          ($3::uuid is not null and member.user_id = $3::uuid)
          or (($3::uuid is null or member.user_id is null) and member.github_user_id = $1)
        )
      limit 1`,
    [githubUserId, tenantId, userId ?? null],
  );
  if (!row?.refresh_required) return undefined;
  const account = row.github_account_id
    && row.github_account_login
    && row.github_account_type
    ? {
        id: Number(row.github_account_id),
        login: row.github_account_login,
        type: row.github_account_type,
      }
    : undefined;
  return { account };
}

export async function refreshGithubTenantAdminMembership(
  githubUserId: number,
  tenantId: string,
  userId?: string,
): Promise<void> {
  if (!databaseConfigured()) return;
  await query(
    `update tenant_members
        set synced_at = now()
      where tenant_id = $2
        and role = 'admin'
        and source in ('oauth', 'installer')
        and (
          ($3::uuid is not null and user_id = $3::uuid)
          or (($3::uuid is null or user_id is null) and github_user_id = $1)
        )`,
    [githubUserId, tenantId, userId ?? null],
  );
}

/** Stable Jina workspace identity used to name and tag its Autumn customer. */
export async function getTenantBillingIdentity(
  tenantId: string,
): Promise<{ name: string; kind: "personal" | "team" } | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  const row = await queryOne<{ name: string; kind: "personal" | "team" }>(
    `select coalesce(name, github_account_login, 'Jina workspace') as name,
            coalesce(
              kind,
              case when lower(coalesce(github_account_type, '')) = 'user' then 'personal' else 'team' end
            ) as kind
       from tenants where id = $1`,
    [tenantId],
  );
  return row;
}

/**
 * Installer authority captured from GitHub's signed installation webhook.
 * This is the durable fallback for organizations that restrict OAuth Apps and
 * hide otherwise-valid admin membership from the OAuth API.
 */
export async function isGithubInstallationInstaller(
  githubInstallationId: number,
  githubUserId: number,
): Promise<boolean> {
  if (!databaseConfigured()) return false;
  const row = await queryOne<{ allowed: boolean }>(
    `select exists (
       select 1
         from installations
        where github_installation_id = $1
          and installed_by_github_user_id = $2
          and installer_verified_at >= now() - interval '5 minutes'
          and suspended_at is null
          and deleted_at is null
     ) as allowed`,
    [githubInstallationId, githubUserId],
  );
  return row?.allowed === true;
}

export async function isGithubInstallationRecorded(githubInstallationId: number): Promise<boolean> {
  if (!databaseConfigured()) return false;
  const row = await queryOne<{ recorded: boolean }>(
    `select exists (
       select 1 from installations where github_installation_id = $1
     ) as recorded`,
    [githubInstallationId],
  );
  return row?.recorded === true;
}

export interface SaveTenantOpenRouterInput {
  // undefined leaves the stored key unchanged; empty string clears it; a value sets it.
  openrouter?: string;
  openrouterSource?: string; // 'oauth' | 'manual' — applied only when a non-empty key is saved.
  openrouterLabel?: string;
  // Stamped whenever the key field is written, recording the admin who connected it.
  configuredByUserId?: number;
  configuredByLogin?: string;
}

/**
 * Persist the tenant-scoped OpenRouter key. Saving a key stamps source/label/connected_at and the
 * configured_by admin; clearing it (empty string) wipes them. An omitted key field leaves the stored
 * key untouched (the tenant_integrations row is still ensured). The key is encrypted at rest.
 */
export async function saveTenantOpenRouterIntegration(tenantId: string, input: SaveTenantOpenRouterInput): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  const openrouterKey = normalizeKey(input.openrouter);
  const openrouterSource = openrouterKey === null ? null : input.openrouterSource ?? null;
  const openrouterLabel = openrouterKey === null ? null : normalizeKey(input.openrouterLabel);
  const keyProvided = input.openrouter !== undefined;
  const configuredByUserId = openrouterKey === null ? null : input.configuredByUserId ?? null;
  const configuredByLogin = openrouterKey === null ? null : normalizeKey(input.configuredByLogin);
  await query(
    `insert into tenant_integrations
       (tenant_id, openrouter_api_key, openrouter_key_source, openrouter_key_label, openrouter_connected_at,
        configured_by_user_id, configured_by_login, updated_at)
     values ($1, $2, $3, $4, case when $2 is not null then now() else null end, $6, $7, now())
     on conflict (tenant_id) do update set
        openrouter_api_key = case when $5 then $2 else tenant_integrations.openrouter_api_key end,
        openrouter_key_source = case when $5 then $3 else tenant_integrations.openrouter_key_source end,
        openrouter_key_label = case when $5 then $4 else tenant_integrations.openrouter_key_label end,
        openrouter_connected_at =
          case when $5 then (case when $2 is not null then now() else null end)
               else tenant_integrations.openrouter_connected_at end,
        configured_by_user_id = case when $5 then $6 else tenant_integrations.configured_by_user_id end,
        configured_by_login = case when $5 then $7 else tenant_integrations.configured_by_login end,
        updated_at = now()`,
    [
      tenantId,
      encryptKey(openrouterKey),
      openrouterSource,
      openrouterLabel,
      keyProvided,
      configuredByUserId,
      configuredByLogin,
    ],
  );
}

/** All tenant-scoped integration statuses for the dashboard: the OpenRouter key plus the BYOK native
 *  OpenAI/Anthropic keys. Never returns any full key — only presence, last4, and connected_at. */
export async function getTenantIntegrations(
  tenantId: string,
): Promise<{ openrouter: OpenRouterIntegration; openai: ProviderKeyIntegration; anthropic: ProviderKeyIntegration }> {
  if (!databaseConfigured()) {
    return { openrouter: { configured: false }, openai: { configured: false }, anthropic: { configured: false } };
  }
  const row = await queryOne<{
    openrouter_api_key: string | null;
    openrouter_key_source: string | null;
    openrouter_key_label: string | null;
    openrouter_connected_at: Date | string | null;
    openai_api_key: string | null;
    openai_connected_at: Date | string | null;
    anthropic_api_key: string | null;
    anthropic_connected_at: Date | string | null;
  }>(
    `select openrouter_api_key, openrouter_key_source, openrouter_key_label, openrouter_connected_at,
            openai_api_key, openai_connected_at, anthropic_api_key, anthropic_connected_at
       from tenant_integrations where tenant_id = $1`,
    [tenantId],
  );
  return {
    openrouter: openRouterInfo(decryptKey(row?.openrouter_api_key), {
      source: row?.openrouter_key_source ?? null,
      label: row?.openrouter_key_label ?? null,
      connectedAt: row?.openrouter_connected_at ?? null,
    }),
    openai: providerKeyInfo(decryptKey(row?.openai_api_key), row?.openai_connected_at ?? null),
    anthropic: providerKeyInfo(decryptKey(row?.anthropic_api_key), row?.anthropic_connected_at ?? null),
  };
}

export interface SaveTenantProviderKeyInput {
  // undefined/empty clears the key; a non-empty value sets it. (The API route only calls this when the
  // field was actually present in the request, so an omitted field never reaches here.)
  key?: string;
  configuredByUserId?: number;
  configuredByLogin?: string;
}

/**
 * Persist a tenant-scoped BYOK native-provider key (OpenAI or Anthropic). Setting a key stamps
 * connected_at and the configured_by admin; clearing it (empty string) wipes the key + connected_at.
 * The key is encrypted at rest. The provider selects a fixed whitelisted column pair — never user input.
 */
export async function saveTenantProviderKey(
  tenantId: string,
  provider: NativeProvider,
  input: SaveTenantProviderKeyInput,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  const cols = PROVIDER_KEY_COLUMNS[provider];
  const key = normalizeKey(input.key);
  const configuredByUserId = key === null ? null : input.configuredByUserId ?? null;
  const configuredByLogin = key === null ? null : normalizeKey(input.configuredByLogin);
  await query(
    `insert into tenant_integrations
       (tenant_id, ${cols.key}, ${cols.at}, configured_by_user_id, configured_by_login, updated_at)
     values ($1, $2::text, case when $2::text is not null then now() else null end, $3, $4, now())
     on conflict (tenant_id) do update set
        ${cols.key} = $2::text,
        ${cols.at} = case when $2::text is not null then now() else null end,
        configured_by_user_id = case when $2::text is not null then $3 else tenant_integrations.configured_by_user_id end,
        configured_by_login = case when $2::text is not null then $4 else tenant_integrations.configured_by_login end,
        updated_at = now()`,
    [tenantId, encryptKey(key), configuredByUserId, configuredByLogin],
  );
}

/**
 * Resolve provider keys bound to a specific review run. This is the authoritative,
 * IDOR-safe path: the run row is the source of truth for which tenant/installation the
 * review belongs to, so a caller cannot ask for another tenant's keys by guessing ids.
 *
 * Two INDEPENDENT resolutions bound to the same run row:
 *  - openrouter: the TENANT's key, now stored on tenant_integrations keyed by the run's tenant_id.
 *    Org tenants are first-class (admins manage the key); personal tenants are unchanged in effect.
 *  - codex harness: the PR AUTHOR's harness (own-harness billing). The author login lives on
 *    pull_requests.author_login (joined via review_runs.pull_request_id); we match it
 *    case-insensitively to the github_login stamped on user_integrations. The harness owner login and
 *    the author's pinned harness model flow back so the worker and billing can use them.
 * Both joins are LEFT so a run resolves whichever credential exists independently of the other.
 */
export async function resolveIntegrationKeysForRun(reviewRunId: string): Promise<ResolvedIntegrationKeys> {
  if (!databaseConfigured()) {
    return {};
  }
  const row = await queryOne<IntegrationKeyRow & {
    planner_model: string | null;
    investigation_model: string | null;
    review_model: string | null;
    model_settings_snapshot: unknown;
  }>(
    `select ti.openrouter_api_key,
            ti.openai_api_key,
            tms.model_provider,
            tms.planner_model, tms.investigation_model, tms.review_model,
            r.model_settings_snapshot,
            ui_author.codex_harness_auth,
            ui_author.codex_harness_connected_at,
            ui_author.github_login as harness_owner_login,
            ui_author.codex_harness_model
       from review_runs r
       join tenants t on t.id = r.tenant_id
       left join tenant_integrations ti on ti.tenant_id = t.id
       left join tenant_model_settings tms on tms.tenant_id = t.id
       left join pull_requests pr on pr.id = r.pull_request_id
       left join user_integrations ui_author on lower(ui_author.github_login) = lower(pr.author_login)
      where r.id = $1`,
    [reviewRunId],
  );
  // The routing decision (model_provider + whole-run coverage) picks WHICH tenant BYOK key the worker uses;
  // the author harness (resolved separately) still overrides for the author's own PRs. Coverage prefers the
  // PREPARE-time snapshot — the model set the worker was actually given — over live settings, so a mid-run
  // settings edit can't flip the routing (runs prepared by an older API have no snapshot; fall back live).
  const coverageModels = parseModelSettingsSnapshot(row?.model_settings_snapshot) ?? row ?? {};
  return applyProviderPreference(
    decryptIntegrationRow(row),
    normalizeModelProvider(row?.model_provider),
    stageModelsAllOpenaiFamily(coverageModels),
  );
}

/** The TRUE platform default stage slugs (env override with code fallbacks mirroring trigger utils).
 *  Lives here (not model-settings.ts) because the routing coverage decision below needs it and
 *  model-settings.ts imports this module. */
export interface PlatformModelDefaults {
  planner: string;
  investigation: string;
  review: string;
  context?: string;
  mentalTrace: string;
}
export function platformModelDefaults(env: NodeJS.ProcessEnv = process.env): PlatformModelDefaults {
  const envSlug = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  };
  return {
    planner: envSlug(env.RUNTIME_PLANNER_MODEL) ?? "openai/gpt-5.6-sol",
    investigation: envSlug(env.RUNTIME_AGENT_MODEL) ?? "openai/gpt-5.6-luna",
    review: envSlug(env.REVIEW_CODEX_MODEL) ?? "openai/gpt-5.6-luna",
    context: envSlug(env.CONTEXT_CODEX_MODEL) ?? "openai/gpt-5.6-terra",
    // The worker's FOURTH stage. Not tenant-settable, but it still calls the gateway, so coverage must
    // include it — a non-OpenAI mental-trace default would 401 an "OpenAI-covered" run on every call.
    mentalTrace: envSlug(env.RUNTIME_MENTAL_TRACE_MODEL) ?? "openai/gpt-5.6-luna",
  };
}

/** Whether every EFFECTIVE stage model is OpenAI-family (openai/*). An unset stage resolves to the
 *  operator's platform default FIRST — the default is env-configurable and may be a non-OpenAI model, so
 *  null must never be assumed to be openai/*. The mental-trace stage has no tenant override and is
 *  checked from its default alone. */
export function stageModelsAllOpenaiFamily(
  models: { planner_model?: string | null; investigation_model?: string | null; review_model?: string | null },
  defaults: PlatformModelDefaults = platformModelDefaults(),
): boolean {
  // CASE-SENSITIVE on purpose: the capture proxy's native route matches `model.startsWith("openai/")`
  // exactly (openrouter-proxy.ts resolveRoute), so coverage must use the same test — a mixed-case slug
  // (e.g. "OpenAI/gpt-5.5", savable during a catalog outage) is NOT natively routable and must classify
  // as uncovered (whole-run managed) rather than "covered" while the proxy sends it to OpenRouter.
  const isOpenai = (value: string | null | undefined, fallback: string) =>
    (value?.trim() || fallback).startsWith("openai/");
  return (
    isOpenai(models.planner_model, defaults.planner) &&
    isOpenai(models.investigation_model, defaults.investigation) &&
    isOpenai(models.review_model, defaults.review) &&
    isOpenai(null, defaults.mentalTrace)
  );
}

/**
 * The SINGLE routing decision, shared by key resolution AND billing so they never disagree. Given the
 * tenant's provider selection, which company keys it holds, and whether every picked stage model is
 * OpenAI-family, returns which tenant COMPANY key(s) the run uses. WHOLE-RUN FALLBACK: if the keys can't
 * cover every picked model, the run uses NONE (Jina managed, billed as credits).
 *   - managed      -> always managed (no company key). This is the DEFAULT until a tenant selects.
 *   - codex | byok -> OpenRouter if present (any vendor, + native OpenAI for openai/*), else the OpenAI
 *                     key when every model is openai/*, else managed. ('codex' only differs from 'byok'
 *                     in the HARNESS gate — see harnessAllowed — since the harness rides per-author, not
 *                     per-key; PRs without a harness fall through BYOK > managed.)
 * hasUserKey for billing = openrouter || openai from this result.
 */
export function resolveRunKeys(
  provider: ModelProvider,
  hasOpenrouter: boolean,
  hasOpenai: boolean,
  allModelsOpenai: boolean,
): { openrouter: boolean; openai: boolean } {
  if (provider === "managed") {
    return { openrouter: false, openai: false };
  }
  if (hasOpenrouter) {
    return { openrouter: true, openai: hasOpenai };
  }
  if (hasOpenai && allModelsOpenai) {
    return { openrouter: false, openai: true };
  }
  return { openrouter: false, openai: false };
}

/** Whether the PR author's personal Codex harness may run this tenant's reviews: only when the tenant
 *  explicitly selected 'codex'. The managed default and 'byok' keep the harness OFF even when connected
 *  ("connect harness but click Jina managed"). */
export function harnessAllowed(provider: ModelProvider): boolean {
  return provider === "codex";
}

/** Narrow a resolved key set to the run's routing decision. `allModelsOpenai` drives the whole-run managed
 *  fallback (see resolveRunKeys). The harness fields are cleared when the selection disables the harness
 *  (harnessAllowed). Whitespace-only keys count as absent (Boolean(' ') is truthy) to match the worker's
 *  own `if (key)` check. */
export function applyProviderPreference(
  keys: ResolvedIntegrationKeys,
  provider: ModelProvider,
  allModelsOpenai: boolean,
): ResolvedIntegrationKeys {
  const use = resolveRunKeys(provider, Boolean(keys.openrouter?.trim()), Boolean(keys.openaiApiKey?.trim()), allModelsOpenai);
  const harness = harnessAllowed(provider);
  const { codexHarnessConnectedAtMs, ...baseKeys } = keys;
  return {
    ...baseKeys,
    openrouter: use.openrouter ? keys.openrouter : undefined,
    openaiApiKey: use.openai ? keys.openaiApiKey : undefined,
    codexHarnessAuth: harness ? keys.codexHarnessAuth : undefined,
    ...(harness && codexHarnessConnectedAtMs !== undefined ? { codexHarnessConnectedAtMs } : {}),
    harnessOwnerLogin: harness ? keys.harnessOwnerLogin : undefined,
    codexHarnessModel: harness ? keys.codexHarnessModel : null,
  };
}

/** Provider credentials resolved for a run. codexHarnessAuth is the decrypted auth.json blob (own
 *  harness); harnessOwnerLogin is the login whose harness was used, surfaced only when a blob resolved;
 *  codexHarnessModel is the author's pinned harness model (validated value or null), tied to the blob. */
export interface ResolvedIntegrationKeys {
  openrouter?: string;
  // Tenant BYOK native OpenAI key. When present (and no harness), the run routes openai/* natively to
  // api.openai.com under this key and is billed infra-only (a "user"/BYOK run).
  openaiApiKey?: string;
  codexHarnessAuth?: string;
  /** Millisecond revision of the exact harness credential returned for this run. */
  codexHarnessConnectedAtMs?: number;
  harnessOwnerLogin?: string;
  codexHarnessModel?: HarnessModel | null;
}

interface IntegrationKeyRow {
  openrouter_api_key: string | null;
  openai_api_key?: string | null;
  // Tenant provider preference; null/absent = 'auto'.
  model_provider?: string | null;
  codex_harness_auth?: string | null;
  codex_harness_connected_at?: Date | string | null;
  harness_owner_login?: string | null;
  codex_harness_model?: string | null;
}

/**
 * Pure row -> resolved-keys mapping (decrypt + shape), exported so the resolve shape is unit-testable
 * without a database. harnessOwnerLogin and codexHarnessModel are tied to the blob: they are only
 * surfaced when a harness auth blob actually resolved, so a matched author with no harness never looks
 * like an own-harness run. The stored harness model is coerced to a valid HARNESS_MODELS value or null.
 */
export function decryptIntegrationRow(row: IntegrationKeyRow | undefined): ResolvedIntegrationKeys {
  const codexHarnessAuth = decryptKey(row?.codex_harness_auth ?? null) ?? undefined;
  const connectedAtMs = row?.codex_harness_connected_at
    ? new Date(row.codex_harness_connected_at).getTime()
    : Number.NaN;
  return {
    openrouter: decryptKey(row?.openrouter_api_key) ?? undefined,
    openaiApiKey: decryptKey(row?.openai_api_key ?? null) ?? undefined,
    codexHarnessAuth,
    ...(codexHarnessAuth && Number.isFinite(connectedAtMs) ? { codexHarnessConnectedAtMs: connectedAtMs } : {}),
    harnessOwnerLogin: codexHarnessAuth ? row?.harness_owner_login ?? undefined : undefined,
    codexHarnessModel: codexHarnessAuth ? coerceStoredHarnessModel(row?.codex_harness_model) : null,
  };
}

function encryptKey(value: string | null): string | null {
  return value === null ? null : encryptSecret(value);
}

function decryptKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return decryptSecret(value);
}

function openRouterInfo(
  value: string | null,
  meta: { source: string | null; label: string | null; connectedAt: Date | string | null },
): OpenRouterIntegration {
  if (!value) {
    return { configured: false };
  }
  return {
    configured: true,
    last4: value.slice(-4),
    source: meta.source ?? undefined,
    label: meta.label ?? undefined,
    connected_at: meta.connectedAt ? toIso(meta.connectedAt) : undefined,
  };
}

function providerKeyInfo(value: string | null, connectedAt: Date | string | null): ProviderKeyIntegration {
  if (!value) {
    return { configured: false };
  }
  return {
    configured: true,
    last4: value.slice(-4),
    connected_at: connectedAt ? toIso(connectedAt) : undefined,
  };
}

function codexHarnessInfo(
  configured: boolean,
  connectedAt: Date | string | null,
  reconnectRequired: boolean,
): CodexHarnessIntegration {
  if (!configured) {
    return { configured: false };
  }
  return {
    configured: true,
    connected_at: connectedAt ? toIso(connectedAt) : undefined,
    reconnect_required: reconnectRequired,
  };
}

function normalizeKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* -------------------------------------------------- model settings + usage --- */

export interface ModelSettings {
  planner_model: string | null;
  investigation_model: string | null;
  review_model: string | null;
  context_model?: string | null;
  planner_effort?: ReasoningEffort | null;
  investigation_effort?: ReasoningEffort | null;
  review_effort?: ReasoningEffort | null;
  context_effort?: ReasoningEffort | null;
  review_fallback_policy?: FallbackPolicy;
  context_fallback_policy?: FallbackPolicy;
}

export type ReasoningEffort = "low" | "medium" | "high";
export type FallbackPolicy = "fail_notify" | "managed";
const DEFAULT_FALLBACK_POLICY: FallbackPolicy = "fail_notify";

export const EMPTY_MODEL_SETTINGS: ModelSettings = {
  planner_model: null,
  investigation_model: null,
  review_model: null,
  context_model: null,
  planner_effort: null,
  investigation_effort: null,
  review_effort: null,
  context_effort: null,
  review_fallback_policy: DEFAULT_FALLBACK_POLICY,
  context_fallback_policy: DEFAULT_FALLBACK_POLICY,
};

/**
 * Per-tenant, per-stage model selection. The tenant is resolved via
 * `tenants.github_account_id = githubUserId` — the same identity mapping used for
 * user_integrations (see the comment above resolveIntegrationKeysForRun). A missing
 * settings row (or missing tenant) resolves to all-null, i.e. platform defaults.
 *
 * This is the LEGACY viewer-scoped read (personal tenant only), kept for deploy skew. Org tenants now
 * read/write model settings through the tenant-scoped route (getTenantModelSettingsById), backed by
 * tenant_members access, so the old per-user membership gap no longer applies to org-owned repos.
 */
export async function getTenantModelSettings(githubUserId: number): Promise<ModelSettings> {
  if (!databaseConfigured()) {
    return { ...EMPTY_MODEL_SETTINGS };
  }
  const row = await queryOne<ModelSettingsRow>(
    `select tms.*
       from tenants t
       left join tenant_model_settings tms on tms.tenant_id = t.id
      where t.github_account_id = $1`,
    [githubUserId],
  );
  return modelSettingsFromRow(row);
}

/**
 * Persist per-tenant model selection. A null (or empty-string) field clears the
 * override so that stage falls back to the platform default. The tenant is
 * ensured (created if absent) so settings can be saved before installation.
 */
export async function saveTenantModelSettings(
  githubUserId: number,
  input: ModelSettings,
  contextHarnessOwnerUserId?: string,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  const planner = normalizeModelValue(input.planner_model);
  const investigation = normalizeModelValue(input.investigation_model);
  const review = normalizeModelValue(input.review_model);
  const context = normalizeModelValue(input.context_model);
  await withTransaction(async (client) => {
    const tenantId = await ensureTenantIdForUser(client, githubUserId);
    await client.query(
      `insert into tenant_model_settings
         (tenant_id, planner_model, investigation_model, review_model, context_model,
          planner_effort, investigation_effort, review_effort, context_effort,
          review_fallback_policy, context_fallback_policy, context_harness_owner_user_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       on conflict (tenant_id) do update set
          planner_model = excluded.planner_model,
          investigation_model = excluded.investigation_model,
          review_model = excluded.review_model,
          context_model = excluded.context_model,
          planner_effort = excluded.planner_effort,
          investigation_effort = excluded.investigation_effort,
          review_effort = excluded.review_effort,
          context_effort = excluded.context_effort,
          review_fallback_policy = excluded.review_fallback_policy,
          context_fallback_policy = excluded.context_fallback_policy,
          context_harness_owner_user_id = coalesce(excluded.context_harness_owner_user_id, tenant_model_settings.context_harness_owner_user_id),
          updated_at = now()`,
      [
        tenantId, planner, investigation, review, context,
        normalizeReasoningEffort(input.planner_effort),
        normalizeReasoningEffort(input.investigation_effort),
        normalizeReasoningEffort(input.review_effort),
        normalizeReasoningEffort(input.context_effort),
        normalizeFallbackPolicy(input.review_fallback_policy),
        normalizeFallbackPolicy(input.context_fallback_policy),
        contextHarnessOwnerUserId ?? null,
      ],
    );
  });
}

/** Read per-tenant model settings keyed directly by tenant id (tenant-scoped dashboard route). */
export async function getTenantModelSettingsById(tenantId: string): Promise<ModelSettings> {
  if (!databaseConfigured()) {
    return { ...EMPTY_MODEL_SETTINGS };
  }
  const row = await queryOne<ModelSettingsRow>(
    `select * from tenant_model_settings where tenant_id = $1`,
    [tenantId],
  );
  return modelSettingsFromRow(row);
}

/** Persist per-tenant model settings keyed directly by tenant id (tenant-scoped dashboard route). */
export async function saveTenantModelSettingsById(
  tenantId: string,
  input: ModelSettings,
  contextHarnessOwnerUserId?: string,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  const planner = normalizeModelValue(input.planner_model);
  const investigation = normalizeModelValue(input.investigation_model);
  const review = normalizeModelValue(input.review_model);
  const context = normalizeModelValue(input.context_model);
  await query(
    `insert into tenant_model_settings
       (tenant_id, planner_model, investigation_model, review_model, context_model,
        planner_effort, investigation_effort, review_effort, context_effort,
        review_fallback_policy, context_fallback_policy, context_harness_owner_user_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     on conflict (tenant_id) do update set
        planner_model = excluded.planner_model,
        investigation_model = excluded.investigation_model,
        review_model = excluded.review_model,
        context_model = excluded.context_model,
        planner_effort = excluded.planner_effort,
        investigation_effort = excluded.investigation_effort,
        review_effort = excluded.review_effort,
        context_effort = excluded.context_effort,
        review_fallback_policy = excluded.review_fallback_policy,
        context_fallback_policy = excluded.context_fallback_policy,
        context_harness_owner_user_id = coalesce(excluded.context_harness_owner_user_id, tenant_model_settings.context_harness_owner_user_id),
        updated_at = now()`,
    [
      tenantId, planner, investigation, review, context,
      normalizeReasoningEffort(input.planner_effort),
      normalizeReasoningEffort(input.investigation_effort),
      normalizeReasoningEffort(input.review_effort),
      normalizeReasoningEffort(input.context_effort),
      normalizeFallbackPolicy(input.review_fallback_policy),
      normalizeFallbackPolicy(input.context_fallback_policy),
      contextHarnessOwnerUserId ?? null,
    ],
  );
}

export interface ContextExecutionProfile {
  provider: ModelProvider;
  model: string;
  effort: ReasoningEffort;
  fallback_policy: FallbackPolicy;
  credential:
    | { kind: "managed" }
    | { kind: "openai" | "openrouter"; value: string; revision: string }
    | { kind: "codex"; value: string; revision: string }
    | { kind: "unavailable"; reason: string };
  settings_revision: string;
}

/**
 * Resolve and persist a write-once Context execution profile for one Context build.
 * The profile is stable across worker retries and contains an encrypted copy of
 * the exact credential revision selected at build start.
 */
export async function getOrCreateContextExecutionProfile(
  tenantId: string,
  buildId: string,
): Promise<ContextExecutionProfile> {
  if (!databaseConfigured()) {
    return {
      provider: DEFAULT_MODEL_PROVIDER,
      model: platformModelDefaults().context ?? "openai/gpt-5.6-terra",
      effort: "low",
      fallback_policy: DEFAULT_FALLBACK_POLICY,
      credential: { kind: "managed" },
      settings_revision: "unconfigured",
    };
  }
  return withTransaction(async (client) => {
    const existing = await client.query<{
      settings: unknown;
      credential_kind: "managed" | "openai" | "openrouter" | "codex" | "unavailable";
      encrypted_credential: string | null;
      credential_revision: string | null;
    }>(
      `select settings, credential_kind, encrypted_credential, credential_revision
         from context_execution_profiles
        where tenant_id = $1 and build_id = $2`,
      [tenantId, buildId],
    );
    if (existing.rows[0]) return contextExecutionProfileFromRow(existing.rows[0]);

    const selected = await client.query<ModelSettingsRow & {
      model_provider: string | null;
      settings_revision: Date | string | null;
      openrouter_api_key: string | null;
      openrouter_revision: Date | string | null;
      openai_api_key: string | null;
      openai_revision: Date | string | null;
      codex_harness_auth: string | null;
      codex_revision: Date | string | null;
    }>(
      `select tms.*,
              tms.updated_at as settings_revision,
              ti.openrouter_api_key, ti.openrouter_connected_at as openrouter_revision,
              ti.openai_api_key, ti.openai_connected_at as openai_revision,
              ui.codex_harness_auth, ui.codex_harness_connected_at as codex_revision
         from tenants t
         left join tenant_model_settings tms on tms.tenant_id = t.id
         left join tenant_integrations ti on ti.tenant_id = t.id
         left join user_integrations ui on ui.user_id = tms.context_harness_owner_user_id
        where t.id = $1 and t.merged_into_tenant_id is null
        for update of t`,
      [tenantId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("context execution profile tenant not found");
    const settings = modelSettingsFromRow(row);
    const provider = normalizeModelProvider(row.model_provider);
    const model = settings.context_model ?? platformModelDefaults().context ?? "openai/gpt-5.6-terra";
    const effort = settings.context_effort ?? "low";
    const credential = contextCredentialSelection(provider, model, row);
    const settingsRevision = row.settings_revision ? new Date(row.settings_revision).toISOString() : "default";
    const publicSettings = {
      provider,
      model,
      effort,
      fallback_policy: normalizeFallbackPolicy(settings.context_fallback_policy),
      settings_revision: settingsRevision,
      unavailable_reason: credential.kind === "unavailable" ? credential.reason : null,
    };
    await client.query(
      `insert into context_execution_profiles
         (tenant_id, build_id, settings, credential_kind, encrypted_credential, credential_revision)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, build_id) do nothing`,
      [
        tenantId,
        buildId,
        JSON.stringify(publicSettings),
        credential.kind,
        credential.kind === "openai" || credential.kind === "openrouter" || credential.kind === "codex"
          ? encryptSecret(credential.value)
          : null,
        "revision" in credential ? credential.revision : null,
      ],
    );
    const persisted = await client.query<{
      settings: unknown;
      credential_kind: "managed" | "openai" | "openrouter" | "codex" | "unavailable";
      encrypted_credential: string | null;
      credential_revision: string | null;
    }>(
      `select settings, credential_kind, encrypted_credential, credential_revision
         from context_execution_profiles where tenant_id = $1 and build_id = $2`,
      [tenantId, buildId],
    );
    return contextExecutionProfileFromRow(persisted.rows[0]);
  });
}

function contextCredentialSelection(
  provider: ModelProvider,
  model: string,
  row: {
    openrouter_api_key: string | null;
    openrouter_revision: Date | string | null;
    openai_api_key: string | null;
    openai_revision: Date | string | null;
    codex_harness_auth: string | null;
    codex_revision: Date | string | null;
  },
): ContextExecutionProfile["credential"] {
  const revision = (value: Date | string | null) => value ? new Date(value).toISOString() : "unknown";
  if (provider === "managed") return { kind: "managed" };
  if (provider === "codex") {
    const value = decryptKey(row.codex_harness_auth);
    return value
      ? { kind: "codex", value, revision: revision(row.codex_revision) }
      : { kind: "unavailable", reason: "The designated Context owner must connect Codex." };
  }
  const openrouter = decryptKey(row.openrouter_api_key);
  if (openrouter) return { kind: "openrouter", value: openrouter, revision: revision(row.openrouter_revision) };
  const openai = decryptKey(row.openai_api_key);
  if (openai && model.startsWith("openai/")) {
    return { kind: "openai", value: openai, revision: revision(row.openai_revision) };
  }
  return {
    kind: "unavailable",
    reason: model.startsWith("openai/")
      ? "The organization must connect an OpenAI or OpenRouter key."
      : "The selected model requires an OpenRouter key.",
  };
}

function contextExecutionProfileFromRow(row: {
  settings: unknown;
  credential_kind: "managed" | "openai" | "openrouter" | "codex" | "unavailable";
  encrypted_credential: string | null;
  credential_revision: string | null;
}): ContextExecutionProfile {
  const settings = (typeof row.settings === "object" && row.settings && !Array.isArray(row.settings)
    ? row.settings
    : {}) as Record<string, unknown>;
  const kind = row.credential_kind;
  const value = row.encrypted_credential ? decryptKey(row.encrypted_credential) : null;
  const credential: ContextExecutionProfile["credential"] =
    kind === "managed"
      ? { kind }
      : kind === "unavailable"
        ? { kind, reason: typeof settings.unavailable_reason === "string" ? settings.unavailable_reason : "Provider unavailable." }
        : value
          ? { kind, value, revision: row.credential_revision ?? "unknown" }
          : { kind: "unavailable", reason: "The saved provider credential could not be decrypted." };
  return {
    provider: normalizeModelProvider(settings.provider),
    model: typeof settings.model === "string" ? settings.model : platformModelDefaults().context ?? "openai/gpt-5.6-terra",
    effort: normalizeReasoningEffort(settings.effort) ?? "low",
    fallback_policy: normalizeFallbackPolicy(settings.fallback_policy),
    credential,
    settings_revision: typeof settings.settings_revision === "string" ? settings.settings_revision : "unknown",
  };
}

/** Resolve model settings for a specific run via review_runs -> tenants -> tenant_model_settings. */
export async function getModelSettingsForRun(reviewRunId: string): Promise<ModelSettings> {
  if (!databaseConfigured()) {
    return { ...EMPTY_MODEL_SETTINGS };
  }
  // Per-stage models flow through as chosen — the run's routing (resolveRunKeys) handles a model the
  // tenant's keys can't serve via the WHOLE-RUN managed fallback, so there is no per-model gate here.
  const row = await queryOne<ModelSettingsRow>(
    `select tms.*
       from review_runs r
       join tenants t on t.id = r.tenant_id
       left join tenant_model_settings tms on tms.tenant_id = t.id
      where r.id = $1`,
    [reviewRunId],
  );
  return modelSettingsFromRow(row);
}

export async function getReviewProviderResolution(reviewRunId: string): Promise<{
  provider: ModelProvider;
  fallbackPolicy: FallbackPolicy;
}> {
  if (!databaseConfigured()) {
    return { provider: DEFAULT_MODEL_PROVIDER, fallbackPolicy: DEFAULT_FALLBACK_POLICY };
  }
  const row = await queryOne<{ model_provider: string | null; model_settings_snapshot: unknown }>(
    `select tms.model_provider, r.model_settings_snapshot
       from review_runs r
       left join tenant_model_settings tms on tms.tenant_id = r.tenant_id
      where r.id = $1`,
    [reviewRunId],
  );
  const snapshot = parseModelSettingsSnapshot(row?.model_settings_snapshot);
  return {
    provider: normalizeModelProvider(row?.model_provider),
    fallbackPolicy: normalizeFallbackPolicy(snapshot?.review_fallback_policy),
  };
}

/** Persist the run's model-settings SNAPSHOT (taken at prepare) and return the AUTHORITATIVE snapshot.
 *  WRITE-ONCE (coalesce): a rerun/duplicate prepare reuses the same run row (idempotency key =
 *  repo+PR+head), and overwriting would re-open the mid-run divergence the snapshot exists to close — an
 *  earlier worker still mid-run would suddenly resolve keys/billing against the newer model set. The
 *  caller must hand the RETURNED value to the worker so payload ≡ snapshot even on reruns. */
export async function saveRunModelSettingsSnapshot(
  reviewRunId: string,
  settings: ModelSettings,
): Promise<ModelSettings> {
  if (!databaseConfigured()) {
    return settings;
  }
  const row = await queryOne<{ model_settings_snapshot: unknown }>(
    `update review_runs
        set model_settings_snapshot = coalesce(model_settings_snapshot, $2)
      where id = $1
      returning model_settings_snapshot`,
    [reviewRunId, JSON.stringify(settings)],
  );
  return parseModelSettingsSnapshot(row?.model_settings_snapshot) ?? settings;
}

/** Parse a stored model_settings_snapshot; null/malformed -> undefined (caller falls back to live values). */
export function parseModelSettingsSnapshot(raw: unknown): ModelSettings | undefined {
  const record = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const at = (key: string) => {
    const value = (record as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  };
  return {
    planner_model: at("planner_model"),
    investigation_model: at("investigation_model"),
    review_model: at("review_model"),
    context_model: at("context_model"),
    planner_effort: normalizeReasoningEffort((record as Record<string, unknown>).planner_effort),
    investigation_effort: normalizeReasoningEffort((record as Record<string, unknown>).investigation_effort),
    review_effort: normalizeReasoningEffort((record as Record<string, unknown>).review_effort),
    context_effort: normalizeReasoningEffort((record as Record<string, unknown>).context_effort),
    review_fallback_policy: normalizeFallbackPolicy((record as Record<string, unknown>).review_fallback_policy),
    context_fallback_policy: normalizeFallbackPolicy((record as Record<string, unknown>).context_fallback_policy),
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

interface ModelSettingsRow {
  planner_model: string | null;
  investigation_model: string | null;
  review_model: string | null;
  context_model?: string | null;
  planner_effort?: string | null;
  investigation_effort?: string | null;
  review_effort?: string | null;
  context_effort?: string | null;
  review_fallback_policy?: string | null;
  context_fallback_policy?: string | null;
}

/* --------------------------------------------------- model provider --- */

/** The tenant's provider selection — exactly three options, and runs route exactly as selected:
 *   - 'managed' (DEFAULT until the tenant selects) — always Jina managed, even when a harness/keys exist.
 *   - 'codex'   — the author's harness; PRs without a harness fall through BYOK > managed.
 *   - 'byok'    — company keys (never the harness); managed when the keys can't cover the picked models.
 *  There is no automatic priority: nothing routes above managed until a user explicitly selects it.
 *  Legacy values: 'openai'/'openrouter' collapse to 'byok'; the retired 'auto' (and null/unknown)
 *  collapse to the managed default. */
export type ModelProvider = "codex" | "byok" | "managed";
const DEFAULT_MODEL_PROVIDER: ModelProvider = "managed";

/** Coerce a stored/submitted provider value to a valid ModelProvider, defaulting to 'managed'. */
export function normalizeModelProvider(raw: unknown): ModelProvider {
  if (raw === "codex" || raw === "byok" || raw === "managed") {
    return raw;
  }
  // Legacy single-key forces (pre-tri-select) collapse to the BYOK tier.
  if (raw === "openai" || raw === "openrouter") {
    return "byok";
  }
  return DEFAULT_MODEL_PROVIDER;
}

/* --------------------------------------------------- review trigger mode --- */

/** When Jina reviews a PR. 'every_commit' reviews on open + every push; 'first_commit' reviews on
 *  open/reopen/ready only; 'manual_only' requires an @usejina PR comment. */
export type ReviewTriggerMode = "every_commit" | "first_commit" | "manual_only";
const DEFAULT_REVIEW_TRIGGER_MODE: ReviewTriggerMode = "every_commit";

/** Coerce an arbitrary stored/submitted value to a valid mode, defaulting to 'every_commit'. */
export function normalizeReviewTriggerMode(raw: unknown): ReviewTriggerMode {
  return raw === "first_commit" || raw === "manual_only" ? raw : DEFAULT_REVIEW_TRIGGER_MODE;
}

/** Read a tenant's review-trigger mode (tenant-scoped dashboard route). Defaults to 'every_commit'. */
export async function getTenantReviewTriggerMode(tenantId: string): Promise<ReviewTriggerMode> {
  if (!databaseConfigured()) {
    return DEFAULT_REVIEW_TRIGGER_MODE;
  }
  const row = await queryOne<{ review_trigger_mode: string | null }>(
    `select review_trigger_mode from tenant_model_settings where tenant_id = $1`,
    [tenantId],
  );
  return normalizeReviewTriggerMode(row?.review_trigger_mode);
}

/** Persist a tenant's review-trigger mode, upserting the settings row without touching model columns. */
export async function saveTenantReviewTriggerMode(tenantId: string, mode: ReviewTriggerMode): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into tenant_model_settings (tenant_id, review_trigger_mode, updated_at)
     values ($1, $2, now())
     on conflict (tenant_id) do update set review_trigger_mode = excluded.review_trigger_mode, updated_at = now()`,
    [tenantId, mode],
  );
}

/** Read a tenant's model-provider preference (tenant-scoped dashboard route). Defaults to 'auto'. */
export async function getTenantModelProvider(tenantId: string): Promise<ModelProvider> {
  if (!databaseConfigured()) {
    return DEFAULT_MODEL_PROVIDER;
  }
  const row = await queryOne<{ model_provider: string | null }>(
    `select model_provider from tenant_model_settings where tenant_id = $1`,
    [tenantId],
  );
  return normalizeModelProvider(row?.model_provider);
}

/** Persist a tenant's model-provider preference, upserting the settings row without touching model columns. */
export async function saveTenantModelProvider(
  tenantId: string,
  provider: ModelProvider,
  contextHarnessOwnerUserId?: string,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into tenant_model_settings (tenant_id, model_provider, context_harness_owner_user_id, updated_at)
     values ($1, $2, $3, now())
     on conflict (tenant_id) do update set
       model_provider = excluded.model_provider,
       context_harness_owner_user_id =
         coalesce(excluded.context_harness_owner_user_id, tenant_model_settings.context_harness_owner_user_id),
       updated_at = now()`,
    [tenantId, provider, contextHarnessOwnerUserId ?? null],
  );
}

/**
 * Resolve the review-trigger mode for a webhook, keyed by installation id (installations -> tenants ->
 * tenant_model_settings). Used to decide whether an automatic pull-request event triggers a review.
 * Defaults to 'every_commit' when the installation/tenant/setting is absent, preserving today's behavior.
 */
export async function getReviewTriggerModeForInstallation(installationId: number): Promise<ReviewTriggerMode> {
  if (!databaseConfigured()) {
    return DEFAULT_REVIEW_TRIGGER_MODE;
  }
  const row = await queryOne<{ review_trigger_mode: string | null }>(
    `select tms.review_trigger_mode
       from installations i
       join tenants t on t.id = i.tenant_id
       left join tenant_model_settings tms on tms.tenant_id = t.id
      where i.github_installation_id = $1`,
    [installationId],
  );
  return normalizeReviewTriggerMode(row?.review_trigger_mode);
}

function modelSettingsFromRow(row: ModelSettingsRow | undefined): ModelSettings {
  return {
    planner_model: row?.planner_model ?? null,
    investigation_model: row?.investigation_model ?? null,
    review_model: row?.review_model ?? null,
    context_model: row?.context_model ?? null,
    planner_effort: normalizeReasoningEffort(row?.planner_effort),
    investigation_effort: normalizeReasoningEffort(row?.investigation_effort),
    review_effort: normalizeReasoningEffort(row?.review_effort),
    context_effort: normalizeReasoningEffort(row?.context_effort),
    review_fallback_policy: normalizeFallbackPolicy(row?.review_fallback_policy),
    context_fallback_policy: normalizeFallbackPolicy(row?.context_fallback_policy),
  };
}

export function normalizeReasoningEffort(raw: unknown): ReasoningEffort | null {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : null;
}

export function normalizeFallbackPolicy(raw: unknown): FallbackPolicy {
  return raw === "managed" ? "managed" : DEFAULT_FALLBACK_POLICY;
}

function normalizeModelValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ensure the viewer's PERSONAL tenant exists and return its id (Autumn customer id). Used by the legacy
 * viewer-scoped integrations save (which now writes tenant_integrations) and by the OpenRouter OAuth
 * default-tenant path. Undefined only when the database is unconfigured (tests).
 */
export async function ensurePersonalTenantId(githubUserId: number, login?: string): Promise<string | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  return withTransaction((client) => ensureTenantIdForUser(client, githubUserId, login));
}

async function ensureTenantIdForUser(client: pg.PoolClient, githubUserId: number, login?: string): Promise<string> {
  const trimmedLogin = login?.trim();
  const identity = await client.query<{ user_id: string }>(
    `select user_id
       from user_identities
      where provider = 'github' and provider_user_id = $1::text`,
    [githubUserId],
  );
  const userId = identity.rows[0]?.user_id ?? null;
  const existing = await client.query<{ id: string; github_account_login: string | null }>(
    `select id, github_account_login from tenants where github_account_id = $1`,
    [githubUserId],
  );
  if (existing.rows[0]) {
    // Keep the stable account id while refreshing the current session login (including GitHub renames).
    await client.query(
      `update tenants
          set github_account_login = coalesce($2, github_account_login),
              github_account_type = 'User',
              kind = coalesce(kind, 'personal'),
              name = coalesce(name, $2, github_account_login),
              personal_owner_user_id = coalesce(personal_owner_user_id, $3)
        where id = $1`,
      [existing.rows[0].id, trimmedLogin || null, userId],
    );
    return existing.rows[0].id;
  }
  // No installation yet — create the personal tenant with the session's login when available (the
  // 'unknown' placeholder is a last resort for callers with no session identity).
  const created = await client.query<{ id: string }>(
    `insert into tenants
       (github_account_id, github_account_login, github_account_type, kind, name, personal_owner_user_id)
     values ($1, $2, 'User', 'personal', $2, $3)
     on conflict (github_account_id) do update set github_account_id = excluded.github_account_id
     returning id`,
    [githubUserId, trimmedLogin || "unknown", userId],
  );
  return created.rows[0].id;
}

/** Thrown by persistReviewUsageRecords when the review run does not exist (maps to 404). */
export class ReviewRunNotFoundError extends Error {
  constructor(public readonly reviewRunId: string) {
    super(`review run not found: ${reviewRunId}`);
    this.name = "ReviewRunNotFoundError";
  }
}

export interface ReviewUsageRecord {
  operation: string;
  request_seq: number;
  model?: string;
  generation_id?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  // Decimal strings from OpenRouter — passed straight to numeric columns, never parseFloat'd.
  cost?: string;
  upstream_inference_cost?: string;
  // OpenRouter's usage.is_byok: true when the upstream model spend rode a BYOK key on the managed
  // account, so `cost` is only the OpenRouter fee. Optional on the wire; defaults to false.
  is_byok?: boolean;
  raw_usage: unknown;
  raw_response_metadata?: unknown;
}

/**
 * The single basis the credit math bills from, computed EXACTLY (string decimal, never float):
 *   is_byok ? (upstream_inference_cost + cost) : cost
 * On a BYOK route OpenRouter's `cost` is only its ~5% fee and the real model spend is in
 * upstream_inference_cost, so the basis must sum both; on a non-BYOK route `cost` is the full charge
 * and upstream merely mirrors it, so summing would double-charge — hence the conditional. Returns
 * undefined when the applicable source cost is absent (persisted as NULL; credit math falls back to
 * openrouter_cost for such rows).
 */
export function computeBillableCost(record: {
  cost?: string;
  upstream_inference_cost?: string;
  is_byok?: boolean;
}): string | undefined {
  if (record.is_byok) {
    if (record.cost === undefined && record.upstream_inference_cost === undefined) {
      return undefined;
    }
    return exactDecimalSum(record.upstream_inference_cost, record.cost);
  }
  return record.cost;
}

export interface ReviewUsageInput {
  stage: "summary" | "runtime";
  sandbox_id: string;
  // "harness" mirrors the runtime credential precedence (author harness > tenant openrouter > managed).
  // Own-harness AI, like own-key ("user") AI, is never billed — see usageBillingStatus.
  key_source: "harness" | "user" | "managed";
  usage_records: ReviewUsageRecord[];
}

/** The dedupe key is the generation id when present, else `{sandbox_id}:{request_seq}`. */
export function usageDedupeKey(sandboxId: string, record: { generation_id?: string; request_seq: number }): string {
  const generationId = typeof record.generation_id === "string" ? record.generation_id.trim() : "";
  return generationId.length > 0 ? generationId : `${sandboxId}:${record.request_seq}`;
}

/**
 * Own-harness (user key) AI rows are never billed. Managed rows are held as pending_outcome until
 * the run reaches a terminal completion — but ONLY when billing is active (shadow/on). FINDING 2:
 * when billing is inactive (enforce=off or no secret), persistence captures telemetry only, so
 * managed rows land as 'not_billable' too. This keeps enforce=off truly inert: a later flip to 'on'
 * must not let the retry drain back-bill usage that accrued while billing was off. (Shadow rows also
 * start pending_outcome so settlement can compute them — but DECISION 1: shadow settlement finalizes
 * them as the terminal 'shadow_computed' status, never 'pending', so shadow usage is never back-billed.)
 *
 * 'harness' is treated exactly like 'user': own-harness AI runs on the PR author's own subscription and
 * is NEVER billed for managed AI, so it lands 'not_billable' too (managed billing does not apply).
 */
export function usageBillingStatus(keySource: string, billingActive: boolean): "not_billable" | "pending_outcome" {
  return keySource === "user" || keySource === "harness" || !billingActive ? "not_billable" : "pending_outcome";
}

/**
 * Persist a batch of usage records in one transaction, deduped by
 * (review_run_id, dedupe_key). tenant_id is resolved server-side from the run row
 * (never trusted from the caller). Throws ReviewRunNotFoundError for an unknown run.
 */
export async function persistReviewUsageRecords(
  reviewRunId: string,
  input: ReviewUsageInput,
  billingActive: boolean,
): Promise<{ persisted: number; deduped: number }> {
  if (!databaseConfigured()) {
    return { persisted: 0, deduped: 0 };
  }
  return withTransaction(async (client) => {
    const runRow = await client.query<{ tenant_id: string }>(
      `select tenant_id from review_runs where id = $1`,
      [reviewRunId],
    );
    const tenantId = runRow.rows[0]?.tenant_id;
    if (!tenantId) {
      throw new ReviewRunNotFoundError(reviewRunId);
    }

    const billingStatus = usageBillingStatus(input.key_source, billingActive);
    let persisted = 0;
    for (const record of input.usage_records) {
      const dedupeKey = usageDedupeKey(input.sandbox_id, record);
      const isByok = record.is_byok === true;
      // The single basis the credit math bills from — computed exactly here, never re-derived later.
      const billableCost = computeBillableCost(record);
      const result = await client.query(
        `insert into review_llm_usage
           (tenant_id, review_run_id, stage, operation, key_source, sandbox_id, request_seq,
            model, generation_id, dedupe_key,
            prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, cached_tokens, cache_write_tokens,
            openrouter_cost, upstream_inference_cost, is_byok, billable_cost,
            raw_usage_json, raw_response_metadata_json, billing_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         on conflict (review_run_id, dedupe_key) do nothing`,
        [
          tenantId,
          reviewRunId,
          input.stage,
          record.operation,
          input.key_source,
          input.sandbox_id,
          record.request_seq,
          record.model ?? null,
          record.generation_id ?? null,
          dedupeKey,
          record.prompt_tokens ?? null,
          record.completion_tokens ?? null,
          record.total_tokens ?? null,
          record.reasoning_tokens ?? null,
          record.cached_tokens ?? null,
          record.cache_write_tokens ?? null,
          record.cost ?? null,
          record.upstream_inference_cost ?? null,
          isByok,
          billableCost ?? null,
          JSON.stringify(record.raw_usage ?? {}),
          jsonOrNull(record.raw_response_metadata),
          billingStatus,
        ],
      );
      persisted += result.rowCount ?? 0;
    }
    return { persisted, deduped: input.usage_records.length - persisted };
  });
}

/* --------------------------------------------------------------- billing --- */

export interface BillingPolicy {
  subsidy_rate: string; // numeric(5,4) decimal string; customer_share = 1 - subsidy_rate
  infra_credits_per_run: number;
  overage_infra_credits_per_run: number;
  overage_subsidy_rate: string; // decimal string; overage customer_share = 1 - overage_subsidy_rate
  // Auto-review credit cap (migration 0015). When enabled AND auto_review_limit_credits is non-null, an
  // AUTO-triggered run whose current-cycle used credits have reached the cap is blocked at prepare.
  auto_review_limit_enabled: boolean;
  auto_review_limit_credits: number | null;
}

/** Platform defaults when a tenant has no tenant_billing_policy row (spec: 0.30 / 100 / 150 / 0.00; cap off). */
export const PLATFORM_BILLING_POLICY: BillingPolicy = {
  subsidy_rate: "0.3000",
  infra_credits_per_run: 100,
  overage_infra_credits_per_run: 150,
  overage_subsidy_rate: "0.0000",
  auto_review_limit_enabled: false,
  auto_review_limit_credits: null,
};

export interface BillingPolicyRow {
  subsidy_rate: string | null;
  infra_credits_per_run: number | null;
  overage_infra_credits_per_run: number | null;
  overage_subsidy_rate: string | null;
  auto_review_limit_enabled?: boolean | null;
  auto_review_limit_credits?: number | null;
}

/**
 * FINDING 3: tenant_billing_policy rows are operator-editable and were previously trusted blindly — a
 * reviewer drove a NEGATIVE infra credit charge all the way into an Autumn track. Clamp every field to
 * a sane range and fall back to the platform default (logging billing_policy_invalid) for any value out
 * of range: subsidy rates to [0, 1] and per-run credits to a non-negative safe integer. Migration 0009
 * adds matching CHECK constraints so bad values cannot be written in the first place; this is defense
 * in depth for rows that predate the constraint.
 */
function clampSubsidyRate(value: string | null, field: string, tenantId: string, fallback: string): string {
  if (value === null) {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    console.error("billing_policy_invalid", { tenant_id: tenantId, field, value });
    return fallback;
  }
  return value;
}

function clampCredits(value: number | null, field: string, tenantId: string, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error("billing_policy_invalid", { tenant_id: tenantId, field, value });
    return fallback;
  }
  return value;
}

export function policyFromRow(row: BillingPolicyRow | undefined | null, tenantId: string): BillingPolicy {
  if (!row || row.subsidy_rate === null) {
    return { ...PLATFORM_BILLING_POLICY };
  }
  return {
    subsidy_rate: clampSubsidyRate(row.subsidy_rate, "subsidy_rate", tenantId, PLATFORM_BILLING_POLICY.subsidy_rate),
    infra_credits_per_run: clampCredits(
      row.infra_credits_per_run,
      "infra_credits_per_run",
      tenantId,
      PLATFORM_BILLING_POLICY.infra_credits_per_run,
    ),
    overage_infra_credits_per_run: clampCredits(
      row.overage_infra_credits_per_run,
      "overage_infra_credits_per_run",
      tenantId,
      PLATFORM_BILLING_POLICY.overage_infra_credits_per_run,
    ),
    overage_subsidy_rate: clampSubsidyRate(
      row.overage_subsidy_rate,
      "overage_subsidy_rate",
      tenantId,
      PLATFORM_BILLING_POLICY.overage_subsidy_rate,
    ),
    // The cap is a tenant/operator-editable field; guard it like the credit fields. A null credits value
    // is legitimate ("no cap set"), so it passes through untouched; only a negative value is corrected.
    auto_review_limit_enabled: row.auto_review_limit_enabled === true,
    auto_review_limit_credits:
      row.auto_review_limit_credits === null || row.auto_review_limit_credits === undefined
        ? null
        : clampCredits(row.auto_review_limit_credits, "auto_review_limit_credits", tenantId, 0),
  };
}

/** Per-tenant billing policy with platform defaults when no row exists. */
export async function getTenantBillingPolicy(tenantId: string): Promise<BillingPolicy> {
  if (!databaseConfigured()) {
    return { ...PLATFORM_BILLING_POLICY };
  }
  const row = await queryOne<BillingPolicyRow>(
    `select subsidy_rate, infra_credits_per_run, overage_infra_credits_per_run, overage_subsidy_rate,
            auto_review_limit_enabled, auto_review_limit_credits
       from tenant_billing_policy where tenant_id = $1`,
    [tenantId],
  );
  return policyFromRow(row, tenantId);
}

/** The auto-review cap as surfaced to the dashboard billing overview. */
export interface AutoReviewLimit { enabled: boolean; limit_credits: number | null }

/**
 * Persist the tenant's auto-review credit cap onto tenant_billing_policy. Other policy columns keep their
 * defaults on insert (the row may not exist yet); on conflict only the two cap columns are updated. The
 * caller validates enabled/limitCredits (limitCredits must be a non-negative integer or null); the CHECK
 * constraint from migration 0015 is the backstop.
 */
export async function saveTenantAutoReviewLimit(tenantId: string, input: AutoReviewLimit): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into tenant_billing_policy (tenant_id, auto_review_limit_enabled, auto_review_limit_credits, updated_at)
     values ($1, $2, $3, now())
     on conflict (tenant_id) do update set
        auto_review_limit_enabled = excluded.auto_review_limit_enabled,
        auto_review_limit_credits = excluded.auto_review_limit_credits,
        updated_at = now()`,
    [tenantId, input.enabled, input.limit_credits],
  );
}

/** Member counts for the tenant billing overview: total members and how many have a Codex harness connected. */
export interface TenantMemberStats { total: number; with_harness: number }

/**
 * Count tenant members and how many have connected a Codex harness. tenant_members is joined to
 * user_integrations by github_user_id; codex_harness_auth presence (never the blob) is the harness signal.
 */
export async function getTenantMemberStats(tenantId: string): Promise<TenantMemberStats> {
  if (!databaseConfigured()) {
    return { total: 0, with_harness: 0 };
  }
  const row = await queryOne<{ total: number; with_harness: number }>(
    `select count(*)::int as total,
            count(*) filter (where ui.codex_harness_auth is not null)::int as with_harness
       from tenant_members m
       left join user_integrations ui on ui.github_user_id = m.github_user_id
      where m.tenant_id = $1`,
    [tenantId],
  );
  return { total: row?.total ?? 0, with_harness: row?.with_harness ?? 0 };
}

/* ------------------------------------------------------- tenant usage summary --- */

interface UsageDailyPoint { date: string; credits: number; runs: number }
// One row PER PULL REQUEST (not per review_run): a PR re-reviewed on each push has its per-commit runs
// rolled up here. infra_credits/ai_credits are summed across those runs; review_count is how many; the
// status/key_source/review_run_id reflect the most recent run for that PR.
interface UsageRecentRun {
  review_run_id: string;
  repo_full_name: string;
  pr_number: number | null;
  status: string;
  key_source: string | null;
  rate_mode: string | null;
  infra_credits: number | null;
  ai_credits: number | null;
  review_count: number;
  created_at: string;
}
export interface TenantUsageSummary {
  period: { days: number };
  totals: {
    runs: number;
    completed_runs: number;
    infra_credits: number;
    ai_credits: number;
    total_credits: number;
    model_cost_usd: string;
    byok_runs: number;
    harness_runs: number;
  };
  // Our-data credits (infra + ai) consumed in the CURRENT monthly cycle (month-to-date).
  // The dashboard meter shows this against the plan's included grant — the source of truth
  // for consumption is our review_run_billing, not Autumn's ledger.
  cycle_credits_used: number;
  daily: UsageDailyPoint[];
  recent_runs: UsageRecentRun[];
}

/** Raw run-level totals row (one row) returned by the grouped aggregate query. */
export interface UsageTotalsRow {
  runs: number;
  completed_runs: number;
  infra_credits: number;
  ai_credits: number;
  byok_runs: number;
  harness_runs: number;
}
interface UsageDailyRow { date: string; credits: number; runs: number }
interface UsageRecentRow {
  review_run_id: string;
  repo_full_name: string;
  pr_number: number | null;
  status: string;
  key_source: string | null;
  rate_mode: string | null;
  infra_credits: number | null;
  ai_credits: number | null;
  review_count: number;
  created_at: Date | string;
}

/**
 * Pure shaper (exported for unit testing without a database): assemble the usage-summary response from
 * the grouped-aggregate rows. total_credits is infra + ai; model_cost_usd stays a string (a numeric sum
 * from Postgres); numeric fields are coerced defensively. No N+1 — the caller runs four grouped queries.
 */
export function shapeTenantUsage(
  days: number,
  totals: UsageTotalsRow,
  modelCostUsd: string | null,
  dailyRows: UsageDailyRow[],
  recentRows: UsageRecentRow[],
  cycleCreditsUsed = 0,
): TenantUsageSummary {
  const infra = Number(totals.infra_credits) || 0;
  const ai = Number(totals.ai_credits) || 0;
  return {
    period: { days },
    totals: {
      runs: Number(totals.runs) || 0,
      completed_runs: Number(totals.completed_runs) || 0,
      infra_credits: infra,
      ai_credits: ai,
      total_credits: infra + ai,
      model_cost_usd: modelCostUsd ?? "0",
      byok_runs: Number(totals.byok_runs) || 0,
      harness_runs: Number(totals.harness_runs) || 0,
    },
    cycle_credits_used: Number(cycleCreditsUsed) || 0,
    daily: dailyRows.map((row) => ({
      date: row.date,
      credits: Number(row.credits) || 0,
      runs: Number(row.runs) || 0,
    })),
    recent_runs: recentRows.map((row) => ({
      review_run_id: row.review_run_id,
      repo_full_name: row.repo_full_name,
      pr_number: row.pr_number ?? null,
      status: row.status,
      key_source: row.key_source ?? null,
      rate_mode: row.rate_mode ?? null,
      infra_credits: row.infra_credits ?? null,
      ai_credits: row.ai_credits ?? null,
      review_count: Number(row.review_count) || 1,
      created_at: toIso(row.created_at),
    })),
  };
}

/**
 * Aggregate a tenant's review usage over the trailing `days` window. Four grouped queries (run-level
 * totals, model-cost sum over usage rows, per-day series, and the 20 most-recent runs) — never per-run
 * N+1. Credits come from review_run_billing; model_cost_usd sums the BYOK-aware billable_cost (fallback
 * openrouter_cost) over review_llm_usage. `days` is validated by the caller (one of 7/30/90).
 */
export async function getTenantUsageSummary(tenantId: string, days: number): Promise<TenantUsageSummary> {
  if (!databaseConfigured()) {
    return shapeTenantUsage(
      days,
      { runs: 0, completed_runs: 0, infra_credits: 0, ai_credits: 0, byok_runs: 0, harness_runs: 0 },
      "0",
      [],
      [],
    );
  }
  const [totalsRow, costRow, dailyRows, recentRows, cycleRow] = await Promise.all([
    queryOne<UsageTotalsRow>(
      `select count(*)::int as runs,
              count(*) filter (where r.status = 'completed')::int as completed_runs,
              coalesce(sum(b.infra_credits_charged), 0)::int as infra_credits,
              coalesce(sum(b.ai_credits_charged_total), 0)::int as ai_credits,
              count(*) filter (where b.key_source = 'user')::int as byok_runs,
              count(*) filter (where b.key_source = 'harness')::int as harness_runs
         from review_runs r
         left join review_run_billing b on b.review_run_id = r.id
        where r.tenant_id = $1 and r.created_at >= now() - make_interval(days => $2)`,
      [tenantId, days],
    ),
    queryOne<{ model_cost_usd: string | null }>(
      `select coalesce(sum(coalesce(u.billable_cost, u.openrouter_cost)), 0)::text as model_cost_usd
         from review_llm_usage u
         join review_runs r on r.id = u.review_run_id
        where r.tenant_id = $1 and r.created_at >= now() - make_interval(days => $2)`,
      [tenantId, days],
    ),
    query<UsageDailyRow>(
      `select to_char(date_trunc('day', r.created_at), 'YYYY-MM-DD') as date,
              count(*)::int as runs,
              (coalesce(sum(b.infra_credits_charged), 0) + coalesce(sum(b.ai_credits_charged_total), 0))::int as credits
         from review_runs r
         left join review_run_billing b on b.review_run_id = r.id
        where r.tenant_id = $1 and r.created_at >= now() - make_interval(days => $2)
        group by 1 order by 1`,
      [tenantId, days],
    ),
    // Aggregated PER PULL REQUEST: a PR reviewed on every push has one review_run per commit; roll those
    // up so the list shows one line per PR with the SUMMED credits (infra + ai across all its runs) and a
    // review_count. status/key_source/rate_mode/review_run_id are taken from the PR's most recent run.
    query<UsageRecentRow>(
      `with runs as (
         select r.id as review_run_id, repo.owner || '/' || repo.name as repo_full_name,
                pr.pr_number, r.status, b.key_source, b.rate_mode,
                coalesce(b.infra_credits_charged, 0) as infra_credits,
                coalesce(b.ai_credits_charged_total, 0) as ai_credits,
                r.created_at
           from review_runs r
           join repositories repo on repo.id = r.repository_id
           left join pull_requests pr on pr.id = r.pull_request_id
           left join review_run_billing b on b.review_run_id = r.id
          where r.tenant_id = $1 and r.created_at >= now() - make_interval(days => $2)
       )
       select repo_full_name, pr_number,
              count(*)::int as review_count,
              sum(infra_credits)::int as infra_credits,
              sum(ai_credits)::int as ai_credits,
              max(created_at) as created_at,
              (array_agg(review_run_id order by created_at desc, review_run_id desc))[1] as review_run_id,
              (array_agg(status order by created_at desc, review_run_id desc))[1] as status,
              (array_agg(key_source order by created_at desc, review_run_id desc))[1] as key_source,
              (array_agg(rate_mode order by created_at desc, review_run_id desc))[1] as rate_mode
         from runs
        group by repo_full_name, pr_number
        order by max(created_at) desc
        limit 20`,
      [tenantId, days],
    ),
    // Cycle-to-date credits from OUR data (monthly reset): what the meter shows against the plan grant.
    queryOne<{ cycle_credits_used: number }>(
      `select (coalesce(sum(b.infra_credits_charged), 0) + coalesce(sum(b.ai_credits_charged_total), 0))::int
                as cycle_credits_used
         from review_runs r
         left join review_run_billing b on b.review_run_id = r.id
        where r.tenant_id = $1 and r.created_at >= date_trunc('month', now())`,
      [tenantId],
    ),
  ]);
  return shapeTenantUsage(
    days,
    totalsRow ?? { runs: 0, completed_runs: 0, infra_credits: 0, ai_credits: 0, byok_runs: 0, harness_runs: 0 },
    costRow?.model_cost_usd ?? "0",
    dailyRows,
    recentRows,
    cycleRow?.cycle_credits_used ?? 0,
  );
}

/**
 * Billing key-source classification. It MIRRORS the runtime credential precedence used by
 * resolveIntegrationKeysForRun: author harness > tenant OpenRouter key > managed. Billing must agree
 * with what the run actually executes on, because only "managed" consumes the managed-AI entitlement
 * (and is billed). "harness"/"user" runs execute on the author's / tenant's own credential and are
 * never billed for AI. review_run_billing.key_source is pinned to this value.
 */
export type BillingKeySource = "harness" | "user" | "managed";

export interface RunBillingContext {
  tenantId: string;
  // Derived from author-harness / tenant-key presence with runtime precedence (see BillingKeySource).
  keySource: BillingKeySource;
  // 'User' | 'Organization'. Surfaced so billing can flag Organization tenants whose per-user
  // keys/model-settings are invisible under the current identity mapping (see membership note below).
  githubAccountType?: string;
  // review_runs.trigger — 'webhook' | 'manual' | 'scheduled' | 'policy'. The auto-review cap applies to
  // AUTO triggers only (everything except 'manual'); the enforcement helper reads this to bypass manual runs.
  triggerSource?: string;
  // "login (org|personal)" — passed to Autumn's get_or_create so gate-created customers arrive NAMED
  // (webhook-driven first touches create the customer here, not in the dashboard).
  customerName?: string;
  policy: BillingPolicy;
}

export interface DispatchBillingContext {
  tenantId: string;
  keySource: BillingKeySource;
  githubAccountType?: string;
  customerName?: string;
}

/**
 * Derive the billing key source from the two independent credential-presence flags, honoring the same
 * precedence the runtime uses to pick a credential: an author harness wins over a tenant OpenRouter key,
 * which wins over managed. Exported as a tiny pure helper so the dispatch and run contexts classify
 * identically and the precedence is unit-testable without a database.
 */
/** "login (org|personal)" for the Autumn customer, or undefined when the login is the unbackfilled
 *  placeholder — better nameless than named "unknown (personal)". */
function composeAutumnCustomerName(login: string | null | undefined, accountType: string | null | undefined): string | undefined {
  if (!login || login === "unknown") {
    return undefined;
  }
  return `${login} (${accountType === "Organization" ? "org" : "personal"})`;
}

export function deriveKeySource(hasAuthorHarness: boolean, hasUserKey: boolean): BillingKeySource {
  if (hasAuthorHarness) {
    return "harness";
  }
  return hasUserKey ? "user" : "managed";
}

/** Resolve everything the billing service needs for a run: tenant, derived key source, policy. */
export async function getRunBillingContext(reviewRunId: string): Promise<RunBillingContext | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  // Two INDEPENDENT credential resolutions, mirroring resolveIntegrationKeysForRun so billing matches
  // runtime:
  //  - has_user_key: the TENANT's OpenRouter key on tenant_integrations (keyed by the run's tenant_id).
  //    Org tenants are first-class now, so an org-admin-managed key gates the run as "user" (own-key),
  //    not managed. github_account_type is still selected so billing can log affected orgs.
  //  - has_author_harness: the PR AUTHOR's Codex harness, joined via pull_requests.author_login to
  //    user_integrations.github_login (case-insensitively). We select only the presence boolean, NEVER
  //    the encrypted auth.json blob. An author harness is the highest-precedence credential at runtime,
  //    so billing classifies such a run as "harness" (own-subscription, not managed).
  const row = await queryOne<{
    tenant_id: string;
    has_openrouter: boolean;
    has_openai: boolean;
    model_provider: string | null;
    planner_model: string | null;
    investigation_model: string | null;
    review_model: string | null;
    model_settings_snapshot: unknown;
    has_author_harness: boolean;
    github_account_type: string | null;
    github_account_login: string | null;
    trigger_source: string | null;
  } & BillingPolicyRow>(
    `select t.id as tenant_id,
            case when coalesce(t.kind, case when lower(coalesce(t.github_account_type, '')) = 'user' then 'personal' else 'team' end) = 'team'
              then 'Organization' else 'User' end as github_account_type,
            coalesce(t.name, t.github_account_login) as github_account_login,
            r.trigger as trigger_source,
            (ti.openrouter_api_key is not null) as has_openrouter,
            (ti.openai_api_key is not null) as has_openai,
            tms.model_provider,
            tms.planner_model, tms.investigation_model, tms.review_model,
            r.model_settings_snapshot,
            (ui_author.codex_harness_auth is not null) as has_author_harness,
            bp.subsidy_rate, bp.infra_credits_per_run, bp.overage_infra_credits_per_run, bp.overage_subsidy_rate,
            bp.auto_review_limit_enabled, bp.auto_review_limit_credits
       from review_runs r
       join tenants t on t.id = r.tenant_id
       left join tenant_integrations ti on ti.tenant_id = t.id
       left join tenant_model_settings tms on tms.tenant_id = t.id
       left join pull_requests pr on pr.id = r.pull_request_id
       left join user_integrations ui_author on lower(ui_author.github_login) = lower(pr.author_login)
       left join tenant_billing_policy bp on bp.tenant_id = t.id
      where r.id = $1`,
    [reviewRunId],
  );
  if (!row) {
    return undefined;
  }
  // has_user_key uses the SAME routing decision the worker will (resolveRunKeys), including the whole-run
  // managed fallback, so billing never diverges from routing (a run that falls back to managed for coverage
  // is classified 'managed'/credits, not 'user'). Coverage prefers the prepare-time snapshot, exactly like
  // resolveIntegrationKeysForRun.
  const runProvider = normalizeModelProvider(row.model_provider);
  const runKeys = resolveRunKeys(
    runProvider,
    row.has_openrouter,
    row.has_openai,
    stageModelsAllOpenaiFamily(parseModelSettingsSnapshot(row.model_settings_snapshot) ?? row),
  );
  const hasUserKey = runKeys.openrouter || runKeys.openai;
  return {
    tenantId: row.tenant_id,
    // The harness classification follows the SAME selection gate as key resolution (harnessAllowed):
    // a tenant that explicitly picked 'byok' or 'managed' disabled the harness, so it must not bill as one.
    keySource: deriveKeySource(harnessAllowed(runProvider) && Boolean(row.has_author_harness), hasUserKey),
    githubAccountType: row.github_account_type ?? undefined,
    triggerSource: row.trigger_source ?? undefined,
    customerName: composeAutumnCustomerName(row.github_account_login, row.github_account_type),
    policy: policyFromRow(row, row.tenant_id),
  };
}

/**
 * Dispatch-time billing context resolved by installation id (the run row does not exist yet). The PR
 * author login is not on any row at this point — it comes from the webhook payload — so callers pass it
 * in for the author-harness join. Absent an authorLogin the harness join yields no match and the context
 * classifies on the tenant key alone (user/managed), exactly as before.
 */
export async function getDispatchBillingContext(
  installationId: number,
  authorLogin?: string,
): Promise<DispatchBillingContext | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  // has_user_key is a tenant BYOK credential on tenant_integrations (OpenRouter OR native OpenAI key,
  // keyed by tenant_id), so an org-admin-managed key gates dispatch as "user" too — matching the runtime,
  // where either key makes the run BYOK (billed infra-only). has_author_harness mirrors runtime precedence —
  // an author harness (matched case-insensitively on the webhook-supplied login) classifies dispatch as
  // "harness". github_account_type is selected so billing can log affected orgs.
  const row = await queryOne<{
    tenant_id: string;
    has_openrouter: boolean;
    has_openai: boolean;
    model_provider: string | null;
    planner_model: string | null;
    investigation_model: string | null;
    review_model: string | null;
    has_author_harness: boolean;
    github_account_type: string | null;
    github_account_login: string | null;
  }>(
    `select t.id as tenant_id,
            case when coalesce(t.kind, case when lower(coalesce(t.github_account_type, '')) = 'user' then 'personal' else 'team' end) = 'team'
              then 'Organization' else 'User' end as github_account_type,
            coalesce(t.name, t.github_account_login) as github_account_login,
            (ti.openrouter_api_key is not null) as has_openrouter,
            (ti.openai_api_key is not null) as has_openai,
            tms.model_provider,
            tms.planner_model, tms.investigation_model, tms.review_model,
            (ui_author.codex_harness_auth is not null) as has_author_harness
       from installations i
       join tenants t on t.id = i.tenant_id
       left join tenant_integrations ti on ti.tenant_id = t.id
       left join tenant_model_settings tms on tms.tenant_id = t.id
       left join user_integrations ui_author
              on $2::text is not null and lower(ui_author.github_login) = lower($2)
      where i.github_installation_id = $1`,
    [installationId, authorLogin ?? null],
  );
  if (!row) {
    return undefined;
  }
  const dispatchProvider = normalizeModelProvider(row.model_provider);
  const dispatchRunKeys = resolveRunKeys(
    dispatchProvider,
    row.has_openrouter,
    row.has_openai,
    stageModelsAllOpenaiFamily(row),
  );
  const hasUserKey = dispatchRunKeys.openrouter || dispatchRunKeys.openai;
  return {
    tenantId: row.tenant_id,
    // Same harness gate as runtime/billing: an explicit 'byok'/'managed' selection disables the harness.
    keySource: deriveKeySource(harnessAllowed(dispatchProvider) && Boolean(row.has_author_harness), hasUserKey),
    githubAccountType: row.github_account_type ?? undefined,
    customerName: composeAutumnCustomerName(row.github_account_login, row.github_account_type),
  };
}

/**
 * Resolve a dashboard viewer's personal Jina tenant for legacy routes.
 *
 * New sessions authorize by the internal user id only. The GitHub lookup is
 * retained exclusively for pre-transition sessions that do not carry userId;
 * a mismatched internal id must never borrow the legacy fallback.
 */
export async function getTenantIdForUser(
  githubUserId: number,
  userId?: string,
): Promise<string | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  const row = await queryOne<{ id: string }>(
    `select id
       from tenants
      where merged_into_tenant_id is null
        and (
          (
            $2::uuid is not null
            and personal_owner_user_id = $2::uuid
          ) or (
            $2::uuid is null
            and github_account_id = $1
          )
        )
      order by case when personal_owner_user_id = $2::uuid then 0 else 1 end
      limit 1`,
    [githubUserId, userId ?? null],
  );
  return row?.id;
}

export interface ReviewRunBilling {
  rate_mode: string;
  key_source: string | null;
  infra_credits_charged: number | null;
  ai_credits_charged_total: number;
  infra_billing_status: string;
}

/** Pin rate_mode on review_run_billing at prepare time. rate_mode is fixed at dispatch, so an
 *  existing row is never overwritten (on conflict do nothing). */
export async function upsertReviewRunBilling(input: {
  reviewRunId: string;
  tenantId: string;
  rateMode: "included" | "overage";
  keySource?: BillingKeySource;
}): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into review_run_billing (review_run_id, tenant_id, rate_mode, key_source, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (review_run_id) do nothing`,
    [input.reviewRunId, input.tenantId, input.rateMode, input.keySource ?? null],
  );
}

/**
 * FINDING 4: reconcile the run-level key_source with runtime truth. prepare pins
 * review_run_billing.key_source from tenant state, but the key actually USED at stage time can differ
 * (e.g. the user key was deleted between prepare and stage), and each usage row already carries the
 * posted key_source. On first usage arrival, overwrite the run-level column with the posted value so
 * the usage rows and the run record agree. Returns the PREVIOUS (pinned) value plus tenant id so the
 * caller can log billing_key_source_drift when it differed. Returns undefined when no billing row
 * exists yet (billing inactive at prepare) — nothing to reconcile.
 */
export async function reconcileReviewRunBillingKeySource(
  reviewRunId: string,
  keySource: BillingKeySource,
): Promise<{ pinned: string | null; tenantId: string } | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  // CTE captures the pre-update (pinned) value; the UPDATE stamps runtime truth. RETURNING surfaces
  // both so drift is observable without a second read.
  const row = await queryOne<{ pinned: string | null; tenant_id: string }>(
    `with prev as (
       select key_source, tenant_id from review_run_billing where review_run_id = $1
     )
     update review_run_billing b
        set key_source = $2, updated_at = now()
       from prev
      where b.review_run_id = $1
      returning prev.key_source as pinned, b.tenant_id as tenant_id`,
    [reviewRunId, keySource],
  );
  return row ? { pinned: row.pinned, tenantId: row.tenant_id } : undefined;
}

export async function getReviewRunBilling(reviewRunId: string): Promise<ReviewRunBilling | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  const row = await queryOne<{
    rate_mode: string;
    key_source: string | null;
    infra_credits_charged: number | null;
    ai_credits_charged_total: number;
    infra_billing_status: string;
  }>(
    `select rate_mode, key_source, infra_credits_charged, ai_credits_charged_total, infra_billing_status
       from review_run_billing where review_run_id = $1`,
    [reviewRunId],
  );
  return row ?? undefined;
}

export interface PendingUsageRow {
  id: string;
  review_run_id: string;
  tenant_id: string;
  dedupe_key: string;
  // The BYOK-aware billing basis (is_byok ? upstream+cost : cost). NULL on pre-0014 rows — the credit
  // math falls back to openrouter_cost for those. openrouter_cost stays the raw OpenRouter `cost` field.
  billable_cost: string | null;
  openrouter_cost: string | null;
  ai_credits_charged: number | null;
  // Stamped at claim time; present on rows read from a stale 'tracking' claim.
  autumn_event_id?: string | null;
}

/** Managed usage rows for a run still held as pending_outcome (awaiting the run's terminal outcome). */
export async function listRunUsagePendingOutcome(reviewRunId: string): Promise<PendingUsageRow[]> {
  if (!databaseConfigured()) {
    return [];
  }
  return query<PendingUsageRow>(
    `select id, review_run_id, tenant_id, dedupe_key, billable_cost, openrouter_cost, ai_credits_charged
       from review_llm_usage
      where review_run_id = $1 and billing_status = 'pending_outcome'
      order by recorded_at asc`,
    [reviewRunId],
  );
}

/** Compute-and-hold a usage row: record its share + ai credits and move pending_outcome -> pending. */
export async function setUsageComputedPending(
  usageId: string,
  customerShare: string,
  aiCredits: number,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `update review_llm_usage
        set customer_share = $2, ai_credits_charged = $3, billing_status = 'pending'
      where id = $1 and billing_status in ('pending_outcome', 'pending')`,
    [usageId, customerShare, aiCredits],
  );
}

/**
 * DECISION 1 (shadow never back-bills): record a usage row's computed share + credits but finalize it
 * as the terminal, non-billable status 'shadow_computed' instead of 'pending'. The retry drain selects
 * only 'pending' / 'pending_outcome' / 'tracking' rows, so a shadow_computed row is never billed even
 * after enforcement flips to "on". Idempotent: re-running keeps it shadow_computed.
 */
export async function setUsageShadowComputed(
  usageId: string,
  customerShare: string,
  aiCredits: number,
): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `update review_llm_usage
        set customer_share = $2, ai_credits_charged = $3, billing_status = 'shadow_computed'
      where id = $1 and billing_status in ('pending_outcome', 'shadow_computed')`,
    [usageId, customerShare, aiCredits],
  );
}

/**
 * Atomically claim a computed 'pending' usage row for tracking (single-flight). Stamps the Autumn
 * event id + claimed_at and moves 'pending' -> 'tracking'. Returns true iff this caller won the
 * claim; the conditional UPDATE is the mutual exclusion that prevents concurrent double-tracking.
 */
export async function claimUsageForTracking(usageId: string, autumnEventId: string): Promise<boolean> {
  if (!databaseConfigured()) {
    return false;
  }
  const rows = await query(
    `update review_llm_usage
        set billing_status = 'tracking', autumn_event_id = $2, claimed_at = now()
      where id = $1 and billing_status = 'pending'
      returning id`,
    [usageId, autumnEventId],
  );
  return rows.length === 1;
}

/** Revert a usage claim ('tracking' -> 'pending') after a track that did NOT charge. */
export async function revertUsageClaim(usageId: string): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `update review_llm_usage set billing_status = 'pending', claimed_at = null
      where id = $1 and billing_status = 'tracking'`,
    [usageId],
  );
}

/**
 * Mark a claimed usage row billed after a successful Autumn track ('tracking' -> 'billed').
 * Returns true iff this call actually performed the transition — callers gate the run's
 * ai_credits_charged_total increment on this so the total is added exactly once per row ever.
 */
export async function markUsageBilled(usageId: string, autumnEventId: string): Promise<boolean> {
  if (!databaseConfigured()) {
    return false;
  }
  const rows = await query(
    `update review_llm_usage
        set billing_status = 'billed', billed_at = now(), autumn_event_id = $2, claimed_at = null
      where id = $1 and billing_status = 'tracking'
      returning id`,
    [usageId, autumnEventId],
  );
  return rows.length === 1;
}

/**
 * Stale 'tracking' usage claims (claimed before `olderThan`): a crash likely happened after a
 * successful track but before the 'billed' persist. Returned for a same-event-id re-track.
 */
export async function listStaleTrackingUsageRows(limit: number, olderThan: Date): Promise<PendingUsageRow[]> {
  if (!databaseConfigured()) {
    return [];
  }
  return query<PendingUsageRow>(
    `select id, review_run_id, tenant_id, dedupe_key, billable_cost, openrouter_cost, ai_credits_charged, autumn_event_id
       from review_llm_usage
      where billing_status = 'tracking' and claimed_at < $2
      order by claimed_at asc
      limit $1`,
    [limit, olderThan],
  );
}

/** Re-claim a stale 'tracking' usage row (bump claimed_at) so concurrent retry workers don't both
 *  re-track it. Returns true iff this caller won the re-claim. */
export async function reclaimStaleTrackingUsage(usageId: string, olderThan: Date): Promise<boolean> {
  if (!databaseConfigured()) {
    return false;
  }
  const rows = await query(
    `update review_llm_usage set claimed_at = now()
      where id = $1 and billing_status = 'tracking' and claimed_at < $2
      returning id`,
    [usageId, olderThan],
  );
  return rows.length === 1;
}

/**
 * Waive a run's still-open managed AI usage rows (entitlement mismatch caught at settlement or replay).
 * FINDING 3: also waives 'tracking' rows so the stale-replay path can waive on a denied entitlement
 * recheck — a row is claimed 'tracking' before its first track, so a denied replay must waive it too.
 */
export async function waiveManagedUsageRows(reviewRunId: string): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `update review_llm_usage set billing_status = 'waived'
      where review_run_id = $1 and billing_status in ('pending_outcome', 'pending', 'tracking')`,
    [reviewRunId],
  );
}

/** Failed/superseded run: waive all still-open usage rows and the infra charge (charge nothing). */
export async function waiveRunBilling(reviewRunId: string, tenantId: string): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await withTransaction(async (client) => {
    await client.query(
      `update review_llm_usage set billing_status = 'waived'
        where review_run_id = $1 and billing_status in ('pending_outcome', 'pending')`,
      [reviewRunId],
    );
    await client.query(
      `insert into review_run_billing
         (review_run_id, tenant_id, rate_mode, infra_credits_charged, infra_billing_status, created_at, updated_at)
       values ($1, $2, 'included', 0, 'waived', now(), now())
       on conflict (review_run_id) do update set
          infra_credits_charged = 0, infra_billing_status = 'waived', updated_at = now()`,
      [reviewRunId, tenantId],
    );
  });
}

/**
 * Atomically claim a run's infra charge for tracking (single-flight). Creates the billing row if
 * absent (rate_mode pinned by the caller) and stamps the intended credits, event id, and
 * infra_claimed_at, moving 'pending' -> 'tracking'. Returns true iff this caller won the claim.
 */
export async function claimInfraForTracking(input: {
  reviewRunId: string;
  tenantId: string;
  rateMode: "included" | "overage";
  credits: number;
  autumnEventId: string;
}): Promise<boolean> {
  if (!databaseConfigured()) {
    return false;
  }
  const rows = await query(
    `insert into review_run_billing
       (review_run_id, tenant_id, rate_mode, infra_credits_charged, infra_billing_status,
        infra_autumn_event_id, infra_claimed_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'tracking', $5, now(), now(), now())
     on conflict (review_run_id) do update set
        infra_credits_charged = $4, infra_billing_status = 'tracking', infra_autumn_event_id = $5,
        infra_claimed_at = now(), updated_at = now()
      where review_run_billing.infra_billing_status = 'pending'
     returning review_run_id`,
    [input.reviewRunId, input.tenantId, input.rateMode, input.credits, input.autumnEventId],
  );
  return rows.length === 1;
}

/** Revert an infra claim ('tracking' -> 'pending') after a track that did NOT charge. */
export async function revertInfraClaim(reviewRunId: string): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `update review_run_billing set infra_billing_status = 'pending', infra_claimed_at = null
      where review_run_id = $1 and infra_billing_status = 'tracking'`,
    [reviewRunId],
  );
}

/** Record the one-shot infra charge for a claimed run ('tracking' -> 'billed'). */
export async function markInfraBilled(input: {
  reviewRunId: string;
  tenantId: string;
  rateMode: "included" | "overage";
  credits: number;
  autumnEventId: string;
}): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `update review_run_billing
        set infra_billing_status = 'billed', infra_credits_charged = $2, infra_autumn_event_id = $3,
            infra_claimed_at = null, updated_at = now()
      where review_run_id = $1 and infra_billing_status = 'tracking'`,
    [input.reviewRunId, input.credits, input.autumnEventId],
  );
}

export interface StaleTrackingInfra {
  reviewRunId: string;
  tenantId: string;
  status: string;
  credits: number | null;
  autumnEventId: string | null;
  rateMode: string;
}

/** Stale 'tracking' infra claims (claimed before `olderThan`) — for a same-event-id re-track. */
export async function listStaleTrackingInfra(limit: number, olderThan: Date): Promise<StaleTrackingInfra[]> {
  if (!databaseConfigured()) {
    return [];
  }
  const rows = await query<{
    review_run_id: string;
    tenant_id: string;
    status: string;
    infra_credits_charged: number | null;
    infra_autumn_event_id: string | null;
    rate_mode: string;
  }>(
    `select b.review_run_id, b.tenant_id, r.status, b.infra_credits_charged, b.infra_autumn_event_id, b.rate_mode
       from review_run_billing b
       join review_runs r on r.id = b.review_run_id
      where b.infra_billing_status = 'tracking' and b.infra_claimed_at < $2
      limit $1`,
    [limit, olderThan],
  );
  return rows.map((row) => ({
    reviewRunId: row.review_run_id,
    tenantId: row.tenant_id,
    status: row.status,
    credits: row.infra_credits_charged,
    autumnEventId: row.infra_autumn_event_id,
    rateMode: row.rate_mode,
  }));
}

/** Re-claim a stale 'tracking' infra row (bump infra_claimed_at). Returns true iff this caller won. */
export async function reclaimStaleTrackingInfra(reviewRunId: string, olderThan: Date): Promise<boolean> {
  if (!databaseConfigured()) {
    return false;
  }
  const rows = await query(
    `update review_run_billing set infra_claimed_at = now()
      where review_run_id = $1 and infra_billing_status = 'tracking' and infra_claimed_at < $2
      returning review_run_id`,
    [reviewRunId, olderThan],
  );
  return rows.length === 1;
}

/** Record the computed infra credits but leave infra_billing_status 'pending' (the retry job drains it
 *  under "on"). Never downgrades a billed/waived row. Used when settlement defers the actual track. */
export async function setInfraPending(input: {
  reviewRunId: string;
  tenantId: string;
  rateMode: "included" | "overage";
  credits: number;
}): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into review_run_billing
       (review_run_id, tenant_id, rate_mode, infra_credits_charged, infra_billing_status, created_at, updated_at)
     values ($1, $2, $3, $4, 'pending', now(), now())
     on conflict (review_run_id) do update set
        infra_credits_charged = $4, updated_at = now()
      where review_run_billing.infra_billing_status = 'pending'`,
    [input.reviewRunId, input.tenantId, input.rateMode, input.credits],
  );
}

/**
 * DECISION 1 (shadow never back-bills): record the computed infra credits but finalize
 * infra_billing_status as the terminal, non-billable 'shadow_computed' instead of 'pending'. The retry
 * drain scans only 'pending' / 'tracking' infra rows, so this is never billed even after a flip to
 * "on". Idempotent and never downgrades a billed/waived row.
 */
export async function setInfraShadowComputed(input: {
  reviewRunId: string;
  tenantId: string;
  rateMode: "included" | "overage";
  credits: number;
}): Promise<void> {
  if (!databaseConfigured()) {
    return;
  }
  await query(
    `insert into review_run_billing
       (review_run_id, tenant_id, rate_mode, infra_credits_charged, infra_billing_status, created_at, updated_at)
     values ($1, $2, $3, $4, 'shadow_computed', now(), now())
     on conflict (review_run_id) do update set
        infra_credits_charged = $4, infra_billing_status = 'shadow_computed', updated_at = now()
      where review_run_billing.infra_billing_status in ('pending', 'shadow_computed')`,
    [input.reviewRunId, input.tenantId, input.rateMode, input.credits],
  );
}

export async function addRunAiCreditsTotal(reviewRunId: string, credits: number): Promise<void> {
  if (!databaseConfigured() || credits === 0) {
    return;
  }
  await query(
    `update review_run_billing set ai_credits_charged_total = ai_credits_charged_total + $2, updated_at = now()
      where review_run_id = $1`,
    [reviewRunId, credits],
  );
}

export async function getReviewRunStatus(reviewRunId: string): Promise<string | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  const row = await queryOne<{ status: string }>(`select status from review_runs where id = $1`, [reviewRunId]);
  return row?.status;
}

/** 'pending' usage rows (credits already computed) awaiting an Autumn track — for the retry job. */
export async function listPendingUsageRows(limit: number): Promise<PendingUsageRow[]> {
  if (!databaseConfigured()) {
    return [];
  }
  return query<PendingUsageRow>(
    `select id, review_run_id, tenant_id, dedupe_key, billable_cost, openrouter_cost, ai_credits_charged
       from review_llm_usage
      where billing_status = 'pending'
      order by recorded_at asc
      limit $1`,
    [limit],
  );
}

/** Terminal runs that still have pending_outcome usage rows (late callbacks / interrupted settlement). */
export async function listTerminalRunsWithPendingOutcome(
  limit: number,
): Promise<{ reviewRunId: string; status: string }[]> {
  if (!databaseConfigured()) {
    return [];
  }
  const rows = await query<{ review_run_id: string; status: string }>(
    `select distinct u.review_run_id, r.status
       from review_llm_usage u
       join review_runs r on r.id = u.review_run_id
      where u.billing_status = 'pending_outcome' and r.status = any($1)
      limit $2`,
    [TERMINAL_RUN_STATUSES, limit],
  );
  return rows.map((row) => ({ reviewRunId: row.review_run_id, status: row.status }));
}

/** Terminal runs whose infra charge is still pending — for the retry job. */
export async function listRunsWithPendingInfra(limit: number): Promise<{ reviewRunId: string; status: string }[]> {
  if (!databaseConfigured()) {
    return [];
  }
  const rows = await query<{ review_run_id: string; status: string }>(
    `select b.review_run_id, r.status
       from review_run_billing b
       join review_runs r on r.id = b.review_run_id
      where b.infra_billing_status = 'pending' and r.status = any($1)
      limit $2`,
    [TERMINAL_RUN_STATUSES, limit],
  );
  return rows.map((row) => ({ reviewRunId: row.review_run_id, status: row.status }));
}

export async function knownProjects(tenantId?: string): Promise<ProjectRecord[]> {
  if (!databaseConfigured()) {
    return [];
  }

  const rows = await query<{ github_repo_id: number | null; owner: string; name: string; private: boolean | null }>(
    `select distinct repo.github_repo_id, repo.owner, repo.name, repo.private
     from repositories repo
       join review_runs r on r.repository_id = repo.id
     where ($1::uuid is null or r.tenant_id = $1)
     order by repo.owner, repo.name`,
    [tenantId ?? null],
  );

  return rows.map((row) => ({
    github_repo_id: row.github_repo_id ?? undefined,
    full_name: `${row.owner}/${row.name}`,
    owner: row.owner,
    name: row.name,
    private: row.private ?? undefined,
  }));
}

/* -------------------------------------------------------------- sessions --- */

const memSessions = new Map<string, DashboardSession>();
const memOauthStates = new Map<string, { returnTo: string; expiresAt: number }>();

export async function upsertGithubUserIdentity(
  profile: GithubIdentityProfile,
): Promise<InternalUserIdentity | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  return withTransaction((client) => upsertGithubUserIdentityWithClient(client, profile));
}

export async function linkClerkUserIdentity(
  profile: ClerkIdentityProfile,
): Promise<ClerkIdentityLinkResult | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  return withTransaction((client) => linkClerkUserIdentityWithClient(client, profile));
}

export interface ResolvedClerkUserIdentity {
  userId: string;
  githubUserId: number;
  githubLogin: string;
}

/** Resolve a prelinked Clerk principal without relying on mutable email/name fields. */
export async function resolveClerkUserIdentity(
  clerkUserId: string,
  externalUserId?: string | null,
): Promise<ResolvedClerkUserIdentity | undefined> {
  if (!databaseConfigured()) return undefined;
  const externalId = externalUserId
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(externalUserId)
    ? externalUserId
    : null;
  const rows = await query<{
    user_id: string;
    github_user_id: number;
    github_login: string;
  }>(
    `select jina_user.id as user_id,
            github.provider_user_id::bigint as github_user_id,
            github.provider_login as github_login
       from users jina_user
       join user_identities github
         on github.user_id = jina_user.id and github.provider = 'github'
       left join user_identities clerk
         on clerk.user_id = jina_user.id and clerk.provider = 'clerk'
      where clerk.provider_user_id = $1
         or ($2::uuid is not null and jina_user.id = $2::uuid)`,
    [clerkUserId, externalId],
  );
  const uniqueUsers = new Set(rows.map((row) => row.user_id));
  if (uniqueUsers.size > 1) {
    throw new Error("Clerk principal and external id resolve to different Jina users");
  }
  const row = rows[0];
  if (!row?.github_login) return undefined;
  return {
    userId: row.user_id,
    githubUserId: Number(row.github_user_id),
    githubLogin: row.github_login,
  };
}

export async function saveSession(session: DashboardSession): Promise<void> {
  if (!databaseConfigured()) {
    memSessions.set(session.id, session);
    return;
  }
  await query(
    `insert into dashboard_sessions (id, session_json, expires_at, user_id)
     values ($1, $2, to_timestamp($3 / 1000.0), $4)
     on conflict (id) do update set
       session_json = excluded.session_json,
       expires_at = excluded.expires_at,
       user_id = excluded.user_id`,
    [session.id, JSON.stringify(encryptSessionSecrets(session)), session.expiresAt, session.userId ?? null],
  );
}

/**
 * Replace a session only while the caller's snapshot is still current.
 *
 * Refresh requests use this compare-and-swap path instead of the login upsert,
 * so a concurrent logout cannot be undone and refreshes from separate API
 * instances cannot overwrite a newer access snapshot.
 */
export async function updateSessionIfCurrent(session: DashboardSession, expectedUpdatedAt: string): Promise<boolean> {
  if (!databaseConfigured()) {
    const current = memSessions.get(session.id);
    if (!current || current.updatedAt !== expectedUpdatedAt) {
      return false;
    }
    memSessions.set(session.id, session);
    return true;
  }
  const rows = await query<{ id: string }>(
    `update dashboard_sessions
        set session_json = $2,
            expires_at = to_timestamp($3 / 1000.0),
            user_id = coalesce($5, user_id)
      where id = $1 and session_json ->> 'updatedAt' = $4
      returning id`,
    [session.id, JSON.stringify(encryptSessionSecrets(session)), session.expiresAt, expectedUpdatedAt, session.userId ?? null],
  );
  return rows.length === 1;
}

export async function getSession(id: string): Promise<DashboardSession | undefined> {
  if (!databaseConfigured()) {
    return memSessions.get(id);
  }
  const row = await queryOne<{ session_json: DashboardSession; user_id: string | null }>(
    `select session_json, user_id from dashboard_sessions where id = $1`,
    [id],
  );
  if (!row?.session_json) {
    return undefined;
  }
  const session = decryptSessionSecrets(row.session_json);
  return row.user_id ? { ...session, userId: row.user_id } : session;
}

// The GitHub access token is the only secret in the session blob; encrypt it at rest.
function encryptSessionSecrets(session: DashboardSession): DashboardSession {
  if (!session.accessToken) {
    return session;
  }
  return { ...session, accessToken: encryptSecret(session.accessToken) };
}

function decryptSessionSecrets(session: DashboardSession): DashboardSession {
  if (!session.accessToken) {
    return session;
  }
  return { ...session, accessToken: decryptSecret(session.accessToken) };
}

export async function deleteSession(id: string): Promise<void> {
  if (!databaseConfigured()) {
    memSessions.delete(id);
    return;
  }
  await query(`delete from dashboard_sessions where id = $1`, [id]);
}

export async function saveOauthState(state: string, returnTo: string, expiresAt: number): Promise<void> {
  if (!databaseConfigured()) {
    memOauthStates.set(state, { returnTo, expiresAt });
    return;
  }
  await query(
    `insert into oauth_states (state, return_to, expires_at)
     values ($1, $2, to_timestamp($3 / 1000.0))
     on conflict (state) do update set return_to = excluded.return_to, expires_at = excluded.expires_at`,
    [state, returnTo, expiresAt],
  );
}

export async function consumeOauthState(state: string): Promise<string | undefined> {
  if (!databaseConfigured()) {
    const entry = memOauthStates.get(state);
    memOauthStates.delete(state);
    return entry && entry.expiresAt > Date.now() ? entry.returnTo : undefined;
  }
  const row = await queryOne<{ return_to: string; expires_at: Date | string }>(
    `delete from oauth_states where state = $1 returning return_to, expires_at`,
    [state],
  );
  if (!row) {
    return undefined;
  }
  return new Date(row.expires_at).getTime() > Date.now() ? row.return_to : undefined;
}

/* ----------------------------------------------- scenarios + simulations --- */

interface SimScenario {
  id?: string;
  index?: number;
  title?: string;
  risk?: string;
  status?: string;
  final_verdict?: string;
  confidence?: number;
  source_files?: unknown;
  steps?: SimStep[];
  lineage_key?: string;
}

interface SimStep {
  step_index?: number;
  step_text?: string;
  step_status?: string;
  scenario_verdict?: string;
  consensus_reached?: boolean;
  predicted_output?: string;
  confidence?: number;
}

interface RawFinding {
  fingerprint?: unknown;
  file_path?: unknown;
  line_number?: unknown;
  severity?: unknown;
  category?: unknown;
  body?: unknown;
}

export async function persistReviewFindings(reviewRunId: string, result: unknown): Promise<void> {
  if (!databaseConfigured() || !result || typeof result !== "object" || Array.isArray(result)) {
    return;
  }

  const findings = extractFindings(result);
  if (findings.length === 0) {
    return;
  }

  await withTransaction(async (client) => {
    const runRow = await client.query<{ tenant_id: string }>(
      `select tenant_id from review_runs where id = $1`,
      [reviewRunId],
    );
    const tenantId = runRow.rows[0]?.tenant_id;
    if (!tenantId) {
      return;
    }

    for (const finding of findings) {
      await client.query(
        `insert into review_findings
           (tenant_id, review_run_id, fingerprint, file_path, line_number, severity, category, body)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (review_run_id, fingerprint) do update set
           file_path = excluded.file_path,
           line_number = excluded.line_number,
           severity = excluded.severity,
           category = excluded.category,
           body = excluded.body`,
        [
          tenantId,
          reviewRunId,
          finding.fingerprint,
          finding.file_path ?? null,
          finding.line_number ?? null,
          finding.severity,
          finding.category,
          finding.body,
        ],
      );
    }
  });
}

/** Persist a run's scenario plans (with steps) and any simulation instances (with steps). */
export async function persistScenariosAndSimulations(reviewRunId: string, result: unknown): Promise<void> {
  if (!databaseConfigured() || !result || typeof result !== "object") {
    return;
  }
  const r = result as Record<string, unknown>;
  const markdown =
    (typeof r.review_markdown === "string" ? r.review_markdown : undefined) ??
    (typeof r.markdown_preview === "string" ? r.markdown_preview : undefined);
  const jsonPlans = parseScenarioJson(r.scenario_json);
  const plans = jsonPlans.length > 0 ? jsonPlans : parseScenarios(markdown);
  const simulation =
    r.simulation && typeof r.simulation === "object" ? (r.simulation as Record<string, unknown>) : undefined;
  const simScenarios: SimScenario[] = Array.isArray(simulation?.scenarios)
    ? (simulation.scenarios as SimScenario[])
    : [];

  if (plans.length === 0 && simScenarios.length === 0) {
    return;
  }

  // Top-level rerun/question metadata lives on the simulation object itself.
  const simKind = typeof simulation?.kind === "string" ? simulation.kind : "review";
  const simPrior = simulation?.prior;
  const simPriorHash = typeof simulation?.prior_hash === "string" ? simulation.prior_hash : null;
  const simQuestion = typeof simulation?.question === "string" ? simulation.question : null;
  const simAnswer = typeof simulation?.answer === "string" ? simulation.answer : null;

  await withTransaction(async (client) => {
    const runRow = await client.query<{
      tenant_id: string | null;
      repository_id: string | null;
      pr_number: string | number | null;
    }>(
      `select r.tenant_id, r.repository_id, pr.pr_number
         from review_runs r
         left join pull_requests pr on pr.id = r.pull_request_id
        where r.id = $1`,
      [reviewRunId],
    );
    if (runRow.rows.length === 0) {
      return;
    }
    const tenantId = runRow.rows[0].tenant_id;
    const repositoryId = runRow.rows[0].repository_id;
    const prNumber = numberOrNull(runRow.rows[0].pr_number);

    // Idempotent: clear previous scenarios for this run (cascades steps + simulations).
    await client.query(`delete from scenarios where review_run_id = $1`, [reviewRunId]);

    // Lineage key is carried per scenario on the simulation payload; index it so the
    // persisted scenario snapshot can be linked to its durable lineage.
    const lineageKeyByIndex = new Map<number, string>();
    for (const sim of simScenarios) {
      const key = typeof sim.lineage_key === "string" && sim.lineage_key.trim() ? sim.lineage_key.trim() : undefined;
      if (key !== undefined && typeof sim.index === "number") {
        lineageKeyByIndex.set(sim.index, key);
      }
    }

    const scenarioIdByIndex = new Map<number, string>();
    // Caches keyed by lineage_key so repeated scenarios in the same run reuse the rows.
    const caches: LineageCaches = { lineageIdByKey: new Map(), versionIdByKey: new Map() };
    const planList: ParsedScenario[] = plans.length > 0 ? plans : simScenarios.map(simToPlan);

    for (const plan of planList) {
      const lineageKey = lineageKeyByIndex.get(plan.index);
      let lineageId: string | null = null;
      if (lineageKey && repositoryId && prNumber !== null) {
        ({ lineageId } = await ensureLineageAndVersion(client, plan, { tenantId, repositoryId, prNumber, lineageKey }, caches));
      }

      const scenarioId = await insertScenario(client, tenantId, reviewRunId, plan, lineageId, lineageKey ?? null);
      scenarioIdByIndex.set(plan.index, scenarioId);
      for (let i = 0; i < plan.steps.length; i += 1) {
        await client.query(
          `insert into scenario_steps (scenario_id, step_index, text, step_type) values ($1, $2, $3, $4)`,
          [scenarioId, i + 1, plan.steps[i], scenarioStepType(plan.steps[i] ?? "")],
        );
      }
    }

    for (const sim of simScenarios) {
      const index = typeof sim.index === "number" ? sim.index : undefined;
      const lineageKey =
        typeof sim.lineage_key === "string" && sim.lineage_key.trim() ? sim.lineage_key.trim() : undefined;
      let scenarioId = index !== undefined ? scenarioIdByIndex.get(index) : undefined;
      let lineageId = lineageKey ? caches.lineageIdByKey.get(lineageKey) ?? null : null;
      let scenarioVersionId = lineageKey ? caches.versionIdByKey.get(lineageKey) ?? null : null;
      if (!scenarioId) {
        const plan = simToPlan(sim);
        if (lineageKey && repositoryId && prNumber !== null && lineageId === null) {
          ({ lineageId, versionId: scenarioVersionId } = await ensureLineageAndVersion(
            client,
            plan,
            { tenantId, repositoryId, prNumber, lineageKey },
            caches,
          ));
        }
        scenarioId = await insertScenario(client, tenantId, reviewRunId, plan, lineageId, lineageKey ?? null);
        scenarioIdByIndex.set(plan.index, scenarioId);
      }

      const simRow = await client.query<{ id: string }>(
        `insert into simulations
           (tenant_id, scenario_id, review_run_id, mode, status, final_verdict, confidence, commit, completed_at, raw_json,
            lineage_id, scenario_version_id, prior_state, prior_hash, kind, question, answer)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
        [
          tenantId,
          scenarioId,
          reviewRunId,
          typeof simulation?.mode === "string" ? simulation.mode : null,
          String(sim.status ?? "unknown"),
          sim.final_verdict ?? null,
          numberOrNull(sim.confidence),
          typeof simulation?.commit === "string" ? simulation.commit : null,
          typeof simulation?.completed_at === "string" ? simulation.completed_at : null,
          JSON.stringify(sim),
          lineageId,
          scenarioVersionId,
          jsonOrNull(simPrior),
          simPriorHash,
          simKind,
          simQuestion,
          simAnswer,
        ],
      );
      const simulationId = simRow.rows[0].id;

      const steps = Array.isArray(sim.steps) ? sim.steps : [];
      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i] ?? {};
        await client.query(
          `insert into simulation_steps
             (simulation_id, step_index, step_text, step_status, scenario_verdict, consensus_reached, predicted_output, confidence, raw_json)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            simulationId,
            typeof step.step_index === "number" ? step.step_index : i + 1,
            step.step_text ?? null,
            step.step_status ?? null,
            step.scenario_verdict ?? null,
            typeof step.consensus_reached === "boolean" ? step.consensus_reached : null,
            step.predicted_output ?? null,
            numberOrNull(step.confidence),
            JSON.stringify(step),
          ],
        );
      }
    }
  });
}

async function insertScenario(
  client: pg.PoolClient,
  tenantId: string | null,
  reviewRunId: string,
  plan: ParsedScenario,
  lineageId: string | null,
  fingerprint: string | null,
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `insert into scenarios
       (tenant_id, review_run_id, scenario_key, scenario_index, title, risk, intent, justification, relevant_paths, markdown, lineage_id, fingerprint)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (review_run_id, scenario_key) do update set
        title = excluded.title, risk = excluded.risk, intent = excluded.intent,
        justification = excluded.justification, relevant_paths = excluded.relevant_paths, markdown = excluded.markdown,
        lineage_id = excluded.lineage_id, fingerprint = excluded.fingerprint
     returning id`,
    [
      tenantId,
      reviewRunId,
      plan.id,
      plan.index,
      plan.title,
      plan.risk,
      plan.expectedResult ?? null,
      plan.context ?? null,
      JSON.stringify(plan.relevantPaths ?? []),
      plan.markdown ?? null,
      lineageId,
      fingerprint,
    ],
  );
  return rows.rows[0].id;
}

interface LineageContext { tenantId: string | null; repositoryId: string; prNumber: number; lineageKey: string }
interface LineageCaches { lineageIdByKey: Map<string, string>; versionIdByKey: Map<string, string> }

/** Upsert the lineage + its current version (course) for a scenario, caching both
 *  by lineage_key so the plan and simulation passes reuse the rows. */
async function ensureLineageAndVersion(
  client: pg.PoolClient,
  plan: ParsedScenario,
  ctx: LineageContext,
  caches: LineageCaches,
): Promise<{ lineageId: string; versionId: string }> {
  const lineageId = await upsertScenarioLineage(client, {
    tenantId: ctx.tenantId,
    repositoryId: ctx.repositoryId,
    prNumber: ctx.prNumber,
    lineageKey: ctx.lineageKey,
    title: plan.title,
    risk: plan.risk,
    relevantPaths: plan.relevantPaths ?? [],
  });
  caches.lineageIdByKey.set(ctx.lineageKey, lineageId);
  const versionId = await upsertScenarioVersion(client, {
    lineageId,
    steps: plan.steps,
    markdown: plan.markdown ?? null,
    origin: "generated",
  });
  caches.versionIdByKey.set(ctx.lineageKey, versionId);
  return { lineageId, versionId };
}

/** Upsert a durable scenario lineage keyed by (repository_id, pr_number, lineage_key). */
async function upsertScenarioLineage(
  client: pg.PoolClient,
  input: {
    tenantId: string | null;
    repositoryId: string;
    prNumber: number;
    lineageKey: string;
    title: string;
    risk: string;
    relevantPaths: string[];
  },
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `insert into scenario_lineages
       (tenant_id, repository_id, pr_number, lineage_key, title, risk, relevant_paths)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (repository_id, pr_number, lineage_key) do update set
        title = excluded.title, risk = excluded.risk, relevant_paths = excluded.relevant_paths
     returning id`,
    [
      input.tenantId,
      input.repositoryId,
      input.prNumber,
      input.lineageKey,
      input.title,
      input.risk,
      JSON.stringify(input.relevantPaths ?? []),
    ],
  );
  return rows.rows[0].id;
}

/**
 * Upsert a scenario version (a concrete course) keyed by (lineage_id, version_hash).
 * version_index is the count of existing versions + 1 on insert; an identical course
 * (same normalized steps) is reused rather than duplicated.
 */
async function upsertScenarioVersion(
  client: pg.PoolClient,
  input: {
    lineageId: string;
    steps: string[];
    markdown: string | null;
    origin: string;
    createdBy?: string | null;
  },
): Promise<string> {
  const versionHash = scenarioVersionHash(input.steps);
  const rows = await client.query<{ id: string }>(
    `insert into scenario_versions
       (lineage_id, version_index, version_hash, steps, markdown, origin, created_by)
     values (
        $1,
        (select count(*) from scenario_versions where lineage_id = $1) + 1,
        $2, $3, $4, $5, $6
     )
     on conflict (lineage_id, version_hash) do update set markdown = coalesce(excluded.markdown, scenario_versions.markdown)
     returning id`,
    [
      input.lineageId,
      versionHash,
      JSON.stringify(input.steps ?? []),
      input.markdown,
      input.origin,
      input.createdBy ?? null,
    ],
  );
  return rows.rows[0].id;
}

/** Content hash of a normalized steps array (sha256 hex, first 12 chars). */
function scenarioVersionHash(steps: string[]): string {
  const normalized = (steps ?? []).map((step) => (typeof step === "string" ? step.trim() : String(step ?? "")));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
}

function simToPlan(sim: SimScenario): ParsedScenario {
  const index = typeof sim.index === "number" ? sim.index : 0;
  return {
    id: sim.id ?? `scenario-${index}`,
    index,
    risk: (sim.risk as ParsedScenario["risk"]) ?? "unknown",
    title: sim.title ?? `Scenario ${index}`,
    steps: Array.isArray(sim.steps) ? sim.steps.map((step) => step.step_text ?? "").filter(Boolean) : [],
    relevantPaths: Array.isArray(sim.source_files) ? (sim.source_files as string[]) : [],
    markdown: "",
  };
}

function extractFindings(result: object): {
  fingerprint: string;
  file_path?: string;
  line_number?: number;
  severity: string;
  category: string;
  body: string;
}[] {
  const record = result as Record<string, unknown>;
  const finalReview = record.final_review && typeof record.final_review === "object" && !Array.isArray(record.final_review)
    ? (record.final_review as Record<string, unknown>)
    : undefined;
  const rawFindings = Array.isArray(finalReview?.findings)
    ? finalReview.findings
    : Array.isArray(record.findings)
      ? record.findings
      : [];

  return rawFindings.map(normalizeFinding).filter((finding): finding is NonNullable<ReturnType<typeof normalizeFinding>> => Boolean(finding));
}

function normalizeFinding(value: unknown): {
  fingerprint: string;
  file_path?: string;
  line_number?: number;
  severity: string;
  category: string;
  body: string;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as RawFinding;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) {
    return undefined;
  }
  const filePath = typeof raw.file_path === "string" && raw.file_path.trim() ? raw.file_path.trim() : undefined;
  const lineNumber = typeof raw.line_number === "number" && Number.isFinite(raw.line_number) ? Math.trunc(raw.line_number) : undefined;
  const severity = typeof raw.severity === "string" && raw.severity.trim() ? raw.severity.trim().toLowerCase() : "medium";
  const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim().toLowerCase() : "correctness";
  const fingerprint =
    typeof raw.fingerprint === "string" && raw.fingerprint.trim()
      ? raw.fingerprint.trim()
      : [filePath ?? "", lineNumber ?? "", severity, category, body].join(":").slice(0, 240);

  return {
    fingerprint,
    file_path: filePath,
    line_number: lineNumber,
    severity,
    category,
    body,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ----------------------------------------------------------------- internals -- */

async function resolveTenantId(
  client: pg.PoolClient,
  input: { installationId?: number; accountId?: number; accountLogin?: string; accountType?: string },
): Promise<string> {
  if (input.installationId) {
    const existing = await client.query<{ tenant_id: string }>(
      `select tenant_id from installations where github_installation_id = $1`,
      [input.installationId],
    );
    // Once a GitHub installation is connected, that explicit Jina workspace
    // binding is authoritative. Account metadata may describe any one of the
    // tenant's GitHub orgs and must never pull the installation back to the
    // legacy account-derived tenant.
    if (existing.rows[0]) {
      return existing.rows[0].tenant_id;
    }
  }

  const accountId = input.accountId ?? input.installationId;
  if (!accountId) {
    throw new Error("cannot resolve tenant without an account or installation id");
  }

  const rows = await client.query<{ id: string }>(
    `insert into tenants
       (github_account_id, github_account_login, github_account_type, kind, name, personal_owner_user_id)
     values (
       $1,
       $2,
       $3,
       case when lower($3) = 'user' then 'personal' else 'team' end,
       $2,
       case
         when lower($3) = 'user' then (
           select user_id
             from user_identities
            where provider = 'github' and provider_user_id = $1::bigint::text
         )
         else null
       end
     )
     on conflict (github_account_id) do update
        set github_account_login = excluded.github_account_login,
            github_account_type = excluded.github_account_type,
            kind = coalesce(tenants.kind, excluded.kind),
            name = coalesce(tenants.name, excluded.name),
            personal_owner_user_id = coalesce(tenants.personal_owner_user_id, excluded.personal_owner_user_id)
     returning coalesce(tenants.merged_into_tenant_id, tenants.id) as id`,
    [accountId, input.accountLogin ?? "unknown", input.accountType ?? "Organization"],
  );
  return rows.rows[0].id;
}

async function upsertInstallation(
  client: pg.PoolClient,
  tenantId: string,
  installationId: number,
  account?: { id?: number; login?: string; type?: string },
  installedByGithubUserId?: number,
  lifecycle?: InstallationLifecycle,
): Promise<string> {
  const rows = await client.query<{ id: string; tenant_id: string }>(
    `insert into installations
       (tenant_id, github_installation_id, github_account_id, github_account_login, github_account_type,
        installed_by_github_user_id, installer_verified_at, suspended_at, deleted_at)
     values (
       $1, $2, $3, $4, $5, $6,
       case when $6::bigint is not null then now() else null end,
       case when $7::text in ('suspended', 'deleted') then now() else null end,
       case when $7::text = 'deleted' then now() else null end
     )
     on conflict (github_installation_id) do update set
       tenant_id = installations.tenant_id,
       github_account_id = coalesce(excluded.github_account_id, installations.github_account_id),
       github_account_login = coalesce(excluded.github_account_login, installations.github_account_login),
       github_account_type = coalesce(excluded.github_account_type, installations.github_account_type),
       installed_by_github_user_id =
         coalesce(excluded.installed_by_github_user_id, installations.installed_by_github_user_id),
       installer_verified_at = case
         when excluded.installed_by_github_user_id is not null then now()
         else installations.installer_verified_at
       end,
       suspended_at = case
         when $7::text = 'active' then null
         when $7::text in ('suspended', 'deleted') then coalesce(installations.suspended_at, now())
         else installations.suspended_at
       end,
       deleted_at = case
         when $7::text = 'active' then null
         when $7::text = 'deleted' then coalesce(installations.deleted_at, now())
         else installations.deleted_at
       end
     returning id, tenant_id`,
    [
      tenantId,
      installationId,
      account?.id ?? null,
      account?.login ?? null,
      account?.type ?? null,
      installedByGithubUserId ?? null,
      lifecycle ?? null,
    ],
  );
  if (rows.rows[0]?.tenant_id !== tenantId) {
    throw new Error(`GitHub installation ${installationId} is already bound to another tenant`);
  }
  return rows.rows[0].id;
}

async function upsertRepository(
  client: pg.PoolClient,
  input: {
    tenantId: string;
    installationRecordId?: string;
    githubRepoId: number;
    owner: string;
    name: string;
    defaultBranch?: string;
    private?: boolean;
  },
): Promise<string> {
  const rows = await client.query<{ id: string; tenant_id: string }>(
    `insert into repositories
       (tenant_id, installation_id, github_repo_id, owner, name, default_branch, private)
     values ($1, $2, $3, $4, $5, coalesce($6, 'main'), coalesce($7, true))
     on conflict (github_repo_id) do update set
        tenant_id = repositories.tenant_id,
        installation_id = coalesce(excluded.installation_id, repositories.installation_id),
        owner = excluded.owner,
        name = excluded.name,
        default_branch = coalesce($6, repositories.default_branch),
        private = coalesce($7, repositories.private),
        enabled = true
     returning id, tenant_id`,
    [
      input.tenantId,
      input.installationRecordId ?? null,
      input.githubRepoId,
      input.owner,
      input.name,
      input.defaultBranch ?? null,
      input.private ?? null,
    ],
  );
  if (rows.rows[0]?.tenant_id !== input.tenantId) {
    throw new Error(`GitHub repository ${input.githubRepoId} is already bound to another tenant`);
  }
  return rows.rows[0].id;
}

async function upsertPullRequest(
  client: pg.PoolClient,
  input: {
    tenantId: string;
    repositoryId: string;
    number: number;
    title?: string;
    author?: string;
    headSha: string;
    baseSha?: string;
    headRef?: string;
    baseRef?: string;
    htmlUrl?: string;
    draft?: boolean;
  },
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `insert into pull_requests
        (tenant_id, repository_id, pr_number, title, author_login, head_sha, base_sha,
         head_ref, base_ref, state, draft, html_url, updated_at)
     values ($1,$2,$3,coalesce($4,''),$5,$6,$7,$8,$9,'open',coalesce($10,false),$11, now())
     on conflict (repository_id, pr_number) do update set
        title = coalesce(nullif(excluded.title, ''), pull_requests.title),
        author_login = coalesce(excluded.author_login, pull_requests.author_login),
        head_sha = excluded.head_sha,
        base_sha = excluded.base_sha,
        head_ref = coalesce(excluded.head_ref, pull_requests.head_ref),
        base_ref = coalesce(excluded.base_ref, pull_requests.base_ref),
        draft = excluded.draft,
        html_url = coalesce(excluded.html_url, pull_requests.html_url),
        updated_at = now()
     returning id`,
    [
      input.tenantId,
      input.repositoryId,
      input.number,
      input.title ?? null,
      input.author ?? null,
      input.headSha,
      input.baseSha ?? null,
      input.headRef ?? null,
      input.baseRef ?? null,
      input.draft ?? null,
      input.htmlUrl ?? null,
    ],
  );
  return rows.rows[0].id;
}

interface ReviewRunRow {
  id: string;
  trigger_run_id: string | null;
  delivery_id: string | null;
  source_event: string | null;
  trigger: string | null;
  status: string;
  bot_type: string;
  bot_status: string;
  run_head_sha: string | null;
  result_json: unknown;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
  github_repo_id: number | null;
  owner: string;
  name: string;
  private: boolean | null;
  github_installation_id: number | null;
  pr_number: number | null;
  pr_title: string | null;
  pr_html_url: string | null;
  author_login: string | null;
  pr_head_sha: string | null;
  base_sha: string | null;
  head_ref: string | null;
  base_ref: string | null;
  billing_key_source: string | null;
  billing_rate_mode: string | null;
  billing_infra_credits: number | null;
  billing_ai_credits: number | null;
  billing_infra_status: string | null;
}

interface EventRow {
  review_run_id: string;
  status: string;
  payload_json: unknown;
  trigger_run_id: string | null;
  recorded_at: Date | string;
}

interface FindingRow {
  id: string;
  review_run_id: string;
  fingerprint: string;
  file_path: string | null;
  line_number: number | null;
  severity: string;
  category: string;
  body: string;
  github_comment_id: number | null;
  created_at: Date | string;
  owner: string;
  name: string;
  pr_number: number | null;
  pr_title: string | null;
  pr_html_url: string | null;
}

function toReviewRunRecord(row: ReviewRunRow, events: ReviewEvent[]): ReviewRunRecord {
  const result = mergeRunResult(liveResultFromEvents(events), row.result_json);
  return {
    review_run_id: row.id,
    trigger_run_id: row.trigger_run_id ?? undefined,
    delivery_id: row.delivery_id ?? undefined,
    source_event: row.source_event ?? undefined,
    trigger: row.trigger ?? undefined,
    status: row.status,
    bot: { type: row.bot_type, status: row.bot_status },
    installation: { github_installation_id: row.github_installation_id ?? undefined },
    repository: {
      github_repo_id: row.github_repo_id ?? undefined,
      owner: row.owner,
      name: row.name,
      full_name: `${row.owner}/${row.name}`,
      private: row.private ?? undefined,
    },
    pull_request: {
      number: row.pr_number ?? undefined,
      title: row.pr_title ?? undefined,
      html_url: row.pr_html_url ?? undefined,
      author: row.author_login ?? undefined,
      head_sha: row.pr_head_sha ?? row.run_head_sha ?? undefined,
      base_sha: row.base_sha ?? undefined,
      head_ref: row.head_ref ?? undefined,
      base_ref: row.base_ref ?? undefined,
    },
    result,
    error: row.error ?? undefined,
    billing: toRunBilling(row),
    events,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    finished_at: row.finished_at ? toIso(row.finished_at) : undefined,
  };
}

/**
 * Shape the per-run billing (from review_run_billing) for the review record. Pure + exported for unit
 * tests. Returns undefined when there is no billing row at all (older runs / no prepare).
 *
 * SETTLEMENT-AWARE TOTAL: infra settles asynchronously — `prepareRunBilling` inserts the row as
 * 'pending' with a NULL infra charge and the default AI 0. Summing a null infra as zero would render a
 * finalized-looking "0 credits" mid-flight, so `total_credits` stays null while the infra status is
 * 'pending'/'tracking' (unsettled) and is only computed once it has settled (billed / waived /
 * shadow_computed / not_billable). `infra_status` is surfaced so the UI can label unsettled vs
 * non-billable rows rather than presenting computed/waived credits as finalized charges.
 */
export function shapeRunBilling(input: {
  keySource: string | null;
  rateMode: string | null;
  infraCredits: number | null;
  aiCredits: number | null;
  infraStatus: string | null;
}): NonNullable<ReviewRunRecord["billing"]> | undefined {
  const hasBilling =
    input.keySource !== null ||
    input.infraCredits !== null ||
    input.aiCredits !== null ||
    input.infraStatus !== null;
  if (!hasBilling) {
    return undefined;
  }
  const infra = input.infraCredits;
  const ai = input.aiCredits;
  const status = input.infraStatus;
  const settled = status !== null && status !== "pending" && status !== "tracking";
  return {
    key_source: input.keySource ?? undefined,
    rate_mode: input.rateMode ?? undefined,
    infra_credits: infra,
    ai_credits: ai,
    total_credits: settled ? (infra ?? 0) + (ai ?? 0) : null,
    infra_status: status ?? undefined,
  };
}

function toRunBilling(row: ReviewRunRow): ReviewRunRecord["billing"] {
  return shapeRunBilling({
    keySource: row.billing_key_source,
    rateMode: row.billing_rate_mode,
    infraCredits: row.billing_infra_credits,
    aiCredits: row.billing_ai_credits,
    infraStatus: row.billing_infra_status,
  });
}

function liveResultFromEvents(events: ReviewEvent[]): unknown {
  const merged: Record<string, unknown> = {};
  for (const event of events) {
    if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      Object.assign(merged, event.payload as Record<string, unknown>);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeRunResult(liveResult: unknown, storedResult: unknown): unknown {
  if (!isObjectRecord(liveResult)) {
    return storedResult ?? undefined;
  }
  if (!isObjectRecord(storedResult)) {
    return liveResult;
  }
  return { ...liveResult, ...storedResult };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));
}

function boundedText(value: unknown, maxLength = LIST_ERROR_PREVIEW_LENGTH): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactNumberRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const compact = compactRecord(Object.fromEntries(keys.map((key) => [key, numberValue(value[key])])));
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function normalizeReviewRunLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_REVIEW_RUN_LIMIT;
  }
  return Math.max(1, Math.min(MAX_REVIEW_RUN_LIMIT, Math.floor(value)));
}

function encodeReviewRunCursor(row: Pick<ReviewRunRow, "created_at" | "id">): string {
  return Buffer.from(JSON.stringify({ created_at: toIso(row.created_at), id: row.id }), "utf8").toString("base64url");
}

function decodeReviewRunCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = typeof decoded.created_at === "string" ? decoded.created_at : undefined;
    const id = typeof decoded.id === "string" ? decoded.id : undefined;
    if (!createdAt || !id || !Number.isFinite(new Date(createdAt).getTime()) || !UUID_PATTERN.test(id)) {
      return undefined;
    }
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  // Guard against Invalid Date (toISOString throws on NaN); fall back to epoch.
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

export interface InstalledRepositoryForReview {
  githubInstallationId: number;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface ReviewGraphTarget {
  tenantId: string;
  repository: string;
  defaultBranch: string;
  workspaceLabel: string;
  githubAccountId: string;
  githubAccountType: string;
}

/** Resolve a review delivery through the repository's exact GitHub connection. */
export async function getReviewGraphTarget(input: {
  installationId: number;
  githubRepoId: number;
  repository: string;
}): Promise<ReviewGraphTarget | undefined> {
  if (!databaseConfigured()) return undefined;
  const row = await queryOne<{
    tenant_id: string;
    owner: string;
    name: string;
    default_branch: string;
    github_account_login: string;
    github_account_id: string;
    github_account_type: string;
  }>(
    `select repo.tenant_id, repo.owner, repo.name, repo.default_branch,
            i.github_account_login, i.github_account_id::text as github_account_id, i.github_account_type
       from repositories repo
       join installations i on i.id = repo.installation_id
      where i.github_installation_id = $1
        and i.suspended_at is null
        and repo.github_repo_id = $2
        and repo.enabled = true
        and lower(repo.owner || '/' || repo.name) = lower($3)
      limit 1`,
    [input.installationId, input.githubRepoId, input.repository],
  );
  return row
    ? {
        tenantId: row.tenant_id,
        repository: `${row.owner}/${row.name}`,
        defaultBranch: row.default_branch,
        workspaceLabel: row.github_account_login,
        githubAccountId: row.github_account_id,
        githubAccountType: row.github_account_type,
      }
    : undefined;
}

export async function getInstalledRepositoryForReview(input: {
  fullName: string;
  githubRepoId?: number;
}): Promise<InstalledRepositoryForReview | undefined> {
  if (!databaseConfigured()) {
    return undefined;
  }
  const row = await queryOne<{
    github_installation_id: number;
    github_repo_id: number;
    owner: string;
    name: string;
    default_branch: string;
    private: boolean;
  }>(
    `select
        i.github_installation_id,
        repo.github_repo_id,
        repo.owner,
        repo.name,
        repo.default_branch,
        repo.private
       from repositories repo
       join installations i on i.id = repo.installation_id
      where i.suspended_at is null
        and (
          ($2::bigint is not null and repo.github_repo_id = $2)
          or (
            $2::bigint is null
            and lower(repo.owner || '/' || repo.name) = lower($1)
          )
        )
      order by i.created_at desc
      limit 1`,
    [input.fullName, input.githubRepoId ?? null],
  );
  return row
    ? {
        githubInstallationId: Number(row.github_installation_id),
        githubRepoId: Number(row.github_repo_id),
        owner: row.owner,
        name: row.name,
        fullName: `${row.owner}/${row.name}`,
        defaultBranch: row.default_branch,
        private: row.private,
      }
    : undefined;
}

export interface TenantRepositoryAccess {
  name: string;
  defaultBranch: string;
  githubInstallationId: number;
}

/** All repositories in a Jina tenant, each paired with its exact GitHub installation. */
export async function listTenantRepositoryAccess(tenantId: string): Promise<TenantRepositoryAccess[]> {
  if (!databaseConfigured()) return [];
  const rows = await query<{
    owner: string;
    name: string;
    default_branch: string;
    github_installation_id: string;
  }>(
    `select repository.owner, repository.name, repository.default_branch,
            installation.github_installation_id::text
       from repositories repository
       join installations installation on installation.id = repository.installation_id
      where repository.tenant_id = $1
        and repository.enabled = true
        and installation.suspended_at is null
      order by lower(repository.owner), lower(repository.name)`,
    [tenantId],
  );
  return rows.map((row) => ({
    name: `${row.owner}/${row.name}`,
    defaultBranch: row.default_branch,
    githubInstallationId: Number(row.github_installation_id),
  }));
}
