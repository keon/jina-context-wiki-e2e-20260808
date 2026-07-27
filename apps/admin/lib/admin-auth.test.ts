import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAdminAccess } from "./admin-auth.ts";

test("local/dev deployments without the internal token are permitted", () => {
  assert.deepEqual(evaluateAdminAccess({ authRequired: false }), {
    ok: true,
    actorId: "svc:admin-dev"
  });
});

test("production without Basic authentication is rejected with 401", () => {
  const decision = evaluateAdminAccess({ authRequired: true });
  assert.deepEqual(decision, { ok: false, status: 401, error: "authenticated identity required" });
});

test("production permits requests with valid app-level HTTP authentication", () => {
  const authenticated = evaluateAdminAccess({
    authRequired: true,
    authorizationHeader: `Basic ${Buffer.from("omlabs:correct horse").toString("base64")}`,
    webAuthUsername: "omlabs",
    webAuthPassword: "correct horse"
  });
  assert.deepEqual(authenticated, { ok: true, actorId: "admin:omlabs" });

  const invalidPassword = evaluateAdminAccess({
    authRequired: true,
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

test("caller-supplied IAP identity cannot bypass deployed Basic authentication", () => {
  const decision = evaluateAdminAccess({
    authRequired: true,
    authorizationHeader: null,
    webAuthUsername: "omlabs",
    webAuthPassword: "correct horse"
  });
  assert.deepEqual(decision, { ok: false, status: 401, error: "authenticated identity required" });
});
