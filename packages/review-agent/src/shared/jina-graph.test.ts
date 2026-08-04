import assert from "node:assert/strict";
import test from "node:test";

import { contextGraphMcpEnabled, createContextGraphMcpAccess } from "./jina-graph.js";

const input = {
  repository: "omxyz/example",
  githubRepositoryId: 456,
  installationId: 123,
  pullRequestNumber: 42,
  reviewRunId: "run-1",
  headSha: "a".repeat(40),
  headRef: "feature/auth",
  baseRef: "main"
};

test("ContextGraph MCP is enabled by default and requests access for the exact installed repository", async () => {
  let path = "";
  let body: unknown;
  const expiresAt = new Date(Date.now() + 600_000).toISOString();

  const result = await createContextGraphMcpAccess(
    input,
    {},
    async <TResponse>(nextPath: string, nextBody: unknown) => {
      path = nextPath;
      body = nextBody;
      return {
        available: true,
        mcp_url: "https://api.example/mcp",
        access_token: "short-lived-repository-token",
        token_type: "Bearer",
        expires_at: expiresAt
      } as TResponse;
    }
  );

  assert.equal(path, "/internal/context/mcp-access");
  assert.deepEqual(body, {
    installation_id: 123,
    github_repository_id: 456,
    repository: "omxyz/example",
    pull_request_number: 42,
    review_run_id: "run-1"
  });
  assert.deepEqual(result, {
    mcpUrl: "https://api.example/mcp",
    accessToken: "short-lived-repository-token",
    expiresAt
  });
});

test("ContextGraph MCP can be explicitly disabled without affecting local CodeGraph", async () => {
  let requests = 0;
  const result = await createContextGraphMcpAccess(input, { JINA_GRAPH_MCP_ENABLED: "false" }, async <TResponse>() => {
    requests += 1;
    return { available: true } as TResponse;
  });

  assert.equal(contextGraphMcpEnabled({}), true);
  assert.equal(contextGraphMcpEnabled({ JINA_GRAPH_MCP_ENABLED: "off" }), false);
  assert.equal(result, undefined);
  assert.equal(requests, 0);
});

test("ContextGraph MCP is not attached when the API reports no graph", async () => {
  const result = await createContextGraphMcpAccess(
    input,
    {},
    async <TResponse>() => ({ available: false }) as TResponse
  );
  assert.equal(result, undefined);
});

test("ContextGraph MCP requires https outside localhost", async () => {
  await assert.rejects(
    () =>
      createContextGraphMcpAccess(
        input,
        {},
        async <TResponse>() =>
          ({
            available: true,
            mcp_url: "http://graph.example/mcp",
            access_token: "short-lived-token",
            token_type: "Bearer",
            expires_at: new Date(Date.now() + 600_000).toISOString()
          }) as TResponse
      ),
    /must use https/
  );
});

test("ContextGraph MCP rejects expired credentials", async () => {
  await assert.rejects(
    () =>
      createContextGraphMcpAccess(
        input,
        {},
        async <TResponse>() =>
          ({
            available: true,
            mcp_url: "https://api.example/mcp",
            access_token: "expired-token",
            token_type: "Bearer",
            expires_at: new Date(Date.now() - 1_000).toISOString()
          }) as TResponse
      ),
    /expired token/
  );
});
