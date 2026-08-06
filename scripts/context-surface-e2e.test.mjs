import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { redactContextCredentials, runContextSurfaceAcceptance } from "./context-surface-e2e.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";
const QUERY_TOKEN = "surface-query";
const INTERNAL_TOKEN = "surface-internal";
const ISSUED_PRINCIPAL = "user:surface-acceptance@example.com";
const ISSUED_SECRET = `jina_atk_${"s".repeat(43)}`;
const ISSUED_TOKEN_ID = "atk_surface";
const REPOSITORY = "acme/context";
const REF = "main";
const BUILD_ID = "cb_surface";
const CURRENT_RELEASE = "cr_current";
const OLD_RELEASE = "cr_old";
const COMMIT = "a".repeat(40);

test("surface diagnostics redact issued and configured credentials", () => {
  const staticSecret = "static-super-secret";
  const diagnostic = redactContextCredentials(
    `mint failed with ${ISSUED_SECRET}; authorization Bearer ${staticSecret}`,
    [staticSecret]
  );
  assert.doesNotMatch(diagnostic, new RegExp(ISSUED_SECRET));
  assert.doesNotMatch(diagnostic, new RegExp(staticSecret));
  assert.equal((diagnostic.match(/\[REDACTED\]/g) ?? []).length, 2);
});

const citations = [
  {
    claim: "The request enters through the HTTP router.",
    citationId: "cite-file",
    anchor: {
      sourceType: "git_blob",
      sourceId: "blob-router",
      repository: REPOSITORY,
      commitSha: COMMIT,
      pathOrUrl: "src/router.ts",
      startLine: 10,
      endLine: 24
    }
  },
  {
    claim: "Issue 7 records the recovery requirement.",
    citationId: "cite-issue",
    anchor: {
      sourceType: "issue",
      sourceId: "github:acme/context:issue:7",
      repository: REPOSITORY,
      pathOrUrl: "https://github.com/acme/context/issues/7"
    }
  }
];

const release = {
  id: CURRENT_RELEASE,
  repository: REPOSITORY,
  ref: REF,
  commitSha: COMMIT,
  createdAt: "2026-07-29T12:00:00.000Z",
  publishedAt: "2026-07-29T12:01:00.000Z",
  completeness: "complete",
  contextStatus: "available"
};
const oldRelease = {
  ...release,
  id: OLD_RELEASE,
  commitSha: "b".repeat(40),
  createdAt: "2026-07-28T12:00:00.000Z",
  publishedAt: "2026-07-28T12:01:00.000Z"
};
const document = {
  id: "doc-architecture",
  logicalId: "architecture",
  revisionId: "rev-architecture",
  title: "Request architecture",
  summary: "The request path and its failure boundary.",
  citations
};
const catalog = {
  release,
  documents: [document],
  tree: [
    {
      id: "node-root",
      documentId: document.id,
      title: document.title,
      summary: document.summary,
      depth: 1,
      children: []
    }
  ]
};
const read = {
  release,
  document: { ...document, bodyMarkdown: "# Request architecture\n\nGrounded context." }
};
const diff = {
  from: oldRelease,
  to: release,
  added: [],
  removed: [],
  changed: [],
  unchanged: [document.logicalId]
};
const search = {
  release,
  query: "Request architecture architecture",
  results: [
    {
      documentId: document.id,
      logicalId: document.logicalId,
      revisionId: document.revisionId,
      title: document.title,
      score: 1,
      selectedNodeIds: ["node-root"],
      excerpts: ["The request path and its failure boundary."],
      citations
    }
  ],
  retrieval: { method: "lexical_tree", selector: "pageindex-lexical-tree-v1" }
};
const metrics = {
  outboxDepthByConsumer: {},
  publishedGenerationCount: 2,
  documentCount: 1,
  fragmentCount: 2,
  hierarchyNodeCount: 1,
  embeddingCount: 0,
  query: { count: 1, p95Ms: 1, citationFailureCount: 0, conflictCount: 0 },
  quotas: {
    active: { builds: 0, modelTasks: 0 },
    storage: { committedBytes: 1024, reservedBytes: 0, limitBytes: 1_000_000 },
    monthlyModel: {
      requests: 9,
      totalTokens: 42,
      requestLimit: 1_000,
      tokenLimit: 1_000_000
    }
  },
  projectors: [
    {
      name: "hierarchy",
      status: "ready",
      checkpoint: CURRENT_RELEASE,
      backlog: 0,
      version: "pageindex-test"
    }
  ]
};

test("surface harness validates the real HTTP and MCP contracts against a deterministic server", async () => {
  const requests = [];
  let issuedSecret;
  let issuedRevoked = false;
  let accessSynchronized = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const authorization = request.headers.authorization;
    const tenant = request.headers["x-jina-tenant-id"];
    const principal = request.headers["x-jina-principal-id"];
    requests.push({ method: request.method, path: url.pathname, authorization, tenant, principal, issuedRevoked });
    if (!authorization) return json(response, 401, { error: "unauthorized" });
    const internal = authorization === `Bearer ${INTERNAL_TOKEN}`;
    const queryCredential = authorization === `Bearer ${QUERY_TOKEN}`;
    const issuedCredential = authorization === `Bearer ${issuedSecret}` && !issuedRevoked;
    if (authorization === `Bearer ${issuedSecret}` && issuedRevoked) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (tenant !== TENANT) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (issuedCredential && principal !== ISSUED_PRINCIPAL) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (!internal && !queryCredential && !issuedCredential) return json(response, 401, { error: "unauthorized" });

    if (url.pathname === "/internal/context/access/sync" && request.method === "POST") {
      if (!internal || principal !== ISSUED_PRINCIPAL) return json(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      assert.deepEqual(body, { repositories: [REPOSITORY], mode: "merge" });
      accessSynchronized = true;
      return json(response, 200, { principalId: ISSUED_PRINCIPAL, repositoryCount: 1, mode: "merge" });
    }
    if (url.pathname === "/internal/context/tokens" && request.method === "POST") {
      if (!internal) return json(response, 401, { error: "internal credential required" });
      const body = await readJson(request);
      assert.equal(body.principalId, ISSUED_PRINCIPAL);
      assert.deepEqual(body.scopes, ["context:read", "context:query"]);
      assert.equal(body.expiresInMinutes, 15);
      assert.equal("administrator" in body, false);
      issuedSecret = ISSUED_SECRET;
      response.setHeader("cache-control", "no-store");
      return json(response, 201, {
        secret: issuedSecret,
        token: {
          id: ISSUED_TOKEN_ID,
          name: body.name,
          principalId: ISSUED_PRINCIPAL,
          scopes: body.scopes,
          createdAt: "2026-07-29T12:02:00.000Z",
          expiresAt: "2026-07-29T12:17:00.000Z"
        }
      });
    }
    if (url.pathname === `/internal/context/tokens/${ISSUED_TOKEN_ID}/revoke` && request.method === "POST") {
      if (!internal) return json(response, 401, { error: "internal credential required" });
      issuedRevoked = true;
      return json(response, 200, {
        token: {
          id: ISSUED_TOKEN_ID,
          name: "Context surface acceptance",
          principalId: ISSUED_PRINCIPAL,
          scopes: ["context:read", "context:query"],
          createdAt: "2026-07-29T12:02:00.000Z",
          expiresAt: "2026-07-29T12:17:00.000Z",
          revokedAt: "2026-07-29T12:10:00.000Z"
        }
      });
    }
    if (url.pathname.startsWith("/internal/") && issuedCredential) {
      return json(response, 401, { error: "internal credential required" });
    }

    if (url.pathname === "/mcp") {
      if (!queryCredential && !issuedCredential) return json(response, 401, { error: "unauthorized" });
      return handleMcp(request, response);
    }
    if (url.pathname === "/wiki/metrics") {
      return internal ? json(response, 200, metrics) : json(response, 403, { code: "insufficient_scope" });
    }
    if (url.pathname === "/board") {
      return queryCredential || issuedCredential
        ? json(response, 403, { code: "insufficient_scope" })
        : json(response, 200, { tasks: [] });
    }
    if (url.pathname === "/wiki/build" && request.method === "POST") {
      return issuedCredential
        ? json(response, 403, { code: "insufficient_scope" })
        : json(response, 401, { error: "unauthorized" });
    }
    if (url.pathname === "/wiki/builds") {
      if (!internal) return json(response, 403, { code: "insufficient_scope" });
      return json(response, 200, {
        builds: [
          {
            id: BUILD_ID,
            repository: REPOSITORY,
            ref: REF,
            commitSha: COMMIT,
            status: "completed",
            stages: [],
            createdAt: release.createdAt
          }
        ]
      });
    }
    if (url.pathname === `/wiki/builds/${BUILD_ID}/progress`) {
      if (!internal) return json(response, 403, { code: "insufficient_scope" });
      return json(response, 200, {
        buildId: BUILD_ID,
        repository: REPOSITORY,
        ref: REF,
        status: "completed",
        stages: [
          {
            id: "publication",
            type: "publish-context-release",
            title: "Publish context release",
            status: "done",
            attempt: 1,
            updatedAt: release.publishedAt
          },
          {
            id: "pageindex",
            type: "index-context-release",
            title: "Index context release",
            status: "done",
            attempt: 1,
            updatedAt: release.publishedAt
          }
        ],
        pages: [
          {
            documentPath: "architecture.md",
            title: document.title,
            bytes: 100,
            validationStatus: "valid",
            diagnostics: [],
            checkpointSequence: 1,
            updatedAt: release.publishedAt
          }
        ],
        updatedAt: release.publishedAt
      });
    }
    if (url.pathname === "/wiki/releases") {
      return json(response, 200, { releases: [release, oldRelease] });
    }
    if (url.pathname === "/wiki/list") return json(response, 200, catalog);
    if (url.pathname === "/wiki/read") return json(response, 200, read);
    if (url.pathname === "/wiki/diff") return json(response, 200, diff);
    if (url.pathname === "/wiki/search" && request.method === "POST") {
      return json(response, 200, search);
    }
    return json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const report = await runContextSurfaceAcceptance({
      apiUrl: `http://127.0.0.1:${address.port}`,
      tenantId: TENANT,
      internalToken: INTERNAL_TOKEN,
      queryToken: QUERY_TOKEN,
      repository: REPOSITORY,
      ref: REF,
      buildId: BUILD_ID,
      timeoutMs: 5_000
    });
    assert.equal(report.releaseId, CURRENT_RELEASE);
    assert.equal(report.fromReleaseId, OLD_RELEASE);
    assert.deepEqual(report.mcp.tools, ["search_context", "list_context", "read_context", "diff_context"]);
    assert.equal(report.mcp.calls, 4);
    assert.equal(report.catalog.citations.urls > 0, true);
    assert.equal(report.catalog.citations.ranges > 0, true);
    assert.equal(report.retrieval.answerGenerated, false);
    assert.equal(report.ui.status, "prerequisite");
    assert.equal(report.ui.prerequisite.length, 2);
    assert.ok(
      requests.some((entry) => entry.path === "/wiki/metrics" && entry.authorization === `Bearer ${QUERY_TOKEN}`)
    );
    assert.ok(requests.some((entry) => entry.tenant !== TENANT));
    assert.equal(
      requests.some((entry) => entry.path === "/internal/context/tokens"),
      false,
      "static mode unexpectedly minted a credential"
    );

    const issuedReport = await runContextSurfaceAcceptance({
      apiUrl: `http://127.0.0.1:${address.port}`,
      tenantId: TENANT,
      internalToken: INTERNAL_TOKEN,
      credentialMode: "issued",
      internalPrincipalId: `tenant:${TENANT}`,
      issuedPrincipalId: ISSUED_PRINCIPAL,
      issuedAccessMode: "sync-bound",
      repository: REPOSITORY,
      ref: REF,
      buildId: BUILD_ID,
      timeoutMs: 5_000
    });
    assert.equal(accessSynchronized, true);
    assert.equal(issuedReport.releaseId, CURRENT_RELEASE);
    assert.deepEqual(issuedReport.mcp.tools, ["search_context", "list_context", "read_context", "diff_context"]);
    assert.deepEqual(issuedReport.issuedCredential.scopes, ["context:read", "context:query"]);
    assert.equal(issuedReport.issuedCredential.principalId, ISSUED_PRINCIPAL);
    assert.equal(issuedReport.issuedCredential.accessMode, "sync-bound");
    assert.deepEqual(issuedReport.issuedCredential.boundaries, {
      build: 403,
      admin: 403,
      board: 403,
      tokenAdministration: 401,
      crossTenant: 401
    });
    assert.deepEqual(issuedReport.issuedCredential.revocation, {
      status: "revoked",
      http: 401,
      mcp: 401
    });
    assert.equal(issuedRevoked, true);
    assert.ok(
      requests.some(
        (entry) =>
          entry.path === `/internal/context/tokens/${ISSUED_TOKEN_ID}/revoke` &&
          entry.authorization === `Bearer ${INTERNAL_TOKEN}`
      )
    );
    assert.ok(
      requests.some(
        (entry) => entry.path === "/mcp" && entry.authorization === `Bearer ${ISSUED_SECRET}` && entry.issuedRevoked
      )
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("surface harness rejects non-loopback endpoints before making a request", async () => {
  let called = false;
  await assert.rejects(
    () =>
      runContextSurfaceAcceptance(
        {
          apiUrl: "https://example.com",
          tenantId: TENANT,
          internalToken: INTERNAL_TOKEN,
          queryToken: QUERY_TOKEN,
          repository: REPOSITORY,
          ref: REF,
          buildId: BUILD_ID
        },
        {
          fetch: async () => {
            called = true;
            throw new Error("must not fetch");
          }
        }
      ),
    /loopback|local HTTP/
  );
  assert.equal(called, false);
});

test("issued mode revokes and proves HTTP and MCP rejection when acceptance fails", async () => {
  const paths = [];
  let revoked = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push({ path: url.pathname, authorization: request.headers.authorization, revoked });
    if (url.pathname === "/internal/context/tokens" && request.method === "POST") {
      response.setHeader("cache-control", "no-store");
      return json(response, 201, {
        secret: ISSUED_SECRET,
        token: {
          id: ISSUED_TOKEN_ID,
          name: "failure cleanup",
          principalId: ISSUED_PRINCIPAL,
          scopes: ["context:read", "context:query"],
          createdAt: "2026-07-29T12:02:00.000Z",
          expiresAt: "2026-07-29T12:17:00.000Z"
        }
      });
    }
    if (url.pathname === `/internal/context/tokens/${ISSUED_TOKEN_ID}/revoke`) {
      revoked = true;
      return json(response, 200, {
        token: {
          id: ISSUED_TOKEN_ID,
          principalId: ISSUED_PRINCIPAL,
          scopes: ["context:read", "context:query"],
          createdAt: "2026-07-29T12:02:00.000Z",
          expiresAt: "2026-07-29T12:17:00.000Z",
          revokedAt: "2026-07-29T12:03:00.000Z"
        }
      });
    }
    if (request.headers.authorization === `Bearer ${ISSUED_SECRET}` && revoked) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (url.pathname === "/wiki/releases") {
      return json(response, 500, { error: "deliberate acceptance failure" });
    }
    return json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      () =>
        runContextSurfaceAcceptance({
          apiUrl: `http://127.0.0.1:${address.port}`,
          tenantId: TENANT,
          internalToken: INTERNAL_TOKEN,
          credentialMode: "issued",
          internalPrincipalId: `tenant:${TENANT}`,
          issuedPrincipalId: ISSUED_PRINCIPAL,
          issuedAccessMode: "pregranted",
          repository: REPOSITORY,
          ref: REF,
          buildId: BUILD_ID,
          timeoutMs: 5_000
        }),
      /HTTP 500/
    );
    assert.equal(revoked, true);
    assert.ok(
      paths.some(
        (entry) =>
          entry.path === `/internal/context/tokens/${ISSUED_TOKEN_ID}/revoke` &&
          entry.authorization === `Bearer ${INTERNAL_TOKEN}`
      )
    );
    assert.ok(
      paths.some(
        (entry) => entry.path === "/wiki/releases" && entry.authorization === `Bearer ${ISSUED_SECRET}` && entry.revoked
      )
    );
    assert.ok(
      paths.some((entry) => entry.path === "/mcp" && entry.authorization === `Bearer ${ISSUED_SECRET}` && entry.revoked)
    );
    assert.equal(
      paths.some((entry) => entry.path === "/internal/context/access/sync"),
      false,
      "pregranted mode unexpectedly mutated repository ACL"
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function handleMcp(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, {
      "content-type": "application/json; charset=utf-8",
      allow: "POST"
    });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null
      })
    );
    return;
  }
  const body = await readJson(request);
  const server = new McpServer({ name: "surface-mock", version: "1.0.0" });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
  const schema = {};
  server.registerTool("search_context", { inputSchema: schema, annotations }, async () => result(search));
  server.registerTool("list_context", { inputSchema: schema, annotations }, async () => result(catalog));
  server.registerTool("read_context", { inputSchema: schema, annotations }, async () => result(read));
  server.registerTool("diff_context", { inputSchema: schema, annotations }, async () => result(diff));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);
  response.once("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(request, response, body);
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
