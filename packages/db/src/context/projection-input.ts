import type { PoolClient } from "pg";
import { contextDigest } from "./database.js";

export type ProjectionInputEventType =
  "evidence.checkpoint.committed" | "knowledge.run.committed" | "knowledge.revision.event" | "evidence.erased";

function projectionInputLockKey(tenantId: string, repository: string): string {
  return `context-projection-input:${tenantId}:${repository}`;
}

export async function lockProjectionInput(client: PoolClient, tenantId: string, repository: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    projectionInputLockKey(tenantId, repository)
  ]);
}

export async function appendProjectionInputEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    repository: string;
    id: string;
    eventType: ProjectionInputEventType;
    aggregateId: string;
    occurredAt: string;
  }
): Promise<void> {
  await lockProjectionInput(client, input.tenantId, input.repository);
  const existing = await client.query(
    `select 1 from jina_context.projection_input_events
     where tenant_id=$1 and repository=$2 and id=$3`,
    [input.tenantId, input.repository, input.id]
  );
  if (existing.rowCount === 1) return;
  await client.query(
    `insert into jina_context.projection_input_events
      (tenant_id,repository,sequence,id,event_type,aggregate_id,occurred_at)
     select $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$6
     from jina_context.projection_input_events
     where tenant_id=$1 and repository=$2`,
    [input.tenantId, input.repository, input.id, input.eventType, input.aggregateId, input.occurredAt]
  );
}

export async function currentProjectionInputFingerprint(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  repository: string
): Promise<string> {
  const result = await client.query<{ sequence: string; id: string | null }>(
    `select coalesce(max(sequence),0)::text sequence,
            (array_agg(id order by sequence desc))[1] id
     from jina_context.projection_input_events
     where tenant_id=$1 and repository=$2`,
    [tenantId, repository]
  );
  const frontier = result.rows[0]!;
  const sequence = Number(frontier.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Projection input frontier exceeds the supported sequence range for ${repository}`);
  }
  return contextDigest({
    tenantId,
    repository,
    sequence,
    eventId: frontier.id
  });
}

export async function assertProjectionInputFingerprint(
  client: PoolClient,
  tenantId: string,
  repository: string,
  expected: string
): Promise<void> {
  const actual = await currentProjectionInputFingerprint(client, tenantId, repository);
  if (actual !== expected) {
    throw new Error(`Canonical projection inputs changed while indexing ${repository}; retry with a new generation`);
  }
}
