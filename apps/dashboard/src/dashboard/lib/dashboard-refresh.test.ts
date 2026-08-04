import assert from "node:assert/strict";
import { test } from "node:test";

import {
  shouldDiscardDashboardData,
  shouldShowDashboardLoading,
} from "./dashboard-refresh";

test("only foreground dashboard reloads expose loading state", () => {
  assert.equal(shouldShowDashboardLoading({}), true);
  assert.equal(shouldShowDashboardLoading({ background: false }), true);
  assert.equal(shouldShowDashboardLoading({ background: true }), false);
});

test("only authorization failures discard the last successful dashboard response", () => {
  assert.equal(shouldDiscardDashboardData(401), true);
  assert.equal(shouldDiscardDashboardData(403), true);
  assert.equal(shouldDiscardDashboardData(408), false);
  assert.equal(shouldDiscardDashboardData(500), false);
  assert.equal(shouldDiscardDashboardData(503), false);
});
