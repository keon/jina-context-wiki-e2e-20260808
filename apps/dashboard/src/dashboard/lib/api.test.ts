import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeCreatedJinaOrganization,
  normalizeJinaOrganization,
  reviewRunPath,
  reviewRunsPath,
} from "./api";

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

test("review paths retain the legacy endpoint only for auth-disabled compatibility", () => {
  assert.equal(reviewRunsPath(null), "/dashboard/review-runs");
  assert.equal(reviewRunPath("run-id", null), "/dashboard/review-runs/run-id");
});

test("created Jina organizations use the authoritative tenant response", () => {
  assert.deepEqual(
    normalizeCreatedJinaOrganization({
      tenant_id: "tenant-1",
      login: "Acme Research",
      type: "Organization",
      role: "admin",
    }),
    {
      tenant_id: "tenant-1",
      login: "Acme Research",
      type: "Organization",
      role: "admin",
    },
  );
});

test("created Jina organizations reject malformed responses", () => {
  assert.throws(() => normalizeCreatedJinaOrganization({ login: "Acme Research" }), /Invalid tenant entry/);
});

test("updated Jina organizations use the same authoritative tenant shape", () => {
  assert.deepEqual(
    normalizeJinaOrganization({
      tenant_id: "tenant-1",
      login: "Acme Labs",
      type: "Organization",
      role: "admin",
    }),
    {
      tenant_id: "tenant-1",
      login: "Acme Labs",
      type: "Organization",
      role: "admin",
    },
  );
});
