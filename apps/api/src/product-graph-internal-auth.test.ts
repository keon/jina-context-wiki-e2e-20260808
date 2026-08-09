import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MemoryContextEngineStore } from "@jina/context-engine";
import { createApiServer, type ApiServerConfig } from "./server.js";

const tenantId = "6e5b7efe-9a51-4d34-ae9f-f67460b24d2f";
const otherTenantId = "64941a56-a547-418f-8eb1-bc9d47cabedd";
const bridgeToken = "product-graph-internal-test-token";
const internalToken = "operator-internal-test-token";

async function withServer(
  overrides: Partial<ApiServerConfig>,
  run: (input: { baseUrl: string; store: MemoryContextEngineStore }) => Promise<void>
): Promise<void> {
  const store = new MemoryContextEngineStore();
  const server: Server = createApiServer({
    ...(overrides.sharedIdentityResolver ? {} : { tenantId }),
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    productGraphInternalToken: bridgeToken,
    contextStore: store,
    ...overrides
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ baseUrl, store });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function bridgeHeaders(boundTenantId = tenantId): Record<string, string> {
  return {
    authorization: `Bearer ${bridgeToken}`,
    "x-jina-tenant-id": boundTenantId,
    "x-jina-principal-id": `tenant:${boundTenantId}`
  };
}

test("the product graph credential reaches only the GraphApiClient internal route union", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const overview = await fetch(`${baseUrl}/overview`, { headers: bridgeHeaders() });
    assert.equal(overview.status, 200, await overview.text());

    const initialTokens = await fetch(`${baseUrl}/internal/context/tokens`, { headers: bridgeHeaders() });
    assert.equal(initialTokens.status, 200, await initialTokens.text());

    const minted = await fetch(`${baseUrl}/internal/context/tokens`, {
      method: "POST",
      headers: { ...bridgeHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        principalId: `tenant:${tenantId}`,
        name: "dashboard token",
        scopes: ["context:read"],
        expiresInMinutes: 15,
        administrator: true
      })
    });
    const mintedBody = (await minted.json()) as { token?: { id?: string }; error?: string };
    assert.equal(minted.status, 201, mintedBody.error ?? "token mint failed");
    const tokenId = mintedBody.token?.id;
    assert.ok(tokenId);

    const revoked = await fetch(`${baseUrl}/internal/context/tokens/${encodeURIComponent(tokenId)}/revoke`, {
      method: "POST",
      headers: bridgeHeaders()
    });
    assert.equal(revoked.status, 200, await revoked.text());

    const reviewAccess = await fetch(`${baseUrl}/internal/context/review-access`, {
      method: "POST",
      headers: { ...bridgeHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ repository: "omxyz/product-bridge-test", reviewRunId: "review-run-1" })
    });
    assert.equal(reviewAccess.status, 201, await reviewAccess.text());

    // A missing build is deliberately a 404, proving authentication and the
    // internal-route gate both succeeded before the resource lookup.
    const cancel = await fetch(`${baseUrl}/internal/context/builds/cb_missing/cancel`, {
      method: "POST",
      headers: { ...bridgeHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ reason: "dashboard cancellation" })
    });
    assert.equal(cancel.status, 404, await cancel.text());
  });
});

test("the product graph credential cannot expand from an allowed path or method", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const attempts: readonly [method: string, path: string, body?: object][] = [
      ["GET", "/board"],
      ["GET", "/events"],
      ["GET", "/internal/observability"],
      ["POST", "/overview", {}],
      ["POST", "/wiki/build", { repository: "omxyz/private", ref: "main" }],
      ["POST", "/internal/context/access/sync", { repositories: [] }],
      ["POST", "/internal/context/wiki/dispatch/authorize", {}],
      ["GET", "/internal/context/tokens/atk_example/revoke"],
      ["POST", "/internal/context/tokens/atk_example/revoke/extra", {}],
      ["POST", "/internal/context/builds/cb_example/worker-completions", {}]
    ];
    for (const [method, path, body] of attempts) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...bridgeHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      assert.equal(response.status, 401, `${method} ${path}: ${await response.text()}`);
    }
  });
});

test("the product graph credential requires matching tenant and tenant-principal headers", async () => {
  await withServer({}, async ({ baseUrl }) => {
    const attempts: Record<string, string>[] = [
      { authorization: `Bearer ${bridgeToken}`, "x-jina-principal-id": `tenant:${tenantId}` },
      { authorization: `Bearer ${bridgeToken}`, "x-jina-tenant-id": tenantId },
      {
        authorization: `Bearer ${bridgeToken}`,
        "x-jina-tenant-id": tenantId,
        "x-jina-principal-id": `tenant:${otherTenantId}`
      },
      {
        authorization: `Bearer ${bridgeToken}`,
        "x-jina-tenant-id": tenantId,
        "x-jina-principal-id": "user:admin@example.com"
      },
      bridgeHeaders(otherTenantId)
    ];
    for (const headers of attempts) {
      const response = await fetch(`${baseUrl}/overview`, { headers });
      assert.equal(response.status, 401, await response.text());
    }
  });
});

test("shared-database product graph requests remain bound per tenant", async () => {
  await withServer(
    {
      sharedIdentityResolver: {
        async resolveRepository() {
          return undefined;
        },
        async listTenantIds() {
          return [tenantId, otherTenantId];
        },
        async ping() {},
        async close() {}
      }
    },
    async ({ baseUrl }) => {
      const accepted = await fetch(`${baseUrl}/overview`, { headers: bridgeHeaders(otherTenantId) });
      assert.equal(accepted.status, 200, await accepted.text());

      const mismatched = await fetch(`${baseUrl}/overview`, {
        headers: {
          ...bridgeHeaders(otherTenantId),
          "x-jina-principal-id": `tenant:${tenantId}`
        }
      });
      assert.equal(mismatched.status, 401, await mismatched.text());
    }
  );
});

test("the product graph credential cannot alias another static credential", () => {
  assert.throws(
    () => createApiServer({ internalApiToken: bridgeToken, productGraphInternalToken: bridgeToken }),
    /product graph internal token must be distinct/
  );
  assert.throws(
    () => createApiServer({ productGraphInternalToken: `jina_atk_${"a".repeat(43)}` }),
    /static API tokens must not use the jina_atk_ prefix/
  );
});
