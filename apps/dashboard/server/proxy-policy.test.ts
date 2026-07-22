import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDashboardApiRequest, retiredDashboardPathRedirectTarget } from "./proxy-policy.js";

test("dashboard proxy allows context graph assertion reads", () => {
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context-graph/assertions", true), true);
});

test("dashboard proxy allows assertion review commands", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context-graph/commands", true), true);
});

test("dashboard proxy still rejects unrelated and mutating requests", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context-graph/assertions", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/internal/secrets", true), false);
});

test("retired ontology paths map to their context-graph replacements", () => {
  assert.equal(retiredDashboardPathRedirectTarget("/ontology"), "/context-graph");
  assert.equal(
    retiredDashboardPathRedirectTarget("/assets/ontology-graph-client.js"),
    "/assets/context-graph-client.js"
  );
  assert.equal(retiredDashboardPathRedirectTarget("/api/ontology"), "/api/context-graph");
  assert.equal(retiredDashboardPathRedirectTarget("/api/ontology/assertions"), "/api/context-graph/assertions");
  assert.equal(retiredDashboardPathRedirectTarget("/context-graph"), undefined);
  assert.equal(retiredDashboardPathRedirectTarget("/api/board"), undefined);
});
