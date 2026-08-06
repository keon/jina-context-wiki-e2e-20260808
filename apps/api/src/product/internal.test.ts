import assert from "node:assert/strict";
import { test } from "node:test";

import type { Context } from "hono";

import type { AppConfig } from "./config.js";
import {
  acceptBackfill,
  botStatusFor,
  keySourceDrifted,
  parseUsageRequestBody,
  resolveIntegrations,
  runPrepareBillingGate,
  settleIfTerminalRun,
  type InstallationBackfillStore,
  type InstallationCustomerProvisioner,
  type PrepareGateStore,
} from "./internal.js";
import { isTerminalReviewRunStatus } from "./store.js";

/* --------------------------------------------- resolveIntegrations native pricing --- */

// Minimal Context stand-in: authorizeInternal only reads the Authorization header, readJson only
// c.req.json(), and the handler only c.json(); capture what the handler emits.
function internalContext(body: unknown, token = "internal-token"): { c: Context; captured: () => unknown } {
  let captured: unknown;
  const c = {
    req: {
      header: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
      json: async () => body,
    },
    json: (obj: unknown) => {
      captured = obj;
      return obj as Response;
    },
  };
  return { c: c as unknown as Context, captured: () => captured };
}

const internalConfig = { internalApiToken: "internal-token" } as unknown as AppConfig;

/* --------------------------------------- installation customer provisioning --- */

test("acceptBackfill provisions Autumn from the Jina tenant identity before any PR", async () => {
  const ctx = internalContext({
    trigger_run_id: "trigger-run-1",
    payload: {
      source_event: "installation",
      action: "created",
      github_installation_id: 147254889,
      account: {
        github_account_id: 234299496,
        login: "holdoutlabs",
        type: "Organization",
      },
      sender: { github_user_id: 7399456, login: "lowhung" },
      repositories: [{ id: 1, name: "api", full_name: "holdoutlabs/api" }],
    },
  });
  const recorded: Parameters<InstallationBackfillStore["recordInstallation"]>[0][] = [];
  const store: InstallationBackfillStore = {
    async recordInstallation(input) {
      recorded.push(input);
      return "tenant-1";
    },
    async getTenantBillingIdentity() {
      return { name: "Acme workspace", kind: "team" };
    },
  };
  const provisioned: Parameters<InstallationCustomerProvisioner["provisionTenantCustomer"]>[] = [];
  const billing: InstallationCustomerProvisioner = {
    async provisionTenantCustomer(...input) {
      provisioned.push(input);
      return true;
    },
  };

  await acceptBackfill(ctx.c, internalConfig, billing, store);

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]?.account, { id: 234299496, login: "holdoutlabs", type: "Organization" });
  assert.equal(recorded[0]?.lifecycle, "active");
  assert.deepEqual(recorded[0]?.removedRepositories, []);
  assert.deepEqual(provisioned, [[
    "tenant-1",
    "Acme workspace (team)",
    {
      jina_tenant_id: "tenant-1",
      jina_tenant_name: "Acme workspace",
      jina_tenant_kind: "team",
    },
  ]]);
  assert.deepEqual(ctx.captured(), { ok: true, customer_provisioned: true });
});

test("acceptBackfill persists suspension/deletion without provisioning billing", async () => {
  for (const [action, lifecycle] of [["suspended", "suspended"], ["deleted", "deleted"]] as const) {
    const ctx = internalContext({
      payload: {
        source_event: "installation",
        action,
        github_installation_id: 147254889,
        account: { github_account_id: 234299496, login: "holdoutlabs", type: "Organization" },
        sender: { github_user_id: 7399456, login: "lowhung" },
      },
    });
    let recordedLifecycle: string | undefined;
    let billingLookups = 0;
    const store: InstallationBackfillStore = {
      async recordInstallation(input) {
        recordedLifecycle = input.lifecycle;
        return "tenant-1";
      },
      async getTenantBillingIdentity() {
        billingLookups += 1;
        return { name: "Acme workspace", kind: "team" };
      },
    };
    await acceptBackfill(ctx.c, internalConfig, undefined, store);
    assert.equal(recordedLifecycle, lifecycle);
    assert.equal(billingLookups, 0);
  }
});

test("acceptBackfill propagates an Autumn failure after persisting so the Board retries", async () => {
  const ctx = internalContext({
    payload: {
      github_installation_id: 147254889,
      account: { github_account_id: 234299496, login: "holdoutlabs", type: "Organization" },
      sender: { github_user_id: 7399456, login: "lowhung" },
    },
  });
  let recorded = 0;
  const store: InstallationBackfillStore = {
    async recordInstallation() {
      recorded += 1;
      return "tenant-1";
    },
    async getTenantBillingIdentity() {
      return { name: "Acme workspace", kind: "team" };
    },
  };
  const billing: InstallationCustomerProvisioner = {
    async provisionTenantCustomer() {
      throw new Error("Autumn unavailable");
    },
  };

  await assert.rejects(acceptBackfill(ctx.c, internalConfig, billing, store), /Autumn unavailable/);
  assert.equal(recorded, 1, "the idempotent database backfill completes before the retryable Autumn call");
});

test("acceptBackfill rejects an organization payload without its required webhook sender", async () => {
  const ctx = internalContext({
    payload: {
      github_installation_id: 147254889,
      account: { github_account_id: 234299496, login: "holdoutlabs", type: "Organization" },
    },
  });
  let recorded = false;
  const store: InstallationBackfillStore = {
    async recordInstallation() {
      recorded = true;
      return "tenant-1";
    },
    async getTenantBillingIdentity() {
      return { name: "Acme workspace", kind: "team" };
    },
  };

  await assert.rejects(
    acceptBackfill(ctx.c, internalConfig, undefined, store),
    /requires the GitHub webhook sender/,
  );
  assert.equal(recorded, false, "malformed payloads are rejected before creating an inaccessible tenant");
});

test("resolveIntegrations returns openai_model_pricing for a managed run (no harness/openrouter key)", async () => {
  const pricing = {
    "openai/gpt-5.5": { input_per_token: "0.0000004", output_per_token: "0.0000016", cached_per_token: "0.0000001" },
  };
  // A bound review_run_id with no DB configured -> empty resolved keys -> managed run, so the injected
  // pricing loader is consulted and its map is echoed back to the worker.
  const databaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const ctx = internalContext({ review_run_id: "run-1" });
    await resolveIntegrations(ctx.c, internalConfig, async () => pricing);
    const body = ctx.captured() as Record<string, unknown>;
    assert.deepEqual(body.openai_model_pricing, pricing);
    assert.equal(body.openrouter_api_key, null);
    assert.equal(body.codex_harness_auth, null);
    assert.equal(body.codex_harness_connected_at_ms, null);
  } finally {
    if (databaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = databaseUrl;
    }
  }
});

test("resolveIntegrations 400s when review_run_id is absent (no un-preferenced fallback)", async () => {
  // The removed installation/account fallback ignored the tenant provider preference, so a tenant set
  // to 'managed'/'openai' could leak its OpenRouter key as a "user" run. Resolution now requires the run.
  const ctx = internalContext({ github_installation_id: 123 });
  await assert.rejects(
    resolveIntegrations(ctx.c, internalConfig, async () => ({})),
    /review_run_id is required/,
  );
});

test("resolveIntegrations 401s on a bad internal token before any resolution", async () => {
  const ctx = internalContext({}, "wrong-token");
  await assert.rejects(resolveIntegrations(ctx.c, internalConfig, async () => ({})), /invalid internal token/);
});

/* --------------------------------------------- usage record is_byok contract --- */

function usageBody(record: Record<string, unknown>): unknown {
  return { stage: "runtime", sandbox_id: "sbx-1", key_source: "managed", usage_records: [{ operation: "agent", request_seq: 0, raw_usage: {}, ...record }] };
}

test("parseUsageRequestBody accepts is_byok true/false and defaults it to false when absent", () => {
  assert.equal(parseUsageRequestBody(usageBody({ is_byok: true })).usage_records[0].is_byok, true);
  assert.equal(parseUsageRequestBody(usageBody({ is_byok: false })).usage_records[0].is_byok, false);
  // Absent -> defaults to false (non-BYOK), never undefined, so the billing basis is unambiguous.
  assert.equal(parseUsageRequestBody(usageBody({})).usage_records[0].is_byok, false);
});

test("parseUsageRequestBody rejects a non-boolean is_byok (contract violation, not silent coercion)", () => {
  assert.throws(() => parseUsageRequestBody(usageBody({ is_byok: "true" })), /is_byok must be a boolean/);
  assert.throws(() => parseUsageRequestBody(usageBody({ is_byok: 1 })), /is_byok must be a boolean/);
});

// FINDING 5: a prepare-time 402 completes the run as 'blocked_insufficient_credits'. It must be
// terminal (so it never orbits as 'queued') and carry a 'blocked' bot_status that is not 'completed'
// (so settlement waives it — the run is never billed).
test("blocked_insufficient_credits is terminal and maps to a non-billing 'blocked' bot status", () => {
  assert.equal(botStatusFor("blocked_insufficient_credits"), "blocked");
  assert.equal(isTerminalReviewRunStatus("blocked_insufficient_credits"), true);
});

test("botStatusFor treats superseded and cancelled statuses as terminal", () => {
  assert.equal(botStatusFor("completed_superseded"), "completed_superseded");
  assert.equal(botStatusFor("superseded"), "superseded");
  assert.equal(botStatusFor("cancelled"), "cancelled");
  assert.equal(botStatusFor("canceled"), "canceled");
});

test("botStatusFor preserves existing running and failed behavior", () => {
  assert.equal(botStatusFor("summary_review_started"), "running");
  assert.equal(botStatusFor("failed"), "failed");
  assert.equal(botStatusFor("static_review_failed"), "failed");
});

test("botStatusFor keeps best-effort progress comment failures non-fatal", () => {
  assert.equal(botStatusFor("github_review_progress_comment_update_failed"), "running");
});

test("botStatusFor keeps best-effort publish failures non-fatal", () => {
  assert.equal(botStatusFor("github_runtime_review_publish_failed"), "running");
  assert.equal(botStatusFor("github_static_review_publish_failed"), "running");
});

/* ------------------------------------------------ arrival settlement (FINDING 2) --- */

// FINDING 2: fallback usage on an already-terminal run must settle on arrival with the SAME core the
// /usage route uses — settleIfTerminalRun. It settles iff the run's stored status is terminal.
interface SettleCall { reviewRunId: string; botStatus: string }

function fakeBilling(onSettle?: () => void): {
  calls: SettleCall[];
  settleReviewOutcome(reviewRunId: string, botStatus: string): Promise<void>;
} {
  const calls: SettleCall[] = [];
  return {
    calls,
    async settleReviewOutcome(reviewRunId: string, botStatus: string): Promise<void> {
      calls.push({ reviewRunId, botStatus });
      onSettle?.();
    },
  };
}

test("settleIfTerminalRun settles a terminal run (replay/late-arrival branch)", async () => {
  const billing = fakeBilling();
  await settleIfTerminalRun("run-1", "completed", billing);
  assert.deepEqual(billing.calls, [{ reviewRunId: "run-1", botStatus: "completed" }]);
});

test("settleIfTerminalRun settles non-completed terminal outcomes too (they waive)", async () => {
  const billing = fakeBilling();
  await settleIfTerminalRun("run-1", "superseded", billing);
  assert.deepEqual(billing.calls, [{ reviewRunId: "run-1", botStatus: "superseded" }]);
});

test("settleIfTerminalRun does NOT settle a non-terminal or unknown status (updated/in-flight branch)", async () => {
  const billing = fakeBilling();
  await settleIfTerminalRun("run-1", "runtime_review_started", billing);
  await settleIfTerminalRun("run-1", undefined, billing);
  assert.equal(billing.calls.length, 0);
});

/* -------------------------------------------- key-source drift (FINDING 4) --- */

// FINDING 4: the run-level key_source (pinned at prepare) can drift from the key actually posted at
// stage time. keySourceDrifted flags a present pin that disagrees with runtime truth.
test("keySourceDrifted flags a pinned value that disagrees with the posted value", () => {
  assert.equal(keySourceDrifted("user", "managed"), true);
  assert.equal(keySourceDrifted("managed", "user"), true);
});

test("keySourceDrifted is false when the pin agrees or was never set", () => {
  assert.equal(keySourceDrifted("managed", "managed"), false);
  assert.equal(keySourceDrifted("user", "user"), false);
  assert.equal(keySourceDrifted(null, "managed"), false);
});

/* -------------------------------------- blocked-run reopen at prepare (FINDING 4) --- */

// FINDING 4: a rerun of the same PR head reuses the blocked run's idempotency key, so createReviewRun
// returns the SAME (dead) 'blocked_insufficient_credits' row. runPrepareBillingGate reopens it, then
// runs the prepare gate: if credits are now available it passes; if still exhausted it re-completes as
// blocked (idempotent). These exercise the real production seam prepareReview delegates to.

interface BlockFinalize { status: string; botStatus: string; reason: unknown }

function fakePrepareGateStore(reopen: boolean): {
  store: PrepareGateStore;
  reopenCalls: string[];
  completes: BlockFinalize[];
  events: { status: string }[];
} {
  const reopenCalls: string[] = [];
  const completes: BlockFinalize[] = [];
  const events: { status: string }[] = [];
  const store: PrepareGateStore = {
    async reopenBlockedReviewRun(id: string): Promise<boolean> {
      reopenCalls.push(id);
      return reopen;
    },
    async completeReviewRun(_id, status, botStatus, _result, error): Promise<boolean> {
      completes.push({ status, botStatus, reason: error });
      return true;
    },
    async recordReviewEvent(_id, status): Promise<void> {
      events.push({ status });
    },
  };
  return { store, reopenCalls, completes, events };
}

test("runPrepareBillingGate reopens a blocked run then PASSES when credits are available (FINDING 4)", async () => {
  const { store, reopenCalls, completes } = fakePrepareGateStore(true);
  const billing = { async prepareRunBilling() { return { blocked: false as const }; } };

  const gate = await runPrepareBillingGate("run-1", "trg-1", billing, store);

  assert.deepEqual(gate, { blocked: false });
  assert.deepEqual(reopenCalls, ["run-1"], "reopen attempted before the gate");
  assert.equal(completes.length, 0, "a passing gate never finalizes the run as blocked");
});

test("runPrepareBillingGate reopens a blocked run then RE-BLOCKS when still exhausted (FINDING 4)", async () => {
  const { store, reopenCalls, completes, events } = fakePrepareGateStore(true);
  const billing = { async prepareRunBilling() { return { blocked: true as const, reason: "insufficient_credits" }; } };

  const gate = await runPrepareBillingGate("run-1", "trg-1", billing, store);

  assert.deepEqual(gate, { blocked: true, reason: "insufficient_credits" });
  assert.deepEqual(reopenCalls, ["run-1"]);
  assert.deepEqual(completes, [
    { status: "blocked_insufficient_credits", botStatus: "blocked", reason: "insufficient_credits" },
  ]);
  assert.deepEqual(events, [{ status: "billing_blocked" }]);
});

test("runPrepareBillingGate passes a fresh (non-reopened) run without finalizing it (FINDING 4)", async () => {
  const { store, reopenCalls, completes } = fakePrepareGateStore(false);
  const billing = { async prepareRunBilling() { return { blocked: false as const }; } };

  const gate = await runPrepareBillingGate("run-1", undefined, billing, store);

  assert.deepEqual(gate, { blocked: false });
  assert.deepEqual(reopenCalls, ["run-1"], "reopen is attempted (returns false for a non-blocked run)");
  assert.equal(completes.length, 0);
});

test("runPrepareBillingGate swallows a block-finalize failure and still reports blocked (FINDING 4)", async () => {
  const reopenCalls: string[] = [];
  const store: PrepareGateStore = {
    async reopenBlockedReviewRun(id: string): Promise<boolean> {
      reopenCalls.push(id);
      return false;
    },
    async completeReviewRun(): Promise<boolean> {
      throw new Error("db down");
    },
    async recordReviewEvent(): Promise<void> {
      // unreached — completeReviewRun throws first
    },
  };
  const billing = { async prepareRunBilling() { return { blocked: true as const, reason: "insufficient_credits" }; } };

  // A finalize failure must NOT turn the 402 into a 500 — the gate still returns blocked.
  const gate = await runPrepareBillingGate("run-1", undefined, billing, store);
  assert.deepEqual(gate, { blocked: true, reason: "insufficient_credits" });
});
