import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDashboardApiRequest } from "./proxy-policy.js";

test("dashboard proxy allows contextGraph assertion reads", () => {
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context-graph/assertions", true), true);
});

test("dashboard proxy allows assertion review commands", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context-graph/commands", true), true);
});

test("dashboard proxy still rejects unrelated and mutating requests", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context-graph/assertions", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/internal/secrets", true), false);
});
