import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HARNESS_MODEL_OPTIONS,
  TENANT_STORAGE_KEY,
  type ViewerTenant,
  isResponseForCurrentTenant,
  isTenantWritable,
  normalizeViewerTenants,
  resolveSelectedTenant,
  sortViewerTenants,
  tenantRoleLabel,
  tenantStorageKey,
  tenantTypeLabel,
} from "./tenants";

const TENANTS: ViewerTenant[] = [
  { tenant_id: "org-b", login: "beta-org", type: "Organization", role: "member" },
  { tenant_id: "user-1", login: "octocat", type: "User", role: "admin" },
  { tenant_id: "org-a", login: "Acme", type: "Organization", role: "admin" },
];

test("sortViewerTenants puts personal first, then orgs alphabetical (case-insensitive)", () => {
  const sorted = sortViewerTenants(TENANTS);
  assert.deepEqual(
    sorted.map((t) => t.tenant_id),
    ["user-1", "org-a", "org-b"],
  );
  // Input array is not mutated.
  assert.equal(TENANTS[0]!.tenant_id, "org-b");
});

test("normalizeViewerTenants validates every row and sorts", () => {
  const parsed = normalizeViewerTenants({
    tenants: [
      { tenant_id: "org-1", login: "Zeta", type: "Organization", role: "member" },
      { tenant_id: "user-1", login: "me", type: "User", role: "admin" },
    ],
  });
  assert.deepEqual(
    parsed.map((t) => [t.tenant_id, t.type, t.role]),
    [
      ["user-1", "User", "admin"],
      ["org-1", "Organization", "member"],
    ],
  );
  for (const invalid of [
    { tenant_id: "  ", login: "blank-id", type: "User", role: "member" },
    { login: "no-id", type: "User", role: "member" },
    { tenant_id: "org-2", login: "amp", type: "Weird", role: "boss" },
    "nope",
  ]) {
    assert.throws(() => normalizeViewerTenants({ tenants: [TENANTS[0], invalid] }), /Invalid tenant entry/);
  }
});

test("normalizeViewerTenants accepts explicit arrays and rejects malformed response envelopes", () => {
  assert.deepEqual(normalizeViewerTenants([]), []);
  assert.throws(() => normalizeViewerTenants(null), /Invalid tenants response/);
  assert.throws(() => normalizeViewerTenants({ nope: 1 }), /Invalid tenants response/);
  const one = normalizeViewerTenants([{ tenant_id: "t", login: "x", type: "Organization", role: "admin" }]);
  assert.deepEqual(one, [{ tenant_id: "t", login: "x", type: "Organization", role: "admin" }]);
});

test("tenantTypeLabel / tenantRoleLabel produce friendly text", () => {
  assert.equal(tenantTypeLabel("User"), "Personal");
  assert.equal(tenantTypeLabel("Organization"), "Organization");
  assert.equal(tenantRoleLabel("admin"), "Admin");
  assert.equal(tenantRoleLabel("member"), "Member");
});

test("resolveSelectedTenant honors a stored id, else defaults to the first tenant", () => {
  const sorted = sortViewerTenants(TENANTS);
  assert.equal(resolveSelectedTenant(sorted, "org-a")?.tenant_id, "org-a");
  // Unknown stored id falls back to the first (personal) tenant.
  assert.equal(resolveSelectedTenant(sorted, "ghost")?.tenant_id, "user-1");
  // No stored id -> first tenant.
  assert.equal(resolveSelectedTenant(sorted, null)?.tenant_id, "user-1");
  // No tenants -> null (legacy personal).
  assert.equal(resolveSelectedTenant([], "org-a"), null);
});

test("isTenantWritable gates org members but allows personal, admins, and legacy", () => {
  assert.equal(isTenantWritable(null), true); // legacy personal
  assert.equal(isTenantWritable({ tenantId: "u", login: "me", type: "User", role: "member" }), true);
  assert.equal(isTenantWritable({ tenantId: "o", login: "org", type: "Organization", role: "admin" }), true);
  assert.equal(isTenantWritable({ tenantId: "o", login: "org", type: "Organization", role: "member" }), false);
});

test("tenantStorageKey namespaces the persisted selection by viewer id so accounts never cross", () => {
  // A different signed-in user reads a different key, so a stale selection can't leak across accounts.
  assert.equal(tenantStorageKey(42), `${TENANT_STORAGE_KEY}.42`);
  assert.notEqual(tenantStorageKey(42), tenantStorageKey(43));
  // No viewer id (auth disabled) falls back to the bare legacy key.
  assert.equal(tenantStorageKey(null), TENANT_STORAGE_KEY);
  assert.equal(tenantStorageKey(undefined), TENANT_STORAGE_KEY);
});

test("isResponseForCurrentTenant fences a response to the still-selected tenant", () => {
  const viewerA = {};
  const viewerB = {};
  // Same tenant at request start and resolution -> apply.
  assert.equal(isResponseForCurrentTenant("t-1", "t-1", viewerA, viewerA), true);
  // Legacy viewer-scoped route (null on both sides) -> apply.
  assert.equal(isResponseForCurrentTenant(null, null, viewerA, viewerA), true);
  // A null-to-null transition between accounts still rejects the prior viewer's response.
  assert.equal(isResponseForCurrentTenant(null, null, viewerA, viewerB), false);
  // Switched from A to B before the response resolved -> drop.
  assert.equal(isResponseForCurrentTenant("t-1", "t-2", viewerA, viewerA), false);
  // Switched from a tenant to the legacy route (or vice versa) -> drop.
  assert.equal(isResponseForCurrentTenant("t-1", null), false);
  assert.equal(isResponseForCurrentTenant(null, "t-1"), false);
});

test("HARNESS_MODEL_OPTIONS stays in sync with api HARNESS_MODELS (drives the Codex picker set)", () => {
  assert.deepEqual(
    HARNESS_MODEL_OPTIONS.map((option) => option.value).filter((value) => value !== null),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  );
  assert.equal(HARNESS_MODEL_OPTIONS[0]!.value, null);
});
