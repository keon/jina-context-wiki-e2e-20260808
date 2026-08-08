import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSameTenantScope,
  isTenantScopedQueryKey,
  pollQueryKey,
  tenantQueryKey,
  type TenantQueryScope,
} from "./query-keys";

const SCOPE: TenantQueryScope = { viewerUserId: 7, fenceVersion: 2, tenantId: "org-a" };

test("a tenant-scoped key leads with the fence, then the resource's own parameters", () => {
  assert.deepEqual(tenantQueryKey("usage", SCOPE, 30), ["usage", 7, 2, "org-a", 30]);
  assert.deepEqual(tenantQueryKey("billing", SCOPE), ["billing", 7, 2, "org-a"]);
});

test("every part of the fence changes the key it addresses", () => {
  const base = tenantQueryKey("dashboard-review-runs", SCOPE, "", "");
  const otherTenant = tenantQueryKey("dashboard-review-runs", { ...SCOPE, tenantId: "org-b" }, "", "");
  const otherViewer = tenantQueryKey("dashboard-review-runs", { ...SCOPE, viewerUserId: 8 }, "", "");
  // Authorization loss bumps the fence version, so even a request that resolves
  // to the same tenant afterwards cannot read what was cached before it.
  const afterRevocation = tenantQueryKey("dashboard-review-runs", { ...SCOPE, fenceVersion: 3 }, "", "");
  const viewerWide = tenantQueryKey("dashboard-review-runs", { ...SCOPE, tenantId: null }, "", "");

  for (const other of [otherTenant, otherViewer, afterRevocation, viewerWide]) {
    assert.notDeepEqual(base, other);
  }
});

test("only resource parameters may differ within one scope", () => {
  const thirtyDays = tenantQueryKey("usage", SCOPE, 30);
  const sevenDays = tenantQueryKey("usage", SCOPE, 7);
  assert.equal(isSameTenantScope(thirtyDays, sevenDays), true);

  // A payload may be carried across a period or filter change, never across a
  // tenant, a viewer, or a revocation.
  assert.equal(isSameTenantScope(thirtyDays, tenantQueryKey("usage", { ...SCOPE, tenantId: "org-b" }, 30)), false);
  assert.equal(isSameTenantScope(thirtyDays, tenantQueryKey("usage", { ...SCOPE, viewerUserId: 8 }, 30)), false);
  assert.equal(isSameTenantScope(thirtyDays, tenantQueryKey("usage", { ...SCOPE, fenceVersion: 3 }, 30)), false);
  assert.equal(isSameTenantScope(thirtyDays, tenantQueryKey("billing", SCOPE)), false);
});

test("tenant-scoped keys are recognisable, including polled paths", () => {
  assert.equal(isTenantScopedQueryKey(tenantQueryKey("integrations", SCOPE)), true);
  assert.equal(isTenantScopedQueryKey(tenantQueryKey("review-run-detail", SCOPE, "run-1")), true);
  // The polled path already embeds the tenant, so it is fenced by the path itself.
  assert.equal(isTenantScopedQueryKey(pollQueryKey("/api/dashboard/tenants/org-a/work-overview")), true);
  assert.equal(isTenantScopedQueryKey(["some-unrelated-cache"]), false);
  assert.equal(isTenantScopedQueryKey([]), false);
});
