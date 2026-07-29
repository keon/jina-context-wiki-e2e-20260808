import type { ContextOutboxEvent } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { contextStableId } from "./database.js";

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
