import type {
  ContextOutboxDelivery,
  ContextOutboxEvent,
  ContextProjectionConsumer,
  ProjectionCheckpoint
} from "../domain/projection.js";

export interface OutboxStore {
  append(events: ContextOutboxEvent[]): Promise<void>;
  claim(input: {
    consumer: ContextProjectionConsumer;
    tenantId: string;
    repository: string;
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ContextOutboxDelivery[]>;
  acknowledge(input: {
    consumer: ContextProjectionConsumer;
    eventId: string;
    leaseId: string;
    processedAt: string;
    projectorVersion: string;
  }): Promise<boolean>;
  release(input: {
    consumer: ContextProjectionConsumer;
    eventId: string;
    leaseId: string;
    availableAt: string;
  }): Promise<boolean>;
  checkpoint(
    consumer: ContextProjectionConsumer,
    tenantId: string,
    repository: string
  ): Promise<ProjectionCheckpoint | undefined>;
}
