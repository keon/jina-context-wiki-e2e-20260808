import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAdminAccess, normalizeIapEmail, parseAdminAllowlist } from "./admin-auth.ts";

test("normalizeIapEmail strips the IAP prefix and lowercases", () => {
  assert.equal(normalizeIapEmail("accounts.google.com:Person@Example.com"), "person@example.com");
  assert.equal(normalizeIapEmail("  plain@example.com  "), "plain@example.com");
});

test("normalizeIapEmail rejects missing or malformed identities", () => {
  assert.equal(normalizeIapEmail(undefined), undefined);
  assert.equal(normalizeIapEmail(""), undefined);
  assert.equal(normalizeIapEmail("accounts.google.com:"), undefined);
  assert.equal(normalizeIapEmail("not-an-email"), undefined);
});

test("parseAdminAllowlist splits, trims, and lowercases", () => {
  const allowlist = parseAdminAllowlist(" A@x.com, b@x.com ,, ");
  assert.deepEqual([...(allowlist ?? [])], ["a@x.com", "b@x.com"]);
  assert.equal(parseAdminAllowlist(undefined), undefined);
  assert.equal(parseAdminAllowlist("  , "), undefined);
});

test("local/dev deployments without the internal token are permitted", () => {
  assert.deepEqual(evaluateAdminAccess({ authRequired: false, iapEmailHeader: null, allowlistRaw: null }), {
    ok: true
  });
});

test("production without an IAP identity is rejected with 401", () => {
  const decision = evaluateAdminAccess({ authRequired: true, iapEmailHeader: null, allowlistRaw: null });
  assert.deepEqual(decision, { ok: false, status: 401, error: "authenticated identity required" });
});

test("production permits requests with valid app-level HTTP authentication", () => {
  const authenticated = evaluateAdminAccess({
    authRequired: true,
    iapEmailHeader: null,
    allowlistRaw: null,
    authorizationHeader: `Basic ${Buffer.from("omlabs:correct horse").toString("base64")}`,
    webAuthUsername: "omlabs",
    webAuthPassword: "correct horse"
  });
  assert.deepEqual(authenticated, { ok: true });

  const invalidPassword = evaluateAdminAccess({
    authRequired: true,
    iapEmailHeader: null,
    allowlistRaw: null,
    authorizationHeader: "Basic bm9wZTp3cm9uZw==",
    webAuthUsername: "omlabs",
    webAuthPassword: "correct horse"
  });
  assert.deepEqual(invalidPassword, {
    ok: false,
    status: 401,
    error: "authenticated identity required"
  });
});

test("production with a valid identity and no allowlist is permitted", () => {
  const decision = evaluateAdminAccess({
    authRequired: true,
    iapEmailHeader: "accounts.google.com:ops@example.com",
    allowlistRaw: null
  });
  assert.deepEqual(decision, { ok: true, email: "ops@example.com" });
});

test("an identity outside the allowlist is rejected with 403", () => {
  const decision = evaluateAdminAccess({
    authRequired: true,
    iapEmailHeader: "intruder@example.com",
    allowlistRaw: "admin@example.com"
  });
  assert.deepEqual(decision, { ok: false, status: 403, error: "administrator access required" });
});

test("an identity inside the allowlist is permitted", () => {
  const decision = evaluateAdminAccess({
    authRequired: true,
    iapEmailHeader: "Admin@Example.com",
    allowlistRaw: "admin@example.com, ops@example.com"
  });
  assert.deepEqual(decision, { ok: true, email: "admin@example.com" });
});
