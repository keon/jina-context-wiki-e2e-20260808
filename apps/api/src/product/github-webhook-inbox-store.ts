import { randomUUID } from "node:crypto";

import type pg from "pg";

import { query, queryOne, withTransaction } from "./db.js";

export type GithubWebhookInboxMode =
  | "capture_only"
  | "canary_only"
  | "capture_and_process"
  | "legacy_forward";

type GithubWebhookInboxStatus =
  | "pending"
  | "leased"
  | "completed"
  | "retry_wait"
  | "dead_letter";

export interface GithubWebhookInboxControl {
  readonly mode: GithubWebhookInboxMode;
  readonly generation: number;
  readonly firstV2WorkflowId?: string;
  readonly firstV2At?: Date;
}

export interface GithubWebhookInboxCapture {
  readonly deliveryId: string;
  readonly event: string;
  readonly action?: string;
  readonly installationId?: number;
  readonly repositoryId?: number;
  readonly repositoryFullName?: string;
  readonly pullRequestNumber?: number;
  readonly payloadSha256: string;
  readonly payloadCiphertext: Buffer;
  readonly encryptionKeyVersion: string;
}

export interface GithubWebhookInboxCaptureResult {
  readonly inserted: boolean;
  readonly status: GithubWebhookInboxStatus;
}

export interface GithubWebhookInboxLease {
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly mode: Exclude<GithubWebhookInboxMode, "capture_only">;
  readonly deliveryId: string;
  readonly event: string;
  readonly action?: string;
  readonly repositoryFullName?: string;
  readonly payloadSha256: string;
  readonly payloadCiphertext: Buffer;
  readonly encryptionKeyVersion: string;
  readonly attemptCount: number;
}

export interface GithubWebhookInboxSnapshot {
  readonly control: GithubWebhookInboxControl;
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly completed: number;
  readonly deadLetter: number;
  /** Bounded diagnostic classification for every retained dead-letter row. */
  readonly deadLetterByErrorCode: Readonly<Record<string, number>>;
  /** Newest retained dead letters, capped by the store so the control response stays bounded. */
  readonly recentDeadLetters: readonly GithubWebhookInboxDeadLetterSummary[];
  readonly priorGenerationLeases: number;
  /** Counts for rows that can still be claimed/retried, keyed by their pinned key version. */
  readonly activeKeyVersions: Readonly<Record<string, number>>;
  /** Terminal retained evidence by pinned key version; these rows are never claimed or retried. */
  readonly deadLetterKeyVersions: Readonly<Record<string, number>>;
  readonly oldestPendingAt?: Date;
}

interface GithubWebhookInboxDeadLetterSummary {
  readonly deliveryId: string;
  readonly event: string;
  readonly action?: string;
  readonly repositoryFullName?: string;
  readonly errorCode: string;
  readonly attemptCount: number;
  readonly deadLetteredAt: Date;
}

export interface GithubWebhookInboxRepository {
  capture(input: GithubWebhookInboxCapture): Promise<GithubWebhookInboxCaptureResult>;
  hasDelivery(deliveryId: string): Promise<boolean>;
  reserveRedelivery(input: {
    readonly deliveryId: string;
    readonly providerDeliveryId: number;
    readonly cooldownMs: number;
  }): Promise<boolean>;
  recordRedeliveryResult(input: {
    readonly deliveryId: string;
    readonly providerDeliveryId: number;
    readonly httpStatus: number;
  }): Promise<void>;
  claim(input: {
    readonly deliveryId?: string;
    readonly leaseMs: number;
    readonly canaryRepositories: ReadonlySet<string>;
  }): Promise<GithubWebhookInboxLease | undefined>;
  complete(input: {
    readonly lease: GithubWebhookInboxLease;
    readonly processedWorkflowId?: string;
  }): Promise<void>;
  retry(input: {
    readonly lease: GithubWebhookInboxLease;
    readonly errorCode: string;
    readonly retryAfterMs: number;
  }): Promise<void>;
  deadLetter(input: {
    readonly lease: GithubWebhookInboxLease;
    readonly errorCode: string;
  }): Promise<void>;
  transitionMode(input: {
    readonly expectedGeneration: number;
    readonly mode: GithubWebhookInboxMode;
    readonly updatedBy: string;
  }): Promise<GithubWebhookInboxControl>;
  snapshot(): Promise<GithubWebhookInboxSnapshot>;
}

export class GithubWebhookDeliveryConflictError extends Error {
  constructor(readonly deliveryId: string) {
    super(`GitHub delivery ${deliveryId} was replayed with different event or payload bytes`);
    this.name = "GithubWebhookDeliveryConflictError";
  }
}

export class GithubWebhookInboxLeaseLostError extends Error {
  constructor(readonly deliveryId: string) {
    super(`GitHub webhook inbox lease was lost for ${deliveryId}`);
    this.name = "GithubWebhookInboxLeaseLostError";
  }
}

export class GithubWebhookInboxGenerationConflictError extends Error {
  constructor() {
    super("GitHub webhook inbox processor generation changed");
    this.name = "GithubWebhookInboxGenerationConflictError";
  }
}

export class GithubWebhookInboxEpochError extends Error {
  constructor(readonly workflowId: string) {
    super(`legacy_forward is permanently disabled after v2 workflow ${workflowId}`);
    this.name = "GithubWebhookInboxEpochError";
  }
}

export async function markFirstV2GithubWebhookWorkflowWithClient(
  client: pg.PoolClient,
  workflowId: string,
): Promise<string> {
  const locked = await client.query<ControlRow>(
    `select mode,generation,first_v2_workflow_id,first_v2_at
       from github_webhook_inbox_control
      where singleton=true
      for update`,
  );
  const control = requiredControl(locked.rows[0]);
  if (control.mode === "legacy_forward") {
    throw new Error("v2 review admission is forbidden while legacy_forward is active");
  }
  if (control.firstV2WorkflowId) return control.firstV2WorkflowId;
  const updated = await client.query<{ first_v2_workflow_id: string }>(
    `update github_webhook_inbox_control
        set first_v2_workflow_id=$1,
            first_v2_at=now(),
            updated_at=now(),
            updated_by='v2-review-admission'
      where singleton=true
        and first_v2_workflow_id is null
    returning first_v2_workflow_id`,
    [workflowId],
  );
  const marked = updated.rows[0]?.first_v2_workflow_id;
  if (!marked) throw new Error("failed to record first v2 review workflow epoch");
  return marked;
}

export class PostgresGithubWebhookInboxRepository implements GithubWebhookInboxRepository {
  async capture(input: GithubWebhookInboxCapture): Promise<GithubWebhookInboxCaptureResult> {
    return withTransaction(async (client) => {
      const inserted = await client.query<{ status: GithubWebhookInboxStatus }>(
        `insert into github_webhook_inbox
           (github_delivery_id,github_event,action,installation_id,repository_id,
            repository_full_name,pull_request_number,payload_sha256,payload_ciphertext,
            encryption_key_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (github_delivery_id) do nothing
         returning status`,
        [
          input.deliveryId,
          input.event,
          input.action ?? null,
          input.installationId ?? null,
          input.repositoryId ?? null,
          input.repositoryFullName ?? null,
          input.pullRequestNumber ?? null,
          input.payloadSha256,
          input.payloadCiphertext,
          input.encryptionKeyVersion,
        ],
      );
      if (inserted.rows[0]) {
        return { inserted: true, status: inserted.rows[0].status };
      }

      const existing = await client.query<{
        github_event: string;
        payload_sha256: string;
        status: GithubWebhookInboxStatus;
      }>(
        `select github_event,payload_sha256,status
           from github_webhook_inbox
          where github_delivery_id=$1
          for update`,
        [input.deliveryId],
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.github_event !== input.event ||
        row.payload_sha256 !== input.payloadSha256
      ) {
        throw new GithubWebhookDeliveryConflictError(input.deliveryId);
      }
      return { inserted: false, status: row.status };
    });
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    const row = await queryOne<{ present: boolean }>(
      `select exists (
         select 1 from github_webhook_inbox where github_delivery_id=$1
       ) as present`,
      [deliveryId],
    );
    return row?.present === true;
  }

  async reserveRedelivery(input: {
    readonly deliveryId: string;
    readonly providerDeliveryId: number;
    readonly cooldownMs: number;
  }): Promise<boolean> {
    const rows = await query<{ github_delivery_id: string }>(
      `insert into github_webhook_redelivery_requests
         (github_delivery_id,provider_delivery_id)
       values ($1,$2)
       on conflict (github_delivery_id) do update
         set provider_delivery_id=excluded.provider_delivery_id,
             attempt_count=github_webhook_redelivery_requests.attempt_count + 1,
             last_requested_at=now(),
             last_http_status=null,
             last_result_at=null
       where github_webhook_redelivery_requests.last_requested_at
             <= now() - ($3::bigint * interval '1 millisecond')
         and not exists (
           select 1 from github_webhook_inbox where github_delivery_id=$1
         )
       returning github_delivery_id`,
      [input.deliveryId, input.providerDeliveryId, input.cooldownMs],
    );
    return Boolean(rows[0]);
  }

  async recordRedeliveryResult(input: {
    readonly deliveryId: string;
    readonly providerDeliveryId: number;
    readonly httpStatus: number;
  }): Promise<void> {
    await query(
      `update github_webhook_redelivery_requests
          set last_http_status=$3,last_result_at=now()
        where github_delivery_id=$1 and provider_delivery_id=$2`,
      [input.deliveryId, input.providerDeliveryId, input.httpStatus],
    );
  }

  async claim(input: {
    readonly deliveryId?: string;
    readonly leaseMs: number;
    readonly canaryRepositories: ReadonlySet<string>;
  }): Promise<GithubWebhookInboxLease | undefined> {
    return withTransaction(async (client) => {
      const controlResult = await client.query<ControlRow>(
        `select mode,generation,first_v2_workflow_id,first_v2_at
           from github_webhook_inbox_control
          where singleton=true
          for share`,
      );
      const control = requiredControl(controlResult.rows[0]);
      if (control.mode === "capture_only") return undefined;
      if (control.mode === "legacy_forward" && control.firstV2WorkflowId) {
        throw new GithubWebhookInboxEpochError(control.firstV2WorkflowId);
      }

      const leaseId = randomUUID();
      const canaryRepositories = [...input.canaryRepositories].map((value) => value.toLowerCase());
      const claimed = await client.query<LeaseRow>(
        `with candidate as (
           select delivery.github_delivery_id
             from github_webhook_inbox delivery
            where ($1::text is null or delivery.github_delivery_id=$1)
              and (
                delivery.status in ('pending','retry_wait')
                or (delivery.status='leased' and delivery.lease_expires_at <= now())
              )
              and delivery.available_at <= now()
              and ($2::text <> 'canary_only' or lower(delivery.repository_full_name) = any($3::text[]))
              and not exists (
                select 1
                  from github_webhook_inbox earlier
                 where earlier.status not in ('completed','dead_letter')
                   and earlier.github_delivery_id <> delivery.github_delivery_id
                   and earlier.installation_id is not distinct from delivery.installation_id
                   and earlier.repository_id is not distinct from delivery.repository_id
                   and earlier.pull_request_number is not distinct from delivery.pull_request_number
                   and (earlier.received_at,earlier.github_delivery_id)
                       < (delivery.received_at,delivery.github_delivery_id)
              )
            order by delivery.received_at,delivery.github_delivery_id
            limit 1
            for update skip locked
         )
         update github_webhook_inbox delivery
            set status='leased',
                lease_id=$4,
                lease_expires_at=now() + ($5::bigint * interval '1 millisecond'),
                lease_generation=$6,
                attempt_count=delivery.attempt_count + 1,
                last_error_code=null,
                last_error_at=null
           from candidate
          where delivery.github_delivery_id=candidate.github_delivery_id
         returning delivery.github_delivery_id,delivery.github_event,delivery.action,
                   delivery.repository_full_name,delivery.payload_sha256,
                   delivery.payload_ciphertext,delivery.encryption_key_version,
                   delivery.attempt_count`,
        [
          input.deliveryId ?? null,
          control.mode,
          canaryRepositories,
          leaseId,
          input.leaseMs,
          control.generation,
        ],
      );
      const row = claimed.rows[0];
      if (!row) return undefined;
      return {
        leaseId,
        leaseGeneration: control.generation,
        mode: control.mode,
        deliveryId: row.github_delivery_id,
        event: row.github_event,
        ...(row.action ? { action: row.action } : {}),
        ...(row.repository_full_name ? { repositoryFullName: row.repository_full_name } : {}),
        payloadSha256: row.payload_sha256,
        payloadCiphertext: row.payload_ciphertext,
        encryptionKeyVersion: row.encryption_key_version,
        attemptCount: row.attempt_count,
      };
    });
  }

  async complete(input: {
    readonly lease: GithubWebhookInboxLease;
    readonly processedWorkflowId?: string;
  }): Promise<void> {
    const rows = await query<{ github_delivery_id: string }>(
      `update github_webhook_inbox
          set status='completed',
              processed_workflow_id=coalesce(processed_workflow_id,$4),
              completed_at=now(),
              lease_id=null,
              lease_expires_at=null,
              lease_generation=null,
              last_error_code=null,
              last_error_at=null
        where github_delivery_id=$1
          and status='leased'
          and lease_id=$2
          and lease_generation=$3
          and (processed_workflow_id is null or processed_workflow_id is not distinct from $4)
      returning github_delivery_id`,
      [
        input.lease.deliveryId,
        input.lease.leaseId,
        input.lease.leaseGeneration,
        input.processedWorkflowId ?? null,
      ],
    );
    if (!rows[0]) throw new GithubWebhookInboxLeaseLostError(input.lease.deliveryId);
  }

  async retry(input: {
    readonly lease: GithubWebhookInboxLease;
    readonly errorCode: string;
    readonly retryAfterMs: number;
  }): Promise<void> {
    const rows = await query<{ github_delivery_id: string }>(
      `update github_webhook_inbox
          set status='retry_wait',
              available_at=now() + ($4::bigint * interval '1 millisecond'),
              lease_id=null,
              lease_expires_at=null,
              lease_generation=null,
              last_error_code=$5,
              last_error_at=now()
        where github_delivery_id=$1
          and status='leased'
          and lease_id=$2
          and lease_generation=$3
      returning github_delivery_id`,
      [
        input.lease.deliveryId,
        input.lease.leaseId,
        input.lease.leaseGeneration,
        input.retryAfterMs,
        safeErrorCode(input.errorCode),
      ],
    );
    if (!rows[0]) throw new GithubWebhookInboxLeaseLostError(input.lease.deliveryId);
  }

  async deadLetter(input: {
    readonly lease: GithubWebhookInboxLease;
    readonly errorCode: string;
  }): Promise<void> {
    const rows = await query<{ github_delivery_id: string }>(
      `update github_webhook_inbox
          set status='dead_letter',
              completed_at=now(),
              lease_id=null,
              lease_expires_at=null,
              lease_generation=null,
              last_error_code=$4,
              last_error_at=now()
        where github_delivery_id=$1
          and status='leased'
          and lease_id=$2
          and lease_generation=$3
      returning github_delivery_id`,
      [
        input.lease.deliveryId,
        input.lease.leaseId,
        input.lease.leaseGeneration,
        safeErrorCode(input.errorCode),
      ],
    );
    if (!rows[0]) throw new GithubWebhookInboxLeaseLostError(input.lease.deliveryId);
  }

  async transitionMode(input: {
    readonly expectedGeneration: number;
    readonly mode: GithubWebhookInboxMode;
    readonly updatedBy: string;
  }): Promise<GithubWebhookInboxControl> {
    return withTransaction(async (client) => {
      const locked = await client.query<ControlRow>(
        `select mode,generation,first_v2_workflow_id,first_v2_at
           from github_webhook_inbox_control
          where singleton=true
          for update`,
      );
      const control = requiredControl(locked.rows[0]);
      if (control.generation !== input.expectedGeneration) {
        throw new GithubWebhookInboxGenerationConflictError();
      }
      if (input.mode === "legacy_forward" && control.firstV2WorkflowId) {
        throw new GithubWebhookInboxEpochError(control.firstV2WorkflowId);
      }
      const updated = await client.query<ControlRow>(
        `update github_webhook_inbox_control
            set mode=$1,generation=generation + 1,updated_at=now(),updated_by=$2
          where singleton=true
        returning mode,generation,first_v2_workflow_id,first_v2_at`,
        [input.mode, input.updatedBy.slice(0, 200)],
      );
      return requiredControl(updated.rows[0]);
    });
  }

  async snapshot(): Promise<GithubWebhookInboxSnapshot> {
    const control = requiredControl(await queryOne<ControlRow>(
      `select mode,generation,first_v2_workflow_id,first_v2_at
         from github_webhook_inbox_control
        where singleton=true`,
    ));
    const counts = await queryOne<{
      pending: number;
      leased: number;
      retry_wait: number;
      completed: number;
      dead_letter: number;
      prior_generation_leases: number;
      oldest_pending_at: Date | null;
    }>(
      `select
         count(*) filter (where status='pending')::int as pending,
         count(*) filter (where status='leased')::int as leased,
         count(*) filter (where status='retry_wait')::int as retry_wait,
         count(*) filter (where status='completed')::int as completed,
         count(*) filter (where status='dead_letter')::int as dead_letter,
         count(*) filter (where status='leased' and lease_generation < $1)::int
           as prior_generation_leases,
         min(received_at) filter (where status in ('pending','retry_wait','leased'))
           as oldest_pending_at
       from github_webhook_inbox`,
      [control.generation],
    );
    const keyVersions = await query<{
      encryption_key_version: string;
      active_count: number;
    }>(
      `select encryption_key_version,count(*)::int as active_count
         from github_webhook_inbox
        where status in ('pending','leased','retry_wait')
        group by encryption_key_version
      order by encryption_key_version`,
    );
    const deadLetterKeyVersions = await query<{
      encryption_key_version: string;
      dead_letter_count: number;
    }>(
      `select encryption_key_version,count(*)::int as dead_letter_count
         from github_webhook_inbox
        where status='dead_letter'
        group by encryption_key_version
      order by encryption_key_version`,
    );
    const deadLetterCodes = await query<{
      last_error_code: string;
      dead_letter_count: number;
    }>(
      `select coalesce(last_error_code,'unknown') as last_error_code,
              count(*)::int as dead_letter_count
         from github_webhook_inbox
        where status='dead_letter'
        group by coalesce(last_error_code,'unknown')
        order by dead_letter_count desc,last_error_code
        limit 50`,
    );
    const recentDeadLetters = await query<{
      github_delivery_id: string;
      github_event: string;
      action: string | null;
      repository_full_name: string | null;
      last_error_code: string | null;
      attempt_count: number;
      completed_at: Date;
    }>(
      `select github_delivery_id,github_event,action,repository_full_name,
              last_error_code,attempt_count,completed_at
         from github_webhook_inbox
        where status='dead_letter'
        order by completed_at desc,github_delivery_id
        limit 25`,
    );
    return {
      control,
      pending: counts?.pending ?? 0,
      leased: counts?.leased ?? 0,
      retryWait: counts?.retry_wait ?? 0,
      completed: counts?.completed ?? 0,
      deadLetter: counts?.dead_letter ?? 0,
      deadLetterByErrorCode: Object.fromEntries(
        deadLetterCodes.map((row) => [row.last_error_code, Number(row.dead_letter_count)]),
      ),
      recentDeadLetters: recentDeadLetters.map((row) => ({
        deliveryId: row.github_delivery_id,
        event: row.github_event,
        ...(row.action ? { action: row.action } : {}),
        ...(row.repository_full_name ? { repositoryFullName: row.repository_full_name } : {}),
        errorCode: row.last_error_code ?? "unknown",
        attemptCount: Number(row.attempt_count),
        deadLetteredAt: row.completed_at,
      })),
      priorGenerationLeases: counts?.prior_generation_leases ?? 0,
      activeKeyVersions: Object.fromEntries(
        keyVersions.map((row) => [row.encryption_key_version, Number(row.active_count)]),
      ),
      deadLetterKeyVersions: Object.fromEntries(
        deadLetterKeyVersions.map((row) => [
          row.encryption_key_version,
          Number(row.dead_letter_count),
        ]),
      ),
      ...(counts?.oldest_pending_at ? { oldestPendingAt: counts.oldest_pending_at } : {}),
    };
  }
}

interface ControlRow {
  readonly mode: GithubWebhookInboxMode;
  readonly generation: number;
  readonly first_v2_workflow_id: string | null;
  readonly first_v2_at: Date | null;
}

interface LeaseRow {
  readonly github_delivery_id: string;
  readonly github_event: string;
  readonly action: string | null;
  readonly repository_full_name: string | null;
  readonly payload_sha256: string;
  readonly payload_ciphertext: Buffer;
  readonly encryption_key_version: string;
  readonly attempt_count: number;
}

function requiredControl(row: ControlRow | undefined): GithubWebhookInboxControl {
  if (!row) throw new Error("GitHub webhook inbox control row is missing");
  return {
    mode: row.mode,
    generation: Number(row.generation),
    ...(row.first_v2_workflow_id ? { firstV2WorkflowId: row.first_v2_workflow_id } : {}),
    ...(row.first_v2_at ? { firstV2At: row.first_v2_at } : {}),
  };
}

function safeErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 120);
  return normalized || "processing_failed";
}
