import type {
  ContextArtifactRef,
  ContextPhaseCheckpoint,
  ContextPhaseCheckpointStore,
  ContextPhaseOperationClaim,
  ContextPhaseOperationClaimInput,
  ContextPhaseOperationLease
} from "@jina/context-engine";
import type { QueryResultRow } from "pg";
import { ContextDatabase } from "./database.js";

interface CheckpointRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly repository: string;
  readonly build_id: string;
  readonly task_id: string;
  readonly phase: string;
  readonly checkpoint_key: string;
  readonly attempt: number;
  readonly artifact: unknown;
  readonly recorded_at: Date | string;
}

interface OperationLeaseRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly repository: string;
  readonly build_id: string;
  readonly task_id: string;
  readonly phase: string;
  readonly operation_key: string;
  readonly input_digest: string;
  readonly owner_token: string;
  readonly claimed_at: Date | string;
  readonly expires_at: Date | string;
  readonly released_at: Date | string | null;
}

const COLUMNS = `tenant_id,repository,build_id,task_id,phase,checkpoint_key,attempt,artifact,recorded_at`;
const OPERATION_COLUMNS =
  "tenant_id,repository,build_id,task_id,phase,operation_key,input_digest,owner_token,claimed_at,expires_at,released_at";

export class PostgresContextPhaseCheckpointRepository implements ContextPhaseCheckpointStore {
  constructor(private readonly database: ContextDatabase) {}

  async read(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly checkpointKey: string;
  }): Promise<ContextPhaseCheckpoint | undefined> {
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.tenantId] },
      async (client) => {
        const result = await client.query<CheckpointRow>(
          `select ${COLUMNS}
             from jina_context.context_phase_checkpoints
            where tenant_id=$1 and task_id=$2 and phase=$3 and checkpoint_key=$4`,
          [input.tenantId, input.taskId, input.phase, input.checkpointKey]
        );
        return result.rows[0] ? checkpointFromRow(result.rows[0]) : undefined;
      },
      "context_phase_checkpoint_read"
    );
  }

  async record(checkpoint: ContextPhaseCheckpoint): Promise<{
    readonly checkpoint: ContextPhaseCheckpoint;
    readonly created: boolean;
  }> {
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [checkpoint.tenantId] },
      async (client) => {
        const inserted = await client.query<CheckpointRow>(
          `insert into jina_context.context_phase_checkpoints
             (${COLUMNS})
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)
           on conflict (tenant_id,task_id,phase,checkpoint_key) do nothing
           returning ${COLUMNS}`,
          [
            checkpoint.tenantId,
            checkpoint.repository,
            checkpoint.buildId,
            checkpoint.taskId,
            checkpoint.phase,
            checkpoint.checkpointKey,
            checkpoint.attempt,
            JSON.stringify(checkpoint.artifact),
            checkpoint.recordedAt
          ]
        );
        if (inserted.rows[0]) return { checkpoint: checkpointFromRow(inserted.rows[0]), created: true };
        const existing = await client.query<CheckpointRow>(
          `select ${COLUMNS}
             from jina_context.context_phase_checkpoints
            where tenant_id=$1 and task_id=$2 and phase=$3 and checkpoint_key=$4`,
          [checkpoint.tenantId, checkpoint.taskId, checkpoint.phase, checkpoint.checkpointKey]
        );
        if (!existing.rows[0]) throw new Error("Context phase checkpoint insert raced without a winner");
        return { checkpoint: checkpointFromRow(existing.rows[0]), created: false };
      },
      "context_phase_checkpoint_record"
    );
  }

  async claimOperation(input: ContextPhaseOperationClaimInput): Promise<ContextPhaseOperationClaim> {
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.tenantId] },
      async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [operationLockIdentity(input)]);
        const selected = await client.query<OperationLeaseRow>(
          `select ${OPERATION_COLUMNS}
             from jina_context.context_phase_operation_leases
            where tenant_id=$1 and task_id=$2 and phase=$3 and operation_key=$4
            for update`,
          [input.tenantId, input.taskId, input.phase, input.operationKey]
        );
        const clock = await client.query<{ now: Date | string }>("select transaction_timestamp() as now");
        const databaseNow = new Date(clock.rows[0]!.now);
        const existing = selected.rows[0] ? operationLeaseFromRow(selected.rows[0]) : undefined;
        if (existing) assertOperationScope(existing, input);
        if (existing && existing.inputDigest !== input.inputDigest) {
          return { outcome: "conflict", lease: existing };
        }
        if (existing && !existing.releasedAt && Date.parse(existing.expiresAt) > databaseNow.getTime()) {
          return { outcome: "held", lease: existing };
        }
        const claimed = await client.query<OperationLeaseRow>(
          `insert into jina_context.context_phase_operation_leases (${OPERATION_COLUMNS})
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,null)
           on conflict (tenant_id,task_id,phase,operation_key) do update
             set repository=excluded.repository,build_id=excluded.build_id,
                 input_digest=excluded.input_digest,owner_token=excluded.owner_token,
                 claimed_at=excluded.claimed_at,expires_at=excluded.expires_at,released_at=null
           returning ${OPERATION_COLUMNS}`,
          [
            input.tenantId,
            input.repository,
            input.buildId,
            input.taskId,
            input.phase,
            input.operationKey,
            input.inputDigest,
            input.ownerToken,
            databaseNow.toISOString(),
            new Date(databaseNow.getTime() + operationLeaseDuration(input.leaseDurationMs)).toISOString()
          ]
        );
        return { outcome: "acquired", lease: operationLeaseFromRow(claimed.rows[0]!) };
      },
      "context_phase_operation_claim"
    );
  }

  async renewOperation(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly operationKey: string;
    readonly ownerToken: string;
    readonly now: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean> {
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.tenantId] },
      async (client) => {
        const durationMs = operationLeaseDuration(input.leaseDurationMs);
        const renewed = await client.query(
          `update jina_context.context_phase_operation_leases
              set expires_at=transaction_timestamp()+($6::bigint * interval '1 millisecond')
            where tenant_id=$1 and task_id=$2 and phase=$3 and operation_key=$4 and owner_token=$5
              and released_at is null`,
          [input.tenantId, input.taskId, input.phase, input.operationKey, input.ownerToken, durationMs]
        );
        return renewed.rowCount === 1;
      },
      "context_phase_operation_renew"
    );
  }

  async releaseOperation(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly operationKey: string;
    readonly ownerToken: string;
  }): Promise<boolean> {
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.tenantId] },
      async (client) => {
        const released = await client.query(
          `update jina_context.context_phase_operation_leases
              set released_at=transaction_timestamp()
            where tenant_id=$1 and task_id=$2 and phase=$3 and operation_key=$4 and owner_token=$5
              and released_at is null`,
          [input.tenantId, input.taskId, input.phase, input.operationKey, input.ownerToken]
        );
        return released.rowCount === 1;
      },
      "context_phase_operation_release"
    );
  }

  async listBuilds(input: {
    readonly tenantId: string;
    readonly buildIds: readonly string[];
  }): Promise<readonly ContextPhaseCheckpoint[]> {
    if (input.buildIds.length === 0) return [];
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.tenantId] },
      async (client) => {
        const result = await client.query<CheckpointRow>(
          `select ${COLUMNS}
             from jina_context.context_phase_checkpoints
            where tenant_id=$1 and build_id=any($2::text[])
            order by recorded_at,task_id,phase`,
          [input.tenantId, [...new Set(input.buildIds)]]
        );
        return result.rows.map(checkpointFromRow);
      },
      "context_phase_checkpoint_list"
    );
  }
}

function checkpointFromRow(row: CheckpointRow): ContextPhaseCheckpoint {
  return {
    tenantId: row.tenant_id,
    repository: row.repository,
    buildId: row.build_id,
    taskId: row.task_id,
    phase: row.phase,
    checkpointKey: row.checkpoint_key,
    attempt: row.attempt,
    artifact: artifactRef(row.artifact),
    recordedAt: new Date(row.recorded_at).toISOString()
  };
}

function operationLeaseFromRow(row: OperationLeaseRow): ContextPhaseOperationLease {
  return {
    tenantId: row.tenant_id,
    repository: row.repository,
    buildId: row.build_id,
    taskId: row.task_id,
    phase: row.phase,
    operationKey: row.operation_key,
    inputDigest: row.input_digest,
    ownerToken: row.owner_token,
    claimedAt: new Date(row.claimed_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(row.released_at ? { releasedAt: new Date(row.released_at).toISOString() } : {})
  };
}

function assertOperationScope(
  existing: ContextPhaseOperationLease,
  input: Pick<ContextPhaseOperationClaimInput, "repository" | "buildId">
): void {
  if (existing.repository !== input.repository || existing.buildId !== input.buildId) {
    throw new Error("Context phase operation lease escaped its build scope");
  }
}

function operationLockIdentity(input: {
  readonly tenantId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly operationKey: string;
}): string {
  return `context-phase-operation:${input.tenantId}:${input.taskId}:${input.phase}:${input.operationKey}`;
}

function operationLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60 * 1000) {
    throw new Error("Context phase operation lease duration is invalid");
  }
  return value;
}

function artifactRef(value: unknown): ContextArtifactRef {
  if (!isRecord(value)) throw new Error("Context phase checkpoint artifact is invalid");
  const bytes = value.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Context phase checkpoint artifact bytes are invalid");
  }
  const sha256 = requiredString(value.sha256, "sha256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Context phase checkpoint artifact digest is invalid");
  return {
    uri: requiredString(value.uri, "uri"),
    key: requiredString(value.key, "key"),
    contentType: requiredString(value.contentType, "contentType"),
    bytes,
    sha256,
    ...(value.objectGeneration === undefined
      ? {}
      : { objectGeneration: requiredString(value.objectGeneration, "objectGeneration") })
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Context phase checkpoint artifact ${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
