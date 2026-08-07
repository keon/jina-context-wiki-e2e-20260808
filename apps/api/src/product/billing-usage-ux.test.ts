import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAutoReloadBody,
  parseAutoReviewLimitBody,
  parseSubscribePlanId,
  parseUsageDays,
} from "./app.js";
import { autoReviewLimitReached, isAutoReviewTrigger, usedCreditsFromCheck } from "./billing.js";
import { platformModelDefaults, pricePerMillion } from "./model-settings.js";
import { PLATFORM_BILLING_POLICY, shapeTenantUsage, type BillingPolicy } from "./store.js";

/* ----------------------------------------------- platform model defaults --- */

test("platformModelDefaults falls back to trigger-utils defaults when env is unset", () => {
  assert.deepEqual(platformModelDefaults({}), {
    planner: "openai/gpt-5.6-sol",
    investigation: "openai/gpt-5.6-luna",
    review: "openai/gpt-5.6-luna",
    context: "openai/gpt-5.6-terra",
    mentalTrace: "openai/gpt-5.6-luna",
  });
});

test("platformModelDefaults reads env overrides (planner<-PLANNER, investigation<-AGENT, review<-CODEX)", () => {
  const env = {
    RUNTIME_PLANNER_MODEL: "openai/gpt-6",
    RUNTIME_AGENT_MODEL: "anthropic/claude",
    RUNTIME_MENTAL_TRACE_MODEL: "openai/gpt-6-nano",
    REVIEW_CODEX_MODEL: "  openai/gpt-6-mini  ",
  } as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(platformModelDefaults(env), {
    planner: "openai/gpt-6",
    investigation: "anthropic/claude",
    review: "openai/gpt-6-mini",
    context: "openai/gpt-5.6-terra",
    mentalTrace: "openai/gpt-6-nano",
  });
});

test("platformModelDefaults treats a blank env value as unset (fallback)", () => {
  const env = { RUNTIME_PLANNER_MODEL: "   " } as unknown as NodeJS.ProcessEnv;
  assert.equal(platformModelDefaults(env).planner, "openai/gpt-5.6-sol");
});

/* ----------------------------------------------- catalog per-1M pricing --- */

test("pricePerMillion converts per-token USD strings exactly and is null-safe", () => {
  assert.equal(pricePerMillion("0.0000005"), "0.5");
  assert.equal(pricePerMillion("0.0000032"), "3.2");
  assert.equal(pricePerMillion("0"), "0");
  assert.equal(pricePerMillion(undefined), null);
  assert.equal(pricePerMillion(null), null);
  assert.equal(pricePerMillion(""), null);
  assert.equal(pricePerMillion(42), null); // non-string
  assert.equal(pricePerMillion("-0.0000005"), null); // negative rejected
});

/* ----------------------------------------------- usage aggregation shaper --- */

test("shapeTenantUsage assembles totals (total = infra+ai), daily, and recent rows", () => {
  const summary = shapeTenantUsage(
    30,
    { runs: 5, completed_runs: 4, infra_credits: 400, ai_credits: 1200, byok_runs: 1, harness_runs: 2 },
    "3.50000000",
    [{ date: "2026-07-01", credits: 300, runs: 2 }],
    [
      {
        review_run_id: "run-1",
        repo_full_name: "acme/app",
        pr_number: 7,
        status: "completed",
        key_source: "managed",
        rate_mode: "included",
        infra_credits: 100,
        ai_credits: 200,
        review_count: 3,
        created_at: new Date("2026-07-01T00:00:00.000Z"),
      },
    ],
  );
  assert.equal(summary.period.days, 30);
  assert.equal(summary.totals.total_credits, 1600); // 400 + 1200
  assert.equal(summary.totals.model_cost_usd, "3.50000000");
  assert.equal(summary.totals.byok_runs, 1);
  assert.equal(summary.totals.harness_runs, 2);
  assert.deepEqual(summary.daily, [{ date: "2026-07-01", credits: 300, runs: 2 }]);
  assert.equal(summary.recent_runs[0].repo_full_name, "acme/app");
  assert.equal(summary.recent_runs[0].review_count, 3); // PR-aggregated: 3 runs rolled up
  assert.equal(summary.recent_runs[0].created_at, "2026-07-01T00:00:00.000Z");
});

test("shapeTenantUsage defaults a null model cost to '0' and coerces null credit fields", () => {
  const summary = shapeTenantUsage(
    7,
    { runs: 0, completed_runs: 0, infra_credits: 0, ai_credits: 0, byok_runs: 0, harness_runs: 0 },
    null,
    [],
    [],
  );
  assert.equal(summary.totals.model_cost_usd, "0");
  assert.equal(summary.totals.total_credits, 0);
  assert.deepEqual(summary.recent_runs, []);
});

/* ----------------------------------------------- validators (app.ts) --- */

test("parseUsageDays defaults to 30 and validates the {7,30,90} allowlist", () => {
  assert.equal(parseUsageDays(undefined), 30);
  assert.equal(parseUsageDays(""), 30);
  assert.equal(parseUsageDays("7"), 7);
  assert.equal(parseUsageDays("30"), 30);
  assert.equal(parseUsageDays("90"), 90);
  assert.throws(() => parseUsageDays("45"), /days must be one of/);
  assert.throws(() => parseUsageDays("abc"), /days must be one of/);
});

test("parseSubscribePlanId accepts startup/growth and rejects anything else", () => {
  assert.equal(parseSubscribePlanId({ plan_id: "startup" }), "startup");
  assert.equal(parseSubscribePlanId({ plan_id: "growth" }), "growth");
  assert.throws(() => parseSubscribePlanId({ plan_id: "enterprise" }), /plan_id must be one of/);
  assert.throws(() => parseSubscribePlanId({ plan_id: "" }), /plan_id must be one of/);
  assert.throws(() => parseSubscribePlanId({}), /plan_id must be one of/);
  assert.throws(() => parseSubscribePlanId(null), /plan_id must be one of/);
});

test("parseAutoReviewLimitBody validates enabled + limit_credits", () => {
  assert.deepEqual(parseAutoReviewLimitBody({ enabled: true, limit_credits: 5000 }), { enabled: true, limit_credits: 5000 });
  assert.deepEqual(parseAutoReviewLimitBody({ enabled: false, limit_credits: null }), { enabled: false, limit_credits: null });
  // A disabled cap may carry a retained limit value.
  assert.deepEqual(parseAutoReviewLimitBody({ enabled: false, limit_credits: 100 }), { enabled: false, limit_credits: 100 });
  // enabled requires a non-null limit.
  assert.throws(() => parseAutoReviewLimitBody({ enabled: true, limit_credits: null }), /required when the cap is enabled/);
  assert.throws(() => parseAutoReviewLimitBody({ enabled: true }), /required when the cap is enabled/);
  // enabled must be a boolean; limit must be a non-negative integer.
  assert.throws(() => parseAutoReviewLimitBody({ enabled: "yes", limit_credits: 1 }), /enabled must be a boolean/);
  assert.throws(() => parseAutoReviewLimitBody({ enabled: true, limit_credits: -1 }), /non-negative integer/);
  assert.throws(() => parseAutoReviewLimitBody({ enabled: true, limit_credits: 2.5 }), /non-negative integer/);
});

test("parseAutoReloadBody validates the auto-reload body", () => {
  assert.deepEqual(parseAutoReloadBody({ enabled: true, threshold_credits: 500, reload_credits: 10000 }), {
    enabled: true,
    thresholdCredits: 500,
    reloadCredits: 10000,
  });
  // Disabling with zero amounts is allowed.
  assert.deepEqual(parseAutoReloadBody({ enabled: false, threshold_credits: 0, reload_credits: 0 }), {
    enabled: false,
    thresholdCredits: 0,
    reloadCredits: 0,
  });
  assert.throws(() => parseAutoReloadBody({ enabled: true, threshold_credits: 500, reload_credits: 0 }), /positive when auto-reload is enabled/);
  assert.throws(() => parseAutoReloadBody({ enabled: "no", threshold_credits: 0, reload_credits: 0 }), /enabled must be a boolean/);
  assert.throws(() => parseAutoReloadBody({ enabled: true, threshold_credits: -1, reload_credits: 1 }), /non-negative integer/);
});

/* ----------------------------------------------- auto-review cap pure helpers --- */

test("usedCreditsFromCheck prefers the usage field, else granted - remaining, else null", () => {
  assert.equal(usedCreditsFromCheck({ allowed: true, usage: 5 }), 5);
  assert.equal(usedCreditsFromCheck({ allowed: true, granted: 10, balance: 3 }), 7);
  assert.equal(usedCreditsFromCheck({ allowed: true, granted: 10 }), null); // no remaining
  assert.equal(usedCreditsFromCheck({ allowed: true }), null);
  assert.equal(usedCreditsFromCheck(null), null); // Autumn down
});

test("isAutoReviewTrigger is true for everything except 'manual'", () => {
  assert.equal(isAutoReviewTrigger("manual"), false);
  assert.equal(isAutoReviewTrigger("webhook"), true);
  assert.equal(isAutoReviewTrigger("scheduled"), true);
  assert.equal(isAutoReviewTrigger("policy"), true);
  assert.equal(isAutoReviewTrigger(undefined), true);
});

const capPolicy = (over: Partial<BillingPolicy> = {}): BillingPolicy => ({
  ...PLATFORM_BILLING_POLICY,
  auto_review_limit_enabled: true,
  auto_review_limit_credits: 1000,
  ...over,
});

test("autoReviewLimitReached blocks only an enabled, auto-triggered, over-cap run with a live check", () => {
  const over = { allowed: true, usage: 1000 };
  const under = { allowed: true, usage: 999 };
  // enabled + auto + at/over cap + live check -> blocked
  assert.equal(autoReviewLimitReached(capPolicy(), "webhook", over), true);
  // under cap -> not blocked
  assert.equal(autoReviewLimitReached(capPolicy(), "webhook", under), false);
  // manual bypasses
  assert.equal(autoReviewLimitReached(capPolicy(), "manual", over), false);
  // disabled cap
  assert.equal(autoReviewLimitReached(capPolicy({ auto_review_limit_enabled: false }), "webhook", over), false);
  // no limit set
  assert.equal(autoReviewLimitReached(capPolicy({ auto_review_limit_credits: null }), "webhook", over), false);
  // Autumn down (null check) -> fail open, no block
  assert.equal(autoReviewLimitReached(capPolicy(), "webhook", null), false);
});
