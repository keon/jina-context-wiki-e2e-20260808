import assert from "node:assert/strict";
import { test } from "node:test";

import { AutumnError, type AutumnClient, type CheckResult, type CustomerSummary } from "./autumn.js";
import {
  BillingService,
  normalizeTopupCredits,
  DEFAULT_TOPUP_CREDITS,
  MIN_TOPUP_CREDITS,
  MAX_TOPUP_CREDITS,
  type BillingStorePort,
} from "./billing.js";
import type { BillingConfig, BillingEnforcement } from "./config.js";
import {
  PLATFORM_BILLING_POLICY,
  type BillingKeySource,
  type BillingPolicy,
  type DispatchBillingContext,
  type PendingUsageRow,
  type ReviewRunBilling,
  type RunBillingContext,
  type StaleTrackingInfra,
} from "./store.js";

/* ------------------------------------------------------------- fake autumn --- */

type FakeAutumnOpts = {
  creditsBalance?: number;
  creditsAllowed?: boolean;
  managedAllowed?: boolean;
  failCheck?: boolean;
  failTrack?: boolean;
  // FINDING 1: simulate ensureCustomer (POST /customers) failing — treated exactly like an outage.
  failEnsure?: boolean;
  // FINDING 4: simulate a deterministic 4xx (non-retryable) on check — a config bug, not an outage.
  configErrorCheck?: boolean;
  // NON-BLOCKING ADOPTED (a): simulate getCustomer (plan lookup) failing — now surfaces 'unavailable'.
  failCustomer?: boolean;
  // Cycle breakdown fields returned on the credits check (for the overview cycle + auto-review-cap tests).
  creditsGranted?: number;
  creditsUsage?: number;
  // Recent invoices returned when getCustomer is called with expandInvoices.
  invoices?: Array<{ date: string | null; amount: string; status: string; url?: string }>;
};

class FakeAutumn implements AutumnClient {
  readonly tracks: Array<{ customerId: string; featureId: string; value: number; idempotencyKey: string }> = [];
  readonly checks: Array<{ customerId: string; featureId: string }> = [];
  readonly ensured: string[] = [];
  readonly updated: Array<{ customerId: string; name?: string; metadata?: Record<string, string> }> = [];

  constructor(private readonly opts: FakeAutumnOpts = {}) {}

  setCreditsBalance(balance: number): void {
    this.opts.creditsBalance = balance;
  }

  async ensureCustomer(customerId: string): Promise<void> {
    if (this.opts.failEnsure) {
      throw new AutumnError("autumn customers down", true, 503, "/customers");
    }
    this.ensured.push(customerId);
  }

  async updateCustomer(customerId: string, name?: string, metadata?: Record<string, string>): Promise<void> {
    this.updated.push({ customerId, name, metadata });
  }

  async check(customerId: string, featureId: string): Promise<CheckResult> {
    this.checks.push({ customerId, featureId });
    if (this.opts.configErrorCheck) {
      throw new AutumnError("Autumn request to /balances.check failed: 400", false, 400, "/balances.check");
    }
    if (this.opts.failCheck) {
      throw new AutumnError("autumn check down", true, 503);
    }
    if (featureId === "managed_ai_access") {
      return { allowed: this.opts.managedAllowed ?? true };
    }
    const balance = this.opts.creditsBalance ?? 0;
    return {
      allowed: this.opts.creditsAllowed ?? balance > 0,
      balance: this.opts.creditsBalance,
      granted: this.opts.creditsGranted,
      usage: this.opts.creditsUsage,
    };
  }

  async track(customerId: string, featureId: string, value: number, idempotencyKey: string): Promise<void> {
    if (this.opts.failTrack) {
      throw new AutumnError("autumn track down", true, 503);
    }
    this.tracks.push({ customerId, featureId, value, idempotencyKey });
  }

  async checkoutUrl(): Promise<string> {
    return "https://checkout.example/session";
  }

  readonly autoTopups: Array<{ customerId: string; featureId: string; enabled: boolean; threshold: number; quantity: number }> = [];

  async getCustomer(_customerId: string, opts?: { expandInvoices?: boolean }): Promise<CustomerSummary> {
    if (this.opts.failCustomer) {
      throw new AutumnError("autumn customer lookup down", true, 503, "/customers");
    }
    return opts?.expandInvoices && this.opts.invoices
      ? { planId: "startup", invoices: this.opts.invoices }
      : { planId: "startup" };
  }

  async setAutoTopup(
    customerId: string,
    input: { featureId: string; enabled: boolean; threshold: number; quantity: number },
  ): Promise<void> {
    this.autoTopups.push({ customerId, ...input });
  }
}

/* -------------------------------------------------------------- fake store --- */

type UsageRow = PendingUsageRow & { billing_status: string; customer_share?: string; claimed_at?: number };

type FakeBilling = ReviewRunBilling & { infra_autumn_event_id?: string | null; infra_claimed_at?: number };

class FakeStore implements BillingStorePort {
  runContexts = new Map<string, RunBillingContext>();
  dispatchContexts = new Map<number, DispatchBillingContext>();
  runBillings = new Map<string, FakeBilling>();
  runStatuses = new Map<string, string>();
  usage: UsageRow[] = [];
  // Test hook: when true, markUsageBilled throws (simulates a crash after a successful track but
  // before the 'billed' persist — the crash window that leaves a row stuck 'tracking').
  failUsagePersist = false;

  // keySource mirrors the runtime credential precedence (harness > user > managed); it defaults to
  // "managed" so existing tests keep their managed-run semantics unless they opt into a key.
  seedRun(reviewRunId: string, opts: { keySource?: BillingKeySource; policy?: BillingPolicy; rateMode?: "included" | "overage"; status?: string; githubAccountType?: string; triggerSource?: string } = {}): void {
    const keySource: BillingKeySource = opts.keySource ?? "managed";
    this.runContexts.set(reviewRunId, {
      tenantId: `tenant-${reviewRunId}`,
      keySource,
      githubAccountType: opts.githubAccountType,
      triggerSource: opts.triggerSource,
      policy: opts.policy ?? PLATFORM_BILLING_POLICY,
    });
    if (opts.rateMode) {
      this.runBillings.set(reviewRunId, {
        rate_mode: opts.rateMode,
        key_source: keySource,
        infra_credits_charged: null,
        ai_credits_charged_total: 0,
        infra_billing_status: "pending",
      });
    }
    if (opts.status) {
      this.runStatuses.set(reviewRunId, opts.status);
    }
  }

  // `cost` seeds openrouter_cost (the raw OpenRouter fee/charge). `billableCost` seeds the BYOK-aware
  // basis the credit math bills from; omit it to leave billable_cost null and exercise the legacy
  // pre-0014 fallback (creditsForCost then reads openrouter_cost).
  seedUsage(row: { id: string; reviewRunId: string; cost: string | null; billableCost?: string | null; status?: string; aiCredits?: number }): void {
    this.usage.push({
      id: row.id,
      review_run_id: row.reviewRunId,
      tenant_id: `tenant-${row.reviewRunId}`,
      dedupe_key: `dk-${row.id}`,
      billable_cost: row.billableCost ?? null,
      openrouter_cost: row.cost,
      ai_credits_charged: row.aiCredits ?? null,
      billing_status: row.status ?? "pending_outcome",
    });
  }

  async getRunBillingContext(reviewRunId: string): Promise<RunBillingContext | undefined> {
    return this.runContexts.get(reviewRunId);
  }

  async getDispatchBillingContext(installationId: number, _authorLogin?: string) {
    return this.dispatchContexts.get(installationId);
  }

  async upsertReviewRunBilling(input: { reviewRunId: string; tenantId: string; rateMode: "included" | "overage"; keySource?: BillingKeySource }): Promise<void> {
    if (!this.runBillings.has(input.reviewRunId)) {
      this.runBillings.set(input.reviewRunId, {
        rate_mode: input.rateMode,
        key_source: input.keySource ?? null,
        infra_credits_charged: null,
        ai_credits_charged_total: 0,
        infra_billing_status: "pending",
      });
    }
  }

  async getReviewRunBilling(reviewRunId: string): Promise<ReviewRunBilling | undefined> {
    return this.runBillings.get(reviewRunId);
  }

  async listRunUsagePendingOutcome(reviewRunId: string): Promise<PendingUsageRow[]> {
    return this.usage.filter((row) => row.review_run_id === reviewRunId && row.billing_status === "pending_outcome");
  }

  async setUsageComputedPending(usageId: string, customerShare: string, aiCredits: number): Promise<void> {
    const row = this.usage.find((r) => r.id === usageId);
    if (row && (row.billing_status === "pending_outcome" || row.billing_status === "pending")) {
      row.customer_share = customerShare;
      row.ai_credits_charged = aiCredits;
      row.billing_status = "pending";
    }
  }

  async setUsageShadowComputed(usageId: string, customerShare: string, aiCredits: number): Promise<void> {
    const row = this.usage.find((r) => r.id === usageId);
    if (row && (row.billing_status === "pending_outcome" || row.billing_status === "shadow_computed")) {
      row.customer_share = customerShare;
      row.ai_credits_charged = aiCredits;
      row.billing_status = "shadow_computed";
    }
  }

  async claimUsageForTracking(usageId: string, autumnEventId: string): Promise<boolean> {
    const row = this.usage.find((r) => r.id === usageId);
    if (row && row.billing_status === "pending") {
      row.billing_status = "tracking";
      row.autumn_event_id = autumnEventId;
      row.claimed_at = Date.now();
      return true;
    }
    return false;
  }

  async revertUsageClaim(usageId: string): Promise<void> {
    const row = this.usage.find((r) => r.id === usageId);
    if (row && row.billing_status === "tracking") {
      row.billing_status = "pending";
      row.claimed_at = undefined;
    }
  }

  async markUsageBilled(usageId: string, autumnEventId: string): Promise<boolean> {
    if (this.failUsagePersist) {
      throw new Error("usage persist failed (simulated crash)");
    }
    const row = this.usage.find((r) => r.id === usageId);
    if (row && row.billing_status === "tracking") {
      row.billing_status = "billed";
      row.autumn_event_id = autumnEventId;
      row.claimed_at = undefined;
      return true;
    }
    return false;
  }

  async waiveManagedUsageRows(reviewRunId: string): Promise<void> {
    // FINDING 3: waives 'tracking' rows too so a denied stale-replay recheck can waive them.
    for (const row of this.usage) {
      if (
        row.review_run_id === reviewRunId &&
        (row.billing_status === "pending_outcome" || row.billing_status === "pending" || row.billing_status === "tracking")
      ) {
        row.billing_status = "waived";
      }
    }
  }

  async listStaleTrackingUsageRows(limit: number, olderThan: Date): Promise<PendingUsageRow[]> {
    return this.usage
      .filter((r) => r.billing_status === "tracking" && r.claimed_at !== undefined && r.claimed_at < olderThan.getTime())
      .slice(0, limit);
  }

  async reclaimStaleTrackingUsage(usageId: string, olderThan: Date): Promise<boolean> {
    const row = this.usage.find((r) => r.id === usageId);
    if (row && row.billing_status === "tracking" && row.claimed_at !== undefined && row.claimed_at < olderThan.getTime()) {
      row.claimed_at = Date.now();
      return true;
    }
    return false;
  }

  private ensureBilling(reviewRunId: string, rateMode: "included" | "overage"): FakeBilling {
    let row = this.runBillings.get(reviewRunId);
    if (!row) {
      row = { rate_mode: rateMode, key_source: null, infra_credits_charged: null, ai_credits_charged_total: 0, infra_billing_status: "pending" };
      this.runBillings.set(reviewRunId, row);
    }
    return row;
  }

  async waiveRunBilling(reviewRunId: string, _tenantId: string): Promise<void> {
    for (const row of this.usage) {
      if (row.review_run_id === reviewRunId && (row.billing_status === "pending_outcome" || row.billing_status === "pending")) {
        row.billing_status = "waived";
      }
    }
    const billing = this.ensureBilling(reviewRunId, "included");
    billing.infra_credits_charged = 0;
    billing.infra_billing_status = "waived";
  }

  async claimInfraForTracking(input: { reviewRunId: string; tenantId: string; rateMode: "included" | "overage"; credits: number; autumnEventId: string }): Promise<boolean> {
    let row = this.runBillings.get(input.reviewRunId);
    if (!row) {
      this.runBillings.set(input.reviewRunId, {
        rate_mode: input.rateMode,
        key_source: null,
        infra_credits_charged: input.credits,
        ai_credits_charged_total: 0,
        infra_billing_status: "tracking",
        infra_autumn_event_id: input.autumnEventId,
        infra_claimed_at: Date.now(),
      });
      return true;
    }
    if (row.infra_billing_status === "pending") {
      row.infra_billing_status = "tracking";
      row.infra_credits_charged = input.credits;
      row.infra_autumn_event_id = input.autumnEventId;
      row.infra_claimed_at = Date.now();
      return true;
    }
    return false;
  }

  async revertInfraClaim(reviewRunId: string): Promise<void> {
    const row = this.runBillings.get(reviewRunId);
    if (row && row.infra_billing_status === "tracking") {
      row.infra_billing_status = "pending";
      row.infra_claimed_at = undefined;
    }
  }

  async markInfraBilled(input: { reviewRunId: string; tenantId: string; rateMode: "included" | "overage"; credits: number; autumnEventId: string }): Promise<void> {
    const row = this.runBillings.get(input.reviewRunId);
    if (row && row.infra_billing_status === "tracking") {
      row.infra_billing_status = "billed";
      row.infra_credits_charged = input.credits;
      row.infra_autumn_event_id = input.autumnEventId;
      row.infra_claimed_at = undefined;
    }
  }

  async listStaleTrackingInfra(limit: number, olderThan: Date): Promise<StaleTrackingInfra[]> {
    const out: StaleTrackingInfra[] = [];
    for (const [reviewRunId, billing] of this.runBillings) {
      if (billing.infra_billing_status === "tracking" && billing.infra_claimed_at !== undefined && billing.infra_claimed_at < olderThan.getTime()) {
        out.push({
          reviewRunId,
          tenantId: `tenant-${reviewRunId}`,
          status: this.runStatuses.get(reviewRunId) ?? "completed",
          credits: billing.infra_credits_charged,
          autumnEventId: billing.infra_autumn_event_id ?? null,
          rateMode: billing.rate_mode,
        });
      }
    }
    return out.slice(0, limit);
  }

  async reclaimStaleTrackingInfra(reviewRunId: string, olderThan: Date): Promise<boolean> {
    const row = this.runBillings.get(reviewRunId);
    if (row && row.infra_billing_status === "tracking" && row.infra_claimed_at !== undefined && row.infra_claimed_at < olderThan.getTime()) {
      row.infra_claimed_at = Date.now();
      return true;
    }
    return false;
  }

  async setInfraPending(input: { reviewRunId: string; tenantId: string; rateMode: "included" | "overage"; credits: number }): Promise<void> {
    const billing = this.ensureBilling(input.reviewRunId, input.rateMode);
    if (billing.infra_billing_status === "pending") {
      billing.infra_credits_charged = input.credits;
    }
  }

  async setInfraShadowComputed(input: { reviewRunId: string; tenantId: string; rateMode: "included" | "overage"; credits: number }): Promise<void> {
    const billing = this.ensureBilling(input.reviewRunId, input.rateMode);
    if (billing.infra_billing_status === "pending" || billing.infra_billing_status === "shadow_computed") {
      billing.infra_credits_charged = input.credits;
      billing.infra_billing_status = "shadow_computed";
    }
  }

  async addRunAiCreditsTotal(reviewRunId: string, credits: number): Promise<void> {
    const billing = this.runBillings.get(reviewRunId);
    if (billing) {
      billing.ai_credits_charged_total += credits;
    }
  }

  async getReviewRunStatus(reviewRunId: string): Promise<string | undefined> {
    return this.runStatuses.get(reviewRunId);
  }

  async listPendingUsageRows(limit: number): Promise<PendingUsageRow[]> {
    return this.usage.filter((row) => row.billing_status === "pending").slice(0, limit);
  }

  async listTerminalRunsWithPendingOutcome(limit: number): Promise<Array<{ reviewRunId: string; status: string }>> {
    const seen = new Map<string, string>();
    for (const row of this.usage) {
      if (row.billing_status !== "pending_outcome") {
        continue;
      }
      const status = this.runStatuses.get(row.review_run_id);
      if (status && isTerminal(status)) {
        seen.set(row.review_run_id, status);
      }
    }
    return [...seen.entries()].slice(0, limit).map(([reviewRunId, status]) => ({ reviewRunId, status }));
  }

  async listRunsWithPendingInfra(limit: number): Promise<Array<{ reviewRunId: string; status: string }>> {
    const out: Array<{ reviewRunId: string; status: string }> = [];
    for (const [reviewRunId, billing] of this.runBillings) {
      const status = this.runStatuses.get(reviewRunId);
      if (billing.infra_billing_status === "pending" && status && isTerminal(status)) {
        out.push({ reviewRunId, status });
      }
    }
    return out.slice(0, limit);
  }
}

function isTerminal(status: string): boolean {
  return ["completed", "completed_superseded", "failed", "superseded", "cancelled", "canceled"].includes(status);
}

/** The full zeroed RetryBillingCounts shape (NON-BLOCKING ADOPTED c). */
function emptyCounts() {
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

/** Capture console.warn calls so tests can assert structured warnings, then restore it. */
function captureWarnings(): { entries: unknown[][]; restore: () => void } {
  const entries: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    entries.push(args);
  };
  return { entries, restore: () => { console.warn = original; } };
}

/** Capture console.error calls (FINDING 4 billing_config_error), then restore it. */
function captureErrors(): { entries: unknown[][]; restore: () => void } {
  const entries: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    entries.push(args);
  };
  return { entries, restore: () => { console.error = original; } };
}

/** Capture console.info calls (FINDING 2 advisory dispatch logs), then restore it. */
function captureInfo(): { entries: unknown[][]; restore: () => void } {
  const entries: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    entries.push(args);
  };
  return { entries, restore: () => { console.info = original; } };
}

/* ------------------------------------------------------------------ helpers --- */

function config(enforce: BillingEnforcement, withSecret = true): BillingConfig {
  return {
    autumnSecretKey: withSecret ? "sk_test" : undefined,
    autumnApiUrl: "https://api.useautumn.com/v1",
    creditsFeatureId: "jina_credits",
    managedAiFeatureId: "managed_ai_access",
    enforce,
  };
}

function service(enforce: BillingEnforcement, autumn: FakeAutumn, store: FakeStore, withSecret = true): BillingService {
  return new BillingService(config(enforce, withSecret), autumn, store);
}

/* ---------------------------------------------------- top-up amount parse --- */

test("normalizeTopupCredits floors + clamps a valid amount into the allowed range", () => {
  assert.equal(normalizeTopupCredits(5000), 5000);
  assert.equal(normalizeTopupCredits(2500.9), 2500); // floored
  assert.equal(normalizeTopupCredits("10000"), 10000); // numeric string accepted
  assert.equal(normalizeTopupCredits(10), MIN_TOPUP_CREDITS); // below floor -> clamp up
  assert.equal(normalizeTopupCredits(9_999_999), MAX_TOPUP_CREDITS); // above ceiling -> clamp down
});

test("normalizeTopupCredits returns undefined for a non-usable amount (fall back to default pack)", () => {
  assert.equal(normalizeTopupCredits(undefined), undefined);
  assert.equal(normalizeTopupCredits(null), undefined);
  assert.equal(normalizeTopupCredits(0), undefined);
  assert.equal(normalizeTopupCredits(-100), undefined);
  assert.equal(normalizeTopupCredits("abc"), undefined);
  // A sanity check that the documented default is what topupUrl falls back to.
  assert.equal(DEFAULT_TOPUP_CREDITS, 10_000);
});

/* ------------------------------------------------------------- rate mode --- */

test("resolveRateMode is 'included' when credits remain and 'overage' when exhausted", async () => {
  const store = new FakeStore();
  assert.equal(await service("on", new FakeAutumn({ creditsBalance: 500 }), store).resolveRateMode("c"), "included");
  assert.equal(await service("on", new FakeAutumn({ creditsBalance: 0 }), store).resolveRateMode("c"), "overage");
});

test("resolveRateMode resolves generously to 'included' when Autumn is down", async () => {
  const store = new FakeStore();
  assert.equal(await service("on", new FakeAutumn({ failCheck: true }), store).resolveRateMode("c"), "included");
});

/* --------------------------------------------------------- enforcement --- */

// FINDING 2: gateDispatch is now ADVISORY-ONLY (returns void, never blocks). Enforcement moved wholly
// to prepareRunBilling so a blocked review is PR-visible. These tests assert it still evaluates + logs
// but never blocks, and that dispatch proceeds even when the balance is exhausted.

test("gateDispatch is inert (no Autumn calls) when enforcement is off", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 0 });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });
  await service("off", autumn, store).gateDispatch(1);
  assert.equal(autumn.checks.length, 0);
});

test("gateDispatch in shadow evaluates (logs would_block) but never blocks", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 0 });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });
  const info = captureInfo();
  try {
    await service("shadow", autumn, store).gateDispatch(1);
  } finally {
    info.restore();
  }
  assert.ok(autumn.checks.length > 0, "shadow still evaluates the gate");
  assert.ok(info.entries.some((e) => e[0] === "billing_gate_shadow"), "shadow logs the would-be decision");
});

// FINDING 2: dispatch PROCEEDS under enforce=on even with an exhausted balance — the hard block now
// happens at prepare (prepareRunBilling), which completes the run terminal-blocked + comments visibly.
// gateDispatch only logs the advisory would_block; it does not block.
test("gateDispatch in 'on' does NOT block an exhausted User tenant; it logs would_block (block happens at prepare)", async () => {
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed", githubAccountType: "User" });
  const info = captureInfo();
  try {
    // Returns void (advisory) and must not throw despite the exhausted balance.
    await assert.doesNotReject(service("on", new FakeAutumn({ creditsBalance: 0 }), store).gateDispatch(1));
  } finally {
    info.restore();
  }
  assert.ok(info.entries.some((e) => e[0] === "billing_gate_would_block"), "logs the advisory would_block");
});

test("gateDispatch does not require managed_ai_access for a BYOH (user-key) run", async () => {
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "user" });
  const autumn = new FakeAutumn({ creditsBalance: 10, managedAllowed: false });
  await service("on", autumn, store).gateDispatch(1);
  assert.ok(!autumn.checks.some((c) => c.featureId === "managed_ai_access"), "no managed_ai check for BYOH");
});

test("gateDispatch never throws when Autumn is unavailable", async () => {
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });
  await assert.doesNotReject(service("on", new FakeAutumn({ failCheck: true }), store).gateDispatch(1));
});

// Dispatch remains advisory for every tenant type; prepare is the sole hard-blocking point.
test("gateDispatch in 'on' logs the same would-block decision for an Organization", async () => {
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed", githubAccountType: "Organization" });
  const info = captureInfo();
  try {
    await service("on", new FakeAutumn({ creditsBalance: 0 }), store).gateDispatch(1);
  } finally {
    info.restore();
  }
  assert.ok(info.entries.some((e) => e[0] === "org_tenant_managed_only"), "org tenant logged via org_tenant_managed_only");
  assert.ok(info.entries.some((e) => e[0] === "billing_gate_would_block"), "org denial is visible in the common advisory log");
});

test("prepareRunBilling in 'on' blocks exhausted Organization and User tenants", async () => {
  const orgStore = new FakeStore();
  orgStore.seedRun("run-org", { keySource: "managed", githubAccountType: "Organization" });
  const org = await service("on", new FakeAutumn({ creditsBalance: 0 }), orgStore).prepareRunBilling("run-org");
  assert.deepEqual(org, { blocked: true, reason: "insufficient_credits" }, "org run is blocked on the same balance gate");

  const userStore = new FakeStore();
  userStore.seedRun("run-user", { keySource: "managed", githubAccountType: "User" });
  const user = await service("on", new FakeAutumn({ creditsBalance: 0 }), userStore).prepareRunBilling("run-user");
  assert.deepEqual(user, { blocked: true, reason: "insufficient_credits" }, "user run is blocked");
});

test("prepareRunBilling pins rate mode and returns blocked under 'on' when denied", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed" });
  const denied = await service("on", new FakeAutumn({ creditsBalance: 0 }), store).prepareRunBilling("run-1");
  assert.equal(denied.blocked, true);
  assert.equal(store.runBillings.get("run-1")?.rate_mode, "overage");
  assert.equal(store.runBillings.get("run-1")?.key_source, "managed");
});

test("prepareRunBilling treats an explicit zero balance as exhausted even if Autumn reports allowed", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed" });

  const result = await service(
    "on",
    new FakeAutumn({ creditsBalance: 0, creditsAllowed: true }),
    store,
  ).prepareRunBilling("run-1");

  assert.deepEqual(result, { blocked: true, reason: "insufficient_credits" });
});

test("prepareRunBilling never blocks in shadow even when denied", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed" });
  const result = await service("shadow", new FakeAutumn({ creditsBalance: 0 }), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
  assert.equal(store.runBillings.get("run-1")?.rate_mode, "overage");
});

/* ------------------------------------------- auto-review credit cap (item 5) --- */
// The tenant's OWN cap applies to AUTO triggers only (manual bypasses). Like the platform balance
// gate, it applies to Organization tenants too and only hard-blocks under enforce=on.

const CAP_POLICY: BillingPolicy = { ...PLATFORM_BILLING_POLICY, auto_review_limit_enabled: true, auto_review_limit_credits: 1000 };
// A healthy balance (so the platform balance gate passes) but current-cycle used credits AT/OVER the cap.
const overCapAutumn = () => new FakeAutumn({ creditsBalance: 500, creditsGranted: 1500, creditsUsage: 1000, managedAllowed: true });
const underCapAutumn = () => new FakeAutumn({ creditsBalance: 500, creditsGranted: 1500, creditsUsage: 900, managedAllowed: true });

test("auto-review cap: an AUTO-triggered User run at/over the cap is blocked with 'auto_review_limit_reached'", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User", triggerSource: "webhook", policy: CAP_POLICY });
  const result = await service("on", overCapAutumn(), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "auto_review_limit_reached");
});

test("auto-review cap: applies to Organization tenants too (the tenant's own cap, not the platform block)", async () => {
  const store = new FakeStore();
  store.seedRun("run-org", { keySource: "managed", githubAccountType: "Organization", triggerSource: "webhook", policy: CAP_POLICY });
  const result = await service("on", overCapAutumn(), store).prepareRunBilling("run-org");
  assert.equal(result.blocked, true, "org is NOT exempt from its own cap");
  assert.equal(result.reason, "auto_review_limit_reached");
});

test("auto-review cap: a MANUAL trigger bypasses the cap even when over", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User", triggerSource: "manual", policy: CAP_POLICY });
  const result = await service("on", overCapAutumn(), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
});

test("auto-review cap: an AUTO trigger UNDER the cap is not blocked", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User", triggerSource: "webhook", policy: CAP_POLICY });
  const result = await service("on", underCapAutumn(), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
});

test("auto-review cap: a DISABLED cap never blocks even when used exceeds the (stale) limit", async () => {
  const store = new FakeStore();
  const disabled: BillingPolicy = { ...CAP_POLICY, auto_review_limit_enabled: false };
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User", triggerSource: "webhook", policy: disabled });
  const result = await service("on", overCapAutumn(), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
});

test("auto-review cap: shadow mode never hard-blocks even over the cap", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User", triggerSource: "webhook", policy: CAP_POLICY });
  const result = await service("shadow", overCapAutumn(), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
});

/* --------------------------------- key-source classification (FINDING) --- */
// Billing classification must mirror the runtime credential precedence: author harness > tenant
// OpenRouter key > managed. Only a "managed" run consumes the managed-AI entitlement, so only it runs
// the managed-AI gate. A harness/user run executes on its own credential and is never gated on managed AI.

test("prepareRunBilling classifies a harness-only author as 'harness': pins 'harness', no managed-AI check", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "harness" });
  // managedAllowed:false would block a managed run; a harness run must not even check it.
  const autumn = new FakeAutumn({ creditsBalance: 10, managedAllowed: false });
  const result = await service("on", autumn, store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false, "own-harness run is never blocked on the managed-AI entitlement");
  assert.equal(store.runBillings.get("run-1")?.key_source, "harness", "pins key_source 'harness'");
  assert.ok(!autumn.checks.some((c) => c.featureId === "managed_ai_access"), "no managed_ai_access check for a harness run");
});

test("prepareRunBilling classifies a tenant-key-only run as 'user': pins 'user', no managed-AI check", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "user" });
  const autumn = new FakeAutumn({ creditsBalance: 10, managedAllowed: false });
  const result = await service("on", autumn, store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
  assert.equal(store.runBillings.get("run-1")?.key_source, "user");
  assert.ok(!autumn.checks.some((c) => c.featureId === "managed_ai_access"), "no managed_ai_access check for a user-key run");
});

test("prepareRunBilling blocks exhausted custom-harness and tenant-key runs", async () => {
  for (const keySource of ["harness", "user"] as const) {
    const store = new FakeStore();
    store.seedRun(`run-${keySource}`, { keySource });
    const autumn = new FakeAutumn({ creditsBalance: 0, managedAllowed: false });

    const result = await service("on", autumn, store).prepareRunBilling(`run-${keySource}`);

    assert.deepEqual(result, { blocked: true, reason: "insufficient_credits" }, `${keySource} run is credit-gated`);
    assert.equal(store.runBillings.get(`run-${keySource}`)?.key_source, keySource);
    assert.ok(!autumn.checks.some((c) => c.featureId === "managed_ai_access"), `${keySource} run skips managed AI check`);
  }
});

test("prepareRunBilling classifies a run with neither credential as 'managed': pins 'managed', checks managed AI", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed" });
  const autumn = new FakeAutumn({ creditsBalance: 10, managedAllowed: true });
  const result = await service("on", autumn, store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false);
  assert.equal(store.runBillings.get("run-1")?.key_source, "managed");
  assert.ok(autumn.checks.some((c) => c.featureId === "managed_ai_access"), "managed run checks managed_ai_access");
});

test("prepareRunBilling: a managed run WITHOUT managed_ai_access is NOT blocked (managed AI is always the fallback)", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User" });
  // managed_ai_access denied but credits available -> allowed. Managed AI is the universal fallback; it is
  // gated ONLY by the credit balance and metered as jina_credits, never blocked by the entitlement boolean.
  const result = await service("on", new FakeAutumn({ creditsBalance: 10, managedAllowed: false }), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, false, "managed AI is always the fallback — the entitlement boolean must not block it");
});

test("prepareRunBilling: a managed run is blocked ONLY when credits are exhausted", async () => {
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed", githubAccountType: "User" });
  // No credits (and managed_ai_access irrelevant now) -> blocked on the credit balance alone.
  const result = await service("on", new FakeAutumn({ creditsBalance: 0, managedAllowed: true }), store).prepareRunBilling("run-1");
  assert.equal(result.blocked, true, "a managed run with no credits is blocked on balance");
});

test("gateDispatch classifies a harness author (author login threaded in) and skips the managed-AI check", async () => {
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "harness" });
  const autumn = new FakeAutumn({ creditsBalance: 10, managedAllowed: false });
  await service("on", autumn, store).gateDispatch(1, "octocat");
  assert.ok(!autumn.checks.some((c) => c.featureId === "managed_ai_access"), "no managed_ai check for a harness dispatch");
});

/* --------------------------------------------------------- settlement --- */

test("a run admitted with credits finishes after its balance is exhausted, while the next run is blocked", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1 });
  const store = new FakeStore();
  store.seedRun("run-live", { keySource: "managed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-live", cost: "0.50" });
  const svc = service("on", autumn, store);

  assert.deepEqual(await svc.prepareRunBilling("run-live"), { blocked: false });
  const checksAtAdmission = autumn.checks.length;

  // Simulate another charge (or this run's accumulating usage) consuming the last credit mid-run.
  autumn.setCreditsBalance(0);
  await svc.settleReviewOutcome("run-live", "completed");

  assert.equal(autumn.checks.length, checksAtAdmission, "settlement never re-gates an admitted run");
  assert.ok(autumn.tracks.some((t) => t.idempotencyKey === "infra:run-live"), "in-flight run still settles infra");
  assert.ok(autumn.tracks.some((t) => t.idempotencyKey.startsWith("ai:run-live:")), "in-flight run still settles AI usage");

  store.seedRun("run-next", { keySource: "managed" });
  assert.deepEqual(
    await svc.prepareRunBilling("run-next"),
    { blocked: true, reason: "insufficient_credits" },
    "a review prepared after exhaustion is blocked",
  );
});

test("settlement of a completed run charges infra once and bills each AI row (enforce on)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" }); // 0.50*0.70*100 = 35
  store.seedUsage({ id: "u2", reviewRunId: "run-1", cost: "0.01" }); // ceil(0.7) = 1

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  const infra = autumn.tracks.filter((t) => t.idempotencyKey === "infra:run-1");
  assert.equal(infra.length, 1);
  assert.equal(infra[0]!.value, 100);
  const ai = autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:run-1:"));
  assert.deepEqual(ai.map((t) => t.value).sort((a, b) => a - b), [1, 35]);
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "billed");
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 36);
  assert.ok(store.usage.every((r) => r.billing_status === "billed"));
});

test("settlement at overage rates uses infra 150 and no subsidy (share 1.0)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "overage" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" }); // 0.50*1.0*100 = 50

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.find((t) => t.idempotencyKey === "infra:run-1")?.value, 150);
  assert.equal(autumn.tracks.find((t) => t.idempotencyKey.startsWith("ai:"))?.value, 50);
});

test("settlement bills a BYOK row from billable_cost (upstream + fee), not the OpenRouter fee alone", async () => {
  // BYOK route: OpenRouter `cost` is only the ~$0.05 fee; the real $1.00 model spend is the upstream
  // inference cost. The proxy summed them into billable_cost = 1.05, so the basis is $1.05, NOT $0.05.
  // ceil(1.05 * 0.70 * 100) = ceil(73.5) = 74 credits at the default 30% subsidy.
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.05", billableCost: "1.05" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.find((t) => t.idempotencyKey.startsWith("ai:"))?.value, 74);
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 74);
});

test("settlement of a non-BYOK row is unchanged: billable_cost mirrors the OpenRouter cost", async () => {
  // Non-BYOK: billable_cost == openrouter_cost ($0.50). ceil(0.50 * 0.70 * 100) = 35 — the pre-BYOK
  // amount. (If the basis had unconditionally summed upstream, this would have double-charged.)
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", billableCost: "0.50" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.find((t) => t.idempotencyKey.startsWith("ai:"))?.value, 35);
});

test("settlement of a legacy pre-0014 row (null billable_cost) falls back to openrouter_cost", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" }); // billableCost omitted -> null

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.find((t) => t.idempotencyKey.startsWith("ai:"))?.value, 35);
});

// DEGRADED-RUN INFRA WAIVER: when every model call failed, the runtime stage reports 'failed' (with a
// degraded review still published to the PR). A 'failed' completion must waive infra AND every AI row
// end-to-end and call Autumn zero times — a published review never implies a billable 'completed'.
test("a run reported 'failed' (all model calls failed) waives infra + all AI rows end-to-end", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.05", billableCost: "1.05" });
  store.seedUsage({ id: "u2", reviewRunId: "run-1", cost: "0.50", billableCost: "0.50" });

  // 'failed' is what botStatusFor("failed") produces; settlement waives on any non-'completed' outcome.
  await service("on", autumn, store).settleReviewOutcome("run-1", "failed");

  assert.equal(autumn.tracks.length, 0, "no infra and no AI credits are ever tracked for a failed run");
  assert.ok(store.usage.every((r) => r.billing_status === "waived"), "every AI row is waived");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "waived");
  assert.equal(store.runBillings.get("run-1")?.infra_credits_charged, 0);
});

test("a failed run waives every charge and calls Autumn zero times", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "failed");

  assert.equal(autumn.tracks.length, 0);
  assert.equal(store.usage[0]!.billing_status, "waived");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "waived");
  assert.equal(store.runBillings.get("run-1")?.infra_credits_charged, 0);
});

test("a superseded run waives every charge", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed_superseded");

  assert.equal(autumn.tracks.length, 0);
  assert.equal(store.usage[0]!.billing_status, "waived");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "waived");
});

// DECISION 1 (reverses the previous design): shadow NEVER back-bills. It still computes + persists
// share/credits/infra for reconciliation, but finalizes rows as the terminal 'shadow_computed' status
// (previously they were left 'pending', which a later flip to "on" would have drained and billed).
test("shadow settlement finalizes shadow_computed with amounts persisted, but never calls Autumn track", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  await service("shadow", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.length, 0);
  // Amounts are still computed + persisted (reconciliation), but the status is the terminal
  // non-billable 'shadow_computed', not 'pending'.
  assert.equal(store.usage[0]!.billing_status, "shadow_computed");
  assert.equal(store.usage[0]!.ai_credits_charged, 35);
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "shadow_computed");
  assert.equal(store.runBillings.get("run-1")?.infra_credits_charged, 100);
});

// DECISION 1: the whole point — usage settled while shadow was live must NEVER bill after a flip to
// "on". The retry drain selects only pending/pending_outcome/tracking rows, never 'shadow_computed'.
test("flipping to 'on' after a shadow settlement bills NOTHING from the shadow period", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  // Settle under shadow -> everything becomes 'shadow_computed'.
  await service("shadow", autumn, store).settleReviewOutcome("run-1", "completed");
  assert.equal(store.usage[0]!.billing_status, "shadow_computed");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "shadow_computed");

  // Now enforcement flips to "on" and the retry drain runs. It must find nothing to bill.
  const counts = await service("on", autumn, store).retryPendingBillingEvents();

  assert.deepEqual(counts, emptyCounts());
  assert.equal(autumn.tracks.length, 0, "no back-billing of shadow-period usage");
  assert.equal(store.usage[0]!.billing_status, "shadow_computed");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "shadow_computed");
});

test("settlement is idempotent: a second call bills nothing more", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });
  const svc = service("on", autumn, store);

  await svc.settleReviewOutcome("run-1", "completed");
  const afterFirst = autumn.tracks.length;
  await svc.settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.length, afterFirst, "second settlement is a no-op");
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 35);
});

test("settlement never throws when Autumn track fails; rows are left for retry", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, failTrack: true });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  await assert.doesNotReject(service("on", autumn, store).settleReviewOutcome("run-1", "completed"));
  // Nothing is marked billed when tracking fails; the row stays recoverable for the retry job
  // (infra tracks first, so on failure the AI row is left untouched at 'pending_outcome').
  assert.notEqual(store.usage[0]!.billing_status, "billed");
  assert.notEqual(store.usage[0]!.billing_status, "waived");
  assert.notEqual(store.runBillings.get("run-1")?.infra_billing_status, "billed");
});

/* --------------------------------------------------- entitlement + claim --- */

test("settlement BILLS managed AI rows even when managed_ai_access is denied (always metered, no waive)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, managedAllowed: false });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" }); // 0.50*0.70*100 = 35

  const warnings = captureWarnings();
  try {
    await service("on", autumn, store).settleReviewOutcome("run-1", "completed");
  } finally {
    warnings.restore();
  }

  // Managed AI is always the fallback and always metered as credits: the AI row is BILLED despite
  // managed_ai_access denied, and there is no entitlement-mismatch waive/warn anymore.
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:")).length, 1);
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey === "infra:run-1").length, 1);
  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.ok(!warnings.entries.some((w) => w[0] === "billing_entitlement_mismatch"), "no entitlement waive");
});

test("settlement bills managed AI rows regardless of a managed_ai_access check outage (entitlement no longer consulted)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, failCheck: true });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  // Settlement no longer performs an entitlement check, so a managed_ai_access check outage cannot
  // strand managed AI rows — they are billed via track(), which is unaffected by a check() failure.
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "billed");
  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:")).length, 1);
});

test("crash after a successful track but before the persist leaves the row 'tracking', then the stale sweep re-tracks once", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" }); // 35 credits
  const svc = service("on", autumn, store);

  // Simulate a crash: track succeeds, markUsageBilled throws.
  store.failUsagePersist = true;
  await svc.settleReviewOutcome("run-1", "completed"); // never throws (settlement swallows)

  const u1 = store.usage.find((r) => r.id === "u1")!;
  assert.equal(u1.billing_status, "tracking", "row stuck 'tracking' (claimed, charged, not persisted)");
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey === "ai:run-1:dk-u1").length, 1, "charged once");
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 0, "total not incremented before persist");

  // 10 minutes pass; the persist works now. The stale sweep re-tracks with the SAME event id.
  store.failUsagePersist = false;
  u1.claimed_at = Date.now() - 11 * 60 * 1000;
  const warnings = captureWarnings();
  let counts;
  try {
    counts = await svc.retryPendingBillingEvents();
  } finally {
    warnings.restore();
  }

  assert.equal(u1.billing_status, "billed");
  assert.equal(counts.usage_billed, 1);
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 35, "total incremented exactly once");
  assert.equal(
    autumn.tracks.filter((t) => t.idempotencyKey === "ai:run-1:dk-u1").length,
    2,
    "re-tracked with the SAME idempotency key",
  );
  assert.ok(warnings.entries.some((w) => w[0] === "possible_duplicate_charge"));
});

test("concurrent retry drains charge each row exactly once (the claim is the single-flight)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "pending", aiCredits: 35 });
  store.runBillings.get("run-1")!.infra_billing_status = "billed"; // isolate the AI row
  const svc = service("on", autumn, store);

  await Promise.all([svc.retryPendingBillingEvents(), svc.retryPendingBillingEvents()]);

  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey === "ai:run-1:dk-u1").length, 1, "charged once");
  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 35, "total added exactly once");
});

test("prepareRunBilling issues a single credits check shared by rate-mode and the gate", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 500 });
  const store = new FakeStore();
  store.seedRun("run-1", { keySource: "managed" });

  await service("on", autumn, store).prepareRunBilling("run-1");

  assert.equal(autumn.checks.filter((c) => c.featureId === "jina_credits").length, 1, "one shared credits check");
  assert.equal(autumn.checks.filter((c) => c.featureId === "managed_ai_access").length, 1, "one managed check");
});

/* --------------------------------------------------------------- retry --- */

test("retryPendingBillingEvents drains pending usage rows and pending infra (enforce on)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  // A usage row already computed to 'pending' (e.g. from a prior Autumn outage).
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "pending", aiCredits: 35 });
  // Pending infra to drain.
  store.runBillings.get("run-1")!.infra_billing_status = "pending";
  store.runBillings.get("run-1")!.infra_credits_charged = 100;

  const counts = await service("on", autumn, store).retryPendingBillingEvents();

  assert.equal(counts.usage_billed, 1);
  assert.equal(counts.infra_billed, 1);
  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "billed");
  assert.ok(autumn.tracks.some((t) => t.idempotencyKey === "ai:run-1:dk-u1" && t.value === 35));
  assert.ok(autumn.tracks.some((t) => t.idempotencyKey === "infra:run-1" && t.value === 100));
});

test("retryPendingBillingEvents settles a terminal run still holding pending_outcome rows", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "pending_outcome" });

  const counts = await service("on", autumn, store).retryPendingBillingEvents();

  assert.equal(counts.runs_settled, 1);
  assert.equal(store.usage[0]!.billing_status, "billed");
});

test("retry drain BILLS a pending managed AI row even when managed_ai_access is denied (no waive)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, managedAllowed: false });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  // A managed AI row already computed to 'pending' (e.g. a prior Autumn outage). Infra already billed
  // so only the AI row is exercised.
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "pending", aiCredits: 35 });
  store.runBillings.get("run-1")!.infra_billing_status = "billed";

  const warnings = captureWarnings();
  let counts;
  try {
    counts = await service("on", autumn, store).retryPendingBillingEvents();
  } finally {
    warnings.restore();
  }

  // Managed AI is always metered: the pending row is BILLED (not waived), no entitlement mismatch.
  assert.equal(counts.usage_billed, 1);
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:")).length, 1);
  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.ok(!warnings.entries.some((w) => w[0] === "billing_entitlement_mismatch"), "no entitlement waive");
});

test("retry drain bills a pending managed AI row regardless of a managed_ai_access check outage", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, failCheck: true });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "pending", aiCredits: 35 });
  store.runBillings.get("run-1")!.infra_billing_status = "billed";

  const counts = await service("on", autumn, store).retryPendingBillingEvents();

  // The drain no longer performs an entitlement check, so a check outage can't strand the row.
  assert.equal(counts.usage_billed, 1);
  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:")).length, 1);
});

/* ------------------------------------- stale-tracking usage replay recheck (FINDING 3) --- */

// FINDING 3: a row is claimed 'tracking' BEFORE its first track, so the crash window can leave a
// 'tracking' row that was never charged. The stale replay must recheck managed entitlement exactly
// like the pending path — entitled -> re-track once with the same event id; denied -> waive; error ->
// leave the claim stale (not bumped) for the next drain.

/** Seed a stale 'tracking' usage row for `run-1` (claimed 11 min ago) with infra already billed. */
function seedStaleTrackingUsage(store: FakeStore, eventId = "ai:run-1:dk-u1", claimedAt = Date.now() - 11 * 60 * 1000) {
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "tracking", aiCredits: 35 });
  store.runBillings.get("run-1")!.infra_billing_status = "billed"; // isolate the AI row
  const row = store.usage.find((r) => r.id === "u1")!;
  row.claimed_at = claimedAt;
  row.autumn_event_id = eventId;
  return row;
}

test("stale usage replay re-tracks once with the same event id when still entitled (FINDING 3)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, managedAllowed: true });
  const store = new FakeStore();
  const row = seedStaleTrackingUsage(store);

  const warnings = captureWarnings();
  let counts;
  try {
    counts = await service("on", autumn, store).retryPendingBillingEvents();
  } finally {
    warnings.restore();
  }

  assert.equal(counts.stale_usage_rebilled, 1);
  assert.equal(counts.usage_billed, 1, "usage_billed still includes stale rebills (compat)");
  assert.equal(row.billing_status, "billed");
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey === "ai:run-1:dk-u1").length, 1, "re-tracked once, same event id");
  assert.equal(store.runBillings.get("run-1")?.ai_credits_charged_total, 35);
  assert.ok(warnings.entries.some((w) => w[0] === "possible_duplicate_charge"));
});

test("stale usage replay RE-TRACKS the tracking row even when managed_ai_access is denied (no waive)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, managedAllowed: false });
  const store = new FakeStore();
  const row = seedStaleTrackingUsage(store);

  const warnings = captureWarnings();
  let counts;
  try {
    counts = await service("on", autumn, store).retryPendingBillingEvents();
  } finally {
    warnings.restore();
  }

  // Managed AI is always metered: the stale 'tracking' row is re-tracked/billed, not waived.
  assert.equal(counts.stale_usage_rebilled, 1);
  assert.equal(counts.usage_billed, 1);
  assert.equal(row.billing_status, "billed");
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:")).length, 1, "re-tracked once");
  assert.ok(!warnings.entries.some((w) => w[0] === "billing_entitlement_mismatch"), "no entitlement waive");
});

test("stale usage replay re-tracks the tracking row regardless of a managed_ai_access check outage", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, failCheck: true });
  const store = new FakeStore();
  const claimedAt = Date.now() - 11 * 60 * 1000;
  const row = seedStaleTrackingUsage(store, "ai:run-1:dk-u1", claimedAt);

  const counts = await service("on", autumn, store).retryPendingBillingEvents();

  // No entitlement check happens, so a check outage can't strand the claim — it is re-tracked/billed.
  assert.equal(counts.stale_usage_rebilled, 1);
  assert.equal(row.billing_status, "billed");
  assert.equal(autumn.tracks.filter((t) => t.idempotencyKey.startsWith("ai:")).length, 1);
});

/* ------------------------------------------- arrival-time settlement (FINDING B) --- */

test("arrival-time settlement bills a late usage row for an already-completed run (FINDING B)", async () => {
  // Mirrors recordReviewUsage: a row arrives after the run is terminal 'completed'; the endpoint
  // invokes this same run-level settle helper, which computes + bills it with an entitlement recheck.
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "late", reviewRunId: "run-1", cost: "0.50" }); // pending_outcome by default

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(store.usage[0]!.billing_status, "billed");
  assert.ok(autumn.tracks.some((t) => t.idempotencyKey === "ai:run-1:dk-late" && t.value === 35));
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "billed");
});

test("arrival-time settlement waives a late usage row for a failed terminal run (FINDING B)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "failed" });
  store.seedUsage({ id: "late", reviewRunId: "run-1", cost: "0.50" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "failed");

  assert.equal(autumn.tracks.length, 0);
  assert.equal(store.usage[0]!.billing_status, "waived");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "waived");
});

test("retryPendingBillingEvents is a no-op in shadow mode (no tracks)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included", status: "completed" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50", status: "pending", aiCredits: 35 });

  const counts = await service("shadow", autumn, store).retryPendingBillingEvents();

  assert.deepEqual(counts, emptyCounts());
  assert.equal(autumn.tracks.length, 0);
});

/* --------------------------------------------------------- disabled --- */

test("no settlement or gating happens when the Autumn secret is absent", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 0 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });
  const svc = new BillingService(config("on", false), undefined, store);

  await svc.settleReviewOutcome("run-1", "completed");
  await svc.gateDispatch(1);

  assert.equal(autumn.tracks.length, 0);
  assert.equal(store.usage[0]!.billing_status, "pending_outcome");
});

/* --------------------------------------------------- overview status --- */

test("overview reports status 'ok' with balances when Autumn responds", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 500, managedAllowed: true });
  const overview = await service("on", autumn, new FakeStore()).overview("tenant-1", "acme");

  assert.equal(overview.status, "ok");
  assert.equal(overview.configured, true);
  assert.equal(overview.credits_balance, 500);
  assert.equal(overview.managed_ai_access, true);
  assert.equal(overview.plan_id, "startup");
});

test("a named overview repairs a customer first ensured without identity and memoizes the repair", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 500, managedAllowed: true });
  const billing = service("on", autumn, new FakeStore());
  const metadata = {
    github_account_id: "107232189",
    github_account_type: "Organization",
    github_login: "Metopian",
  };

  await billing.overview("tenant-1");
  await billing.overview("tenant-1", "Metopian (org)", metadata);
  await billing.overview("tenant-1", "Metopian (org)", metadata);

  assert.deepEqual(autumn.ensured, ["tenant-1"]);
  assert.deepEqual(autumn.updated, [{ customerId: "tenant-1", name: "Metopian (org)", metadata }]);
});

test("concurrent customer synchronization runs once per tenant identity", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 500, managedAllowed: true });
  const billing = service("on", autumn, new FakeStore());
  const metadata = { github_login: "Metopian" };

  await Promise.all([
    billing.overview("tenant-1", "Metopian (org)", metadata),
    billing.overview("tenant-1", "Metopian (org)", metadata),
  ]);

  assert.deepEqual(autumn.ensured, ["tenant-1"]);
  assert.deepEqual(autumn.updated, [{ customerId: "tenant-1", name: "Metopian (org)", metadata }]);
});

test("auto-reload creates or repairs the customer with tenant identity", async () => {
  const autumn = new FakeAutumn();
  const billing = service("on", autumn, new FakeStore());
  const metadata = { github_login: "Metopian" };

  await billing.setAutoReload(
    "tenant-1",
    { enabled: true, thresholdCredits: 500, reloadCredits: 10_000 },
    "Metopian (org)",
    metadata,
  );

  assert.deepEqual(autumn.ensured, ["tenant-1"]);
  assert.deepEqual(autumn.updated, [{ customerId: "tenant-1", name: "Metopian (org)", metadata }]);
  assert.deepEqual(autumn.autoTopups, [
    { customerId: "tenant-1", featureId: "jina_credits", enabled: true, threshold: 500, quantity: 10_000 },
  ]);
});

test("overview surfaces the cycle breakdown and recent invoices from the Autumn balance/customer", async () => {
  const autumn = new FakeAutumn({
    creditsBalance: 500,
    creditsGranted: 1500,
    creditsUsage: 1000,
    managedAllowed: true,
    invoices: [{ date: "2026-07-01", amount: "100", status: "paid", url: "https://pay.example/i1" }],
  });
  const overview = await service("on", autumn, new FakeStore()).overview("tenant-1", "acme");
  assert.deepEqual(overview.cycle, { granted: 1500, remaining: 500, used: 1000, next_reset_at: null });
  assert.deepEqual(overview.billing_activity, [
    { date: "2026-07-01", amount: "100", status: "paid", url: "https://pay.example/i1" },
  ]);
});

test("overview returns an empty cycle + no billing_activity when Autumn is unavailable", async () => {
  const overview = await service("on", new FakeAutumn({ failCheck: true }), new FakeStore()).overview("tenant-1");
  assert.deepEqual(overview.cycle, { granted: null, remaining: null, used: null, next_reset_at: null });
  assert.deepEqual(overview.billing_activity, []);
});

test("overview reports status 'unavailable' (configured=false) when Autumn errors", async () => {
  const autumn = new FakeAutumn({ failCheck: true });
  const overview = await service("on", autumn, new FakeStore()).overview("tenant-1");

  assert.equal(overview.status, "unavailable");
  assert.equal(overview.configured, false);
  assert.equal(overview.credits_balance, null);
  assert.equal(overview.managed_ai_access, null);
});

// NON-BLOCKING ADOPTED (a): a getCustomer (plan lookup) failure no longer degrades to plan_id:null with
// status:'ok' — it surfaces 'unavailable' (balance data notwithstanding), since we cannot confirm state.
test("overview reports 'unavailable' when the plan lookup (getCustomer) fails", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 500, managedAllowed: true, failCustomer: true });
  const overview = await service("on", autumn, new FakeStore()).overview("tenant-1", "acme");

  assert.equal(overview.status, "unavailable");
  assert.equal(overview.configured, false);
  assert.equal(overview.plan_id, null);
  assert.equal(overview.credits_balance, null);
});

test("overview reports status 'not_configured' without a client or without a tenant", async () => {
  const store = new FakeStore();
  const noClient = new BillingService(config("on", false), undefined, store);
  assert.equal((await noClient.overview("tenant-1")).status, "not_configured");

  const noTenant = service("on", new FakeAutumn({ creditsBalance: 1 }), store);
  assert.equal((await noTenant.overview(undefined)).status, "not_configured");
});

test("installation provisioning creates and repairs a named Autumn customer even when enforcement is off", async () => {
  const autumn = new FakeAutumn();
  const svc = service("off", autumn, new FakeStore());
  const metadata = {
    github_login: "holdoutlabs",
    github_account_id: "234299496",
    github_account_type: "Organization",
  };

  assert.equal(await svc.provisionTenantCustomer("tenant-1", "holdoutlabs (org)", metadata), true);
  assert.equal(await svc.provisionTenantCustomer("tenant-1", "holdoutlabs (org)", metadata), true);

  assert.deepEqual(autumn.ensured, ["tenant-1", "tenant-1"]);
  assert.deepEqual(autumn.updated, [
    { customerId: "tenant-1", name: "holdoutlabs (org)", metadata },
    { customerId: "tenant-1", name: "holdoutlabs (org)", metadata },
  ]);
});

test("installation provisioning is a no-op when Autumn is not configured", async () => {
  const svc = new BillingService(config("off", false), undefined, new FakeStore());
  assert.equal(await svc.provisionTenantCustomer("tenant-1", "holdoutlabs (org)", {}), false);
});

/* --------------------------------------------- customer bootstrap (FINDING 1) --- */

test("a first-time customer is bootstrapped (ensureCustomer) before any check", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 10 });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });

  await service("on", autumn, store).gateDispatch(1);

  assert.ok(autumn.ensured.includes("t"), "customer ensured before the gate check");
  assert.ok(autumn.checks.length > 0);
});

test("customer bootstrap runs at most once per process per customer (memoized)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 10 });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });
  const svc = service("on", autumn, store);

  await svc.gateDispatch(1);
  await svc.gateDispatch(1);

  assert.equal(autumn.ensured.filter((id) => id === "t").length, 1, "ensured once despite two gates");
});

test("ensureCustomer failure fails the gate OPEN (treated exactly like an Autumn outage)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 0, failEnsure: true });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });

  await assert.doesNotReject(service("on", autumn, store).gateDispatch(1), "bootstrap failure must not block the review");
  assert.equal(autumn.checks.length, 0, "no check attempted once bootstrap failed");
});

test("ensureCustomer failure leaves settlement rows pending (no charge)", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000, failEnsure: true });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  await service("on", autumn, store).settleReviewOutcome("run-1", "completed");

  assert.equal(autumn.tracks.length, 0, "nothing charged when bootstrap fails");
  assert.notEqual(store.usage[0]!.billing_status, "billed");
  assert.notEqual(store.runBillings.get("run-1")?.infra_billing_status, "billed");
});

/* --------------------------------------------- config-error logging (FINDING 4) --- */

test("a non-retryable Autumn 4xx logs billing_config_error at error level and still fails open", async () => {
  const autumn = new FakeAutumn({ configErrorCheck: true });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });

  const errors = captureErrors();
  try {
    // Config bug never blocks reviews (advisory gate; fail open) — must not throw.
    await assert.doesNotReject(service("on", autumn, store).gateDispatch(1));
  } finally {
    errors.restore();
  }

  const configError = errors.entries.find((e) => e[0] === "billing_config_error");
  assert.ok(configError, "emitted a distinct error-level config log");
  const fields = configError![1] as Record<string, unknown>;
  assert.equal(fields.status, 400);
  assert.equal(fields.endpoint, "/balances.check");
  assert.equal(fields.tenant_id, "t");
});

test("a retryable Autumn outage does NOT emit billing_config_error (info/warn path only)", async () => {
  const autumn = new FakeAutumn({ failCheck: true });
  const store = new FakeStore();
  store.dispatchContexts.set(1, { tenantId: "t", keySource: "managed" });

  const errors = captureErrors();
  try {
    await service("on", autumn, store).gateDispatch(1);
  } finally {
    errors.restore();
  }

  assert.ok(!errors.entries.some((e) => e[0] === "billing_config_error"), "outages are not config errors");
});

/* --------------------------------------- blocked-run settlement waives (FINDING 5) --- */

test("settlement of a blocked_insufficient_credits run waives every charge (bot_status 'blocked')", async () => {
  const autumn = new FakeAutumn({ creditsBalance: 1000 });
  const store = new FakeStore();
  store.seedRun("run-1", { rateMode: "included" });
  store.seedUsage({ id: "u1", reviewRunId: "run-1", cost: "0.50" });

  // botStatusFor('blocked_insufficient_credits') === 'blocked' — not 'completed', so settlement waives.
  await service("on", autumn, store).settleReviewOutcome("run-1", "blocked");

  assert.equal(autumn.tracks.length, 0);
  assert.equal(store.usage[0]!.billing_status, "waived");
  assert.equal(store.runBillings.get("run-1")?.infra_billing_status, "waived");
});
