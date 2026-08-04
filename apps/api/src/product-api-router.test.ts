import assert from "node:assert/strict";
import { test } from "node:test";
import { isProductApiRoute } from "./product-api-router.js";

test("routes product, review, billing, auth, and GitHub endpoints to the absorbed API", () => {
  for (const path of [
    "/dashboard/me",
    "/dashboard/tenants/tenant-1/review-runs",
    "/auth/github/callback",
    "/webhooks/github",
    "/internal/reviews/prepare",
    "/internal/reviews/run-1/complete",
    "/internal/graph/availability",
    "/internal/context/mcp-access",
    "/internal/installations/backfill",
    "/internal/schedules/billing-retry",
    "/internal/integrations/resolve",
    "/internal/context/execution-profile",
    "/internal/billing/retry"
  ]) {
    assert.equal(isProductApiRoute(path), true, path);
  }
});

test("keeps Context, causal graph, MCP, worker, and Jina health routes on the Context handler", () => {
  for (const path of [
    "/health",
    "/healthz",
    "/context/build",
    "/context/webhooks/github",
    "/causal-graph",
    "/mcp",
    "/internal/context/tokens",
    "/internal/worker/claim"
  ]) {
    assert.equal(isProductApiRoute(path), false, path);
  }
});

test("does not retain the retired dashboard or product health route prefixes", () => {
  assert.equal(isProductApiRoute("/v1/dashboard/me"), false);
  assert.equal(isProductApiRoute("/v1/healthz"), false);
});
