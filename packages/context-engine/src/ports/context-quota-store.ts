/**
 * Quota resource names are shared by the admission service, durable store,
 * metrics, and HTTP error payloads. Keep this list stable so persisted denial
 * counters remain readable across deployments.
 */
export const contextQuotaResources = [
  "query_rate",
  "build_rate",
  "active_builds",
  "active_model_tasks",
  "artifact_storage",
  "monthly_model_requests",
  "monthly_model_tokens"
] as const;

export type ContextQuotaResource = (typeof contextQuotaResources)[number];

export interface ContextQuotaRateBucket {
  readonly windowStartedAtMs: number;
  readonly used: number;
  readonly operationIds: Readonly<Record<string, true>>;
}

export interface ContextQuotaTimedReservation {
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ContextQuotaModelTaskReservation extends ContextQuotaTimedReservation {
  readonly reservedTokens: number;
  readonly reservationMonth: string;
}

export interface ContextQuotaArtifactReservation extends ContextQuotaTimedReservation {
  readonly artifactId: string;
  readonly bytes: number;
}

export interface ContextQuotaModelMonthLedger {
  readonly month: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reservedTokens: number;
  readonly completedTasks: Readonly<
    Record<
      string,
      {
        readonly usageDigest: string;
      }
    >
  >;
}

export interface ContextQuotaDenialLedger {
  readonly count: number;
  readonly lastDeniedAt: string;
}

/**
 * JSON-serializable state for one tenant. A production store must keep this
 * behind one serializable transaction or implement equivalent normalized
 * rows. It must never pass another tenant's state to the callback.
 */
export interface ContextTenantQuotaLedger {
  readonly version: 1;
  readonly tenantId: string;
  readonly queryRate: ContextQuotaRateBucket;
  readonly buildRate: ContextQuotaRateBucket;
  readonly activeBuilds: Readonly<Record<string, ContextQuotaTimedReservation>>;
  readonly completedBuilds: Readonly<Record<string, { readonly completedAt: string }>>;
  readonly activeModelTasks: Readonly<Record<string, ContextQuotaModelTaskReservation>>;
  readonly artifactReservations: Readonly<Record<string, ContextQuotaArtifactReservation>>;
  readonly artifacts: Readonly<Record<string, { readonly bytes: number; readonly committedAt: string }>>;
  readonly artifactBytes: number;
  readonly artifactDeletionOperations: Readonly<Record<string, { readonly artifactId: string }>>;
  readonly modelMonth: ContextQuotaModelMonthLedger;
  readonly denials: Readonly<Partial<Record<ContextQuotaResource, ContextQuotaDenialLedger>>>;
  readonly updatedAt: string;
}

export interface ContextQuotaMutation<T> {
  readonly state: ContextTenantQuotaLedger;
  readonly result: T;
}

export interface ContextQuotaStore {
  /**
   * Atomically reads, mutates, and commits exactly one authoritative tenant
   * partition. Store failures must reject; callers never fall back to allowing
   * work without quota state.
   */
  transact<T>(
    tenantId: string,
    operation: (current: ContextTenantQuotaLedger | undefined) => ContextQuotaMutation<T>
  ): Promise<T>;
}
