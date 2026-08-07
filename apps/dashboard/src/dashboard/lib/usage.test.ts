import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeMeter,
  DEFAULT_USAGE_PERIOD,
  loadUsage,
  normalizeUsage,
  normalizeUsagePeriod,
  scaleBars,
  usageParams,
  USAGE_PERIODS,
  USAGE_UNAVAILABLE,
} from "./usage";

test("normalizeUsagePeriod clamps to an allowed window, else the default", () => {
  assert.equal(normalizeUsagePeriod(7), 7);
  assert.equal(normalizeUsagePeriod(30), 30);
  assert.equal(normalizeUsagePeriod(90), 90);
  assert.equal(normalizeUsagePeriod("90"), 90);
  assert.equal(normalizeUsagePeriod(45), DEFAULT_USAGE_PERIOD);
  assert.equal(normalizeUsagePeriod("nope"), DEFAULT_USAGE_PERIOD);
  assert.equal(normalizeUsagePeriod(null), DEFAULT_USAGE_PERIOD);
  assert.deepEqual([...USAGE_PERIODS], [7, 30, 90]);
});

test("usageParams builds a normalized ?days= param", () => {
  assert.equal(usageParams(7).toString(), "days=7");
  assert.equal(usageParams(30).toString(), "days=30");
  // An unsupported window is clamped to the default in the query too.
  assert.equal(usageParams(45).toString(), `days=${DEFAULT_USAGE_PERIOD}`);
});

test("normalizeUsage maps malformed bodies to unavailable and accepts raw summaries", () => {
  // Usage always renders (product ruling): the API returns a raw summary with no
  // status field, so a totals object IS the success signal; anything else is a
  // transport-ish failure, never a "not configured" gate.
  assert.deepEqual(normalizeUsage(null), USAGE_UNAVAILABLE);
  assert.deepEqual(normalizeUsage("nope"), USAGE_UNAVAILABLE);
  assert.deepEqual(normalizeUsage([]), USAGE_UNAVAILABLE);
  assert.deepEqual(normalizeUsage({ status: "weird" }), USAGE_UNAVAILABLE);
  assert.deepEqual(normalizeUsage({ status: "unavailable" }), USAGE_UNAVAILABLE);
  const zeros = normalizeUsage({ period: { days: 30 }, totals: {}, daily: [], recent_runs: [] });
  assert.equal(zeros.status, "ok");
});

test("normalizeUsage parses an ok payload and coerces its arrays defensively", () => {
  const usage = normalizeUsage({
    status: "ok",
    period: { days: 90 },
    totals: {
      runs: 42,
      completed_runs: 40,
      infra_credits: 1200,
      ai_credits: 3400,
      total_credits: 4600,
      model_cost_usd: 12.5,
      byok_runs: 5,
      harness_runs: 7,
    },
    daily: [
      { date: "2026-07-01", credits: 100, runs: 3 },
      { date: "2026-07-02", credits: -5, runs: "x" }, // negatives/junk -> 0
      "junk",
    ],
    recent_runs: [
      {
        review_run_id: "run-1",
        repo_full_name: "acme/web",
        pr_number: 12,
        status: "completed",
        key_source: "harness",
        rate_mode: "byok",
        infra_credits: 10,
        ai_credits: 90,
        review_count: 4,
        created_at: "2026-07-01T10:00:00Z",
      },
      null,
    ],
  });
  assert.equal(usage.status, "ok");
  assert.equal(usage.configured, true);
  assert.deepEqual(usage.period, { days: 90 });
  assert.equal(usage.totals.total_credits, 4600);
  assert.equal(usage.totals.model_cost_usd, 12.5);
  assert.deepEqual(usage.daily, [
    { date: "2026-07-01", credits: 100, runs: 3 },
    { date: "2026-07-02", credits: 0, runs: 0 },
  ]);
  assert.equal(usage.recent_runs.length, 1);
  assert.equal(usage.recent_runs[0]!.repo_full_name, "acme/web");
  assert.equal(usage.recent_runs[0]!.pr_number, 12);
  assert.equal(usage.recent_runs[0]!.review_count, 4);
});

test("normalizeUsage clamps an out-of-range period in the payload", () => {
  const usage = normalizeUsage({ status: "ok", period: { days: 365 } });
  assert.equal(usage.period.days, DEFAULT_USAGE_PERIOD);
});

test("loadUsage maps transport failures to unavailable and routes 200 bodies", async () => {
  assert.deepEqual(await loadUsage(() => Promise.reject(new Error("down"))), USAGE_UNAVAILABLE);
  assert.deepEqual(await loadUsage(() => Promise.resolve(new Response(null, { status: 500 }))), USAGE_UNAVAILABLE);
  assert.deepEqual(
    await loadUsage(() => Promise.resolve(new Response("not json", { status: 200 }))),
    USAGE_UNAVAILABLE,
  );
  const ok = await loadUsage(() =>
    Promise.resolve(new Response(JSON.stringify({ period: { days: 7 }, totals: {} }), { status: 200 })),
  );
  assert.equal(ok.status, "ok");
  assert.equal(ok.period.days, 7);
});

test("computeMeter clamps usage, tracks remaining, and flags overshoot", () => {
  const mid = computeMeter({ used: 8000, granted: 50000, extra: 2000 });
  assert.equal(mid.usedPct, 16);
  assert.equal(mid.remaining, 42000);
  assert.equal(mid.extra, 2000);
  assert.equal(mid.hasIncluded, true);
  assert.equal(mid.overShoot, false);

  const over = computeMeter({ used: 12000, granted: 10000, extra: 0 });
  assert.equal(over.usedPct, 100); // clamped
  assert.equal(over.remaining, 0);
  assert.equal(over.overShoot, true);

  const noPlan = computeMeter({ used: 500, granted: null, extra: null });
  assert.equal(noPlan.hasIncluded, false);
  assert.equal(noPlan.usedPct, 0);
  assert.equal(noPlan.granted, 0);
  assert.equal(noPlan.extra, 0);

  // Negative/garbage inputs floor to zero.
  const junk = computeMeter({ used: -10, granted: 0, extra: -5 });
  assert.equal(junk.used, 0);
  assert.equal(junk.usedPct, 0);
  assert.equal(junk.extra, 0);
});

test("scaleBars scales to the series max with a visible floor, zero-safe", () => {
  assert.deepEqual(scaleBars([]), []);
  assert.deepEqual(scaleBars([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(scaleBars([100, 50, 0]), [100, 50, 0]);
  // A tiny non-zero value is floored to at least `floor` so it stays visible.
  const scaled = scaleBars([1000, 1], 4);
  assert.equal(scaled[0], 100);
  assert.equal(scaled[1], 4);
});
