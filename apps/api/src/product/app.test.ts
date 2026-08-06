import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createApp,
  DEFAULT_GRAPH_HISTORY_LIMIT,
  MAX_GRAPH_HISTORY_LIMIT,
  parseGraphHistoryLimit,
  parseJinaOrganizationName,
  parseReviewGraphAvailabilityBody,
  parseReviewGraphMcpAccessBody,
  tenantAccessDenial,
} from "./app.js";
import type { DashboardSession } from "./auth.js";
import type { AppConfig } from "./config.js";
import { deleteSession, getSession, saveSession } from "./store.js";

/**
 * Minimal AppConfig for route-glue tests. Auth is "disabled" so requireDashboardSession returns
 * undefined (no cookies needed); billing has no Autumn secret so it is unconfigured. This is enough to
 * exercise the topup route's origin guard, which runs BEFORE the session/billing checks.
 */
function testConfig(overrides: { dashboardAllowedOrigins?: AppConfig["dashboardAllowedOrigins"] } = {}): AppConfig {
  return {
    port: 8080,
    githubWebhookSecret: "whsec",
    internalApiToken: "internal-token",
    dashboardAllowedOrigins: overrides.dashboardAllowedOrigins ?? ["https://dash.example"],
    dashboardUrl: "https://dash.example",
    auth: {
      mode: "disabled",
      githubScopes: "read:user",
      sessionCookieName: "jina_dashboard_session",
      oauthStateCookieName: "jina_github_oauth_state",
      cookieSecure: true,
      cookieSameSite: "None",
      sessionTtlSeconds: 3600,
    },
    billing: {
      autumnApiUrl: "https://api.useautumn.com/v1",
      creditsFeatureId: "jina_credits",
      managedAiFeatureId: "managed_ai_access",
      enforce: "off",
    },
  };
}

/* -------------------------- topup origin/CSRF hardening (NON-BLOCKING ADOPTED b) --- */

test("POST topup rejects a present Origin not in the dashboard allowlist with 403", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/billing/topup", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "origin not allowed" });
});

test("POST topup allows an absent Origin header (non-browser clients)", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/billing/topup", { method: "POST" });
  // Passes the origin guard; falls through to the not-configured branch (no session / no Autumn secret).
  assert.equal(res.status, 409);
});

test("POST topup allows an Origin in the dashboard allowlist", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/billing/topup", {
    method: "POST",
    headers: { origin: "https://dash.example" },
  });
  assert.notEqual(res.status, 403);
  assert.equal(res.status, 409);
});

test("POST topup does not reject any Origin under a wildcard allowlist (dev/non-credentialed mode)", async () => {
  const app = createApp(testConfig({ dashboardAllowedOrigins: "*" }));
  const res = await app.request("/dashboard/billing/topup", {
    method: "POST",
    headers: { origin: "https://anything.example" },
  });
  assert.notEqual(res.status, 403);
});

/* --------------- credentialed-write CSRF hardening across all state-changing routes (FINDING 1) --- */

const JSON_HEADERS = { "content-type": "application/json" };

test("Jina does not expose an MCP proxy because review sandboxes connect directly to Context", async () => {
  const app = createApp(testConfig());
  const response = await app.request("/mcp", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(response.status, 404);
});

test("internal graph availability requires the internal credential", async () => {
  const app = createApp(testConfig());
  const response = await app.request("/internal/graph/availability", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      installation_id: 123,
      github_repository_id: 456,
      repository: "omxyz/example",
    }),
  });
  assert.equal(response.status, 401);
});

test("internal graph availability stays false when no configured graph target exists", async () => {
  const app = createApp(testConfig());
  const response = await app.request("/internal/graph/availability", {
    method: "POST",
    headers: { ...JSON_HEADERS, authorization: "Bearer internal-token" },
    body: JSON.stringify({
      installation_id: 123,
      github_repository_id: 456,
      repository: "omxyz/example",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: false });
});

test("internal ContextGraph MCP access stays unavailable unless the exact repository has a graph", async () => {
  const app = createApp(testConfig());
  const response = await app.request("/internal/context/mcp-access", {
    method: "POST",
    headers: { ...JSON_HEADERS, authorization: "Bearer internal-token" },
    body: JSON.stringify({
      installation_id: 123,
      github_repository_id: 456,
      repository: "omxyz/example",
      pull_request_number: 18,
      review_run_id: "review-run-18",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: false });
});

test("Context execution profiles require internal auth and return a bounded default without a database", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const app = createApp(testConfig());
    const body = JSON.stringify({ tenant_id: "tenant-1", build_id: "build-1" });
    const unauthorized = await app.request("/internal/context/execution-profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    assert.equal(unauthorized.status, 401);

    const response = await app.request("/internal/context/execution-profile", {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: "Bearer internal-token" },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      provider: "managed",
      model: "openai/gpt-5.6-terra",
      effort: "low",
      fallback_policy: "fail_notify",
      credential: { kind: "managed" },
      settings_revision: "unconfigured",
    });
  } finally {
    if (databaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = databaseUrl;
    }
  }
});

test("parseReviewGraphAvailabilityBody rejects an ambiguous repository scope", () => {
  assert.throws(
    () => parseReviewGraphAvailabilityBody({
      installation_id: 123,
      github_repository_id: 456,
      repository: "not-a-repository",
    }),
    /repository must be an owner\/name string/,
  );
});

test("parseReviewGraphMcpAccessBody requires review-specific scope", () => {
  assert.deepEqual(parseReviewGraphMcpAccessBody({
    installation_id: 123,
    github_repository_id: 456,
    repository: "omxyz/example",
    pull_request_number: 18,
    review_run_id: "review-run-18",
  }), {
    installationId: 123,
    githubRepoId: 456,
    repository: "omxyz/example",
    pullRequestNumber: 18,
    reviewRunId: "review-run-18",
  });
  assert.throws(() => parseReviewGraphMcpAccessBody({
    installation_id: 123,
    github_repository_id: 456,
    repository: "omxyz/example",
  }), /pull_request_number/);
});

// POST /dashboard/integrations — writes the OpenRouter/provider keys. Origin + JSON content-type guards.
test("POST integrations rejects a present Origin not in the allowlist with 403", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "origin not allowed" });
});

test("POST integrations allows an allowlisted Origin (falls through to the no-session response)", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", {
    method: "POST",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: "{}",
  });
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 415);
});

test("POST integrations allows an absent Origin header (non-browser clients)", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", { method: "POST", headers: JSON_HEADERS, body: "{}" });
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 415);
});

test("POST integrations rejects a non-JSON content type with 415 (closes the text/plain simple-request vector)", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", {
    method: "POST",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 415);
});

test("POST integrations rejects a missing content type with 415", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", { method: "POST", body: "{}" });
  assert.equal(res.status, 415);
});

test("POST Codex connection telemetry applies the dashboard origin and JSON guards", async () => {
  const app = createApp(testConfig());
  const crossSite = await app.request("/dashboard/integrations/codex/events", {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: JSON.stringify({ event: "flow_started", flow_id: "flow_12345678" }),
  });
  assert.equal(crossSite.status, 403);

  const wrongType = await app.request("/dashboard/integrations/codex/events", {
    method: "POST",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const anonymous = await app.request("/dashboard/integrations/codex/events", {
    method: "POST",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: JSON.stringify({ event: "flow_started", flow_id: "flow_12345678" }),
  });
  assert.equal(anonymous.status, 204);
});

// GET /dashboard/integrations — status shape. No session (auth disabled) -> empty integrations,
// which must include the codex_harness status object alongside openrouter.
test("GET integrations returns the codex_harness status object alongside openrouter", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", { method: "GET" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    openrouter: { configured: false },
    openai: { configured: false },
    anthropic: { configured: false },
    codex_harness: { configured: false },
    codex_harness_model: null,
  });
});

// PUT /dashboard/model-settings — writes per-tenant model selection. Origin + JSON content-type guards.
test("PUT model-settings rejects a present Origin not in the allowlist with 403", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/model-settings", {
    method: "PUT",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("PUT model-settings allows an allowlisted Origin (falls through to the auth-required response)", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/model-settings", {
    method: "PUT",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: "{}",
  });
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 415);
});

test("PUT model-settings allows an absent Origin header", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/model-settings", { method: "PUT", headers: JSON_HEADERS, body: "{}" });
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 415);
});

test("PUT model-settings rejects a non-JSON content type with 415", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/model-settings", {
    method: "PUT",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 415);
});

// POST /dashboard/integrations/openrouter/oauth/start — starts the OAuth flow (no body -> origin guard only).
test("POST oauth/start rejects a present Origin not in the allowlist with 403", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations/openrouter/oauth/start", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
});

test("POST oauth/start allows an allowlisted Origin (falls through to the auth-required response)", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations/openrouter/oauth/start", {
    method: "POST",
    headers: { origin: "https://dash.example" },
  });
  assert.notEqual(res.status, 403);
});

test("POST oauth/start allows an absent Origin header", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations/openrouter/oauth/start", { method: "POST" });
  assert.notEqual(res.status, 403);
});

test("POST session refresh rejects a cross-site Origin before refreshing GitHub access", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/session/refresh", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
});

test("POST session refresh allows the dashboard Origin without requiring a request body", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/session/refresh", {
    method: "POST",
    headers: { origin: "https://dash.example" },
  });
  assert.equal(res.status, 200);
});

test("an in-flight access refresh cannot recreate a session after logout", async () => {
  const base = testConfig();
  const config: AppConfig = {
    ...base,
    auth: {
      ...base.auth,
      mode: "github",
      githubClientId: "client",
      githubClientSecret: "secret",
    },
  };
  const app = createApp(config);
  const session: DashboardSession = {
    id: "logout-refresh-race",
    accessToken: "github-token",
    user: { id: 7, login: "octocat" },
    organizations: [],
    projects: [],
    teams: [],
    expiresAt: Date.now() + 60_000,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
  };
  const cookie = `${config.auth.sessionCookieName}=${session.id}`;
  let releaseUser!: () => void;
  let markUserStarted!: () => void;
  const userStarted = new Promise<void>((resolve) => {
    markUserStarted = resolve;
  });
  const userGate = new Promise<void>((resolve) => {
    releaseUser = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/user") {
      markUserStarted();
      await userGate;
      return Response.json({ id: 7, login: "octocat" });
    }
    if (url.startsWith("https://api.github.com/user/")) {
      return Response.json([]);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await saveSession(session);
  try {
    const refresh = app.request("/dashboard/session/refresh", {
      method: "POST",
      headers: { origin: "https://dash.example", cookie },
    });
    await userStarted;
    const logoutResponse = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logoutResponse.status, 200);
    releaseUser();
    const refreshResponse = await refresh;
    assert.equal(refreshResponse.status, 200);
    assert.equal((await refreshResponse.json()).authenticated, false);
    assert.equal(await getSession(session.id), undefined);
    const meResponse = await app.request("/dashboard/me", {
      headers: { cookie },
    });
    assert.equal((await meResponse.json()).authenticated, false);
  } finally {
    releaseUser();
    globalThis.fetch = originalFetch;
    await deleteSession(session.id);
  }
});

test("POST graph query applies dashboard origin and JSON guards before authentication", async () => {
  const app = createApp(testConfig());
  const crossOrigin = await app.request("/dashboard/tenants/tenant-a/graph/query", {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: JSON.stringify({ graph_id: "graph-1", repository: "omxyz/a", query: "What depends on auth?" }),
  });
  assert.equal(crossOrigin.status, 403);

  const wrongContentType = await app.request("/dashboard/tenants/tenant-a/graph/query", {
    method: "POST",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);

  const noSession = await app.request("/dashboard/tenants/tenant-a/graph/query", {
    method: "POST",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: JSON.stringify({ graph_id: "graph-1", repository: "omxyz/a", query: "What depends on auth?" }),
  });
  assert.equal(noSession.status, 401);
});

test("POST graph indexing applies dashboard origin and JSON guards before authentication", async () => {
  const app = createApp(testConfig());
  const path = "/dashboard/tenants/tenant-a/graphs/index";
  const crossOrigin = await app.request(path, {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: JSON.stringify({ repository: "omxyz/a" }),
  });
  assert.equal(crossOrigin.status, 403);

  const wrongContentType = await app.request(path, {
    method: "POST",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);

  const noSession = await app.request(path, {
    method: "POST",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: JSON.stringify({ repository: "omxyz/a" }),
  });
  assert.equal(noSession.status, 401);
});

test("POST tenant creation applies dashboard origin and JSON guards before authentication", async () => {
  const app = createApp(testConfig());
  const crossOrigin = await app.request("/dashboard/tenants", {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: JSON.stringify({ name: "Acme" }),
  });
  assert.equal(crossOrigin.status, 403);

  const wrongContentType = await app.request("/dashboard/tenants", {
    method: "POST",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);

  const noSession = await app.request("/dashboard/tenants", {
    method: "POST",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: JSON.stringify({ name: "Acme" }),
  });
  assert.equal(noSession.status, 401);
});

test("PATCH organization settings applies dashboard origin and JSON guards before authentication", async () => {
  const app = createApp(testConfig());
  const path = "/dashboard/tenants/00000000-0000-4000-8000-000000000001";
  const crossOrigin = await app.request(path, {
    method: "PATCH",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: JSON.stringify({ name: "Acme" }),
  });
  assert.equal(crossOrigin.status, 403);

  const wrongContentType = await app.request(path, {
    method: "PATCH",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);

  const noSession = await app.request(path, {
    method: "PATCH",
    headers: { origin: "https://dash.example", ...JSON_HEADERS },
    body: JSON.stringify({ name: "Acme" }),
  });
  assert.equal(noSession.status, 401);
});

test("organization names are normalized and bounded", () => {
  assert.equal(parseJinaOrganizationName("  Acme   Research  "), "Acme Research");
  assert.throws(() => parseJinaOrganizationName(undefined), /name is required/);
  assert.throws(() => parseJinaOrganizationName(" \t "), /name is required/);
  assert.throws(() => parseJinaOrganizationName("Acme\nResearch"), /control characters/);
  assert.throws(() => parseJinaOrganizationName("a".repeat(81)), /80 characters/);
});

test("graph indexing defaults to 500 commits and cannot exceed 10,000", () => {
  assert.equal(parseGraphHistoryLimit(undefined), DEFAULT_GRAPH_HISTORY_LIMIT);
  assert.equal(DEFAULT_GRAPH_HISTORY_LIMIT, 500);
  assert.equal(MAX_GRAPH_HISTORY_LIMIT, 10_000);
  assert.equal(parseGraphHistoryLimit(2_500), 2_500);
  assert.throws(() => parseGraphHistoryLimit(0), /historyLimit must be an integer from 1 to 10000/);
  assert.throws(() => parseGraphHistoryLimit(10_001), /historyLimit must be an integer from 1 to 10000/);
  assert.throws(() => parseGraphHistoryLimit(500.5), /historyLimit must be an integer from 1 to 10000/);
});

/* ------------------------------ requireTenantAccess decision (member vs admin vs none) --- */

test("tenantAccessDenial: a non-member (no role) is denied read and write with 403", () => {
  assert.deepEqual(tenantAccessDenial(undefined, false), { status: 403, message: "tenant access required" });
  assert.deepEqual(tenantAccessDenial(undefined, true), { status: 403, message: "tenant access required" });
});

test("tenantAccessDenial: a member may read but not write", () => {
  assert.equal(tenantAccessDenial("member", false), undefined);
  assert.deepEqual(tenantAccessDenial("member", true), { status: 403, message: "tenant admin access required" });
});

test("tenantAccessDenial: an admin may read and write", () => {
  assert.equal(tenantAccessDenial("admin", false), undefined);
  assert.equal(tenantAccessDenial("admin", true), undefined);
});

test("tenant-scoped review routes require an authenticated tenant member", async () => {
  const app = createApp(testConfig());
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const runId = "00000000-0000-4000-8000-000000000002";
  const paths = [
    `/dashboard/tenants/${tenantId}/review-runs`,
    `/dashboard/tenants/${tenantId}/review-runs/${runId}`,
    `/dashboard/tenants/${tenantId}/review-runs/${runId}/scenario-lineage/scenario-1`,
    `/dashboard/tenants/${tenantId}/context/repositories`,
  ];
  for (const path of paths) {
    const response = await app.request(path);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "dashboard authentication required" });
  }
});

test("authenticated legacy review routes fail closed without a personal Jina tenant", async () => {
  const base = testConfig();
  const config: AppConfig = {
    ...base,
    auth: {
      ...base.auth,
      mode: "github",
      githubClientId: "client",
      githubClientSecret: "secret",
    },
  };
  const app = createApp(config);
  const session: DashboardSession = {
    id: "legacy-review-without-tenant",
    user: { id: 17, login: "octocat" },
    organizations: [],
    projects: [{ id: "other/repo", full_name: "other/repo", owner: "other", name: "repo", source: "github" }],
    teams: [],
    expiresAt: Date.now() + 60_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const cookie = `${config.auth.sessionCookieName}=${session.id}`;
  await saveSession(session);
  try {
    const list = await app.request("/dashboard/review-runs", { headers: { cookie } });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).review_runs, []);

    const detail = await app.request("/dashboard/review-runs/run-from-another-tenant", {
      headers: { cookie },
    });
    assert.equal(detail.status, 404);

    const lineage = await app.request(
      "/dashboard/review-runs/run-from-another-tenant/scenario-lineage/scenario-1",
      { headers: { cookie } },
    );
    assert.equal(lineage.status, 200);
    assert.deepEqual(await lineage.json(), { review_runs: [] });
  } finally {
    await deleteSession(session.id);
  }
});

/* --------------------- tenant-scoped write routes carry the shared CSRF guards (route wiring) --- */

test("POST tenant integrations rejects a present Origin not in the allowlist with 403", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/tenants/tenant-1/integrations", {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "origin not allowed" });
});

test("PUT tenant model-settings rejects a non-JSON content type with 415", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/tenants/tenant-1/model-settings", {
    method: "PUT",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 415);
});

test("POST Context build cancellation rejects cross-site requests before authentication", async () => {
  const app = createApp(testConfig());
  const response = await app.request(
    "/dashboard/tenants/tenant-1/context/builds/build-1/cancel",
    {
      method: "POST",
      headers: { origin: "https://evil.example", ...JSON_HEADERS },
      body: "{}",
    },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin not allowed" });
});

test("POST Context build cancellation requires JSON before authentication", async () => {
  const app = createApp(testConfig());
  const response = await app.request(
    "/dashboard/tenants/tenant-1/context/builds/build-1/cancel",
    {
      method: "POST",
      headers: { origin: "https://dash.example", "content-type": "text/plain" },
      body: "{}",
    },
  );
  assert.equal(response.status, 415);
});

test("POST Context build cancellation requires an authenticated tenant admin", async () => {
  const app = createApp(testConfig());
  const response = await app.request(
    "/dashboard/tenants/tenant-1/context/builds/build-1/cancel",
    {
      method: "POST",
      headers: { origin: "https://dash.example", ...JSON_HEADERS },
      body: "{}",
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "dashboard authentication required" });
});

test("POST tenant GitHub installation rejects cross-site requests before authentication", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/tenants/tenant-1/github/installations", {
    method: "POST",
    headers: { origin: "https://evil.example", ...JSON_HEADERS },
    body: JSON.stringify({ installation_id: 42 }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "origin not allowed" });
});

test("POST tenant GitHub installation requires JSON before authentication", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/tenants/tenant-1/github/installations", {
    method: "POST",
    headers: { origin: "https://dash.example", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 415);
});

/* -------------------------- dashboard ETag revalidation --------------------------------------- */
// apps/dashboard/src/lib/poll.ts re-fetches these routes every 2.5-15s. Tagging the responses lets an
// unchanged poll come back as a bodyless 304 instead of a full payload, matching the legacy server's
// jsonCacheable semantics (strong ETag over the exact body + cache-control: no-cache).

test("GET dashboard responses carry a strong ETag and cache-control: no-cache", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", { method: "GET" });
  assert.equal(res.status, 200);
  const tag = res.headers.get("etag");
  assert.ok(tag, "expected an etag header on a polled GET route");
  assert.match(tag, /^"[^"]+"$/, "expected a strong (non-weak, quoted) etag");
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

test("a matching if-none-match revalidates to a 304 with an empty body", async () => {
  const app = createApp(testConfig());
  const first = await app.request("/dashboard/integrations", { method: "GET" });
  const tag = first.headers.get("etag");
  assert.ok(tag);

  const revalidated = await app.request("/dashboard/integrations", {
    method: "GET",
    headers: { "if-none-match": tag },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get("etag"), tag);
  assert.equal(revalidated.headers.get("cache-control"), "no-cache");
  assert.equal(await revalidated.text(), "", "a 304 must not carry a body");
});

test("a stale if-none-match returns the full 200 payload", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/integrations", {
    method: "GET",
    headers: { "if-none-match": '"not-the-current-tag"' },
  });
  assert.equal(res.status, 200);
  assert.notEqual(res.headers.get("etag"), '"not-the-current-tag"');
  assert.deepEqual(await res.json(), {
    openrouter: { configured: false },
    openai: { configured: false },
    anthropic: { configured: false },
    codex_harness: { configured: false },
    codex_harness_model: null,
  });
});

test("a changed payload produces a different ETag and does not 304", async () => {
  const appA = createApp({ ...testConfig(), githubAppInstallUrl: "https://github.com/apps/jina-a" });
  const appB = createApp({ ...testConfig(), githubAppInstallUrl: "https://github.com/apps/jina-b" });

  const a = await appA.request("/dashboard/me", { method: "GET" });
  const b = await appB.request("/dashboard/me", { method: "GET" });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const tagA = a.headers.get("etag");
  const tagB = b.headers.get("etag");
  assert.ok(tagA);
  assert.ok(tagB);
  assert.notEqual(await a.text(), await b.text(), "fixture configs must produce different payloads");
  assert.notEqual(tagA, tagB, "a changed payload must produce a different etag");

  // A client holding the old tag gets the new payload, not a 304.
  const stale = await appB.request("/dashboard/me", {
    method: "GET",
    headers: { "if-none-match": tagA },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("etag"), tagB);
});

test("a 304 keeps the credentialed CORS headers the 200 would have carried", async () => {
  const app = createApp(testConfig());
  const first = await app.request("/dashboard/integrations", {
    method: "GET",
    headers: { origin: "https://dash.example" },
  });
  const tag = first.headers.get("etag");
  assert.ok(tag);
  assert.equal(first.headers.get("access-control-allow-origin"), "https://dash.example");

  const revalidated = await app.request("/dashboard/integrations", {
    method: "GET",
    headers: { origin: "https://dash.example", "if-none-match": tag },
  });
  assert.equal(revalidated.status, 304);
  // Without these a browser rejects the 304 outright and the poll fails instead of revalidating.
  assert.equal(revalidated.headers.get("access-control-allow-origin"), "https://dash.example");
  assert.equal(revalidated.headers.get("access-control-allow-credentials"), "true");
});

test("mutating routes are not tagged and are never revalidated away", async () => {
  const app = createApp(testConfig());
  const res = await app.request("/dashboard/billing/topup", {
    method: "POST",
    headers: { "if-none-match": "*" },
  });
  assert.equal(res.status, 409, "if-none-match must not short-circuit a POST");
  assert.equal(res.headers.get("etag"), null);
});
