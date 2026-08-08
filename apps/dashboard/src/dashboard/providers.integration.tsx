import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { tenantQueryKey } from "./lib/query-keys.ts";
import type { ViewerResponse } from "./lib/types.ts";
import {
  WORKSPACE_DISCOVERY_ERROR_MESSAGE,
  WORKSPACE_SESSION_ERROR_MESSAGE,
} from "./lib/tenant-access-error.ts";
import { DashboardProvider, TenantProvider, useDashboard, useTenant } from "./providers.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  globalThis.fetch = originalFetch;
});

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
}

function renderDashboard(client: QueryClient, children: ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <DashboardProvider>{children}</DashboardProvider>
    </QueryClientProvider>,
  );
}

function renderTenant(client: QueryClient) {
  return renderDashboard(
    client,
    <TenantProvider>
      <DashboardProbe />
      <TenantProbe />
    </TenantProvider>,
  );
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : input.toString();
  return new URL(value).pathname;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const VIEWER: ViewerResponse = {
  auth: { mode: "clerk", enabled: true },
  authenticated: true,
  user: { id: 42, internal_id: "user-42", login: "thecskc" },
  organizations: [],
  teams: [],
  projects: [],
};

const EMPTY_DASHBOARD = {
  generated_at: null,
  bots: [],
  review_runs: [],
  issues: [],
  projects: [],
  teams: [],
};

function DashboardProbe() {
  const { authLoading, authRequired, data, sessionError, reloadViewer } = useDashboard();
  return (
    <div>
      <output data-testid="session-error">{sessionError}</output>
      <output data-testid="auth-loading">{String(authLoading)}</output>
      <output data-testid="auth-required">{String(authRequired)}</output>
      <output data-testid="dashboard-loaded">{String(data !== null)}</output>
      <button type="button" onClick={reloadViewer}>
        Retry session
      </button>
    </div>
  );
}

function TenantProbe() {
  const { accessError, fenceVersion, ready, retryDiscovery, selected, tenants } = useTenant();
  return (
    <div>
      <output data-testid="access-error">{accessError}</output>
      <output data-testid="tenant-ready">{String(ready)}</output>
      <output data-testid="tenant-count">{tenants.length}</output>
      <output data-testid="selected-tenant">{selected?.tenantId ?? ""}</output>
      <output data-testid="fence-version">{fenceVersion}</output>
      <button type="button" onClick={retryDiscovery}>
        Retry workspaces
      </button>
    </div>
  );
}

void test("the real dashboard provider turns an initial API 401 into a retryable Clerk session error", async () => {
  const client = queryClient();
  let viewerRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(requestPath(input), "/api/dashboard/me");
    viewerRequests += 1;
    return new Response(null, { status: 401 });
  });

  const rendered = renderDashboard(client, <DashboardProbe />);
  await waitFor(() => {
    assert.equal(rendered.getByTestId("session-error").textContent, WORKSPACE_SESSION_ERROR_MESSAGE);
    assert.equal(rendered.getByTestId("auth-loading").textContent, "false");
    assert.equal(rendered.getByTestId("auth-required").textContent, "true");
  });

  fireEvent.click(rendered.getByRole("button", { name: "Retry session" }));
  await waitFor(() => assert.equal(viewerRequests, 2));
  assert.equal(rendered.getByTestId("session-error").textContent, WORKSPACE_SESSION_ERROR_MESSAGE);
  client.clear();
});

void test("the real tenant provider fails closed on a Clerk API 401 and retries discovery", async () => {
  const client = queryClient();
  const firstTenants = deferred<Response>();
  const retryTenants = deferred<Response>();
  let tenantRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = requestPath(input);
    if (path === "/api/dashboard/me") return jsonResponse(VIEWER);
    if (path === "/api/dashboard/tenants") {
      tenantRequests += 1;
      return tenantRequests === 1 ? firstTenants.promise : retryTenants.promise;
    }
    throw new Error(`Unexpected provider request: ${path}`);
  });

  const rendered = renderTenant(client);
  await waitFor(() => assert.equal(tenantRequests, 1));
  const protectedKey = tenantQueryKey("usage", {
    viewerUserId: 42,
    fenceVersion: 0,
    tenantId: "tenant-stale",
  });
  client.setQueryData(protectedKey, { secret: "must be evicted" });
  client.setQueryData(["public-probe"], { safe: true });

  await act(async () => firstTenants.resolve(new Response(null, { status: 401 })));
  await waitFor(() => {
    assert.equal(rendered.getByTestId("access-error").textContent, WORKSPACE_SESSION_ERROR_MESSAGE);
    assert.equal(rendered.getByTestId("tenant-ready").textContent, "false");
    assert.equal(rendered.getByTestId("tenant-count").textContent, "0");
    assert.equal(rendered.getByTestId("selected-tenant").textContent, "");
    assert.equal(rendered.getByTestId("fence-version").textContent, "1");
  });
  assert.equal(client.getQueryData(protectedKey), undefined);
  assert.deepEqual(client.getQueryData(["public-probe"]), { safe: true });

  fireEvent.click(rendered.getByRole("button", { name: "Retry workspaces" }));
  await waitFor(() => assert.equal(tenantRequests, 2));
  await act(async () => retryTenants.resolve(new Response(null, { status: 401 })));
  await waitFor(() =>
    assert.equal(rendered.getByTestId("access-error").textContent, WORKSPACE_SESSION_ERROR_MESSAGE),
  );
  client.clear();
});

void test("the real tenant provider preserves a 403 explanation while evicting protected cache", async () => {
  const client = queryClient();
  const tenantsResponse = deferred<Response>();
  let tenantRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = requestPath(input);
    if (path === "/api/dashboard/me") return jsonResponse(VIEWER);
    if (path === "/api/dashboard/tenants") {
      tenantRequests += 1;
      return tenantsResponse.promise;
    }
    throw new Error(`Unexpected provider request: ${path}`);
  });

  const rendered = renderTenant(client);
  await waitFor(() => assert.equal(tenantRequests, 1));
  const protectedKey = tenantQueryKey("billing", {
    viewerUserId: 42,
    fenceVersion: 0,
    tenantId: "tenant-revoked",
  });
  client.setQueryData(protectedKey, { billing: "private" });

  await act(async () =>
    tenantsResponse.resolve(
      jsonResponse({ error: "No migrated Jina workspace matches this Clerk identity." }, 403),
    ),
  );
  await waitFor(() => {
    const error = rendered.getByTestId("access-error").textContent ?? "";
    assert.match(error, /No migrated Jina workspace matches this Clerk identity/);
    assert.match(error, /ask a workspace admin/i);
    assert.equal(rendered.getByTestId("tenant-ready").textContent, "false");
  });
  assert.equal(client.getQueryData(protectedKey), undefined);
  client.clear();
});

void test("the real tenant provider reports an initial transient failure and retry recovers", async () => {
  const client = queryClient();
  let tenantRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = requestPath(input);
    if (path === "/api/dashboard/me") return jsonResponse(VIEWER);
    if (path === "/api/dashboard/tenants") {
      tenantRequests += 1;
      return tenantRequests === 1
        ? new Response(null, { status: 503 })
        : jsonResponse({
            tenants: [
              {
                tenant_id: "tenant-pistachio",
                login: "Pistachio",
                type: "Organization",
                role: "member",
              },
            ],
          });
    }
    if (path === "/api/dashboard/tenants/tenant-pistachio/review-runs") {
      return jsonResponse(EMPTY_DASHBOARD);
    }
    throw new Error(`Unexpected provider request: ${path}`);
  });

  const rendered = renderTenant(client);
  await waitFor(() => {
    assert.equal(rendered.getByTestId("access-error").textContent, WORKSPACE_DISCOVERY_ERROR_MESSAGE);
    assert.equal(rendered.getByTestId("tenant-ready").textContent, "false");
  });

  fireEvent.click(rendered.getByRole("button", { name: "Retry workspaces" }));
  await waitFor(() => {
    assert.equal(tenantRequests, 2);
    assert.equal(rendered.getByTestId("access-error").textContent, "");
    assert.equal(rendered.getByTestId("tenant-ready").textContent, "true");
    assert.equal(rendered.getByTestId("selected-tenant").textContent, "tenant-pistachio");
    assert.equal(rendered.getByTestId("dashboard-loaded").textContent, "true");
  });
  client.clear();
});
