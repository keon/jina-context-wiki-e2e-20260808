import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "@testing-library/react";
import { jsonResponse, renderWithQueryClient, stubFetch, textOf } from "../../testing/render.tsx";
import { setTenantState } from "../../testing/stubs/dashboard-providers.tsx";
import McpPage from "./page.tsx";

const WORKSPACE = { tenantId: "ten_1", login: "acme", type: "Organization", role: "admin" } as const;
const ENDPOINT = "https://api.example.test/mcp";

function tokensResponse(endpoint: string | null): Response {
  return jsonResponse({ tokens: [], mcp_endpoint: endpoint });
}

test("no workspace selected issues no requests", () => {
  const { requests } = stubFetch(() => tokensResponse(ENDPOINT));
  setTenantState({ selected: null, ready: true });

  renderWithQueryClient(<McpPage />);

  assert.deepEqual(requests, []);
});

test("loading, unavailable and unconfigured are three different renders", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });

  stubFetch(() => new Promise<Response>(() => undefined));
  const pending = renderWithQueryClient(<McpPage />);
  const loadingCopy = pending.container.textContent ?? "";
  assert.match(loadingCopy, /Loading MCP details/);
  pending.unmount();

  stubFetch(() => jsonResponse({}, 503));
  const failed = renderWithQueryClient(<McpPage />);
  await waitFor(() => {
    assert.match(failed.container.textContent ?? "", /unavailable/);
  });
  const failedCopy = failed.container.textContent ?? "";
  failed.unmount();

  stubFetch(() => tokensResponse(null));
  const unconfigured = renderWithQueryClient(<McpPage />);
  await waitFor(() => {
    assert.match(unconfigured.container.textContent ?? "", /not configured/);
  });
  const unconfiguredCopy = unconfigured.container.textContent ?? "";

  assert.equal(new Set([loadingCopy, failedCopy, unconfiguredCopy]).size, 3);
});

test("a configured endpoint renders the tools and copyable client configs", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });
  stubFetch(() => tokensResponse(ENDPOINT));

  const { container } = renderWithQueryClient(<McpPage />);

  await waitFor(() => {
    assert.match(textOf(container, "[aria-label='Endpoint']"), /https:\/\/api\.example\.test\/mcp/);
  });
  const tools = textOf(container, "[aria-label='Tools']");
  for (const tool of ["search_context", "list_context", "read_context", "diff_context"]) {
    assert.match(tools, new RegExp(tool));
  }
  const connect = textOf(container, "[aria-label='Connect a client']");
  assert.match(connect, /claude mcp add/);
  assert.match(connect, /mcp_servers\.jina_context/);
  assert.match(textOf(container, "[aria-label='Beyond MCP']"), /causal-graph/);
});
