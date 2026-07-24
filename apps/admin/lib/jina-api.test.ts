import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  askGraph,
  getGraph,
  listAdminOperations,
  listAllAdminOperations,
  listAllGraphs,
  startGraphBuild
} from "./jina-api.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  JINA_API_URL: process.env.JINA_API_URL,
  INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN,
  JINA_GLOBAL_ADMIN_TOKEN: process.env.JINA_GLOBAL_ADMIN_TOKEN,
  JINA_TENANT_ID: process.env.JINA_TENANT_ID
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv("JINA_API_URL", ORIGINAL_ENV.JINA_API_URL);
  restoreEnv("INTERNAL_API_TOKEN", ORIGINAL_ENV.INTERNAL_API_TOKEN);
  restoreEnv("JINA_GLOBAL_ADMIN_TOKEN", ORIGINAL_ENV.JINA_GLOBAL_ADMIN_TOKEN);
  restoreEnv("JINA_TENANT_ID", ORIGINAL_ENV.JINA_TENANT_ID);
});

test("global graph listing uses the dedicated credential without a tenant header", { concurrency: false }, async () => {
  process.env.JINA_API_URL = "https://api.example.test";
  process.env.INTERNAL_API_TOKEN = "internal-secret";
  process.env.JINA_GLOBAL_ADMIN_TOKEN = "global-secret";
  process.env.JINA_TENANT_ID = "fixed-tenant";

  let receivedUrl = "";
  let receivedHeaders: Headers | undefined;
  globalThis.fetch = async (input, init) => {
    receivedUrl = String(input);
    receivedHeaders = new Headers(init?.headers);
    return Response.json({
      graphs: [
        graphSummary("tenant-a", "org/first", "2026-07-22T00:00:00.000Z"),
        graphSummary("tenant-b", "org/second", "2026-07-23T00:00:00.000Z")
      ]
    });
  };

  const graphs = await listAllGraphs();

  assert.equal(receivedUrl, "https://api.example.test/internal/admin/context-graph");
  assert.equal(receivedHeaders?.get("authorization"), "Bearer global-secret");
  assert.equal(receivedHeaders?.has("x-jina-tenant-id"), false);
  assert.deepEqual(
    graphs.map((graph) => graph.tenantId),
    ["tenant-b", "tenant-a"]
  );
});

test("graph reads and queries use the internal credential with the graph tenant", { concurrency: false }, async () => {
  process.env.JINA_API_URL = "https://api.example.test";
  process.env.INTERNAL_API_TOKEN = "internal-secret";
  process.env.JINA_GLOBAL_ADMIN_TOKEN = "global-secret";

  const requests: { url: string; headers: Headers; body?: string }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: init.body } : {})
    });
    if (String(input).endsWith("/context-graph/ask")) {
      return Response.json({ answer: "Found it.", citedClaims: [] });
    }
    return Response.json({
      ...graphSummary("tenant-b", "org/second", "2026-07-23T00:00:00.000Z"),
      nodes: [],
      edges: []
    });
  };

  const graph = await getGraph("graph/b", "tenant-b");
  assert.ok(graph);
  await askGraph(graph, "Where is authentication?", "user:admin@example.com");

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.get("authorization"), "Bearer internal-secret");
    assert.equal(request.headers.get("x-jina-tenant-id"), "tenant-b");
  }
  assert.equal(requests[0]?.url, "https://api.example.test/context-graph/graphs/graph%2Fb");
  assert.equal(requests[1]?.url, "https://api.example.test/context-graph/ask");
  assert.equal(requests[1]?.headers.get("x-jina-actor-id"), "user:admin@example.com");
  assert.equal(requests[1]?.headers.get("x-jina-access-channel"), "admin");
});

test("global operations use the read-only cross-tenant credential", { concurrency: false }, async () => {
  process.env.JINA_API_URL = "https://api.example.test";
  process.env.INTERNAL_API_TOKEN = "internal-secret";
  process.env.JINA_GLOBAL_ADMIN_TOKEN = "global-secret";

  let receivedUrl = "";
  let receivedHeaders: Headers | undefined;
  globalThis.fetch = async (input, init) => {
    receivedUrl = String(input);
    receivedHeaders = new Headers(init?.headers);
    return Response.json({ observedAt: "2026-07-23T00:00:00.000Z", tenants: [], queueDepth: 0 });
  };

  const operations = await listAdminOperations({
    limit: 100,
    tenantId: "tenant-a",
    statuses: ["done", "failed"],
    trigger: "manual"
  });

  assert.equal(
    receivedUrl,
    "https://api.example.test/internal/admin/context-graph/operations?limit=100&tenantId=tenant-a&statuses=done%2Cfailed&trigger=manual"
  );
  assert.equal(receivedHeaders?.get("authorization"), "Bearer global-secret");
  assert.deepEqual(operations.tenants, []);
});

test("global operations consume every cursor when a complete range is requested", { concurrency: false }, async () => {
  process.env.JINA_API_URL = "https://api.example.test";
  process.env.INTERNAL_API_TOKEN = "internal-secret";
  process.env.JINA_GLOBAL_ADMIN_TOKEN = "global-secret";

  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const second = url.includes("cursor=next-page");
    return Response.json({
      observedAt: "2026-07-23T00:00:00.000Z",
      queueDepth: 4,
      tenants: [
        {
          tenantId: "tenant-a",
          ...(second
            ? {}
            : {
                name: "Acme Workspace",
                kind: "team",
                githubAccountLogin: "acme",
                repositoryCount: 3,
                githubConnections: [
                  {
                    installationId: "101",
                    login: "acme",
                    type: "Organization",
                    repositoryCount: 3
                  }
                ]
              }),
          workflows: [],
          metrics: {}
        }
      ],
      ...(second ? {} : { nextCursor: "next-page" })
    });
  };

  const operations = await listAllAdminOperations({
    activityAfter: "2026-07-22T00:00:00.000Z"
  });

  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? "", /limit=500/);
  assert.match(urls[1] ?? "", /cursor=next-page/);
  assert.equal(operations.queueDepth, 4);
  assert.deepEqual(
    operations.tenants.map((tenant) => ({
      tenantId: tenant.tenantId,
      name: tenant.name,
      kind: tenant.kind,
      githubAccountLogin: tenant.githubAccountLogin,
      repositoryCount: tenant.repositoryCount,
      githubConnections: tenant.githubConnections
    })),
    [
      {
        tenantId: "tenant-a",
        name: "Acme Workspace",
        kind: "team",
        githubAccountLogin: "acme",
        repositoryCount: 3,
        githubConnections: [
          {
            installationId: "101",
            login: "acme",
            type: "Organization",
            repositoryCount: 3
          }
        ]
      }
    ]
  );
});

test("graph builds use the internal credential and explicit tenant installation", { concurrency: false }, async () => {
  process.env.JINA_API_URL = "https://api.example.test";
  process.env.INTERNAL_API_TOKEN = "internal-secret";
  process.env.JINA_GLOBAL_ADMIN_TOKEN = "global-secret";

  let receivedHeaders: Headers | undefined;
  let receivedBody = "";
  globalThis.fetch = async (_input, init) => {
    receivedHeaders = new Headers(init?.headers);
    receivedBody = String(init?.body);
    return Response.json({ task: { id: "build-1" } }, { status: 202 });
  };

  const result = await startGraphBuild({
    tenantId: "tenant-a",
    repository: "omxyz/jina",
    ref: "main",
    githubInstallationId: 140435029
  });

  assert.equal(result.task.id, "build-1");
  assert.equal(receivedHeaders?.get("authorization"), "Bearer internal-secret");
  assert.equal(receivedHeaders?.get("x-jina-tenant-id"), "tenant-a");
  const body = JSON.parse(receivedBody) as Record<string, unknown>;
  assert.equal(body.githubInstallationId, 140435029);
  assert.match(String(body.requestKey), /^admin-/);
});

test(
  "local graph listing falls back to the configured tenant without a global credential",
  { concurrency: false },
  async () => {
    process.env.JINA_API_URL = "https://api.example.test";
    process.env.INTERNAL_API_TOKEN = "internal-secret";
    delete process.env.JINA_GLOBAL_ADMIN_TOKEN;
    process.env.JINA_TENANT_ID = "local-tenant";

    let receivedUrl = "";
    let receivedHeaders: Headers | undefined;
    globalThis.fetch = async (input, init) => {
      receivedUrl = String(input);
      receivedHeaders = new Headers(init?.headers);
      return Response.json({ graphs: [] });
    };

    await listAllGraphs();

    assert.equal(receivedUrl, "https://api.example.test/context-graph");
    assert.equal(receivedHeaders?.get("authorization"), "Bearer internal-secret");
    assert.equal(receivedHeaders?.get("x-jina-tenant-id"), "local-tenant");
  }
);

function graphSummary(tenantId: string, repository: string, generatedAt: string) {
  return {
    id: `${tenantId}-graph`,
    tenantId,
    repository,
    ref: "refs/heads/main",
    commitSha: "a".repeat(40),
    generatedAt,
    generator: { executor: "fixture", model: "test" },
    summary: repository,
    nodeCount: 1,
    edgeCount: 0
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
