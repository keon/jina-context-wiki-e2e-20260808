export const canonicalEventTypes = [
  "observation_recorded", "commit_ingested", "blob_parsed", "ref_moved", "entity_changed",
  "identity_changed", "assertion_changed", "redirect_added", "observation_redacted", "tombstone"
] as const;
export type CanonicalEventType = (typeof canonicalEventTypes)[number];

export interface CanonicalOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: CanonicalEventType;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly availableAt: string;
  readonly claimedBy?: string;
  readonly claimedAt?: string;
  readonly claimExpiresAt?: string;
  readonly processedAt?: string;
  readonly attempts: number;
  readonly lastError?: string;
}

export interface ProjectionRebuildResult {
  readonly manifestFileCount: number;
  readonly searchDocumentCount: number;
  readonly reconciledAssertionCount: number;
  readonly rebuilt: boolean;
  readonly processedEventCount: number;
  readonly projectedAt: string;
}

export interface OntologyOperationalMetrics {
  readonly outboxDepth: Readonly<Record<string, number>>;
  readonly oldestOutboxAgeSeconds: number;
  readonly unparsedBlobCount: number;
  readonly manifestStalenessSeconds: number;
  readonly searchStalenessSeconds: number;
  readonly proposedAssertionCount: number;
  readonly acceptanceRates: readonly {
    readonly generator: string;
    readonly predicate: string;
    readonly accepted: number;
    readonly rejected: number;
    readonly rate: number;
  }[];
}
