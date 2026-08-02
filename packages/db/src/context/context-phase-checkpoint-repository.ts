import type { ContextArtifactRef, ContextPhaseCheckpoint, ContextPhaseCheckpointStore } from "@jina/context-engine";
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

const COLUMNS = `tenant_id,repository,build_id,task_id,phase,checkpoint_key,attempt,artifact,recorded_at`;

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
