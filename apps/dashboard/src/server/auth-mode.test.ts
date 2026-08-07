import assert from "node:assert/strict";
import test from "node:test";
import { dashboardProxyUsesClerk } from "./auth-mode";

test("GitHub-auth dashboard requests never enter Clerk middleware", () => {
  assert.equal(dashboardProxyUsesClerk("github"), false);
  assert.equal(dashboardProxyUsesClerk("clerk"), true);
  assert.equal(dashboardProxyUsesClerk(undefined), true);
});
