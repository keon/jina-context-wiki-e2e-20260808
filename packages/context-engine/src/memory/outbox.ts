import { newId, normalizeIsoTime } from "../domain/fingerprint.js";
import type {
  ContextOutboxDelivery,
  ContextOutboxEvent,
  ContextProjectionConsumer,
  ProjectionCheckpoint
} from "../domain/projection.js";
import type { OutboxStore } from "../ports/outbox-store.js";

function deliveryKey(eventId: string, consumer: ContextProjectionConsumer): string {
  return `${eventId}\u0000${consumer}`;
}

function checkpointKey(consumer: ContextProjectionConsumer, tenantId: string, repository: string): string {
  return `${consumer}\u0000${tenantId}\u0000${repository}`;
}

export class MemoryContextOutbox implements OutboxStore {
  readonly #deliveries = new Map<string, ContextOutboxDelivery>();
  readonly #checkpoints = new Map<string, ProjectionCheckpoint>();

  async append(events: ContextOutboxEvent[]): Promise<void> {
    for (const event of events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
        throw new Error("Outbox sequence must be a positive safe integer");
      }
      for (const consumer of event.consumers) {
        const key = deliveryKey(event.id, consumer);
        const existing = this.#deliveries.get(key);
        if (existing !== undefined) {
          if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
            throw new Error("Outbox event identity collision");
          }
          continue;
        }
        this.#deliveries.set(key, {
          event: structuredClone(event),
          consumer,
          status: "available",
          attempt: 0,
          availableAt: normalizeIsoTime(event.occurredAt)
        });
      }
    }
  }

  async claim(input: {
    consumer: ContextProjectionConsumer;
    tenantId: string;
    repository: string;
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ContextOutboxDelivery[]> {
    const now = normalizeIsoTime(input.now);
    const leaseExpiresAt = normalizeIsoTime(input.leaseExpiresAt);
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Outbox claim limit must be positive");
    if (leaseExpiresAt <= now) throw new Error("Outbox lease must expire in the future");
    const eligible = [...this.#deliveries.values()]
      .filter(
        (delivery) =>
          delivery.consumer === input.consumer &&
          delivery.event.tenantId === input.tenantId &&
          delivery.event.repository === input.repository &&
          delivery.status !== "processed" &&
          delivery.availableAt <= now &&
          (delivery.status === "available" || (delivery.leaseExpiresAt !== undefined && delivery.leaseExpiresAt <= now))
      )
      .sort((left, right) => left.event.sequence - right.event.sequence || left.event.id.localeCompare(right.event.id))
      .slice(0, input.limit);
    for (const delivery of eligible) {
      delivery.status = "leased";
      delivery.attempt += 1;
      delivery.leaseId = newId("outbox_lease");
      delivery.leaseExpiresAt = leaseExpiresAt;
    }
    return structuredClone(eligible);
  }

  async acknowledge(input: {
    consumer: ContextProjectionConsumer;
    eventId: string;
    leaseId: string;
    processedAt: string;
    projectorVersion: string;
  }): Promise<boolean> {
    const delivery = this.#deliveries.get(deliveryKey(input.eventId, input.consumer));
    if (delivery?.status !== "leased" || delivery.leaseId !== input.leaseId) return false;
    const processedAt = normalizeIsoTime(input.processedAt);
    if (delivery.leaseExpiresAt === undefined || delivery.leaseExpiresAt <= processedAt) return false;
    delivery.status = "processed";
    delivery.processedAt = processedAt;
    delete delivery.leaseId;
    delete delivery.leaseExpiresAt;
    const key = checkpointKey(input.consumer, delivery.event.tenantId, delivery.event.repository);
    const current = this.#checkpoints.get(key);
    if (current === undefined || current.sequence < delivery.event.sequence) {
      this.#checkpoints.set(key, {
        consumer: input.consumer,
        tenantId: delivery.event.tenantId,
        repository: delivery.event.repository,
        sequence: delivery.event.sequence,
        projectorVersion: input.projectorVersion,
        updatedAt: processedAt
      });
    }
    return true;
  }

  async release(input: {
    consumer: ContextProjectionConsumer;
    eventId: string;
    leaseId: string;
    availableAt: string;
  }): Promise<boolean> {
    const delivery = this.#deliveries.get(deliveryKey(input.eventId, input.consumer));
    if (delivery?.status !== "leased" || delivery.leaseId !== input.leaseId) return false;
    delivery.status = "available";
    delivery.availableAt = normalizeIsoTime(input.availableAt);
    delete delivery.leaseId;
    delete delivery.leaseExpiresAt;
    return true;
  }

  async checkpoint(
    consumer: ContextProjectionConsumer,
    tenantId: string,
    repository: string
  ): Promise<ProjectionCheckpoint | undefined> {
    const value = this.#checkpoints.get(checkpointKey(consumer, tenantId, repository));
    return value === undefined ? undefined : structuredClone(value);
  }
}
