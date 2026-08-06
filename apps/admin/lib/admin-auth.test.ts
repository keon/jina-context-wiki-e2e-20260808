import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAdminAccess } from "./admin-auth.ts";

const CREDENTIALS = { webAuthUsername: "omlabs", webAuthPassword: "correct horse" } as const;
const VALID_HEADER = `Basic ${Buffer.from("omlabs:correct horse").toString("base64")}`;

test("local dev without any credentials configured is permitted only when explicitly declared", () => {
  assert.deepEqual(evaluateAdminAccess({ allowUnauthenticatedLocalDev: true }), {
    ok: true,
    actorId: "svc:admin-dev"
  });
});

test("a deployment without configured credentials fails closed instead of serving tenant data", () => {
  // The previous gate keyed off INTERNAL_API_TOKEN, so dropping that unrelated
  // credential silently disabled inbound authentication on an
  // --allow-unauthenticated service. Absent web credentials must now refuse.
  assert.deepEqual(evaluateAdminAccess({}), {
    ok: false,
    status: 503,
    error: "admin authentication is not configured"
  });

  assert.deepEqual(evaluateAdminAccess({ allowUnauthenticatedLocalDev: false }), {
    ok: false,
    status: 503,
    error: "admin authentication is not configured"
  });

  // Valid-looking Basic credentials cannot conjure an identity out of an
  // unconfigured deployment.
  assert.deepEqual(evaluateAdminAccess({ authorizationHeader: VALID_HEADER }), {
    ok: false,
    status: 503,
    error: "admin authentication is not configured"
  });
});

test("credentials configured for the deployment override the local-dev escape hatch", () => {
  const decision = evaluateAdminAccess({ ...CREDENTIALS, allowUnauthenticatedLocalDev: true });
  assert.deepEqual(decision, { ok: false, status: 401, error: "authenticated identity required" });

  assert.deepEqual(
    evaluateAdminAccess({ ...CREDENTIALS, allowUnauthenticatedLocalDev: true, authorizationHeader: VALID_HEADER }),
    { ok: true, actorId: "admin:omlabs" }
  );
});

test("half-configured credentials are refused as a misconfiguration", () => {
  for (const partial of [
    { webAuthUsername: "omlabs" },
    { webAuthPassword: "correct horse" },
    { webAuthUsername: "omlabs", webAuthPassword: "   " },
    { webAuthUsername: "  ", webAuthPassword: "correct horse" }
  ]) {
    assert.deepEqual(evaluateAdminAccess({ ...partial, allowUnauthenticatedLocalDev: true }), {
      ok: false,
      status: 503,
      error: "admin authentication is misconfigured"
    });
  }
});

test("production without Basic authentication is rejected with 401", () => {
  const decision = evaluateAdminAccess(CREDENTIALS);
  assert.deepEqual(decision, { ok: false, status: 401, error: "authenticated identity required" });
});

test("production permits requests with valid app-level HTTP authentication", () => {
  const authenticated = evaluateAdminAccess({ ...CREDENTIALS, authorizationHeader: VALID_HEADER });
  assert.deepEqual(authenticated, { ok: true, actorId: "admin:omlabs" });

  const invalidPassword = evaluateAdminAccess({
    ...CREDENTIALS,
    authorizationHeader: "Basic bm9wZTp3cm9uZw=="
  });
  assert.deepEqual(invalidPassword, {
    ok: false,
    status: 401,
    error: "authenticated identity required"
  });

  const malformedHeader = evaluateAdminAccess({ ...CREDENTIALS, authorizationHeader: "Basic not-base64!!" });
  assert.deepEqual(malformedHeader, {
    ok: false,
    status: 401,
    error: "authenticated identity required"
  });

  const bearerHeader = evaluateAdminAccess({ ...CREDENTIALS, authorizationHeader: "Bearer internal-token" });
  assert.deepEqual(bearerHeader, {
    ok: false,
    status: 401,
    error: "authenticated identity required"
  });
});

test("the authenticated actor is derived from the configured username, never the caller", () => {
  assert.deepEqual(
    evaluateAdminAccess({
      webAuthUsername: "Ops Team",
      webAuthPassword: "correct horse",
      authorizationHeader: `Basic ${Buffer.from("Ops Team:correct horse").toString("base64")}`
    }),
    { ok: true, actorId: "admin:web" }
  );
});

test("caller-supplied IAP identity cannot bypass deployed Basic authentication", () => {
  const decision = evaluateAdminAccess({ ...CREDENTIALS, authorizationHeader: null });
  assert.deepEqual(decision, { ok: false, status: 401, error: "authenticated identity required" });
});
