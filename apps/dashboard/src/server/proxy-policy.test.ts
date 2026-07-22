import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDashboardApiRequest } from "./proxy-policy.ts";

test("allows dashboard reads, blocks internal and unknown routes", () => {
  for (const pathname of [
    "/api/board",
    "/api/events",
    "/api/overview",
    "/api/task-types",
    "/api/context-graph",
    "/api/context-graph/assertions"
  ]) {
    assert.equal(isAllowedDashboardApiRequest("GET", pathname, true), true, pathname);
  }
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context-graph/ask", true), true);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context-graph/commands", true), true);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/internal/worker/claim", true), false);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/board", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context-graph/metrics", true), false);
});

test("demo webhook endpoint is local-only", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/dev/webhooks/github", false), true);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/dev/webhooks/github", true), false);
});
