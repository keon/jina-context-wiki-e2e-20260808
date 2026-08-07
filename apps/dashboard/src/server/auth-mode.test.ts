import assert from "node:assert/strict";
import test from "node:test";
import { dashboardAllowsLegacySession, dashboardProxyUsesClerk } from "./auth-mode";

test("GitHub-auth dashboard requests never enter Clerk middleware", () => {
  assert.equal(dashboardProxyUsesClerk("github"), false);
  assert.equal(dashboardProxyUsesClerk("clerk"), true);
  assert.equal(dashboardProxyUsesClerk(undefined), true);
});

test("hybrid auth mounts Clerk while retaining only the legacy session fallback", () => {
  assert.equal(dashboardProxyUsesClerk("hybrid"), true);
  assert.equal(dashboardAllowsLegacySession("hybrid"), true);
  assert.equal(dashboardAllowsLegacySession("github"), true);
  assert.equal(dashboardAllowsLegacySession("clerk"), false);
  assert.equal(dashboardAllowsLegacySession(undefined), false);
});
