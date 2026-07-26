import assert from "node:assert/strict";
import test from "node:test";
import { adminApiHeaders, JinaApiError } from "./jina-api.ts";

test("admin API requests bind the configured principal and tenant", () => {
  assert.deepEqual(
    adminApiHeaders({
      token: "internal-token",
      tenantId: "tenant-a",
      principalId: "user:admin@example.com"
    }),
    {
      accept: "application/json",
      authorization: "Bearer internal-token",
      "x-jina-principal-id": "user:admin@example.com",
      "x-jina-tenant-id": "tenant-a"
    }
  );
});

test("admin API requests default to the tenant service principal", () => {
  assert.equal(
    adminApiHeaders({ token: "internal-token", tenantId: "tenant-a" })["x-jina-principal-id"],
    "tenant:tenant-a"
  );
});

test("admin API credentials cannot be used without a bound principal", () => {
  assert.throws(() => adminApiHeaders({ token: "internal-token" }), JinaApiError);
  assert.deepEqual(adminApiHeaders({}), { accept: "application/json" });
});
