import assert from "node:assert/strict";
import test from "node:test";
import { GraphApiClient } from "./graph-client.js";

const tenantId = "6e5b7efe-9a51-4d34-ae9f-f67460b24d2f";
const internalToken = "product-graph-internal-test-token";

test("direct delegated-token mint and revocation requests carry the tenant-principal binding", async () => {
  let clock = 1_000_000;
  let mintSequence = 0;
  const requests: { url: string; method: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ url, method, headers: new Headers(init?.headers) });
    if (url === "https://context.example/internal/context/tokens" && method === "POST") {
      mintSequence += 1;
      return Response.json(
        { secret: `jina_atk_${"a".repeat(42)}${mintSequence}`, token: { id: `atk_${mintSequence}` } },
        { status: 201 }
      );
    }
    if (/\/internal\/context\/tokens\/[^/]+\/revoke$/.test(url) && method === "POST") {
      return Response.json({ token: { id: `atk_${mintSequence - 1}` } });
    }
    return Response.json({ generations: [] });
  }) as typeof fetch;
  const client = new GraphApiClient(
    {
      apiUrl: "https://context.example",
      accessToken: "unused-context-token",
      internalToken,
      timeoutMs: 1_000,
      delegatedTokenTtlMinutes: 15
    },
    fetchImpl,
    () => clock
  );
  const context = {
    tenantId,
    installationId: 42,
    repositories: [{ name: "omxyz/jina", defaultBranch: "main" }]
  };

  await client.listGraphs(context);
  clock += 15 * 60_000;
  await client.listGraphs(context);
  await new Promise((resolve) => setImmediate(resolve));

  const bridgeRequests = requests.filter(
    ({ url }) => url.endsWith("/internal/context/tokens") || url.endsWith("/revoke")
  );
  assert.equal(bridgeRequests.length, 3);
  for (const request of bridgeRequests) {
    assert.equal(request.headers.get("authorization"), `Bearer ${internalToken}`, request.url);
    assert.equal(request.headers.get("x-jina-tenant-id"), tenantId, request.url);
    assert.equal(request.headers.get("x-jina-principal-id"), `tenant:${tenantId}`, request.url);
  }
  assert.equal(bridgeRequests.filter(({ url }) => url.endsWith("/internal/context/tokens")).length, 2);
  assert.equal(bridgeRequests.filter(({ url }) => url.endsWith("/revoke")).length, 1);
});
