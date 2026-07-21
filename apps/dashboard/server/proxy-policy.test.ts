import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDashboardApiRequest } from "./proxy-policy.js";

test("dashboard proxy allows ontology assertion reads", () => {
  assert.equal(
    isAllowedDashboardApiRequest("GET", "/api/ontology/assertions", true),
    true
  );
});

test("dashboard proxy still rejects unrelated and mutating requests", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/ontology/assertions", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/internal/secrets", true), false);
});
