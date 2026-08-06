import assert from "node:assert/strict";
import { test } from "node:test";

import { QueryClient } from "@tanstack/react-query";

import {
  DashboardRequestError,
  MAX_POLL_BACKOFF_MS,
  MAX_QUERY_RETRIES,
  createDashboardQueryClient,
  evictTenantScopedQueries,
  nextSnapshot,
  pollBackoffInterval,
  requestStatus,
  shouldRetryDashboardQuery,
} from "./query-client";
import { pollQueryKey, tenantQueryKey, type TenantQueryScope } from "./query-keys";

const SCOPE: TenantQueryScope = { viewerUserId: 7, fenceVersion: 2, tenantId: "org-a" };

function seedTenantCache(client: QueryClient) {
  client.setQueryData(tenantQueryKey("dashboard-review-runs", SCOPE, "", ""), {
    review_runs: [{ review_run_id: "run-1" }],
  });
  client.setQueryData(tenantQueryKey("usage", SCOPE, 30), { status: "ok" });
  client.setQueryData(tenantQueryKey("review-run-detail", SCOPE, "run-1"), { review_run_id: "run-1" });
  client.setQueryData(pollQueryKey("/api/dashboard/tenants/org-a/work-overview"), { board: { tasks: [] } });
}

test("a revoked tenant's payload is removed from the cache, not left readable", async () => {
  const client = new QueryClient();
  seedTenantCache(client);
  const feedKey = tenantQueryKey("dashboard-review-runs", SCOPE, "", "");

  // The naive migration of the 401/403 branches: invalidation only marks the
  // entry stale. Until a refetch resolves — which, having just been refused, it
  // never will — the payload is still served to any observer that mounts.
  await client.invalidateQueries({ queryKey: ["dashboard-review-runs"] });
  assert.notEqual(client.getQueryData(feedKey), undefined);

  // Failing closed means the data is gone, not stale.
  evictTenantScopedQueries(client);
  assert.equal(client.getQueryData(feedKey), undefined);
  assert.equal(client.getQueryData(tenantQueryKey("usage", SCOPE, 30)), undefined);
  assert.equal(client.getQueryData(tenantQueryKey("review-run-detail", SCOPE, "run-1")), undefined);
  assert.equal(client.getQueryData(pollQueryKey("/api/dashboard/tenants/org-a/work-overview")), undefined);
  assert.equal(client.getQueryCache().getAll().length, 0);
});

test("eviction is scoped to tenant data and leaves everything else alone", () => {
  const client = new QueryClient();
  seedTenantCache(client);
  client.setQueryData(["some-unrelated-cache"], { keep: true });

  evictTenantScopedQueries(client);
  assert.deepEqual(client.getQueryData(["some-unrelated-cache"]), { keep: true });
});

test("an authorization answer is never retried", () => {
  for (const status of [401, 403]) {
    assert.equal(shouldRetryDashboardQuery(0, new DashboardRequestError(status)), false);
  }
  // Neither is any other verdict about the request itself.
  assert.equal(shouldRetryDashboardQuery(0, new DashboardRequestError(404)), false);
  assert.equal(shouldRetryDashboardQuery(0, new DashboardRequestError(422)), false);
});

test("transient failures retry a bounded number of times", () => {
  const serverError = new DashboardRequestError(503);
  assert.equal(shouldRetryDashboardQuery(0, serverError), true);
  assert.equal(shouldRetryDashboardQuery(MAX_QUERY_RETRIES - 1, serverError), true);
  assert.equal(shouldRetryDashboardQuery(MAX_QUERY_RETRIES, serverError), false);
  // Rate limiting and timeouts describe a moment, not the request.
  assert.equal(shouldRetryDashboardQuery(0, new DashboardRequestError(429)), true);
  assert.equal(shouldRetryDashboardQuery(0, new DashboardRequestError(408)), true);
  // A transport failure carries no status at all.
  assert.equal(shouldRetryDashboardQuery(0, new TypeError("Failed to fetch")), true);
  assert.equal(requestStatus(new TypeError("Failed to fetch")), null);
  assert.equal(requestStatus(new DashboardRequestError(401)), 401);
});

test("an unchanged payload keeps the cached object rather than an equal one", () => {
  let parses = 0;
  const parse = () => {
    parses += 1;
    return { review_runs: [] };
  };
  const first = nextSnapshot(undefined, '{"review_runs":[]}', parse);
  const second = nextSnapshot(first, '{"review_runs":[]}', parse);
  // Identity, not equality: consumers' memos and the observer's change check both
  // key on it, so an unchanged poll costs no re-render.
  assert.equal(second, first);
  assert.equal(parses, 1);

  const third = nextSnapshot(second, '{"review_runs":[{"review_run_id":"run-1"}]}', parse);
  assert.notEqual(third, second);
  assert.equal(parses, 2);
});

test("consecutive failures back off, capped, and reset on success", () => {
  assert.equal(pollBackoffInterval(2_500, 0), 2_500);
  assert.equal(pollBackoffInterval(2_500, 1), 5_000);
  assert.equal(pollBackoffInterval(2_500, 3), 20_000);
  assert.equal(pollBackoffInterval(2_500, 10), MAX_POLL_BACKOFF_MS);
  // A success resets the counter, which restores the base cadence.
  assert.equal(pollBackoffInterval(10_000, 0), 10_000);
});

test("the shared client refuses focus refetching and applies the retry policy", () => {
  const defaults = createDashboardQueryClient().getDefaultOptions().queries;
  assert.equal(defaults?.refetchOnWindowFocus, false);
  assert.equal(typeof defaults?.staleTime, "number");
  assert.equal(typeof defaults?.retry, "function");
  const retry = defaults?.retry as (failureCount: number, error: unknown) => boolean;
  assert.equal(retry(0, new DashboardRequestError(403)), false);
  assert.equal(retry(0, new DashboardRequestError(500)), true);
});
