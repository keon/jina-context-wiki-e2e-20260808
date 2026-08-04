import assert from "node:assert/strict";
import { test } from "node:test";
import { isProductApiRoute } from "./product-api-router.js";

test("routes product, review, billing, auth, and GitHub endpoints to the absorbed API", () => {
  for (const path of [
    "/v1/healthz",
    "/v1/dashboard/me",
    "/v1/dashboard/tenants/tenant-1/review-runs",
    "/auth/github/callback",
    "/webhooks/github",
    "/internal/reviews/prepare",
    "/internal/reviews/run-1/complete",
    "/internal/graph/availability",
    "/internal/context/mcp-access",
    "/internal/installations/backfill",
    "/internal/scheduled-review-scan",
    "/internal/integrations/resolve",
    "/internal/context/execution-profile",
    "/internal/billing/retry"
  ]) {
    assert.equal(isProductApiRoute(path), true, path);
  }
});

test("keeps Context, causal graph, MCP, worker, and V2 health routes on V2", () => {
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
