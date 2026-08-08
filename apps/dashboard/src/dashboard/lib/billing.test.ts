import assert from "node:assert/strict";
import { test } from "node:test";

import {
  creditsToUsd,
  formatCredits,
  formatUsd,
  loadBilling,
  normalizeBilling,
  normalizeLimits,
  numberOrNull,
  planName,
  topupCreditsForUsd,
  MIN_TOPUP_USD,
  MAX_TOPUP_USD,
  NOT_CONFIGURED,
  UNAVAILABLE,
} from "./billing";

// The default sub-objects an "ok" payload with no members/cycle/limits/activity resolves to.
const EMPTY_EXTRAS = {
  members: { total: null, with_harness: null },
  cycle: { granted: null, remaining: null, used: null, next_reset_at: null },
  limits: { enabled: false, limit_credits: null },
  billing_activity: [],
};

test("normalizeBilling treats missing/malformed payloads as not configured", () => {
  assert.deepEqual(normalizeBilling(null), NOT_CONFIGURED);
  assert.deepEqual(normalizeBilling(undefined), NOT_CONFIGURED);
  assert.deepEqual(normalizeBilling("nope"), NOT_CONFIGURED);
  assert.deepEqual(normalizeBilling([]), NOT_CONFIGURED);
  assert.deepEqual(normalizeBilling({ status: "not_configured" }), NOT_CONFIGURED);
  // Unknown status values fall back to not configured.
  assert.deepEqual(normalizeBilling({ status: "weird" }), NOT_CONFIGURED);
});

test("normalizeBilling maps an unavailable status to the temporarily-unavailable state", () => {
  assert.deepEqual(normalizeBilling({ status: "unavailable" }), UNAVAILABLE);
  // Balance/plan fields are ignored while unavailable.
  assert.deepEqual(
    normalizeBilling({ status: "unavailable", plan_id: "startup", credits_balance: 12500, managed_ai_access: true }),
    UNAVAILABLE,
  );
});

test("normalizeBilling passes through an ok payload and defaults odd fields", () => {
  assert.deepEqual(
    normalizeBilling({
      status: "ok",
      plan_id: "startup",
      credits_balance: 12500,
      managed_ai_access: true,
    }),
    { status: "ok", plan_id: "startup", credits_balance: 12500, managed_ai_access: true, ...EMPTY_EXTRAS },
  );
  assert.deepEqual(
    normalizeBilling({ status: "ok", plan_id: null, credits_balance: "x", managed_ai_access: null }),
    { status: "ok", plan_id: null, credits_balance: null, managed_ai_access: null, ...EMPTY_EXTRAS },
  );
});

test("normalizeBilling parses the members/cycle/limits/activity sub-objects", () => {
  const parsed = normalizeBilling({
    status: "ok",
    plan_id: "growth",
    credits_balance: 5000,
    managed_ai_access: true,
    members: { total: 8, with_harness: 3 },
    cycle: { granted: 50000, remaining: 42000, used: 8000, next_reset_at: "2026-08-01T00:00:00Z" },
    limits: { enabled: true, limit_credits: 20000 },
    billing_activity: [
      { date: "2026-07-01", amount: 500, status: "paid", url: "https://stripe.example/i/1" },
      { date: "2026-06-01", amount: 500, status: "paid" }, // url absent -> null
      "junk", // dropped
    ],
  });
  assert.deepEqual(parsed.members, { total: 8, with_harness: 3 });
  assert.deepEqual(parsed.cycle, { granted: 50000, remaining: 42000, used: 8000, next_reset_at: "2026-08-01T00:00:00Z" });
  assert.deepEqual(parsed.limits, { enabled: true, limit_credits: 20000 });
  assert.deepEqual(parsed.billing_activity, [
    { date: "2026-07-01", amount: 500, status: "paid", url: "https://stripe.example/i/1" },
    { date: "2026-06-01", amount: 500, status: "paid", url: null },
  ]);
});

test("normalizeBilling defaults malformed sub-objects rather than blanking the page", () => {
  const parsed = normalizeBilling({
    status: "ok",
    plan_id: "startup",
    credits_balance: 1000,
    managed_ai_access: false,
    members: "nope",
    cycle: null,
    limits: 42,
    billing_activity: { not: "an array" },
  });
  assert.deepEqual(parsed.members, { total: null, with_harness: null });
  assert.deepEqual(parsed.cycle, { granted: null, remaining: null, used: null, next_reset_at: null });
  assert.deepEqual(parsed.limits, { enabled: false, limit_credits: null });
  assert.deepEqual(parsed.billing_activity, []);
});

test("normalizeLimits coerces enabled/limit_credits and rejects junk", () => {
  assert.deepEqual(normalizeLimits({ enabled: true, limit_credits: 5000 }), { enabled: true, limit_credits: 5000 });
  assert.deepEqual(normalizeLimits({ enabled: "yes", limit_credits: "x" }), { enabled: false, limit_credits: null });
  assert.deepEqual(normalizeLimits(null), { enabled: false, limit_credits: null });
  assert.deepEqual(normalizeLimits({ enabled: true, limit_credits: null }), { enabled: true, limit_credits: null });
});

test("planName maps known ids and falls back to the raw id / null", () => {
  assert.equal(planName("startup"), "Startup");
  assert.equal(planName("growth"), "Growth");
  assert.equal(planName("enterprise"), "enterprise");
  assert.equal(planName(null), null);
});

test("numberOrNull keeps finite numbers and rejects everything else", () => {
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull(12500), 12500);
  assert.equal(numberOrNull(Number.NaN), null);
  assert.equal(numberOrNull(Infinity), null);
  assert.equal(numberOrNull("5"), null);
  assert.equal(numberOrNull(null), null);
});

test("loadBilling maps a network/fetch error to temporarily-unavailable", async () => {
  const result = await loadBilling(() => Promise.reject(new Error("network down")));
  assert.deepEqual(result, UNAVAILABLE);
});

test("loadBilling maps a non-OK HTTP response to temporarily-unavailable", async () => {
  for (const status of [500, 502, 503, 401, 403]) {
    const result = await loadBilling(() => Promise.resolve(new Response(null, { status })));
    assert.deepEqual(result, UNAVAILABLE, `status ${status} should be unavailable`);
  }
});

test("loadBilling maps an OK response with a malformed body to temporarily-unavailable", async () => {
  const result = await loadBilling(() => Promise.resolve(new Response("not json", { status: 200 })));
  assert.deepEqual(result, UNAVAILABLE);
});

test("loadBilling routes a well-formed 200 payload through normalizeBilling", async () => {
  const ok = await loadBilling(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: "ok", plan_id: "startup", credits_balance: 12500, managed_ai_access: true }), {
        status: 200,
      }),
    ),
  );
  assert.deepEqual(ok, {
    status: "ok",
    plan_id: "startup",
    credits_balance: 12500,
    managed_ai_access: true,
    ...EMPTY_EXTRAS,
  });

  // A 200 body of status:"not_configured" is the deliberate unconfigured signal.
  const notConfigured = await loadBilling(() =>
    Promise.resolve(new Response(JSON.stringify({ status: "not_configured" }), { status: 200 })),
  );
  assert.deepEqual(notConfigured, NOT_CONFIGURED);

  // A 200 body of status:"unavailable" stays unavailable.
  const unavailable = await loadBilling(() =>
    Promise.resolve(new Response(JSON.stringify({ status: "unavailable" }), { status: 200 })),
  );
  assert.deepEqual(unavailable, UNAVAILABLE);
});

test("formatCredits adds thousands separators and handles null", () => {
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits(1500), "1,500");
  assert.equal(formatCredits(1234567), "1,234,567");
  assert.equal(formatCredits(null), "—");
});

test("creditsToUsd converts at 100 credits per dollar", () => {
  assert.equal(creditsToUsd(12500), "$125.00");
  assert.equal(creditsToUsd(150), "$1.50");
  assert.equal(creditsToUsd(0), "$0.00");
  assert.equal(creditsToUsd(null), "—");
});

test("topupCreditsForUsd converts dollars to credits and clamps to the allowed range", () => {
  assert.equal(topupCreditsForUsd(100), 10_000);
  assert.equal(topupCreditsForUsd(25), 2_500);
  // Below the floor / above the ceiling clamp to the bounds (then convert at 100 credits/$).
  assert.equal(topupCreditsForUsd(1), MIN_TOPUP_USD * 100);
  assert.equal(topupCreditsForUsd(50_000), MAX_TOPUP_USD * 100);
});

test("topupCreditsForUsd returns null for a non-usable amount (keeps the button disabled)", () => {
  assert.equal(topupCreditsForUsd(0), null);
  assert.equal(topupCreditsForUsd(-5), null);
  assert.equal(topupCreditsForUsd(Number.NaN), null);
});

test("formatUsd formats a raw dollar amount and handles null", () => {
  assert.equal(formatUsd(100), "$100.00");
  assert.equal(formatUsd(4.5), "$4.50");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(null), "—");
  assert.equal(formatUsd(Number.NaN), "—");
});
