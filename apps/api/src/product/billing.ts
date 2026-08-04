import type { AppConfig, BillingConfig } from "./config.js";
import {
  createAutumnClient,
  AutumnError,
  type AutumnClient,
  type AutumnInvoice,
  type CheckResult,
} from "./autumn.js";
import { creditsForCost, customerShareFromSubsidy } from "./billing-math.js";
import {
  addRunAiCreditsTotal,
  claimInfraForTracking,
  claimUsageForTracking,
  getDispatchBillingContext,
  getReviewRunBilling,
  getReviewRunStatus,
  getRunBillingContext,
  listPendingUsageRows,
  listRunUsagePendingOutcome,
  listRunsWithPendingInfra,
  listStaleTrackingInfra,
  listStaleTrackingUsageRows,
  listTerminalRunsWithPendingOutcome,
  markInfraBilled,
  markUsageBilled,
  reclaimStaleTrackingInfra,
  reclaimStaleTrackingUsage,
  revertInfraClaim,
  revertUsageClaim,
  setInfraPending,
  setInfraShadowComputed,
  setUsageComputedPending,
  setUsageShadowComputed,
  upsertReviewRunBilling,
  waiveManagedUsageRows,
  waiveRunBilling,
  type BillingKeySource,
  type BillingPolicy,
  type DispatchBillingContext,
  type PendingUsageRow,
  type ReviewRunBilling,
  type RunBillingContext,
  type StaleTrackingInfra,
} from "./store.js";

/**
 * Autumn billing orchestration. All of the credit rules live here; Autumn only holds
 * balances/entitlements. Behavior is governed by config.billing.enforce:
 *   "off"    -> billing is inert (no Autumn calls, no gating, no settlement).
 *   "shadow" -> compute + persist credits/statuses and log would-be decisions, but never
 *               block a dispatch and never call Autumn track. DECISION 1: shadow NEVER
 *               back-bills — settlement finalizes rows as the terminal 'shadow_computed'
 *               status (amounts persisted for reconciliation), which the retry drain never
 *               selects, so flipping to "on" bills nothing from the shadow period.
 *   "on"     -> block new reviews with exhausted credits at prepare and call Autumn track on
 *               settlement. A run admitted by prepare is never balance-gated again, so it can finish
 *               even if its final usage exhausts the tenant's balance.
 * Billing is only active when AUTUMN_SECRET_KEY is set (createAutumnClient returns a client)
 * AND enforce != "off". Absent the secret, everything degrades to a no-op.
 */

/** The overage-credit top-up product id (see autumn.config.ts). */
const OVERAGE_TOPUP_PRODUCT_ID = "overage_credits";
/** Default overage-credit pack when the dashboard doesn't specify one: 10,000 credits ($100). */
export const DEFAULT_TOPUP_CREDITS = 10_000;
/** Bounds on a user-chosen top-up amount ($1 = 100 credits): $5 floor, $10,000 ceiling. Keeps a fat-
 *  finger or hostile value from creating a nonsensical Stripe line item. */
export const MIN_TOPUP_CREDITS = 500;
export const MAX_TOPUP_CREDITS = 1_000_000;

/**
 * Coerce a client-supplied top-up credit amount into a valid quantity, or undefined to fall back to the
 * default pack. A non-finite / non-positive / non-integer value is rejected (undefined); a valid value is
 * floored and clamped into [MIN_TOPUP_CREDITS, MAX_TOPUP_CREDITS]. Pure + exported for unit tests.
 */
export function normalizeTopupCredits(raw: unknown): number | undefined {
  const value = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(Math.max(Math.floor(value), MIN_TOPUP_CREDITS), MAX_TOPUP_CREDITS);
}

const RETRY_BATCH_LIMIT = 200;

/** A 'tracking' claim older than this is treated as stale (crashed mid-charge) and retried. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** The store surface the billing service depends on — injectable so tests need no database. */
export interface BillingStorePort {
  getRunBillingContext(reviewRunId: string): Promise<RunBillingContext | undefined>;
  getDispatchBillingContext(
    installationId: number,
    authorLogin?: string,
  ): Promise<DispatchBillingContext | undefined>;
  upsertReviewRunBilling(input: {
    reviewRunId: string;
    tenantId: string;
    rateMode: "included" | "overage";
    keySource?: BillingKeySource;
  }): Promise<void>;
  getReviewRunBilling(reviewRunId: string): Promise<ReviewRunBilling | undefined>;
  listRunUsagePendingOutcome(reviewRunId: string): Promise<PendingUsageRow[]>;
  setUsageComputedPending(usageId: string, customerShare: string, aiCredits: number): Promise<void>;
  setUsageShadowComputed(usageId: string, customerShare: string, aiCredits: number): Promise<void>;
  claimUsageForTracking(usageId: string, autumnEventId: string): Promise<boolean>;
  revertUsageClaim(usageId: string): Promise<void>;
  markUsageBilled(usageId: string, autumnEventId: string): Promise<boolean>;
  waiveManagedUsageRows(reviewRunId: string): Promise<void>;
  listStaleTrackingUsageRows(limit: number, olderThan: Date): Promise<PendingUsageRow[]>;
  reclaimStaleTrackingUsage(usageId: string, olderThan: Date): Promise<boolean>;
  waiveRunBilling(reviewRunId: string, tenantId: string): Promise<void>;
  claimInfraForTracking(input: {
    reviewRunId: string;
    tenantId: string;
    rateMode: "included" | "overage";
    credits: number;
    autumnEventId: string;
  }): Promise<boolean>;
  revertInfraClaim(reviewRunId: string): Promise<void>;
  markInfraBilled(input: {
    reviewRunId: string;
    tenantId: string;
    rateMode: "included" | "overage";
    credits: number;
    autumnEventId: string;
  }): Promise<void>;
  listStaleTrackingInfra(limit: number, olderThan: Date): Promise<StaleTrackingInfra[]>;
  reclaimStaleTrackingInfra(reviewRunId: string, olderThan: Date): Promise<boolean>;
  setInfraPending(input: {
    reviewRunId: string;
    tenantId: string;
    rateMode: "included" | "overage";
    credits: number;
  }): Promise<void>;
  setInfraShadowComputed(input: {
    reviewRunId: string;
    tenantId: string;
    rateMode: "included" | "overage";
    credits: number;
  }): Promise<void>;
  addRunAiCreditsTotal(reviewRunId: string, credits: number): Promise<void>;
  getReviewRunStatus(reviewRunId: string): Promise<string | undefined>;
  listPendingUsageRows(limit: number): Promise<PendingUsageRow[]>;
  listTerminalRunsWithPendingOutcome(limit: number): Promise<Array<{ reviewRunId: string; status: string }>>;
  listRunsWithPendingInfra(limit: number): Promise<Array<{ reviewRunId: string; status: string }>>;
}

/** The real store port, binding to store.ts. */
const realBillingStore: BillingStorePort = {
  getRunBillingContext,
  getDispatchBillingContext,
  upsertReviewRunBilling,
  getReviewRunBilling,
  listRunUsagePendingOutcome,
  setUsageComputedPending,
  setUsageShadowComputed,
  claimUsageForTracking,
  revertUsageClaim,
  markUsageBilled,
  waiveManagedUsageRows,
  listStaleTrackingUsageRows,
  reclaimStaleTrackingUsage,
  waiveRunBilling,
  claimInfraForTracking,
  revertInfraClaim,
  markInfraBilled,
  listStaleTrackingInfra,
  reclaimStaleTrackingInfra,
  setInfraPending,
  setInfraShadowComputed,
  addRunAiCreditsTotal,
  getReviewRunStatus,
  listPendingUsageRows,
  listTerminalRunsWithPendingOutcome,
  listRunsWithPendingInfra,
};

export type RateMode = "included" | "overage";
export type AccessDecision = {
  allowed: boolean;
  creditsBalance?: number;
  managedAiAccess?: boolean;
  reason?: string;
};

/**
 * Distinguishes an Autumn outage from a missing configuration for the dashboard:
 *  - "not_configured": Autumn secret unset, or the viewer has no tenant/customer.
 *  - "unavailable":    Autumn is configured but errored (balance fields are null).
 *  - "ok":             live data present.
 * `configured` stays true only for "ok" (backward compatibility).
 */
type BillingStatus = "ok" | "unavailable" | "not_configured";

/**
 * Current-cycle credit breakdown surfaced to the dashboard, derived from the Autumn balance the overview
 * already fetches. `used` = the balance's usage field, else granted - remaining. All null when the
 * balance is unavailable or the fields are absent (never fabricated).
 */
type BillingCycle = {
  granted: number | null;
  remaining: number | null;
  used: number | null;
  next_reset_at: string | null;
};

const EMPTY_CYCLE: BillingCycle = { granted: null, remaining: null, used: null, next_reset_at: null };

export type BillingOverview = {
  configured: boolean;
  status: BillingStatus;
  plan_id: string | null;
  credits_balance: number | null;
  managed_ai_access: boolean | null;
  // Current-cycle granted/remaining/used/next_reset breakdown (from the same Autumn balance).
  cycle: BillingCycle;
  // Recent invoices (from getCustomer expand=invoices). Empty when Autumn returns none or is not
  // configured — never fabricated.
  billing_activity: AutumnInvoice[];
};

/**
 * Current-cycle used credits from an Autumn balance check, or null when it cannot be derived. Prefers the
 * balance's own `usage` field; falls back to granted - remaining. Pure + exported for the auto-review-cap
 * tests. Returns null when the check is absent (Autumn down) or neither source is available.
 */
export function usedCreditsFromCheck(check: CheckResult | null | undefined): number | null {
  if (!check) {
    return null;
  }
  if (typeof check.usage === "number") {
    return Math.max(0, check.usage);
  }
  if (typeof check.granted === "number" && typeof check.balance === "number") {
    return Math.max(0, check.granted - check.balance);
  }
  return null;
}

/**
 * Whether a run's trigger source is an AUTO trigger the cap applies to. The auto-review cap targets
 * unattended reviews (webhook/scheduled/policy); MANUAL triggers are user-initiated and always bypass it.
 * Absent/unknown trigger is treated as AUTO (a run always records a trigger; webhook is the default).
 */
export function isAutoReviewTrigger(triggerSource: string | undefined): boolean {
  return triggerSource !== "manual";
}

/**
 * Whether the tenant's auto-review credit cap should block this run. Pure + exported for testing. Blocks
 * only when: the cap is enabled AND a non-null credit limit is set AND the trigger is AUTO (manual
 * bypasses) AND current-cycle used credits are derivable (Autumn up) AND used >= limit. An Autumn outage
 * (used null) never blocks on the cap — fail open, consistent with the rest of the gate.
 */
export function autoReviewLimitReached(
  policy: BillingPolicy,
  triggerSource: string | undefined,
  check: CheckResult | null | undefined,
): boolean {
  if (!policy.auto_review_limit_enabled || policy.auto_review_limit_credits === null) {
    return false;
  }
  if (!isAutoReviewTrigger(triggerSource)) {
    return false;
  }
  const used = usedCreditsFromCheck(check);
  if (used === null) {
    return false;
  }
  return used >= policy.auto_review_limit_credits;
}

/**
 * Retry-drain outcome counts. NON-BLOCKING ADOPTED (c): the original {usage_billed, runs_settled,
 * infra_billed} are kept for compatibility (usage_billed/infra_billed still INCLUDE stale rebills), and
 * *_failed + stale_*_rebilled breakdowns are added so a failed drain is distinguishable from an empty
 * backlog (both previously reported all-zero billed counts).
 */
export type RetryBillingCounts = {
  usage_billed: number;
  usage_failed: number;
  runs_settled: number;
  runs_failed: number;
  infra_billed: number;
  infra_failed: number;
  stale_usage_rebilled: number;
  stale_infra_rebilled: number;
};

function emptyRetryBillingCounts(): RetryBillingCounts {
  return {
    usage_billed: 0,
    usage_failed: 0,
    runs_settled: 0,
    runs_failed: 0,
    infra_billed: 0,
    infra_failed: 0,
    stale_usage_rebilled: 0,
    stale_infra_rebilled: 0,
  };
}

/** FINDING 1: cap on the per-process ensured-customer memo, bounding its memory footprint. */
const ENSURED_CUSTOMERS_CAP = 1000;

export class BillingService {
  /**
   * FINDING 1: Autumn does NOT auto-create customers — a check/track against an unknown customer
   * 404s, so a first-time tenant's gates permanently fail open and their settlement 404s forever.
   * We bootstrap each customer once per process before any check/track. The identity-aware memo also
   * synchronizes a known name/metadata once, without repeating either call on every webhook.
  */
  private readonly ensuredCustomers = new Map<string, string>();
  private readonly customerSyncs = new Map<string, Promise<void>>();

  constructor(
    private readonly config: BillingConfig,
    private readonly autumn: AutumnClient | undefined,
    private readonly store: BillingStorePort,
  ) {}

  /** Billing is only active with a client (secret set) and enforcement not "off". */
  private active(): boolean {
    return this.autumn !== undefined && this.config.enforce !== "off";
  }

  /** Public view of active() so persistence can pick a billing_status (FINDING 2). */
  isActive(): boolean {
    return this.active();
  }

  /**
   * Create or repair an Autumn customer as soon as a tenant is onboarded. This intentionally ignores
   * the enforcement mode: `off` disables review gating and settlement, but an operator who configured
   * Autumn still expects newly installed GitHub accounts to appear there before their first PR.
   * Returns false only when Autumn itself is not configured.
   */
  async provisionTenantCustomer(
    tenantId: string,
    name: string,
    metadata: Record<string, string>,
  ): Promise<boolean> {
    if (!this.autumn) {
      return false;
    }
    await this.ensureCustomerOnce(tenantId, name, metadata, true);
    return true;
  }

  /**
   * Ensure the Autumn customer exists and synchronize its tenant identity once per identity value per
   * process. get_or_create only applies identity at creation, so an existing nameless customer needs an
   * explicit update. Keeping the identity fingerprint in the memo also lets a later named call repair a
   * customer that an earlier identity-less path created.
   */
  private async ensureCustomerOnce(
    tenantId: string,
    name?: string,
    metadata?: Record<string, string>,
    force = false,
  ): Promise<void> {
    const autumn = this.autumn;
    if (!autumn) {
      return;
    }
    const previous = this.customerSyncs.get(tenantId) ?? Promise.resolve();
    const sync = previous.catch(() => undefined).then(async () => {
      const identity = name || metadata ? JSON.stringify([name ?? null, Object.entries(metadata ?? {}).sort()]) : "";
      const ensured = this.ensuredCustomers.has(tenantId);
      if (!force && ensured && (!identity || this.ensuredCustomers.get(tenantId) === identity)) {
        return;
      }
      if (!ensured || force) {
        await autumn.ensureCustomer(tenantId, name, undefined, metadata);
      }
      if (identity) {
        await autumn.updateCustomer(tenantId, name, metadata);
      }
      if (this.ensuredCustomers.size >= ENSURED_CUSTOMERS_CAP) {
        this.ensuredCustomers.clear();
      }
      this.ensuredCustomers.set(tenantId, identity);
    });
    this.customerSyncs.set(tenantId, sync);
    try {
      await sync;
    } finally {
      if (this.customerSyncs.get(tenantId) === sync) {
        this.customerSyncs.delete(tenantId);
      }
    }
  }

  private get client(): AutumnClient {
    if (!this.autumn) {
      throw new Error("autumn client is not configured");
    }
    return this.autumn;
  }

  /** Whether Autumn track should actually be called (only under hard enforcement). */
  private shouldCallAutumn(): boolean {
    return this.active() && this.config.enforce === "on";
  }

  /**
   * Resolve the run's rate mode generously (spec Decided): 'included' whenever any included
   * credits remain, else 'overage'. Fixed at dispatch/prepare. An Autumn outage resolves in the
   * customer's favor ('included'). `prefetched` shares a credits check already made by the caller
   * (prepareRunBilling) — undefined means "fetch it here"; null means "already tried, Autumn down".
   */
  async resolveRateMode(tenantId: string, prefetched?: CheckResult | null): Promise<RateMode> {
    if (!this.autumn) {
      return "included";
    }
    let credits = prefetched;
    if (credits === undefined) {
      try {
        await this.ensureCustomerOnce(tenantId);
        credits = await this.autumn.check(tenantId, this.config.creditsFeatureId);
      } catch (error) {
        logBillingWarn("rate_mode_resolution_failed", { tenant_id: tenantId, error });
        logBillingConfigError(error, { phase: "rate_mode", tenant_id: tenantId, feature_id: this.config.creditsFeatureId });
        return "included";
      }
    }
    if (credits === null) {
      return "included"; // prefetched outage -> resolve generously
    }
    const balance = credits.balance ?? (credits.allowed ? 1 : 0);
    return balance > 0 ? "included" : "overage";
  }

  /**
   * Evaluate Autumn access: credit balance (> 0) plus managed_ai_access when the run has no user
   * key. Fails OPEN — an Autumn outage or 4xx never blocks a review (blocking every review on a
   * billing hiccup is worse than a rare overdraft). The credits and managed checks run in parallel;
   * `prefetched` reuses a credits check the caller already made (null = caller already saw an outage).
   */
  async evaluateAccess(
    tenantId: string,
    needManagedAi: boolean,
    prefetched?: CheckResult | null,
    customerName?: string,
  ): Promise<AccessDecision> {
    if (!this.autumn) {
      return { allowed: true, reason: "billing_disabled" };
    }
    if (prefetched === null) {
      return { allowed: true, reason: "autumn_unavailable" };
    }
    const client = this.autumn;
    try {
      // The gate is the CREATION point for webhook-driven tenants' customers — name them here, or they
      // arrive in Autumn nameless (get_or_create only applies the name at creation).
      await this.ensureCustomerOnce(tenantId, customerName);
      const [credits, managed] = await Promise.all([
        prefetched !== undefined
          ? Promise.resolve(prefetched)
          : client.check(tenantId, this.config.creditsFeatureId),
        needManagedAi ? client.check(tenantId, this.config.managedAiFeatureId) : Promise.resolve(undefined),
      ]);
      const managedAiAccess = needManagedAi ? managed?.allowed : undefined;
      // Managed AI is ALWAYS the fallback: access is gated ONLY by the credit balance. managed_ai_access
      // is now informational (still fetched for telemetry + the dashboard overview) and never blocks a
      // managed run. Managed usage is always metered as jina_credits at settlement (recheck always
      // entitles), so there is no free-managed-AI path for a plan that omits the entitlement.
      // Treat a numeric zero/negative balance as exhausted even if Autumn's boolean is permissive
      // (for example, a product configured for postpaid overage). Jina credits are prepaid: a review
      // may overdraw only after this admission check, never start from an already-empty balance.
      const allowed = credits.allowed && (credits.balance === undefined || credits.balance > 0);
      const reason = allowed ? undefined : "insufficient_credits";
      return { allowed, creditsBalance: credits.balance, managedAiAccess, reason };
    } catch (error) {
      logBillingWarn("access_evaluation_failed", { tenant_id: tenantId, error });
      logBillingConfigError(error, {
        phase: "gate",
        tenant_id: tenantId,
        credits_feature_id: this.config.creditsFeatureId,
        managed_ai_feature_id: needManagedAi ? this.config.managedAiFeatureId : undefined,
      });
      return { allowed: true, reason: "autumn_unavailable" };
    }
  }

  /**
   * Dispatch-path advisory (webhook/manual). FINDING 2: this is NO LONGER an enforcement point. The
   * enforce=on hard block now lives SOLELY in prepareRunBilling, which blocks VISIBLY (a terminal
   * blocked_insufficient_credits run + PR progress comment via prepare's 402 path) instead of silently
   * dropping the review at dispatch (no run row, no comment). gateDispatch is advisory-only: it always
   * allows dispatch (returns void) and only emits the dispatch-phase observability logs — the shadow
   * would_block line, org_tenant_managed_only, and a would_block line under enforce=on.
   *
   * JUDGMENT (round-trip): the Autumn check is KEPT here. Its logging genuinely needs it — the
   * dispatch funnel (would_block per webhook delivery, keyed by installation BEFORE any review_run row
   * exists) is distinct observability from prepareRunBilling's per-run prepare-phase logs, and the
   * enforcement rollout depends on it to size how many webhooks would block. Dropping the call would
   * save one Autumn round-trip per webhook but blind the rollout to reviews blocked before a run row
   * is created; the enforcement rollout window is short-lived, so the visibility wins.
   */
  async gateDispatch(installationId: number, authorLogin?: string): Promise<void> {
    if (!this.active()) {
      return;
    }
    // authorLogin (from the webhook payload) lets the dispatch context resolve an author harness, so a
    // BYOH author is classified "harness" here exactly as at prepare — no managed-AI check for own-harness.
    const ctx = await this.store.getDispatchBillingContext(installationId, authorLogin).catch((error) => {
      logBillingWarn("dispatch_context_lookup_failed", { installationId, error });
      return undefined;
    });
    if (!ctx) {
      // No tenant/customer to observe (e.g. first review before onboarding).
      return;
    }
    const needManagedAi = ctx.keySource === "managed";
    const decision = await this.evaluateAccess(ctx.tenantId, needManagedAi, undefined, ctx.customerName);
    logOrgTenantManagedOnly("dispatch", ctx.tenantId, ctx.githubAccountType, ctx.keySource, decision);
    if (this.config.enforce === "shadow") {
      console.info("billing_gate_shadow", {
        phase: "dispatch",
        installation_id: installationId,
        tenant_id: ctx.tenantId,
        would_block: !decision.allowed,
        reason: decision.reason,
        credits_balance: decision.creditsBalance,
      });
      return;
    }
    // enforce=on: advisory only. Log what prepareRunBilling will block visibly for every tenant type.
    if (!decision.allowed) {
      console.info("billing_gate_would_block", {
        phase: "dispatch",
        installation_id: installationId,
        tenant_id: ctx.tenantId,
        reason: decision.reason,
        credits_balance: decision.creditsBalance,
      });
    }
  }

  /**
   * Prepare-time work: pin the run's rate mode on review_run_billing and run the gate backstop.
   * Returns { blocked } — the caller (prepareReview) turns blocked into a 402 under "on".
   * Never throws; a billing failure must not fail prepare.
   */
  async prepareRunBilling(reviewRunId: string): Promise<{ blocked: boolean; reason?: string }> {
    if (!this.active()) {
      return { blocked: false };
    }
    try {
      const ctx = await this.store.getRunBillingContext(reviewRunId);
      if (!ctx) {
        return { blocked: false };
      }
      // ONE credits check, shared by rate-mode resolution and the access gate (null = Autumn down,
      // both fall back generously). evaluateAccess adds only the managed-AI check for managed runs.
      let credits: CheckResult | null = null;
      try {
        await this.ensureCustomerOnce(ctx.tenantId, ctx.customerName);
        credits = await this.client.check(ctx.tenantId, this.config.creditsFeatureId);
      } catch (error) {
        logBillingWarn("prepare_credits_check_failed", { reviewRunId, tenant_id: ctx.tenantId, error });
        logBillingConfigError(error, {
          phase: "prepare",
          review_run_id: reviewRunId,
          tenant_id: ctx.tenantId,
          feature_id: this.config.creditsFeatureId,
        });
        credits = null;
      }
      const rateMode = await this.resolveRateMode(ctx.tenantId, credits);
      // Pin the run-level key_source to the derived classification. "harness" pins as "harness"; only a
      // "managed" run consumes the managed-AI entitlement, so only it needs the managed-AI gate.
      const keySource = ctx.keySource;
      const needManagedAi = keySource === "managed";
      await this.store.upsertReviewRunBilling({ reviewRunId, tenantId: ctx.tenantId, rateMode, keySource });

      const decision = await this.evaluateAccess(ctx.tenantId, needManagedAi, credits, ctx.customerName);
      logOrgTenantManagedOnly("prepare", ctx.tenantId, ctx.githubAccountType, ctx.keySource, decision);
      // The tenant's OWN auto-review credit cap (capy-style). Evaluated from the SAME credits check.
      // Unlike the platform balance gate, it targets AUTO triggers only (manual bypasses). Both gates
      // apply to every tenant type. The cap only hard-blocks under enforce=on; shadow logs it.
      const capReached = autoReviewLimitReached(ctx.policy, ctx.triggerSource, credits);
      if (this.config.enforce === "shadow") {
        console.info("billing_gate_shadow", {
          phase: "prepare",
          review_run_id: reviewRunId,
          tenant_id: ctx.tenantId,
          would_block: !decision.allowed || capReached,
          reason: capReached ? "auto_review_limit_reached" : decision.reason,
        });
        return { blocked: false };
      }
      // enforce=on. The tenant-owned cap gets the more specific reason when both gates deny the run.
      if (capReached) {
        console.info("billing_auto_review_limit_reached", {
          phase: "prepare",
          review_run_id: reviewRunId,
          tenant_id: ctx.tenantId,
          trigger_source: ctx.triggerSource,
          limit_credits: ctx.policy.auto_review_limit_credits,
          used_credits: usedCreditsFromCheck(credits),
        });
        return { blocked: true, reason: "auto_review_limit_reached" };
      }
      if (decision.allowed) {
        return { blocked: false };
      }
      // This is the only balance enforcement point. It applies equally to personal, organization,
      // managed, BYOK, and custom-harness reviews. Settlement deliberately does not re-run this gate:
      // once admitted, an in-flight review gets to finish even if it exhausts the remaining balance.
      return { blocked: true, reason: decision.reason ?? "billing_blocked" };
    } catch (error) {
      logBillingWarn("prepare_run_billing_failed", { reviewRunId, error });
      return { blocked: false };
    }
  }

  /**
   * Outcome settlement — call ONLY from completeReview after completeReviewRun reports the first
   * terminal transition (updated===true). NEVER throws: any failure is caught and logged, leaving
   * row statuses where they are for retryPendingBillingEvents() to drain.
   */
  async settleReviewOutcome(reviewRunId: string, botStatus: string): Promise<void> {
    try {
      await this.settleOrThrow(reviewRunId, botStatus);
    } catch (error) {
      // Best-effort tenant lookup so the failure log carries tenant context (FINDING 4). Error path
      // only, so the extra read is not on the hot path.
      const tenantId = await this.store
        .getRunBillingContext(reviewRunId)
        .then((ctx) => ctx?.tenantId)
        .catch(() => undefined);
      logBillingWarn("settlement_failed", { reviewRunId, tenant_id: tenantId, botStatus, error });
      logBillingConfigError(error, { phase: "settlement", review_run_id: reviewRunId, tenant_id: tenantId });
    }
  }

  private async settleOrThrow(reviewRunId: string, botStatus: string): Promise<void> {
    if (!this.active()) {
      return;
    }
    const ctx = await this.store.getRunBillingContext(reviewRunId);
    if (!ctx) {
      return;
    }
    // Only a clean 'completed' bills; failed/superseded/cancelled charge nothing (spec Decided).
    if (botStatus !== "completed") {
      await this.store.waiveRunBilling(reviewRunId, ctx.tenantId);
      return;
    }
    await this.settleCompleted(reviewRunId, ctx);
  }

  private async settleCompleted(reviewRunId: string, ctx: RunBillingContext): Promise<void> {
    const billing = await this.store.getReviewRunBilling(reviewRunId);
    const rateMode: RateMode = billing?.rate_mode === "overage" ? "overage" : "included";
    const { infraCredits, share } = ratesFor(rateMode, ctx.policy);
    const callAutumn = this.shouldCallAutumn();
    // DECISION 1: shadow NEVER back-bills. When billing is active but not hard-tracking, the mode is
    // "shadow": we still compute + persist customer_share, ai_credits, and infra credits (for
    // reconciliation) and log the would-be charges, but we finalize rows as the terminal, non-billable
    // status 'shadow_computed' instead of 'pending'. The retry drain never selects 'shadow_computed', so
    // flipping to "on" later bills NOTHING that accrued while shadow was live. (A run in flight across a
    // shadow->on flip settles under whichever mode is live at settlement time — acceptable.)
    const shadow = !callAutumn;

    // (a) infra credits — once per run. Skip if already billed/waived.
    if (billing?.infra_billing_status !== "billed" && billing?.infra_billing_status !== "waived") {
      if (callAutumn) {
        await this.billInfra(reviewRunId, ctx, rateMode, infraCredits);
      } else {
        await this.store.setInfraShadowComputed({ reviewRunId, tenantId: ctx.tenantId, rateMode, credits: infraCredits });
        console.info("billing_infra_shadow_computed", {
          review_run_id: reviewRunId,
          tenant_id: ctx.tenantId,
          rate_mode: rateMode,
          would_charge_credits: infraCredits,
        });
      }
    }

    // (b) AI credits — managed rows only (pending_outcome). Own-harness rows are 'not_billable', so
    // any pending_outcome row here is a managed-key row.
    const rows = await this.store.listRunUsagePendingOutcome(reviewRunId);
    if (rows.length === 0) {
      return;
    }

    // Managed AI is always the fallback and always metered as jina_credits, so managed rows are always
    // billed (recheckManagedEntitlement always entitles now — no entitlement waive). The hook is kept so
    // a future genuine managed-AI block has one place to reinstate. (Shadow only computes, never tracks.)
    if (callAutumn && (await this.recheckManagedEntitlement(reviewRunId, ctx)) !== "entitled") {
      return;
    }

    // Compute each row's credits, then either claim-and-track it ("on") or finalize it 'shadow_computed'.
    for (const row of rows) {
      // Bill from the BYOK-aware basis (is_byok ? upstream+cost : cost), computed exactly at persist.
      // Pre-0014 rows have a null billable_cost — fall back to openrouter_cost (== the non-BYOK basis).
      const aiCredits = creditsForCost(row.billable_cost ?? row.openrouter_cost, share);
      if (shadow) {
        await this.store.setUsageShadowComputed(row.id, share, aiCredits);
        console.info("billing_usage_shadow_computed", {
          review_run_id: reviewRunId,
          tenant_id: ctx.tenantId,
          usage_id: row.id,
          would_charge_credits: aiCredits,
        });
        continue;
      }
      await this.store.setUsageComputedPending(row.id, share, aiCredits);
      await this.billUsageRow(reviewRunId, ctx.tenantId, row.id, row.dedupe_key, aiCredits);
    }
  }

  /**
   * Managed AI is ALWAYS the fallback and is ALWAYS metered as jina_credits, so managed usage rows are
   * always billed — there is no longer an entitlement waive. This used to re-check managed_ai_access at
   * settlement and waive the rows when a plan lacked it; that would now be a free-managed-AI hole, so it
   * always returns "entitled". Kept (rather than inlined away) so settleCompleted and the retry drains
   * keep one shared policy hook; if a future plan needs a genuine managed-AI block, restore the check here.
   */
  private async recheckManagedEntitlement(
    _reviewRunId: string,
    _ctx: RunBillingContext,
  ): Promise<"entitled" | "denied" | "error"> {
    return "entitled";
  }

  /**
   * Claim-and-track one AI usage row. The claim ('pending' -> 'tracking') is the single-flight
   * gate; only the winner tracks. On a track failure that did NOT charge, the claim is reverted so
   * a clean retry can re-claim. If the track succeeded but the 'billed' persist failed (a crash),
   * the row is left 'tracking' for the stale-claim sweep — never reverted, so we never double-charge
   * by reverting-then-re-tracking. Returns true iff this call charged and marked the row billed.
   */
  private async billUsageRow(
    reviewRunId: string,
    tenantId: string,
    usageId: string,
    dedupeKey: string,
    aiCredits: number,
  ): Promise<boolean> {
    const eventId = `ai:${reviewRunId}:${dedupeKey}`;
    // FINDING 1: bootstrap the customer before the claim so an unbootstrapped tenant throws (outage
    // semantics) before we mutate row state — the claim only happens once the customer is ensured.
    await this.ensureCustomerOnce(tenantId);
    const claimed = await this.store.claimUsageForTracking(usageId, eventId);
    if (!claimed) {
      return false; // already billed, in-flight elsewhere, or not yet computed
    }
    let charged = false;
    try {
      // Zero-credit rows (cost rounds to 0 credits) are deliberately NOT tracked to Autumn — there
      // is nothing to charge — but they are still claimed and marked 'billed' below so they leave the
      // pending set and the drain never revisits them. `charged = true` reflects "settled", not "money moved".
      if (aiCredits > 0) {
        await this.client.track(tenantId, this.config.creditsFeatureId, aiCredits, eventId);
      }
      charged = true;
      // The total is incremented exactly once per row ever, gated on this transition (FINDING 3b).
      const billed = await this.store.markUsageBilled(usageId, eventId);
      if (billed) {
        await this.store.addRunAiCreditsTotal(reviewRunId, aiCredits);
      }
      return billed;
    } catch (error) {
      if (!charged) {
        await this.store.revertUsageClaim(usageId);
      }
      throw error;
    }
  }

  /**
   * Claim-and-track a run's one-shot infra charge, mirroring billUsageRow's claim/track/persist
   * discipline. Returns true iff this call charged and marked infra billed.
   */
  private async billInfra(
    reviewRunId: string,
    ctx: RunBillingContext,
    rateMode: RateMode,
    credits: number,
  ): Promise<boolean> {
    const eventId = `infra:${reviewRunId}`;
    await this.ensureCustomerOnce(ctx.tenantId); // FINDING 1: bootstrap before the claim/track.
    const claimed = await this.store.claimInfraForTracking({
      reviewRunId,
      tenantId: ctx.tenantId,
      rateMode,
      credits,
      autumnEventId: eventId,
    });
    if (!claimed) {
      return false;
    }
    let charged = false;
    try {
      await this.client.track(ctx.tenantId, this.config.creditsFeatureId, credits, eventId);
      charged = true;
      await this.store.markInfraBilled({ reviewRunId, tenantId: ctx.tenantId, rateMode, credits, autumnEventId: eventId });
      return true;
    } catch (error) {
      if (!charged) {
        await this.store.revertInfraClaim(reviewRunId);
      }
      throw error;
    }
  }

  /** Re-track a stale 'tracking' usage claim (crash after a successful track, before the persist). */
  private async rebillStaleUsageRow(row: PendingUsageRow, olderThan: Date): Promise<boolean> {
    if (!(await this.store.reclaimStaleTrackingUsage(row.id, olderThan))) {
      return false; // a concurrent worker won the re-claim
    }
    const eventId = row.autumn_event_id ?? `ai:${row.review_run_id}:${row.dedupe_key}`;
    // Loud + reconcilable: the first track may already have charged. This re-track is idempotency-
    // keyed, so it is exactly-once if Autumn honors the key and a flagged duplicate otherwise.
    console.warn("possible_duplicate_charge", {
      kind: "ai",
      review_run_id: row.review_run_id,
      tenant_id: row.tenant_id,
      usage_id: row.id,
      event_id: eventId,
    });
    const aiCredits = row.ai_credits_charged ?? 0;
    try {
      await this.ensureCustomerOnce(row.tenant_id); // FINDING 1
      if (aiCredits > 0) {
        await this.client.track(row.tenant_id, this.config.creditsFeatureId, aiCredits, eventId);
      }
      const billed = await this.store.markUsageBilled(row.id, eventId);
      if (billed) {
        await this.store.addRunAiCreditsTotal(row.review_run_id, aiCredits);
      }
      return billed;
    } catch (error) {
      // Leave it 'tracking' (claimed_at just bumped) for the next sweep.
      logBillingWarn("retry_stale_usage_bill_failed", { usageId: row.id, error });
      return false;
    }
  }

  /**
   * Re-track a stale 'tracking' infra claim (crash after a successful track, before the persist).
   * FINDING 3: intentionally NO managed-entitlement recheck here (unlike rebillStaleUsageRow) — infra
   * is charged regardless of key source (own-harness runs owe infra too), so it has no entitlement
   * dimension to re-verify.
   */
  private async rebillStaleInfra(run: StaleTrackingInfra, olderThan: Date): Promise<boolean> {
    if (!(await this.store.reclaimStaleTrackingInfra(run.reviewRunId, olderThan))) {
      return false;
    }
    const eventId = run.autumnEventId ?? `infra:${run.reviewRunId}`;
    console.warn("possible_duplicate_charge", {
      kind: "infra",
      review_run_id: run.reviewRunId,
      tenant_id: run.tenantId,
      event_id: eventId,
    });
    const rateMode: RateMode = run.rateMode === "overage" ? "overage" : "included";
    const credits = run.credits ?? 0;
    try {
      await this.ensureCustomerOnce(run.tenantId); // FINDING 1
      await this.client.track(run.tenantId, this.config.creditsFeatureId, credits, eventId);
      await this.store.markInfraBilled({
        reviewRunId: run.reviewRunId,
        tenantId: run.tenantId,
        rateMode,
        credits,
        autumnEventId: eventId,
      });
      return true;
    } catch (error) {
      logBillingWarn("retry_stale_infra_bill_failed", { reviewRunId: run.reviewRunId, error });
      return false;
    }
  }

  /**
   * Scheduled/retry drain (only meaningful under "on"). Drains:
   *  (b) terminal runs still holding 'pending_outcome' rows (late callbacks) -> settle per outcome;
   *  (a) 'pending' usage rows (credits already computed) -> claim -> track -> billed;
   *  (a2) stale 'tracking' usage claims (crashed mid-charge) -> re-track with the same event id;
   *  (c) terminal runs whose infra charge is still 'pending' -> claim -> track infra;
   *  (c2) stale 'tracking' infra claims -> re-track with the same event id.
   * The claim UPDATE is the mutual exclusion, so concurrent drains never double-charge. Each item is
   * isolated so one failure never aborts the batch.
   */
  async retryPendingBillingEvents(): Promise<RetryBillingCounts> {
    const counts = emptyRetryBillingCounts();
    if (!this.shouldCallAutumn()) {
      return counts;
    }
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

    // (b) settle late/interrupted runs first so their rows become 'pending'/'billed' consistently.
    for (const run of await this.store.listTerminalRunsWithPendingOutcome(RETRY_BATCH_LIMIT)) {
      try {
        await this.settleOrThrow(run.reviewRunId, run.status);
        counts.runs_settled += 1;
      } catch (error) {
        counts.runs_failed += 1;
        logBillingWarn("retry_settle_failed", { review_run_id: run.reviewRunId, error });
      }
    }

    // (a) drain individually-pending usage rows. FINDING A: these managed-AI rows were computed to
    // 'pending' before a prior Autumn track (outage/crash/shadow flip), but managed_ai_access may have
    // been revoked since. settleCompleted rechecks entitlement before billing; the drain must too, or a
    // tenant who lost access is still charged from the pending backlog. Group by run so the recheck runs
    // ONCE per run, applying the same policy: entitled -> bill; denied -> waive + warn; outage -> leave
    // pending. Own-harness rows are 'not_billable', so every pending row here is a managed-key row.
    for (const [reviewRunId, rows] of groupByRun(await this.store.listPendingUsageRows(RETRY_BATCH_LIMIT))) {
      const ctx = await this.store.getRunBillingContext(reviewRunId).catch((error) => {
        logBillingWarn("retry_usage_context_lookup_failed", { review_run_id: reviewRunId, error });
        return undefined;
      });
      // No context -> cannot verify entitlement; leave the rows pending for a later drain.
      if (!ctx || (await this.recheckManagedEntitlement(reviewRunId, ctx)) !== "entitled") {
        continue;
      }
      for (const row of rows) {
        try {
          if (await this.billUsageRow(row.review_run_id, row.tenant_id, row.id, row.dedupe_key, row.ai_credits_charged ?? 0)) {
            counts.usage_billed += 1;
          }
        } catch (error) {
          counts.usage_failed += 1;
          logBillingWarn("retry_usage_bill_failed", {
            usage_id: row.id,
            review_run_id: row.review_run_id,
            tenant_id: row.tenant_id,
            event_id: `ai:${row.review_run_id}:${row.dedupe_key}`,
            error,
          });
        }
      }
    }

    // (a2) re-drain stale 'tracking' usage claims (crash after a successful track, before the persist).
    // FINDING 3: a row is claimed 'tracking' BEFORE the first track (the claim precedes the track in
    // billUsageRow), so a crash in that window leaves a 'tracking' row that was NEVER charged. Replaying
    // it must re-verify managed entitlement exactly like the pending path (a) — a tenant who lost
    // managed_ai_access after the claim must not be billed on replay. Group by run and recheck ONCE per
    // run, BEFORE the reclaim, so a recheck outage leaves the claim untouched (claimed_at not bumped) for
    // the next drain rather than losing/delaying it: entitled -> re-track each row with the same event
    // id; denied -> waive (recheckManagedEntitlement waives the run's open rows, including 'tracking') +
    // billing_entitlement_mismatch; error/no-context -> skip (claim stays stale for the next drain).
    for (const [reviewRunId, rows] of groupByRun(await this.store.listStaleTrackingUsageRows(RETRY_BATCH_LIMIT, staleBefore))) {
      const ctx = await this.store.getRunBillingContext(reviewRunId).catch((error) => {
        logBillingWarn("retry_stale_usage_context_lookup_failed", { review_run_id: reviewRunId, error });
        return undefined;
      });
      if (!ctx || (await this.recheckManagedEntitlement(reviewRunId, ctx)) !== "entitled") {
        continue;
      }
      for (const row of rows) {
        if (await this.rebillStaleUsageRow(row, staleBefore)) {
          counts.usage_billed += 1;
          counts.stale_usage_rebilled += 1;
        }
      }
    }

    // (c) drain pending infra charges.
    for (const run of await this.store.listRunsWithPendingInfra(RETRY_BATCH_LIMIT)) {
      try {
        if (await this.drainPendingInfra(run)) {
          counts.infra_billed += 1;
        }
      } catch (error) {
        counts.infra_failed += 1;
        logBillingWarn("retry_infra_bill_failed", {
          review_run_id: run.reviewRunId,
          event_id: `infra:${run.reviewRunId}`,
          error,
        });
      }
    }

    // (c2) re-drain stale 'tracking' infra claims. FINDING 3: infra has NO entitlement dimension — it is
    // charged regardless of key source (own-harness runs still owe infra), so rebillStaleInfra needs no
    // managed_ai_access recheck. Only the AI-usage replay (a2) gates on entitlement.
    for (const run of await this.store.listStaleTrackingInfra(RETRY_BATCH_LIMIT, staleBefore)) {
      if (await this.rebillStaleInfra(run, staleBefore)) {
        counts.infra_billed += 1;
        counts.stale_infra_rebilled += 1;
      }
    }

    return counts;
  }

  /** Bill (or defensively waive) one run's still-pending infra charge. Returns true iff it billed. */
  private async drainPendingInfra(run: { reviewRunId: string; status: string }): Promise<boolean> {
    if (run.status !== "completed") {
      // A non-completed terminal run should never owe infra; waive defensively.
      const ctx = await this.store.getRunBillingContext(run.reviewRunId);
      if (ctx) {
        await this.store.waiveRunBilling(run.reviewRunId, ctx.tenantId);
      }
      return false;
    }
    const ctx = await this.store.getRunBillingContext(run.reviewRunId);
    if (!ctx) {
      return false;
    }
    const billing = await this.store.getReviewRunBilling(run.reviewRunId);
    const rateMode: RateMode = billing?.rate_mode === "overage" ? "overage" : "included";
    const { infraCredits } = ratesFor(rateMode, ctx.policy);
    const credits = billing?.infra_credits_charged ?? infraCredits;
    return this.billInfra(run.reviewRunId, ctx, rateMode, credits);
  }

  /* ---------------------------------------------------------- dashboard --- */

  /**
   * Dashboard billing overview. status distinguishes not_configured (no secret / no tenant) from
   * unavailable (Autumn set but errored) from ok (live data). configured stays true only for ok.
   */
  async overview(
    tenantId: string | undefined,
    name?: string,
    metadata?: Record<string, string>,
  ): Promise<BillingOverview> {
    if (!this.autumn || !tenantId) {
      return {
        configured: false,
        status: "not_configured",
        plan_id: null,
        credits_balance: null,
        managed_ai_access: null,
        cycle: { ...EMPTY_CYCLE },
        billing_activity: [],
      };
    }
    const client = this.autumn;
    try {
      await this.ensureCustomerOnce(tenantId, name, metadata);
      // The two entitlement checks and the plan lookup are independent — fetch them in parallel.
      // NON-BLOCKING ADOPTED (a): a getCustomer() failure is NO LONGER swallowed to plan_id:null with
      // status:'ok'. A retryable outage or schema failure there means we cannot confirm the customer's
      // state, so it must read as 'unavailable' (balance data notwithstanding): letting it reject
      // propagates to the outer catch, which returns the unavailable shape. A customer with genuinely
      // no plan resolves normally (planId null, no throw) and still reports 'ok'. Invoices are expanded
      // here so billing_activity can surface recent invoices in the same round-trip.
      const [credits, managed, customer] = await Promise.all([
        client.check(tenantId, this.config.creditsFeatureId),
        client.check(tenantId, this.config.managedAiFeatureId),
        client.getCustomer(tenantId, { expandInvoices: true }),
      ]);
      return {
        configured: true,
        status: "ok",
        plan_id: customer.planId,
        credits_balance: credits.balance ?? null,
        managed_ai_access: managed.allowed,
        cycle: {
          granted: credits.granted ?? null,
          remaining: credits.balance ?? null,
          used: usedCreditsFromCheck(credits),
          next_reset_at: credits.nextResetAt ?? null,
        },
        // Never fabricated: [] when Autumn returned no invoices (or omitted the field).
        billing_activity: customer.invoices ?? [],
      };
    } catch (error) {
      logBillingWarn("overview_failed", { tenantId, error });
      // NON-BLOCKING ADOPTED: a non-retryable AutumnError here is a config bug, not an outage — surface
      // it at error level via the same helper the gate uses (no-op for retryable outages).
      logBillingConfigError(error, { phase: "overview", tenant_id: tenantId });
      return {
        configured: false,
        status: "unavailable",
        plan_id: null,
        credits_balance: null,
        managed_ai_access: null,
        cycle: { ...EMPTY_CYCLE },
        billing_activity: [],
      };
    }
  }

  /** Create an Autumn checkout URL for the overage-credit top-up product. */
  async topupUrl(
    tenantId: string | undefined,
    name?: string,
    creditQuantity?: number,
    metadata?: Record<string, string>,
  ): Promise<string | undefined> {
    if (!this.autumn || !tenantId) {
      return undefined;
    }
    try {
      await this.ensureCustomerOnce(tenantId, name, metadata);
      // The overage product is prepaid: the checkout needs the credit quantity to
      // buy, or Autumn's Stripe checkout has no line items and 400s. Default to a
      // 10,000-credit ($100) pack; the dashboard can pass an explicit amount.
      const quantity = creditQuantity && creditQuantity > 0 ? Math.floor(creditQuantity) : DEFAULT_TOPUP_CREDITS;
      return await this.autumn.checkoutUrl(tenantId, OVERAGE_TOPUP_PRODUCT_ID, {
        featureQuantities: [{ feature_id: this.config.creditsFeatureId, quantity }],
      });
    } catch (error) {
      // NON-BLOCKING ADOPTED: route a non-retryable AutumnError through the shared config-error log,
      // then rethrow so the route still returns its 502 (behavior unchanged).
      logBillingConfigError(error, { phase: "topup", tenant_id: tenantId });
      throw error;
    }
  }

  /**
   * Create an Autumn checkout URL to subscribe the tenant to a plan (Startup/Growth). Mirrors topupUrl:
   * ensure the customer, then Autumn attach -> checkout url. The caller validates plan_id against the
   * static allowlist. Returns undefined only when billing is unconfigured (no client/tenant).
   */
  async subscribeUrl(
    tenantId: string | undefined,
    planId: string,
    name?: string,
    metadata?: Record<string, string>,
  ): Promise<string | undefined> {
    if (!this.autumn || !tenantId) {
      return undefined;
    }
    try {
      await this.ensureCustomerOnce(tenantId, name, metadata);
      return await this.autumn.checkoutUrl(tenantId, planId);
    } catch (error) {
      logBillingConfigError(error, { phase: "subscribe", tenant_id: tenantId });
      throw error;
    }
  }

  /**
   * Configure per-customer auto top-up (auto-reload) on the credits feature. threshold/reload are in Jina
   * Credits. Wired to Autumn's customer-update billing controls. Returns false when billing is not
   * configured (no client/tenant); throws (routed through the config-error log) on an Autumn failure so
   * the route can surface a 502.
   */
  async setAutoReload(
    tenantId: string | undefined,
    input: { enabled: boolean; thresholdCredits: number; reloadCredits: number },
    name?: string,
    metadata?: Record<string, string>,
  ): Promise<boolean> {
    if (!this.autumn || !tenantId) {
      return false;
    }
    try {
      await this.ensureCustomerOnce(tenantId, name, metadata);
      await this.autumn.setAutoTopup(tenantId, {
        featureId: this.config.creditsFeatureId,
        enabled: input.enabled,
        threshold: input.thresholdCredits,
        quantity: input.reloadCredits,
      });
      return true;
    } catch (error) {
      logBillingConfigError(error, { phase: "auto_reload", tenant_id: tenantId });
      throw error;
    }
  }

  /** Whether the Autumn secret is configured (independent of enforcement). */
  billingConfigured(): boolean {
    return this.autumn !== undefined;
  }
}

/** Infra credits + customer_share for a rate mode, derived from the tenant policy. */
function ratesFor(rateMode: RateMode, policy: BillingPolicy): { infraCredits: number; share: string } {
  if (rateMode === "overage") {
    return {
      infraCredits: policy.overage_infra_credits_per_run,
      share: customerShareFromSubsidy(policy.overage_subsidy_rate),
    };
  }
  return {
    infraCredits: policy.infra_credits_per_run,
    share: customerShareFromSubsidy(policy.subsidy_rate),
  };
}

/** Group pending usage rows by review_run_id so a per-run entitlement recheck runs once per run. */
function groupByRun(rows: PendingUsageRow[]): Map<string, PendingUsageRow[]> {
  const byRun = new Map<string, PendingUsageRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.review_run_id);
    if (list) {
      list.push(row);
    } else {
      byRun.set(row.review_run_id, [row]);
    }
  }
  return byRun;
}

/**
 * FINDING 4: a NON-RETRYABLE AutumnError (a deterministic 4xx — e.g. a wrong feature id) is a
 * configuration bug, not an outage. Fail-open stays the behavior (we never block reviews on our own
 * config mistake), but a silent info-level "unavailable" would leave everything unbilled/ungated
 * forever with no alarm. Surface it at error level, distinct from the info/warn outage logs, so the
 * mistake is visible. No-op for retryable outages and non-Autumn errors (those are the info/warn path).
 */
function logBillingConfigError(error: unknown, fields: Record<string, unknown>): void {
  if (!(error instanceof AutumnError) || error.retryable) {
    return;
  }
  const { error: _drop, ...rest } = fields as Record<string, unknown> & { error?: unknown };
  console.error("billing_config_error", {
    ...rest,
    status: error.status,
    endpoint: error.endpoint,
    message: error.message,
  });
}

/** Log a billing warning without ever leaking an Autumn secret (AutumnError messages are safe). */
function logBillingWarn(event: string, fields: Record<string, unknown> & { error?: unknown }): void {
  const { error, ...rest } = fields;
  const message =
    error instanceof AutumnError
      ? `${error.message}${error.retryable ? " (retryable)" : ""}`
      : error instanceof Error
        ? error.message
        : error !== undefined
          ? String(error)
          : undefined;
  console.warn(event, { ...rest, ...(message !== undefined ? { error: message } : {}) });
}

/**
 * Organization gate telemetry. The event name predates tenant membership and is retained for
 * operational continuity even though org runs may now resolve to managed, BYOK, or harness credentials.
 * `would_block` is advisory at dispatch; at prepare the same denied decision is enforced.
 */
function logOrgTenantManagedOnly(
  phase: "dispatch" | "prepare",
  tenantId: string,
  githubAccountType: string | undefined,
  keySource: BillingKeySource,
  decision: AccessDecision,
): void {
  if (githubAccountType !== "Organization") {
    return;
  }
  console.info("org_tenant_managed_only", {
    phase,
    tenant_id: tenantId,
    key_source: keySource,
    would_block: !decision.allowed,
    decision: decision.allowed ? "allowed" : "blocked",
    reason: decision.reason,
  });
}

/** Build the production billing service from app config. */
export function createBillingService(config: AppConfig): BillingService {
  return new BillingService(config.billing, createAutumnClient(config.billing), realBillingStore);
}
