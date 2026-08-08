import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewRunPath, reviewRunsPath } from "./api";

test("review paths use the selected tenant and encode every identifier", () => {
  assert.equal(
    reviewRunsPath("tenant/id"),
    "/dashboard/tenants/tenant%2Fid/review-runs",
  );
  assert.equal(
    reviewRunPath("run/id", "tenant/id"),
    "/dashboard/tenants/tenant%2Fid/review-runs/run%2Fid",
  );
});

test("review paths use the explicit local endpoint when dashboard auth is disabled", () => {
  assert.equal(reviewRunsPath(null), "/dashboard/local/review-runs");
  assert.equal(reviewRunPath("run-id", null), "/dashboard/local/review-runs/run-id");
});
