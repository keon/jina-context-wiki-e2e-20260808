import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDashboard, type FindingRecord, type ReviewRunRecord } from "./records.js";

function reviewRun(overrides: Partial<ReviewRunRecord> = {}): ReviewRunRecord {
  return {
    review_run_id: "run-1",
    status: "completed",
    bot: { type: "code_review", status: "completed" },
    repository: { github_repo_id: 1, owner: "acme", name: "web", full_name: "acme/web" },
    pull_request: { number: 7 },
    events: [],
    created_at: "2026-06-22T14:00:00.000Z",
    updated_at: "2026-06-22T14:04:00.000Z",
    ...overrides,
  };
}

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "finding-1",
    review_run_id: "run-1",
    fingerprint: "fp-1",
    severity: "high",
    category: "auth",
    body: "Checkout session can be created before ownership is verified.",
    created_at: "2026-06-22T14:03:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------- cacheability guard --- */
// `/dashboard/**/review-runs` is polled every 10s from every page and is the largest payload on the
// surface. The response body must depend ONLY on the data: a per-request value (a wall-clock
// `generated_at` was one) makes every body unique, so the ETag never matches and the client's
// `setData` re-renders every consumer on every poll.

test("buildDashboard is a pure function of its input: identical input serializes identically", async () => {
  const runs = [reviewRun(), reviewRun({ review_run_id: "run-2", updated_at: "2026-06-22T15:30:00.000Z" })];
  const issues = [finding(), finding({ id: "finding-2", created_at: "2026-06-22T13:00:00.000Z" })];

  const first = buildDashboard(runs, issues, { limit: 50 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = buildDashboard(runs, issues, { limit: 50 });

  assert.deepEqual(first, second);
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    "two calls with identical input must produce byte-identical JSON, otherwise the response can never revalidate to a 304",
  );
});

test("generated_at is the newest activity timestamp across review runs and issues", () => {
  const runs = [
    reviewRun({ review_run_id: "run-1", updated_at: "2026-06-22T14:04:00.000Z" }),
    reviewRun({ review_run_id: "run-2", updated_at: "2026-06-21T09:00:00.000Z" }),
  ];
  assert.equal(buildDashboard(runs, []).generated_at, "2026-06-22T14:04:00.000Z");

  // A finding newer than every run still moves the stamp forward.
  const issues = [finding({ created_at: "2026-06-23T08:15:00.000Z" })];
  assert.equal(buildDashboard(runs, issues).generated_at, "2026-06-23T08:15:00.000Z");
});

test("generated_at is null (never a clock reading) when there are no rows", () => {
  const empty = buildDashboard([], [], { limit: 50 });
  assert.equal(empty.generated_at, null);
  assert.deepEqual(empty, buildDashboard([], [], { limit: 50 }));
});

test("an unparsable timestamp is ignored rather than treated as now", () => {
  const runs = [
    reviewRun({ review_run_id: "run-1", updated_at: "not-a-timestamp" }),
    reviewRun({ review_run_id: "run-2", updated_at: "2026-06-22T14:04:00.000Z" }),
  ];
  assert.equal(buildDashboard(runs, []).generated_at, "2026-06-22T14:04:00.000Z");
  assert.equal(buildDashboard([reviewRun({ updated_at: "not-a-timestamp" })], []).generated_at, null);
});

test("bots are projected from the review runs they summarize", () => {
  const dashboard = buildDashboard([reviewRun({ error: "boom" })], []);
  assert.deepEqual(dashboard.bots, [
    {
      id: "code_review:1",
      type: "code_review",
      repository: "acme/web",
      pull_request: 7,
      status: "completed",
      last_run_at: "2026-06-22T14:04:00.000Z",
      last_error: "boom",
    },
  ]);
});
