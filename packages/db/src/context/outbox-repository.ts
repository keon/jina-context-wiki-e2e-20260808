import { randomUUID } from "node:crypto";
import type { ContextOutboxEvent, ContextProjectionConsumer } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, contextStableId, dateString } from "./database.js";

export interface ContextOutboxDelivery {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly aggregateType: ContextOutboxEvent["aggregateType"];
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly eventType: string;
  readonly consumer: ContextProjectionConsumer;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
  readonly availableAt: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
}

interface DeliveryRow {
  delivery_id: string;
  event_id: string;
  tenant_id: string;
  repository: string;
  aggregate_type: ContextOutboxEvent["aggregateType"];
  aggregate_id: string;
  aggregate_sequence: string | number;
  event_type: string;
  consumer: ContextProjectionConsumer;
  payload: Record<string, unknown>;
  occurred_at: Date;
  available_at: Date;
  attempt: number;
  lease_id: string;
  lease_owner: string;
  lease_expires_at: Date;
}

export class PostgresContextOutboxRepository {
  constructor(private readonly database: ContextDatabase) {}

  async enqueue(event: ContextOutboxEvent, availableAt = event.occurredAt): Promise<void> {
    await this.database.transactionAs("jina_context_admin", (client) =>
      enqueueContextEvent(client, event, availableAt)
    );
  }

  async claim(input: {
    readonly consumer: ContextProjectionConsumer;
    readonly workerId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
    readonly tenantId?: string;
    readonly repository?: string;
    readonly ref?: string;
    readonly commitSha?: string;
    readonly limit?: number;
  }): Promise<readonly ContextOutboxDelivery[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    return this.database.transactionAs("jina_context_admin", async (client) => {
      const result = await client.query<DeliveryRow>(
        `with claimable as (
           select delivery_id
           from jina_context.outbox
           where consumer=$1 and processed_at is null and available_at <= $2
             and (lease_expires_at is null or lease_expires_at <= $2)
             and ($3::text is null or tenant_id=$3)
             and ($4::text is null or repository=$4)
             and (
               $5::text is null
               or aggregate_type not in ('evidence','knowledge')
               or payload->>'ref'=$5
               or exists (
                 select 1 from jina_context.knowledge_document_revisions revision
                 where revision.tenant_id=outbox.tenant_id
                   and revision.repository=outbox.repository
                   and revision.id=outbox.aggregate_id
                   and revision.ref_name=$5
               )
             )
             and (
               $6::text is null
               or aggregate_type not in ('evidence','knowledge')
               or payload->>'commitSha'=$6
               or exists (
                 select 1 from jina_context.knowledge_document_revisions revision
                 where revision.tenant_id=outbox.tenant_id
                   and revision.repository=outbox.repository
                   and revision.id=outbox.aggregate_id
                   and revision.commit_sha=$6
               )
             )
           order by available_at,occurred_at,delivery_id
           for update skip locked
           limit $7
         )
         update jina_context.outbox delivery
         set lease_id=$8,lease_owner=$9,lease_expires_at=$10,attempt=delivery.attempt+1,last_error=null
         from claimable
         where delivery.delivery_id=claimable.delivery_id
         returning delivery.*`,
        [
          input.consumer,
          input.now,
          input.tenantId ?? null,
          input.repository ?? null,
          input.ref ?? null,
          input.commitSha ?? null,
          limit,
          randomUUID(),
          input.workerId,
          input.leaseExpiresAt
        ]
      );
      return result.rows.map(deliveryFromRow);
    });
  }

  async acknowledge(deliveryId: string, leaseId: string, processedAt: string): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_admin",
      `update jina_context.outbox
       set processed_at=$3,lease_id=null,lease_owner=null,lease_expires_at=null,last_error=null
       where delivery_id=$1 and lease_id=$2 and processed_at is null and lease_expires_at > $3`,
      [deliveryId, leaseId, processedAt]
    );
    return result.rowCount === 1;
  }

  async fail(input: {
    readonly deliveryId: string;
    readonly leaseId: string;
    readonly now: string;
    readonly retryAt: string;
    readonly error: string;
  }): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_admin",
      `update jina_context.outbox
       set available_at=$4,lease_id=null,lease_owner=null,lease_expires_at=null,last_error=$5
       where delivery_id=$1 and lease_id=$2 and processed_at is null and lease_expires_at > $3`,
      [input.deliveryId, input.leaseId, input.now, input.retryAt, input.error.slice(0, 8_000)]
    );
    return result.rowCount === 1;
  }

  async pendingDepth(
    consumer: ContextProjectionConsumer,
    scope?: { readonly tenantId?: string; readonly repository?: string }
  ): Promise<{ readonly count: number; readonly oldestAvailableAt?: string }> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ count: string; oldest: Date | null }>(
      "jina_context_admin",
      `select count(*)::text as count,min(available_at) as oldest
       from jina_context.outbox
       where consumer=$1 and processed_at is null
         and ($2::text is null or tenant_id=$2)
         and ($3::text is null or repository=$3)`,
      [consumer, scope?.tenantId ?? null, scope?.repository ?? null]
    );
    const row = result.rows[0]!;
    return {
      count: Number(row.count),
      ...(row.oldest ? { oldestAvailableAt: row.oldest.toISOString() } : {})
    };
  }
}

/**
 * Enqueue from the same transaction as a canonical or projection write.
 * A delivery is immutable apart from lease/delivery state, and retries over
 * the same event ID converge through `(event_id, consumer)`.
 */
export async function enqueueContextEvent(
  client: PoolClient,
  event: ContextOutboxEvent,
  availableAt = event.occurredAt
): Promise<void> {
  if (event.consumers.length === 0) return;
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error("Context outbox event sequence must be a positive safe integer");
  }
  for (const consumer of [...new Set(event.consumers)]) {
    await client.query(
      `insert into jina_context.outbox
        (delivery_id,event_id,tenant_id,repository,aggregate_type,aggregate_id,
         aggregate_sequence,event_type,consumer,payload,occurred_at,available_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       on conflict (event_id,consumer) do nothing`,
      [
        contextStableId("delivery", { eventId: event.id, consumer }),
        event.id,
        event.tenantId,
        event.repository,
        event.aggregateType,
        event.aggregateId,
        event.sequence,
        event.eventType,
        consumer,
        JSON.stringify(event.payload),
        event.occurredAt,
        availableAt
      ]
    );
    const stored = await client.query(
      `select 1 from jina_context.outbox
       where event_id=$1 and consumer=$2 and tenant_id=$3 and repository=$4
         and aggregate_type=$5 and aggregate_id=$6 and aggregate_sequence=$7
         and event_type=$8 and payload=$9::jsonb and occurred_at=$10`,
      [
        event.id,
        consumer,
        event.tenantId,
        event.repository,
        event.aggregateType,
        event.aggregateId,
        event.sequence,
        event.eventType,
        JSON.stringify(event.payload),
        event.occurredAt
      ]
    );
    if (stored.rowCount !== 1) {
      throw new Error(`Context outbox event identity collision for ${event.id}:${consumer}`);
    }
  }
}

function deliveryFromRow(row: DeliveryRow): ContextOutboxDelivery {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateSequence: Number(row.aggregate_sequence),
    eventType: row.event_type,
    consumer: row.consumer,
    payload: row.payload,
    occurredAt: dateString(row.occurred_at),
    availableAt: dateString(row.available_at),
    attempt: row.attempt,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: dateString(row.lease_expires_at)
  };
}
