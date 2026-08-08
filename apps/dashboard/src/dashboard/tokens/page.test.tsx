import assert from "node:assert/strict";
import { test } from "node:test";
import { waitFor } from "@testing-library/react";
import { jsonResponse, renderWithQueryClient, stubFetch, textOf } from "../../testing/render.tsx";
import { setTenantState } from "../../testing/stubs/dashboard-providers.tsx";
import TokensPage from "./page.tsx";

const WORKSPACE = { tenantId: "ten_1", login: "acme", type: "Organization", role: "admin" } as const;
const MEMBER_WORKSPACE = { tenantId: "ten_1", login: "acme", type: "Organization", role: "member" } as const;

const TOKEN = {
  id: "tok_1",
  name: "CI reader",
  scopes: ["context:query", "context:read"],
  createdAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:00:00.000Z",
};

function tokensResponse(tokens: unknown[]): Response {
  return jsonResponse({ tokens, mcp_endpoint: "https://api.example.test/mcp" });
}

test("no workspace selected issues no requests", () => {
  const { requests } = stubFetch(() => tokensResponse([]));
  setTenantState({ selected: null, ready: true });

  renderWithQueryClient(<TokensPage />);

  assert.deepEqual(requests, []);
});

test("loading, unavailable and empty are three different renders", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });

  stubFetch(() => new Promise<Response>(() => undefined));
  const pending = renderWithQueryClient(<TokensPage />);
  const loadingCopy = textOf(pending.container, "[aria-label='Tokens']");
  assert.match(loadingCopy, /Loading tokens/);
  pending.unmount();

  stubFetch(() => jsonResponse({}, 503));
  const failed = renderWithQueryClient(<TokensPage />);
  await waitFor(() => {
    assert.match(textOf(failed.container, "[aria-label='Tokens']"), /unavailable/);
  });
  const failedCopy = textOf(failed.container, "[aria-label='Tokens']");
  failed.unmount();

  stubFetch(() => tokensResponse([]));
  const empty = renderWithQueryClient(<TokensPage />);
  await waitFor(() => {
    assert.match(textOf(empty.container, "[aria-label='Tokens']"), /No API tokens yet/);
  });
  const emptyCopy = textOf(empty.container, "[aria-label='Tokens']");

  assert.equal(new Set([loadingCopy, failedCopy, emptyCopy]).size, 3);
});

test("an admin sees the create form and the token list with a revoke control", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });
  stubFetch(() => tokensResponse([TOKEN]));

  const { container } = renderWithQueryClient(<TokensPage />);

  await waitFor(() => {
    assert.match(textOf(container, "[aria-label='Tokens']"), /CI reader/);
  });
  assert.match(textOf(container, "[aria-label='Create token']"), /Create token/);
  assert.match(textOf(container, "[aria-label='Tokens']"), /Revoke/);
  assert.match(textOf(container, "[aria-label='Tokens']"), /context:query/);
});

test("a non-admin member sees the list without create or revoke controls", async () => {
  setTenantState({ selected: MEMBER_WORKSPACE, ready: true });
  stubFetch(() => tokensResponse([TOKEN]));

  const { container } = renderWithQueryClient(<TokensPage />);

  await waitFor(() => {
    assert.match(textOf(container, "[aria-label='Tokens']"), /CI reader/);
  });
  assert.equal(container.querySelector("[aria-label='Create token']"), null);
  assert.doesNotMatch(textOf(container, "[aria-label='Tokens']"), /Revoke/);
});

test("revoked tokens are not listed as active", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });
  stubFetch(() =>
    tokensResponse([TOKEN, { ...TOKEN, id: "tok_2", name: "Old token", revokedAt: "2026-08-02T00:00:00.000Z" }]),
  );

  const { container } = renderWithQueryClient(<TokensPage />);

  await waitFor(() => {
    assert.match(textOf(container, "[aria-label='Tokens']"), /CI reader/);
  });
  assert.doesNotMatch(textOf(container, "[aria-label='Tokens']"), /Old token/);
});
