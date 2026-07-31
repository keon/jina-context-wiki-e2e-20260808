import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDashboardApiRequest, resolveDashboardPrincipal } from "./proxy-policy.ts";

test("allows dashboard reads, blocks internal and unknown routes", () => {
  for (const pathname of [
    "/api/board",
    "/api/events",
    "/api/overview",
    "/api/task-types",
    "/api/context/metrics",
    "/api/context/releases",
    "/api/context/list",
    "/api/context/read",
    "/api/context/diff",
    "/api/context/builds",
    "/api/context/builds/build-1/progress"
  ]) {
    assert.equal(isAllowedDashboardApiRequest("GET", pathname, true), true, pathname);
  }
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context/search", true), true);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context/rebuild", true), false);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context/knowledge/revision-1/review", true), false);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context/build", true), false);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/context/erasure", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/internal/worker/claim", true), false);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/board", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context/generations", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context/documents", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context/structure", true), false);
  assert.equal(isAllowedDashboardApiRequest("GET", "/api/context/documents/revision-1/events", true), false);
  assert.equal(isAllowedDashboardApiRequest("DELETE", "/api/context/documents/revision-1", true), false);
});

test("demo webhook endpoint is local-only", () => {
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/dev/webhooks/github", false), true);
  assert.equal(isAllowedDashboardApiRequest("POST", "/api/dev/webhooks/github", true), false);
});

test("dashboard principal prefers a validated IAP email", () => {
  assert.equal(
    resolveDashboardPrincipal({
      iapEmailHeader: "accounts.google.com:Person@Example.com",
      authorizationHeader: null,
      webAuthUsername: undefined,
      webAuthPassword: undefined,
      webPrincipal: undefined
    }),
    "user:person@example.com"
  );
});

test("dashboard principal uses the configured tenant identity behind IAP", () => {
  assert.equal(
    resolveDashboardPrincipal({
      iapEmailHeader: "accounts.google.com:jina-acceptance@example.iam.gserviceaccount.com",
      authorizationHeader: null,
      webAuthUsername: undefined,
      webAuthPassword: undefined,
      webPrincipal: "tenant:eff0efc9-b103-494a-b7a3-1ae7f95c2d26"
    }),
    "tenant:eff0efc9-b103-494a-b7a3-1ae7f95c2d26"
  );
});

test("dashboard principal accepts the fixed identity only with valid HTTP authentication", () => {
  const input = {
    iapEmailHeader: null,
    authorizationHeader: `Basic ${Buffer.from("omlabs:correct horse").toString("base64")}`,
    webAuthUsername: "omlabs",
    webAuthPassword: "correct horse",
    webPrincipal: "user:keon@omlabs.xyz"
  } as const;
  assert.equal(resolveDashboardPrincipal(input), "user:keon@omlabs.xyz");
  assert.equal(resolveDashboardPrincipal({ ...input, authorizationHeader: "Basic bm9wZTp3cm9uZw==" }), undefined);
  assert.equal(resolveDashboardPrincipal({ ...input, webPrincipal: "not-a-principal" }), undefined);
});
