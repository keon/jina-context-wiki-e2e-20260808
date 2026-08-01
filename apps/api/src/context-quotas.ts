import { createHash } from "node:crypto";
import {
  type ContextQuotaModelMonthLedger as ModelMonthLedger,
  type ContextQuotaMutation,
  type ContextQuotaRateBucket as RateBucket,
  type ContextQuotaResource,
  type ContextQuotaStore,
  type ContextQuotaTimedReservation as TimedReservation,
  type ContextTenantQuotaLedger
} from "@jina/context-engine";

export type { ContextQuotaMutation, ContextQuotaResource, ContextQuotaStore, ContextTenantQuotaLedger };

export interface ContextQuotaLimits {
  readonly queryRequestsPerWindow: number;
  readonly queryWindowMs: number;
  readonly buildRequestsPerWindow: number;
  readonly buildWindowMs: number;
  readonly maxActiveBuilds: number;
  readonly maxActiveModelTasks: number;
  readonly artifactStorageBytes: number;
  readonly monthlyModelRequests: number;
  readonly monthlyModelTokens: number;
  readonly defaultModelTaskReservationTokens: number;
  readonly buildReservationTtlMs: number;
  readonly modelTaskReservationTtlMs: number;
  readonly artifactReservationTtlMs: number;
}

export const DEFAULT_CONTEXT_QUOTA_LIMITS: ContextQuotaLimits = Object.freeze({
  queryRequestsPerWindow: 600,
  queryWindowMs: 60_000,
  buildRequestsPerWindow: 30,
  buildWindowMs: 60 * 60_000,
  maxActiveBuilds: 4,
  maxActiveModelTasks: 8,
  artifactStorageBytes: 50 * 1024 * 1024 * 1024,
  monthlyModelRequests: 20_000,
  monthlyModelTokens: 500_000_000,
  defaultModelTaskReservationTokens: 250_000,
  buildReservationTtlMs: 24 * 60 * 60_000,
  modelTaskReservationTtlMs: 2 * 60 * 60_000,
  artifactReservationTtlMs: 30 * 60_000
});

/** Serialized local/test adapter. Multi-replica production should use a shared store. */
export class InMemoryContextQuotaStore implements ContextQuotaStore {
  readonly #states = new Map<string, ContextTenantQuotaLedger>();
  #tail: Promise<void> = Promise.resolve();

  async transact<T>(
    tenantId: string,
    operation: (current: ContextTenantQuotaLedger | undefined) => ContextQuotaMutation<T>
  ): Promise<T> {
    const prior = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const current = this.#states.get(tenantId);
      if (current && current.tenantId !== tenantId) {
        throw new ContextQuotaInvariantError("tenant_isolation", "quota store returned a cross-tenant ledger");
      }
      const mutation = operation(current === undefined ? undefined : structuredClone(current));
      if (mutation.state.tenantId !== tenantId) {
        throw new ContextQuotaInvariantError("tenant_isolation", "quota mutation crossed its tenant partition");
      }
      this.#states.set(tenantId, structuredClone(mutation.state));
      return mutation.result;
    } finally {
      release();
    }
  }
}

interface ContextQuotaRateSnapshot {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}

export interface ContextQuotaSnapshot {
  readonly version: 1;
  readonly tenantId: string;
  readonly observedAt: string;
  readonly limits: ContextQuotaLimits;
  readonly rates: {
    readonly query: ContextQuotaRateSnapshot;
    readonly build: ContextQuotaRateSnapshot;
  };
  readonly active: {
    readonly builds: number;
    readonly modelTasks: number;
  };
  readonly storage: {
    readonly committedBytes: number;
    readonly reservedBytes: number;
    readonly artifactCount: number;
    readonly limitBytes: number;
    readonly remainingBytes: number;
  };
  readonly monthlyModel: {
    readonly month: string;
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly totalTokens: number;
    readonly reservedTokens: number;
    readonly requestLimit: number;
    readonly tokenLimit: number;
    readonly remainingRequests: number;
    readonly remainingTokens: number;
  };
  readonly denials: Readonly<
    Partial<
      Record<
        ContextQuotaResource,
        {
          readonly count: number;
          readonly lastDeniedAt: string;
        }
      >
    >
  >;
}

export class ContextQuotaExceededError extends Error {
  readonly code = "context_quota_exceeded";

  constructor(
    readonly resource: ContextQuotaResource,
    message: string,
    readonly snapshot: ContextQuotaSnapshot,
    readonly retryAfterMs?: number
  ) {
    super(message.slice(0, 1_000));
    this.name = "ContextQuotaExceededError";
  }
}

export type ContextQuotaInvariantCode =
  "invalid_input" | "reservation_conflict" | "reservation_not_found" | "tenant_isolation";

export class ContextQuotaInvariantError extends Error {
  readonly code = "context_quota_invariant";

  constructor(
    readonly reason: ContextQuotaInvariantCode,
    message: string
  ) {
    super(message.slice(0, 1_000));
    this.name = "ContextQuotaInvariantError";
  }
}

export interface ContextQuotaAdmission {
  readonly outcome: "admitted" | "already_admitted" | "already_completed";
  readonly snapshot: ContextQuotaSnapshot;
  readonly expiresAt?: string;
}

interface QuotaDenied {
  readonly accepted: false;
  readonly resource: ContextQuotaResource;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly snapshot: ContextQuotaSnapshot;
}

interface QuotaAccepted<T> {
  readonly accepted: true;
  readonly value: T;
}

type QuotaOutcome<T> = QuotaAccepted<T> | QuotaDenied;

export interface ContextQuotaServiceOptions {
  readonly store: ContextQuotaStore;
  readonly defaults?: Partial<ContextQuotaLimits>;
  readonly resolveTenantLimits?: (
    tenantId: string
  ) => Partial<ContextQuotaLimits> | Promise<Partial<ContextQuotaLimits>>;
  readonly clock?: () => Date;
}

/**
 * Admission/accounting boundary for public Context work.
 *
 * Integration points:
 * - call `admitQuery` before list/read/search/diff work that is rate limited;
 * - call `admitBuild` in the same control flow as board-build creation, then
 *   `completeBuild` on every terminal board outcome;
 * - call `startModelTask` immediately before a model-backed worker stage and
 *   `finishModelTask` or `cancelModelTask` in its terminal path;
 * - reserve storage before upload, commit only after immutable persistence,
 *   and delete accounting during authoritative erasure.
 */
export class ContextQuotaService {
  readonly #store: ContextQuotaStore;
  readonly #defaults: ContextQuotaLimits;
  readonly #resolveTenantLimits?: ContextQuotaServiceOptions["resolveTenantLimits"];
  readonly #clock: () => Date;

  constructor(options: ContextQuotaServiceOptions) {
    this.#store = options.store;
    this.#defaults = contextQuotaLimits(options.defaults);
    this.#resolveTenantLimits = options.resolveTenantLimits;
    this.#clock = options.clock ?? (() => new Date());
  }

  async admitQuery(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const requestId = resourceId(input.requestId, "requestId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    const outcome = await this.#store.transact<QuotaOutcome<ContextQuotaAdmission>>(tenantId, (current) => {
      let state = currentState(current, tenantId, now, limits);
      const existing = state.queryRate.operationIds[requestId] === true;
      if (!existing && state.queryRate.used >= limits.queryRequestsPerWindow) {
        state = deniedState(state, "query_rate", now.iso);
        return denied(
          state,
          limits,
          now,
          "query_rate",
          "tenant query rate limit exceeded",
          rateResetMs(state.queryRate, limits.queryWindowMs, now.ms)
        );
      }
      if (!existing) state = { ...state, queryRate: consumeRate(state.queryRate, requestId), updatedAt: now.iso };
      return accepted(
        {
          outcome: existing ? "already_admitted" : "admitted",
          snapshot: quotaSnapshot(state, limits, now)
        } satisfies ContextQuotaAdmission,
        state
      );
    });
    return unwrap(outcome);
  }

  async admitBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly replacesBuildIds?: readonly string[];
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const buildId = resourceId(input.buildId, "buildId");
    const replacesBuildIds = new Set(
      (input.replacesBuildIds ?? []).map((replacedBuildId) => resourceId(replacedBuildId, "replacesBuildId"))
    );
    if (replacesBuildIds.has(buildId)) {
      throw new ContextQuotaInvariantError("invalid_input", "a Context build cannot replace itself");
    }
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    const outcome = await this.#store.transact<QuotaOutcome<ContextQuotaAdmission>>(tenantId, (current) => {
      let state = currentState(current, tenantId, now, limits);
      if (state.completedBuilds[buildId]) {
        return accepted(
          {
            outcome: "already_completed",
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      const active = state.activeBuilds[buildId];
      if (active) {
        return accepted(
          {
            outcome: "already_admitted",
            expiresAt: active.expiresAt,
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      if (state.buildRate.used >= limits.buildRequestsPerWindow) {
        state = deniedState(state, "build_rate", now.iso);
        return denied(
          state,
          limits,
          now,
          "build_rate",
          "tenant build rate limit exceeded",
          rateResetMs(state.buildRate, limits.buildWindowMs, now.ms)
        );
      }
      const retainedActiveBuilds = Object.fromEntries(
        Object.entries(state.activeBuilds).filter(([activeBuildId]) => !replacesBuildIds.has(activeBuildId))
      );
      if (Object.keys(retainedActiveBuilds).length >= limits.maxActiveBuilds) {
        state = deniedState(state, "active_builds", now.iso);
        return denied(
          state,
          limits,
          now,
          "active_builds",
          "tenant active Context build limit exceeded",
          earliestExpiryMs(state.activeBuilds, now.ms)
        );
      }
      const expiresAt = new Date(now.ms + limits.buildReservationTtlMs).toISOString();
      state = {
        ...state,
        buildRate: consumeRate(state.buildRate, buildId),
        activeBuilds: {
          // Keep replaced reservations until the Board mutation commits. The
          // caller reconciles them afterward, so a state-store rollback cannot
          // leave a still-active build permanently uncounted.
          ...state.activeBuilds,
          [buildId]: { createdAt: now.iso, expiresAt }
        },
        updatedAt: now.iso
      };
      return accepted(
        {
          outcome: "admitted",
          expiresAt,
          snapshot: quotaSnapshot(state, limits, now)
        } satisfies ContextQuotaAdmission,
        state
      );
    });
    return unwrap(outcome);
  }

  async renewBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    return this.#renewReservation(input, "build");
  }

  /**
   * Reactivates the same completed build reservation for an audited operator
   * retry. This does not consume a second build-rate token because it is not a
   * new build, but it does enforce the active-build limit and restores normal
   * lease renewal/accounting until the reopened build terminates again.
   */
  async resumeBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const buildId = resourceId(input.buildId, "buildId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    const outcome = await this.#store.transact<QuotaOutcome<ContextQuotaAdmission>>(tenantId, (current) => {
      let state = currentState(current, tenantId, now, limits);
      const active = state.activeBuilds[buildId];
      if (active) {
        return accepted(
          {
            outcome: "already_admitted",
            expiresAt: active.expiresAt,
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      if (!state.completedBuilds[buildId]) {
        throw notReserved("completed Context build reservation not found");
      }
      if (Object.keys(state.activeBuilds).length >= limits.maxActiveBuilds) {
        state = deniedState(state, "active_builds", now.iso);
        return denied(
          state,
          limits,
          now,
          "active_builds",
          "tenant active Context build limit exceeded",
          earliestExpiryMs(state.activeBuilds, now.ms)
        );
      }
      const completedBuilds = { ...state.completedBuilds };
      delete completedBuilds[buildId];
      const expiresAt = new Date(now.ms + limits.buildReservationTtlMs).toISOString();
      state = {
        ...state,
        activeBuilds: {
          ...state.activeBuilds,
          [buildId]: { createdAt: now.iso, expiresAt }
        },
        completedBuilds,
        updatedAt: now.iso
      };
      return accepted(
        {
          outcome: "admitted",
          expiresAt,
          snapshot: quotaSnapshot(state, limits, now)
        } satisfies ContextQuotaAdmission,
        state
      );
    });
    return unwrap(outcome);
  }

  /**
   * Restores quota accounting for a build that the durable Board still marks
   * active. Unlike operator resume, this also covers an expired reservation;
   * callers must establish active Board state before using it. The original
   * build-rate admission remains unchanged.
   */
  async restoreActiveBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const buildId = resourceId(input.buildId, "buildId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    const outcome = await this.#store.transact<QuotaOutcome<ContextQuotaAdmission>>(tenantId, (current) => {
      let state = currentState(current, tenantId, now, limits);
      const active = state.activeBuilds[buildId];
      if (active) {
        return accepted(
          {
            outcome: "already_admitted",
            expiresAt: active.expiresAt,
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      if (Object.keys(state.activeBuilds).length >= limits.maxActiveBuilds) {
        state = deniedState(state, "active_builds", now.iso);
        return denied(
          state,
          limits,
          now,
          "active_builds",
          "tenant active Context build limit exceeded",
          earliestExpiryMs(state.activeBuilds, now.ms)
        );
      }
      const completedBuilds = { ...state.completedBuilds };
      delete completedBuilds[buildId];
      const expiresAt = new Date(now.ms + limits.buildReservationTtlMs).toISOString();
      state = {
        ...state,
        activeBuilds: { ...state.activeBuilds, [buildId]: { createdAt: now.iso, expiresAt } },
        completedBuilds,
        updatedAt: now.iso
      };
      return accepted(
        {
          outcome: "admitted",
          expiresAt,
          snapshot: quotaSnapshot(state, limits, now)
        } satisfies ContextQuotaAdmission,
        state
      );
    });
    return unwrap(outcome);
  }

  async completeBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly at?: string;
  }): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(input.tenantId);
    const buildId = resourceId(input.buildId, "buildId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      if (state.completedBuilds[buildId]) {
        return { state, result: quotaSnapshot(state, limits, now) };
      }
      if (!state.activeBuilds[buildId]) {
        throw notReserved("Context build reservation not found");
      }
      const activeBuilds = { ...state.activeBuilds };
      delete activeBuilds[buildId];
      const next = {
        ...state,
        activeBuilds,
        completedBuilds: {
          ...state.completedBuilds,
          [buildId]: { completedAt: now.iso }
        },
        updatedAt: now.iso
      };
      return { state: next, result: quotaSnapshot(next, limits, now) };
    });
  }

  /**
   * Repairs reservations left behind when a board build became terminal or
   * was removed before quota settlement committed. The board is the
   * authoritative lifecycle record, so only its nonterminal ids remain active.
   */
  async reconcileActiveBuilds(input: {
    readonly tenantId: string;
    readonly activeBuildIds: readonly string[];
    readonly at?: string;
  }): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(input.tenantId);
    const activeBuildIds = new Set(input.activeBuildIds.map((buildId) => resourceId(buildId, "buildId")));
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      const activeBuilds = { ...state.activeBuilds };
      const completedBuilds = { ...state.completedBuilds };
      let changed = false;
      for (const buildId of Object.keys(activeBuilds)) {
        if (activeBuildIds.has(buildId)) continue;
        delete activeBuilds[buildId];
        completedBuilds[buildId] = { completedAt: now.iso };
        changed = true;
      }
      const next = changed
        ? {
            ...state,
            activeBuilds,
            completedBuilds,
            updatedAt: now.iso
          }
        : state;
      return { state: next, result: quotaSnapshot(next, limits, now) };
    });
  }

  async startModelTask(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly reservedTokens?: number;
    readonly at?: string;
    /**
     * A single worker claim may probe several candidates for one tenant. Keep
     * enforcing admission for every candidate while recording only the first
     * equivalent denial in that claim.
     */
    readonly recordDenial?: boolean;
  }): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const taskId = resourceId(input.taskId, "taskId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    const reservedTokens = nonNegativeInteger(
      input.reservedTokens ?? limits.defaultModelTaskReservationTokens,
      "reservedTokens"
    );
    const outcome = await this.#store.transact<QuotaOutcome<ContextQuotaAdmission>>(tenantId, (current) => {
      let state = currentState(current, tenantId, now, limits);
      if (state.modelMonth.completedTasks[taskId]) {
        return accepted(
          {
            outcome: "already_completed",
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      const active = state.activeModelTasks[taskId];
      if (active) {
        if (active.reservedTokens !== reservedTokens) {
          throw conflict("model task reservation changed its token estimate");
        }
        return accepted(
          {
            outcome: "already_admitted",
            expiresAt: active.expiresAt,
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      if (Object.keys(state.activeModelTasks).length >= limits.maxActiveModelTasks) {
        if (input.recordDenial !== false) state = deniedState(state, "active_model_tasks", now.iso);
        return denied(
          state,
          limits,
          now,
          "active_model_tasks",
          "tenant active model task limit exceeded",
          earliestExpiryMs(state.activeModelTasks, now.ms)
        );
      }
      if (state.modelMonth.requests >= limits.monthlyModelRequests) {
        if (input.recordDenial !== false) state = deniedState(state, "monthly_model_requests", now.iso);
        return denied(
          state,
          limits,
          now,
          "monthly_model_requests",
          "tenant monthly model request limit exceeded",
          nextMonthMs(now.date) - now.ms
        );
      }
      if (
        modelTokens(state.modelMonth) + state.modelMonth.reservedTokens + reservedTokens >
        limits.monthlyModelTokens
      ) {
        if (input.recordDenial !== false) state = deniedState(state, "monthly_model_tokens", now.iso);
        return denied(
          state,
          limits,
          now,
          "monthly_model_tokens",
          "tenant monthly model token limit exceeded",
          nextMonthMs(now.date) - now.ms
        );
      }
      const expiresAt = new Date(now.ms + limits.modelTaskReservationTtlMs).toISOString();
      state = {
        ...state,
        activeModelTasks: {
          ...state.activeModelTasks,
          [taskId]: {
            createdAt: now.iso,
            expiresAt,
            reservedTokens,
            reservationMonth: state.modelMonth.month
          }
        },
        modelMonth: {
          ...state.modelMonth,
          requests: state.modelMonth.requests + 1,
          reservedTokens: state.modelMonth.reservedTokens + reservedTokens
        },
        updatedAt: now.iso
      };
      return accepted(
        {
          outcome: "admitted",
          expiresAt,
          snapshot: quotaSnapshot(state, limits, now)
        } satisfies ContextQuotaAdmission,
        state
      );
    });
    return unwrap(outcome);
  }

  async renewModelTask(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    return this.#renewReservation(
      { tenantId: input.tenantId, buildId: input.taskId, ...(input.at ? { at: input.at } : {}) },
      "model"
    );
  }

  async finishModelTask(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number;
    readonly at?: string;
  }): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(input.tenantId);
    const taskId = resourceId(input.taskId, "taskId");
    const inputTokens = nonNegativeInteger(input.inputTokens, "inputTokens");
    const outputTokens = nonNegativeInteger(input.outputTokens, "outputTokens");
    const cachedInputTokens = nonNegativeInteger(input.cachedInputTokens ?? 0, "cachedInputTokens");
    if (cachedInputTokens > inputTokens) {
      throw new ContextQuotaInvariantError("invalid_input", "cachedInputTokens cannot exceed inputTokens");
    }
    const usageDigest = digest({ inputTokens, outputTokens, cachedInputTokens });
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      const completed = state.modelMonth.completedTasks[taskId];
      if (completed) {
        if (completed.usageDigest !== usageDigest) {
          throw conflict("model task completion changed its usage");
        }
        return { state, result: quotaSnapshot(state, limits, now) };
      }
      const active = state.activeModelTasks[taskId];
      const activeModelTasks = { ...state.activeModelTasks };
      if (active) delete activeModelTasks[taskId];
      const reservationInCurrentMonth = active?.reservationMonth === state.modelMonth.month ? active.reservedTokens : 0;
      const next = {
        ...state,
        activeModelTasks,
        modelMonth: {
          ...state.modelMonth,
          requests: active ? state.modelMonth.requests : state.modelMonth.requests + 1,
          inputTokens: state.modelMonth.inputTokens + inputTokens,
          outputTokens: state.modelMonth.outputTokens + outputTokens,
          cachedInputTokens: state.modelMonth.cachedInputTokens + cachedInputTokens,
          reservedTokens: Math.max(0, state.modelMonth.reservedTokens - reservationInCurrentMonth),
          completedTasks: {
            ...state.modelMonth.completedTasks,
            [taskId]: { usageDigest }
          }
        },
        updatedAt: now.iso
      };
      return { state: next, result: quotaSnapshot(next, limits, now) };
    });
  }

  async cancelModelTask(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly at?: string;
  }): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(input.tenantId);
    const taskId = resourceId(input.taskId, "taskId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      const active = state.activeModelTasks[taskId];
      if (!active) throw notReserved("model task reservation not found");
      const activeModelTasks = { ...state.activeModelTasks };
      delete activeModelTasks[taskId];
      const next = {
        ...state,
        activeModelTasks,
        modelMonth: {
          ...state.modelMonth,
          reservedTokens:
            active.reservationMonth === state.modelMonth.month
              ? Math.max(0, state.modelMonth.reservedTokens - active.reservedTokens)
              : state.modelMonth.reservedTokens
        },
        updatedAt: now.iso
      };
      return { state: next, result: quotaSnapshot(next, limits, now) };
    });
  }

  async reserveArtifactStorage(input: {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly artifactId: string;
    readonly bytes: number;
    readonly at?: string;
  }): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const reservationId = resourceId(input.reservationId, "reservationId");
    const artifactId = resourceId(input.artifactId, "artifactId");
    const bytes = nonNegativeInteger(input.bytes, "bytes");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    const outcome = await this.#store.transact<QuotaOutcome<ContextQuotaAdmission>>(tenantId, (current) => {
      let state = currentState(current, tenantId, now, limits);
      const committed = state.artifacts[artifactId];
      if (committed) {
        if (committed.bytes !== bytes) throw conflict("immutable artifact changed its accounted bytes");
        return accepted(
          {
            outcome: "already_completed",
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      const existing = state.artifactReservations[reservationId];
      if (existing) {
        if (existing.artifactId !== artifactId || existing.bytes !== bytes) {
          throw conflict("artifact reservation changed identity or bytes");
        }
        return accepted(
          {
            outcome: "already_admitted",
            expiresAt: existing.expiresAt,
            snapshot: quotaSnapshot(state, limits, now)
          } satisfies ContextQuotaAdmission,
          state
        );
      }
      const competing = Object.entries(state.artifactReservations).find(
        ([, reservation]) => reservation.artifactId === artifactId
      );
      if (competing) {
        throw conflict("artifact already has a different active storage reservation");
      }
      const reservedBytes = artifactReservedBytes(state);
      if (state.artifactBytes + reservedBytes + bytes > limits.artifactStorageBytes) {
        state = deniedState(state, "artifact_storage", now.iso);
        return denied(state, limits, now, "artifact_storage", "tenant artifact storage limit exceeded");
      }
      const expiresAt = new Date(now.ms + limits.artifactReservationTtlMs).toISOString();
      state = {
        ...state,
        artifactReservations: {
          ...state.artifactReservations,
          [reservationId]: { artifactId, bytes, createdAt: now.iso, expiresAt }
        },
        updatedAt: now.iso
      };
      return accepted(
        {
          outcome: "admitted",
          expiresAt,
          snapshot: quotaSnapshot(state, limits, now)
        } satisfies ContextQuotaAdmission,
        state
      );
    });
    return unwrap(outcome);
  }

  async commitArtifactStorage(input: {
    readonly tenantId: string;
    readonly reservationId: string;
    readonly artifactId: string;
    readonly bytes: number;
    readonly at?: string;
  }): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(input.tenantId);
    const reservationId = resourceId(input.reservationId, "reservationId");
    const artifactId = resourceId(input.artifactId, "artifactId");
    const bytes = nonNegativeInteger(input.bytes, "bytes");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      const committed = state.artifacts[artifactId];
      if (committed) {
        if (committed.bytes !== bytes) throw conflict("immutable artifact changed its accounted bytes");
        const pending = state.artifactReservations[reservationId];
        if (pending && (pending.artifactId !== artifactId || pending.bytes !== bytes)) {
          throw conflict("artifact commit does not match its storage reservation");
        }
        if (!pending) return { state, result: quotaSnapshot(state, limits, now) };
        const artifactReservations = { ...state.artifactReservations };
        delete artifactReservations[reservationId];
        const next = { ...state, artifactReservations, updatedAt: now.iso };
        return { state: next, result: quotaSnapshot(next, limits, now) };
      }
      const reservation = state.artifactReservations[reservationId];
      if (!reservation) throw notReserved("artifact storage reservation not found");
      if (reservation.artifactId !== artifactId || reservation.bytes !== bytes) {
        throw conflict("artifact commit does not match its storage reservation");
      }
      const artifactReservations = { ...state.artifactReservations };
      delete artifactReservations[reservationId];
      const next = {
        ...state,
        artifactReservations,
        artifacts: {
          ...state.artifacts,
          [artifactId]: { bytes, committedAt: now.iso }
        },
        artifactBytes: state.artifactBytes + bytes,
        updatedAt: now.iso
      };
      return { state: next, result: quotaSnapshot(next, limits, now) };
    });
  }

  async deleteArtifactStorage(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly artifactId: string;
    readonly at?: string;
  }): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(input.tenantId);
    const operationId = resourceId(input.operationId, "operationId");
    const artifactId = resourceId(input.artifactId, "artifactId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      const completed = state.artifactDeletionOperations[operationId];
      if (completed) {
        if (completed.artifactId !== artifactId) throw conflict("artifact deletion operation changed target");
        return { state, result: quotaSnapshot(state, limits, now) };
      }
      const artifact = state.artifacts[artifactId];
      if (!artifact) throw notReserved("accounted artifact not found");
      const artifacts = { ...state.artifacts };
      delete artifacts[artifactId];
      const next = {
        ...state,
        artifacts,
        artifactBytes: Math.max(0, state.artifactBytes - artifact.bytes),
        artifactDeletionOperations: {
          ...state.artifactDeletionOperations,
          [operationId]: { artifactId }
        },
        updatedAt: now.iso
      };
      return { state: next, result: quotaSnapshot(next, limits, now) };
    });
  }

  async snapshot(tenantIdValue: string, at?: string): Promise<ContextQuotaSnapshot> {
    const tenantId = tenant(tenantIdValue);
    const now = this.#time(at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      return { state, result: quotaSnapshot(state, limits, now) };
    });
  }

  async #renewReservation(
    input: { readonly tenantId: string; readonly buildId: string; readonly at?: string },
    kind: "build" | "model"
  ): Promise<ContextQuotaAdmission> {
    const tenantId = tenant(input.tenantId);
    const id = resourceId(input.buildId, kind === "build" ? "buildId" : "taskId");
    const now = this.#time(input.at);
    const limits = await this.#limits(tenantId);
    return this.#store.transact(tenantId, (current) => {
      const state = currentState(current, tenantId, now, limits);
      if (kind === "build") {
        const reservation = state.activeBuilds[id];
        if (!reservation) throw notReserved("Context build reservation not found");
        const expiresAt = new Date(now.ms + limits.buildReservationTtlMs).toISOString();
        const next = {
          ...state,
          activeBuilds: {
            ...state.activeBuilds,
            [id]: { ...reservation, expiresAt }
          },
          updatedAt: now.iso
        };
        return {
          state: next,
          result: {
            outcome: "already_admitted",
            expiresAt,
            snapshot: quotaSnapshot(next, limits, now)
          }
        };
      }
      const reservation = state.activeModelTasks[id];
      if (!reservation) throw notReserved("model task reservation not found");
      const expiresAt = new Date(now.ms + limits.modelTaskReservationTtlMs).toISOString();
      const next = {
        ...state,
        activeModelTasks: {
          ...state.activeModelTasks,
          [id]: { ...reservation, expiresAt }
        },
        updatedAt: now.iso
      };
      return {
        state: next,
        result: {
          outcome: "already_admitted",
          expiresAt,
          snapshot: quotaSnapshot(next, limits, now)
        }
      };
    });
  }

  #time(at?: string): QuotaTime {
    const date = at === undefined ? this.#clock() : new Date(at);
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
      throw new ContextQuotaInvariantError("invalid_input", "quota timestamp is invalid");
    }
    return { date, ms: date.valueOf(), iso: date.toISOString() };
  }

  async #limits(tenantId: string): Promise<ContextQuotaLimits> {
    let override: Partial<ContextQuotaLimits> = {};
    if (this.#resolveTenantLimits) {
      try {
        override = await this.#resolveTenantLimits(tenantId);
      } catch (error) {
        throw new ContextQuotaInvariantError(
          "tenant_isolation",
          `tenant quota configuration is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    }
    return contextQuotaLimits({ ...this.#defaults, ...override });
  }
}

interface QuotaTime {
  readonly date: Date;
  readonly ms: number;
  readonly iso: string;
}

export function contextQuotaLimits(overrides: Partial<ContextQuotaLimits> = {}): ContextQuotaLimits {
  const limits = { ...DEFAULT_CONTEXT_QUOTA_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ContextQuotaInvariantError("invalid_input", `${name} must be a positive safe integer`);
    }
  }
  if (limits.defaultModelTaskReservationTokens > limits.monthlyModelTokens) {
    throw new ContextQuotaInvariantError(
      "invalid_input",
      "defaultModelTaskReservationTokens cannot exceed monthlyModelTokens"
    );
  }
  return limits;
}

function emptyState(tenantId: string, now: QuotaTime, limits: ContextQuotaLimits): ContextTenantQuotaLedger {
  return {
    version: 1,
    tenantId,
    queryRate: currentRate(undefined, limits.queryWindowMs, now.ms),
    buildRate: currentRate(undefined, limits.buildWindowMs, now.ms),
    activeBuilds: {},
    completedBuilds: {},
    activeModelTasks: {},
    artifactReservations: {},
    artifacts: {},
    artifactBytes: 0,
    artifactDeletionOperations: {},
    modelMonth: emptyModelMonth(monthKey(now.date)),
    denials: {},
    updatedAt: now.iso
  };
}

function currentState(
  input: ContextTenantQuotaLedger | undefined,
  tenantId: string,
  now: QuotaTime,
  limits: ContextQuotaLimits
): ContextTenantQuotaLedger {
  if (input === undefined) return emptyState(tenantId, now, limits);
  if (input.version !== 1 || input.tenantId !== tenantId) {
    throw new ContextQuotaInvariantError("tenant_isolation", "quota ledger is outside the requested tenant");
  }
  const currentMonth = monthKey(now.date);
  const modelMonth = input.modelMonth.month === currentMonth ? input.modelMonth : emptyModelMonth(currentMonth);
  const activeBuilds = unexpired(input.activeBuilds, now.ms);
  const activeModelTasks = unexpired(input.activeModelTasks, now.ms);
  const artifactReservations = unexpired(input.artifactReservations, now.ms);
  const reservedTokens = Object.values(activeModelTasks)
    .filter((task) => task.reservationMonth === currentMonth)
    .reduce((total, task) => total + task.reservedTokens, 0);
  return {
    ...input,
    queryRate: currentRate(input.queryRate, limits.queryWindowMs, now.ms),
    buildRate: currentRate(input.buildRate, limits.buildWindowMs, now.ms),
    activeBuilds,
    activeModelTasks,
    artifactReservations,
    modelMonth: { ...modelMonth, reservedTokens },
    updatedAt: now.iso
  };
}

function currentRate(input: RateBucket | undefined, windowMs: number, nowMs: number): RateBucket {
  const windowStartedAtMs = Math.floor(nowMs / windowMs) * windowMs;
  return input?.windowStartedAtMs === windowStartedAtMs ? input : { windowStartedAtMs, used: 0, operationIds: {} };
}

function consumeRate(input: RateBucket, operationId: string): RateBucket {
  return {
    ...input,
    used: input.used + 1,
    operationIds: { ...input.operationIds, [operationId]: true }
  };
}

function unexpired<T extends TimedReservation>(input: Readonly<Record<string, T>>, nowMs: number): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, reservation]) => Date.parse(reservation.expiresAt) > nowMs)
  );
}

function emptyModelMonth(month: string): ModelMonthLedger {
  return {
    month,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reservedTokens: 0,
    completedTasks: {}
  };
}

function quotaSnapshot(
  state: ContextTenantQuotaLedger,
  limits: ContextQuotaLimits,
  now: QuotaTime
): ContextQuotaSnapshot {
  const committedBytes = state.artifactBytes;
  const reservedBytes = artifactReservedBytes(state);
  const totalTokens = modelTokens(state.modelMonth);
  return {
    version: 1,
    tenantId: state.tenantId,
    observedAt: now.iso,
    limits,
    rates: {
      query: rateSnapshot(state.queryRate, limits.queryRequestsPerWindow, limits.queryWindowMs),
      build: rateSnapshot(state.buildRate, limits.buildRequestsPerWindow, limits.buildWindowMs)
    },
    active: {
      builds: Object.keys(state.activeBuilds).length,
      modelTasks: Object.keys(state.activeModelTasks).length
    },
    storage: {
      committedBytes,
      reservedBytes,
      artifactCount: Object.keys(state.artifacts).length,
      limitBytes: limits.artifactStorageBytes,
      remainingBytes: Math.max(0, limits.artifactStorageBytes - committedBytes - reservedBytes)
    },
    monthlyModel: {
      month: state.modelMonth.month,
      requests: state.modelMonth.requests,
      inputTokens: state.modelMonth.inputTokens,
      outputTokens: state.modelMonth.outputTokens,
      cachedInputTokens: state.modelMonth.cachedInputTokens,
      totalTokens,
      reservedTokens: state.modelMonth.reservedTokens,
      requestLimit: limits.monthlyModelRequests,
      tokenLimit: limits.monthlyModelTokens,
      remainingRequests: Math.max(0, limits.monthlyModelRequests - state.modelMonth.requests),
      remainingTokens: Math.max(0, limits.monthlyModelTokens - totalTokens - state.modelMonth.reservedTokens)
    },
    denials: state.denials
  };
}

function rateSnapshot(bucket: RateBucket, limit: number, windowMs: number): ContextQuotaRateSnapshot {
  return {
    used: bucket.used,
    limit,
    remaining: Math.max(0, limit - bucket.used),
    resetAt: new Date(bucket.windowStartedAtMs + windowMs).toISOString()
  };
}

function deniedState(
  state: ContextTenantQuotaLedger,
  resource: ContextQuotaResource,
  at: string
): ContextTenantQuotaLedger {
  const previous = state.denials[resource];
  return {
    ...state,
    denials: {
      ...state.denials,
      [resource]: {
        count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1),
        lastDeniedAt: at
      }
    },
    updatedAt: at
  };
}

function denied<T>(
  state: ContextTenantQuotaLedger,
  limits: ContextQuotaLimits,
  now: QuotaTime,
  resource: ContextQuotaResource,
  message: string,
  retryAfterMs?: number
): ContextQuotaMutation<QuotaOutcome<T>> {
  return {
    state,
    result: {
      accepted: false,
      resource,
      message,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) }),
      snapshot: quotaSnapshot(state, limits, now)
    }
  };
}

function accepted<T>(value: T, state: ContextTenantQuotaLedger): ContextQuotaMutation<QuotaOutcome<T>> {
  return { state, result: { accepted: true, value } };
}

function unwrap<T>(outcome: QuotaOutcome<T>): T {
  if (outcome.accepted) return outcome.value;
  throw new ContextQuotaExceededError(outcome.resource, outcome.message, outcome.snapshot, outcome.retryAfterMs);
}

function rateResetMs(bucket: RateBucket, windowMs: number, nowMs: number): number {
  return Math.max(0, bucket.windowStartedAtMs + windowMs - nowMs);
}

function earliestExpiryMs(input: Readonly<Record<string, TimedReservation>>, nowMs: number): number | undefined {
  const expiries = Object.values(input).map((reservation) => Date.parse(reservation.expiresAt));
  return expiries.length === 0 ? undefined : Math.max(0, Math.min(...expiries) - nowMs);
}

function artifactReservedBytes(state: ContextTenantQuotaLedger): number {
  return Object.values(state.artifactReservations).reduce((total, reservation) => total + reservation.bytes, 0);
}

function modelTokens(month: ModelMonthLedger): number {
  return month.inputTokens + month.outputTokens;
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function nextMonthMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function tenant(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || tenantId.length > 240 || containsControlCharacter(tenantId)) {
    throw new ContextQuotaInvariantError("invalid_input", "tenantId is invalid");
  }
  return tenantId;
}

function resourceId(value: string, label: string): string {
  const id = value.trim();
  if (!id || id.length > 512 || containsControlCharacter(id)) {
    throw new ContextQuotaInvariantError("invalid_input", `${label} is invalid`);
  }
  return id;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContextQuotaInvariantError("invalid_input", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function conflict(message: string): ContextQuotaInvariantError {
  return new ContextQuotaInvariantError("reservation_conflict", message);
}

function notReserved(message: string): ContextQuotaInvariantError {
  return new ContextQuotaInvariantError("reservation_not_found", message);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127;
  });
}
