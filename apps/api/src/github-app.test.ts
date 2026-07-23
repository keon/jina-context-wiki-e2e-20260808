import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createContextGraph,
  MemoryContextGraphStore,
  MemoryContextGraphPipelineCoordinator,
  CONTEXT_GRAPH_PARSER_VERSION,
  type BlobAnalysis,
  type RetrievalRequest,
  type RetrievalResult
} from "@jina/context-graph";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";
import { resolveDatabaseConfigs } from "./database-config.js";

const SECRET = "test-webhook-secret";
const INTERNAL_TOKEN = "test-internal-token";
const GRAPH_TOKEN = "test-graph-token";
const TENANT = "github:installation:99";
const SHARED_TENANT = "5f4d1548-7e14-4f9e-a6e2-e7d38b61b1c2";

test("database config keeps graph storage on the primary database when no graph override exists", () => {
  const configs = resolveDatabaseConfigs({
    DATABASE_URL: "postgresql://primary.example/jina"
  });

  assert.deepEqual(configs, {
    primary: { connectionString: "postgresql://primary.example/jina" },
    graph: { connectionString: "postgresql://primary.example/jina" },
    graphIsDedicated: false
  });
});

test("database config isolates graph storage when an explicit graph connection exists", () => {
  const configs = resolveDatabaseConfigs({
    INSTANCE_UNIX_SOCKET: "/cloudsql/original:us-east1:jina-db",
    DB_USER: "jina_v2_app",
    DB_PASS: "primary-password",
    DB_NAME: "jina",
    GRAPH_INSTANCE_UNIX_SOCKET: "/cloudsql/jina-v2:us-central1:jina-postgres",
    GRAPH_DB_USER: "jina_app",
    GRAPH_DB_PASS: "graph-password",
    GRAPH_DB_NAME: "jina"
  });

  assert.deepEqual(configs, {
    primary: {
      host: "/cloudsql/original:us-east1:jina-db",
      user: "jina_v2_app",
      password: "primary-password",
      database: "jina"
    },
    graph: {
      host: "/cloudsql/jina-v2:us-central1:jina-postgres",
      user: "jina_app",
      password: "graph-password",
      database: "jina"
    },
    graphIsDedicated: true
  });
});

test("database config fails closed on a partial graph database override", () => {
  assert.throws(
    () =>
      resolveDatabaseConfigs({
        DATABASE_URL: "postgresql://primary.example/jina",
        GRAPH_DB_NAME: "jina"
      }),
    /GRAPH_DATABASE_URL or GRAPH_INSTANCE_UNIX_SOCKET\/GRAPH_DB_HOST is required/
  );
});

test("disabled GitHub intake acknowledges signed deliveries without creating work", async (context) => {
  const server = createApiServer({
    githubWebhookSecret: SECRET,
    githubWebhookEnabled: false,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: TENANT
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  );

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await deliver(baseUrl, "pull_request", "delivery-disabled", pullRequestPayload(42, "abc123"));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: false,
    reason: "GitHub webhook intake is disabled; original Jina owns review intake"
  });
  const board = await authenticatedFetch(`${baseUrl}/board`).then(
    (value) => value.json() as Promise<{ tasks: unknown[] }>
  );
  assert.deepEqual(board.tasks, []);
});

test("signed GitHub App deliveries create idempotent PR and issue tasks", async (context) => {
  const server = createApiServer({ githubWebhookSecret: SECRET, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  );

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const issuePayload = issueOpenedPayload();

  const rejected = await deliver(baseUrl, "issues", "delivery-bad", issuePayload, "wrong-secret");
  assert.equal(rejected.status, 401);

  const issue = await deliver(baseUrl, "issues", "delivery-issue-1", issuePayload);
  assert.equal(issue.status, 202);
  assert.equal(((await issue.json()) as { outcome: string }).outcome, "created");

  const repeatedDelivery = await deliver(baseUrl, "issues", "delivery-issue-1", issuePayload);
  assert.equal(repeatedDelivery.status, 200);
  assert.equal(((await repeatedDelivery.json()) as { duplicate: boolean }).duplicate, true);

  const sameIssueNewDelivery = await deliver(baseUrl, "issues", "delivery-issue-redelivery", issuePayload);
  assert.equal(((await sameIssueNewDelivery.json()) as { outcome: string }).outcome, "duplicate");

  const pullRequest = await deliver(baseUrl, "pull_request", "delivery-pr-1", pullRequestPayload(42, "abc123"));
  assert.equal(pullRequest.status, 202);
  assert.equal(((await pullRequest.json()) as { createdTaskIds: string[] }).createdTaskIds.length, 3);

  await deliver(baseUrl, "pull_request", "delivery-pr-2", pullRequestPayload(43, "other123"));
  await deliver(baseUrl, "pull_request", "delivery-pr-1-sync", pullRequestPayload(42, "def456", "synchronize"));

  assert.equal((await fetch(`${baseUrl}/board`)).status, 401);
  const boardResponse = await authenticatedFetch(`${baseUrl}/board`);
  const board = (await boardResponse.json()) as {
    tasks: { type: string; status: string; metadata: Record<string, unknown> }[];
    dependencies: {
      taskId: string;
      dependsOnTaskId: string;
      relationship: string;
      required: boolean;
    }[];
    outbox: { topic: string }[];
  };

  assert.equal(board.tasks.filter((task) => task.type === "issue_triage").length, 1);
  assert.equal(board.tasks.find((task) => task.type === "issue_triage")?.status, "triage");
  assert.equal(board.tasks.find((task) => task.type === "issue_triage")?.metadata.authorGithubUserId, 101);
  assert.equal(board.tasks.filter((task) => task.type === "pr_review").length, 3);
  assert.equal(
    board.tasks.find((task) => task.type === "pr_review" && task.metadata.pullRequestNumber === 43)?.metadata
      .authorGithubUserId,
    101
  );
  assert.equal(
    board.tasks.find((task) => task.type === "pr_review" && task.metadata.pullRequestNumber === 43)?.metadata
      .senderGithubUserId,
    101
  );
  assert.equal(
    board.tasks.find((task) => task.type === "pr_review" && task.metadata.pullRequestNumber === 43)?.metadata
      .githubAccountId,
    "202"
  );
  assert.equal(
    board.tasks.filter((task) => task.metadata.pullRequestNumber === 43).some((task) => task.status === "superseded"),
    false,
    "synchronizing one PR must not supersede another PR's tasks"
  );
  assert.equal(
    board.tasks.find(
      (task) =>
        task.type === "review_pass" && task.metadata.pullRequestNumber === 42 && task.metadata.headSha === "def456"
    )?.status,
    "queued"
  );
  assert.equal(board.outbox.filter((message) => message.topic === "run-review").length, 3);
  assert.equal(board.dependencies.length, 12);
  assert.equal(
    board.dependencies.some((dependency) => dependency.relationship === "blocks" && dependency.required),
    true
  );

  const taskTypes = await fetch(`${baseUrl}/task-types`).then(
    (response) =>
      response.json() as Promise<
        {
          type: string;
          kind: string;
          description: string;
          triggeredBy: { source: string; description: string; conditions: string[] }[];
          dependsOn: { taskType: string; relationships: string[]; conditions: string[] }[];
          requiredBy: { taskType: string; relationships: string[] }[];
        }[]
      >
  );
  assert.equal(taskTypes.length, 11);
  assert.deepEqual(
    taskTypes.map((definition) => definition.type),
    [
      "pr_review",
      "review_pass",
      "context",
      "publish",
      "cleanup",
      "issue_triage",
      "human_decision",
      "context_graph_build",
      "context_graph_ingest",
      "context_graph_assert",
      "context_graph_project"
    ]
  );
  assert.equal(
    taskTypes.every((definition) => definition.kind.length > 0 && definition.description.length > 0),
    true
  );
  assert.deepEqual(taskTypes.find((definition) => definition.type === "context_graph_ingest")?.triggeredBy, [
    {
      source: "POST /context-graph/build",
      description: "Creates and queues the first executable context graph task.",
      conditions: []
    },
    {
      source: "GitHub push webhook",
      description: "Queues repository intake for a pushed branch head.",
      conditions: []
    }
  ]);
  assert.equal(
    taskTypes.find((definition) => definition.type === "context_graph_assert")?.triggeredBy[0]?.source,
    "POST /context-graph/build"
  );
  assert.equal(
    taskTypes.find((definition) => definition.type === "context_graph_project")?.triggeredBy[0]?.source,
    "POST /context-graph/build"
  );
  assert.equal(
    taskTypes.find((definition) => definition.type === "publish")?.triggeredBy[0]?.source,
    "GitHub pull_request webhook"
  );
  assert.deepEqual(taskTypes.find((definition) => definition.type === "context_graph_project")?.dependsOn, [
    {
      taskType: "context_graph_ingest",
      relationships: ["blocks"],
      workflows: ["context_graph_build"],
      required: true,
      conditions: []
    }
  ]);
  assert.deepEqual(taskTypes.find((definition) => definition.type === "review_pass")?.dependsOn, [
    {
      taskType: "context",
      relationships: ["context_for"],
      workflows: ["pr_review"],
      required: true,
      conditions: ["when external context is requested"]
    }
  ]);
  assert.deepEqual(
    taskTypes
      .find((definition) => definition.type === "review_pass")
      ?.requiredBy.map((dependency) => dependency.taskType),
    ["pr_review", "publish"]
  );
});

test("shared tenancy resolves original Jina organizations and scopes workers and board reads", async (context) => {
  const resolutions: unknown[] = [];
  const sharedIdentityResolver = {
    async resolveRepository(input: unknown) {
      resolutions.push(input);
      const repository = (input as { repository: string }).repository;
      if (repository !== "omlabs/example") return undefined;
      return {
        tenantId: SHARED_TENANT,
        githubAccountId: "202",
        githubAccountLogin: "omlabs",
        githubAccountType: "Organization",
        githubRepositoryId: "10",
        repository,
        defaultBranch: "main"
      };
    },
    async listTenantIds() {
      return [SHARED_TENANT];
    },
    async ping() {},
    async close() {}
  };
  const server = createApiServer({
    githubWebhookSecret: SECRET,
    internalApiToken: INTERNAL_TOKEN,
    graphApiToken: GRAPH_TOKEN,
    sharedIdentityResolver
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  );
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const delivered = await deliver(baseUrl, "pull_request", "shared-pr-1", pullRequestPayload(42, "abc123"));
  assert.equal(delivered.status, 202);
  assert.deepEqual(resolutions, [{ repository: "omlabs/example", githubRepositoryId: 10, githubInstallationId: 99 }]);

  assert.equal((await authenticatedFetch(`${baseUrl}/board`)).status, 401);
  const boardResponse = await fetch(`${baseUrl}/board`, {
    headers: {
      authorization: `Bearer ${INTERNAL_TOKEN}`,
      "x-jina-tenant-id": SHARED_TENANT
    }
  });
  assert.equal(boardResponse.status, 200);
  const board = (await boardResponse.json()) as { tasks: { metadata: Record<string, unknown> }[] };
  assert.equal(board.tasks.length, 3);
  assert.equal(
    board.tasks.every((task) => task.metadata.tenantId === SHARED_TENANT),
    true
  );
  const graphOverviewResponse = await fetch(`${baseUrl}/overview`, {
    headers: {
      authorization: `Bearer ${GRAPH_TOKEN}`,
      "x-jina-tenant-id": SHARED_TENANT,
      "x-jina-principal-id": `tenant:${SHARED_TENANT}`
    }
  });
  assert.equal(graphOverviewResponse.status, 200);
  assert.equal(
    board.tasks.every((task) => task.metadata.workspaceLabel === "omlabs"),
    true
  );
  assert.equal(
    board.tasks.every((task) => task.metadata.githubAccountId === "202"),
    true
  );
  assert.equal(
    board.tasks.every((task) => task.metadata.authorGithubUserId === 101),
    true
  );

  const claim = await fetch(`${baseUrl}/internal/worker/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "shared-worker", topics: ["run-review"] })
  });
  assert.equal(claim.status, 200);
  const claimed = (await claim.json()) as { task: { metadata: Record<string, unknown> } };
  assert.equal(claimed.task.metadata.tenantId, SHARED_TENANT);

  const unknownPayload = pullRequestPayload(43, "def456") as Record<string, unknown>;
  unknownPayload.repository = {
    id: 11,
    full_name: "elsewhere/unknown",
    owner: { id: 303, login: "elsewhere", type: "Organization" }
  };
  const unknown = await deliver(baseUrl, "pull_request", "shared-pr-unknown", unknownPayload);
  assert.equal(unknown.status, 409);
  assert.equal(((await unknown.json()) as { code: string }).code, "repository_tenant_not_found");
});

test("branch pushes create and supersede the existing context graph workflow", async (context) => {
  const server = createApiServer({ githubWebhookSecret: SECRET, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  );
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const first = await deliver(baseUrl, "push", "push-1", pushPayload("a".repeat(40)));
  assert.equal(first.status, 202);
  assert.equal(((await first.json()) as { createdTaskIds: string[] }).createdTaskIds.length, 6);
  const repeatedHead = await deliver(baseUrl, "push", "push-2", pushPayload("a".repeat(40)));
  assert.equal(((await repeatedHead.json()) as { outcome: string }).outcome, "duplicate");
  const second = await deliver(baseUrl, "push", "push-3", pushPayload("b".repeat(40)));
  assert.equal(((await second.json()) as { createdTaskIds: string[] }).createdTaskIds.length, 6);
  const returned = await deliver(baseUrl, "push", "push-4", pushPayload("a".repeat(40)));
  assert.equal(
    ((await returned.json()) as { createdTaskIds: string[] }).createdTaskIds.length,
    6,
    "moving a branch back to an earlier SHA is a new ref transition, not a redelivery"
  );

  const board = await authenticatedFetch(`${baseUrl}/board`).then(
    (response) =>
      response.json() as Promise<{
        tasks: { type: string; status: string; metadata: Record<string, unknown> }[];
      }>
  );
  const current = board.tasks.filter((task) => task.metadata.githubDeliveryId === "push-4");
  const old = board.tasks.filter((task) => task.metadata.githubDeliveryId === "push-3");
  assert.deepEqual(current.map((task) => task.type).sort(), [
    "context_graph_assert",
    "context_graph_build",
    "context_graph_ingest",
    "context_graph_ingest",
    "context_graph_project",
    "context_graph_project"
  ]);
  assert.equal(current.find((task) => task.type === "context_graph_ingest")?.status, "queued");
  assert.equal(
    current.every((task) => task.metadata.githubInstallationId === 99),
    true,
    "the webhook installation id is durable across every graph stage"
  );
  assert.equal(
    old.every((task) => task.status === "superseded"),
    true
  );

  const directBuild = await fetch(`${baseUrl}/context-graph/build`, {
    method: "POST",
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repository: "omlabs/example", ref: "main", requestKey: "operator-retry" })
  });
  assert.equal(directBuild.status, 202);
  const retriedBoard = await authenticatedFetch(`${baseUrl}/board`).then(
    (response) => response.json() as Promise<{ tasks: { metadata: Record<string, unknown> }[] }>
  );
  const retried = retriedBoard.tasks.filter((task) => task.metadata.requestKey === "operator-retry");
  assert.equal(retried.length, 6);
  assert.equal(
    retried.every((task) => task.metadata.githubInstallationId === 99),
    true,
    "operator retries inherit the last recorded installation id for the repository"
  );
});

test("context graph retrieval forwards generalized Issue identity and Feature text", async () => {
  class CapturingContextGraphStore extends MemoryContextGraphStore {
    request?: RetrievalRequest;

    override async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
      this.request = request;
      return {
        template: request.template,
        repository: request.repository,
        ref: request.ref ?? "main",
        items: [],
        truncated: false,
        totalBeforeLimit: 0,
        limit: request.limit ?? 50
      };
    }
  }
  const contextGraphStore = new CapturingContextGraphStore();
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default", contextGraphStore });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/context-graph/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/context-graph-fixture",
        template: "issue_trace",
        issueEntityId: "entity_virtual_issue"
      })
    });
    assert.equal(response.status, 200);
    assert.equal(contextGraphStore.request?.issueEntityId, "entity_virtual_issue");
    const featureResponse = await fetch(`${baseUrl}/context-graph/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/context-graph-fixture",
        template: "feature_trace",
        featureText: "administrator deletion"
      })
    });
    assert.equal(featureResponse.status, 200);
    assert.equal(contextGraphStore.request?.featureText, "administrator deletion");
  } finally {
    await close(server);
  }
});

test("MCP exposes one authorized graph query with cited structured output", async () => {
  class QueryContextGraphStore extends MemoryContextGraphStore {
    override async repositoriesForPrincipal(_tenantId: string, principalId: string): Promise<readonly string[]> {
      return principalId === "user:reader@example.com" ? ["omxyz/context-graph-fixture"] : [];
    }

    override async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
      if (!request.allowedRepositories.includes(request.repository)) throw new Error("repository access denied");
      return {
        template: request.template,
        repository: request.repository,
        ref: request.ref ?? "main",
        items: [
          {
            kind: "symbol_definition",
            title: "main is defined in src/index.ts",
            data: { symbol: "main", path: "src/index.ts" },
            citations: [
              {
                kind: "code",
                id: "blob-main:1-3",
                repository: request.repository,
                commitSha: "a".repeat(40),
                path: "src/index.ts",
                startLine: 1,
                endLine: 3
              }
            ],
            score: 1
          }
        ],
        truncated: false,
        totalBeforeLimit: 1,
        limit: request.limit ?? 50
      };
    }
  }

  const server = createApiServer({
    contextGraphStore: new QueryContextGraphStore(),
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "tenant-a"
  });
  const baseUrl = await listen(server);
  const client = new Client({ name: "jina-api-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": "user:reader@example.com"
      }
    }
  });
  const strangerClient = new Client({ name: "jina-api-stranger-test", version: "1.0.0" });
  const strangerTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": "user:stranger@example.com"
      }
    }
  });
  try {
    assert.equal((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }
        })
      ).status,
      401
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${INTERNAL_TOKEN}`,
            "x-jina-principal-id": "user:reader@example.com",
            origin: "https://untrusted.example"
          }
        })
      ).status,
      403
    );

    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["query_graph"]
    );
    assert.equal(JSON.stringify(tools).includes("project"), false);

    const result = (await client.callTool({
      name: "query_graph",
      arguments: {
        repository: "omxyz/context-graph-fixture",
        query: "Where is main implemented?"
      }
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.match(String(result.content[0]?.type === "text" ? result.content[0].text : ""), /src\/index\.ts/);
    assert.deepEqual(result.structuredContent, {
      answer: "Found 1 cited structural fact for main: main is defined in src/index.ts.",
      claims: [
        {
          text: "main is defined in src/index.ts",
          citations: [
            {
              kind: "code",
              id: "blob-main:1-3",
              repository: "omxyz/context-graph-fixture",
              commitSha: "a".repeat(40),
              path: "src/index.ts",
              startLine: 1,
              endLine: 3
            }
          ]
        }
      ],
      incomplete: false,
      notes: []
    });

    await strangerClient.connect(strangerTransport as unknown as Transport);
    const denied = (await strangerClient.callTool({
      name: "query_graph",
      arguments: { repository: "omxyz/context-graph-fixture", query: "Where is main implemented?" }
    })) as CallToolResult;
    assert.equal(denied.isError, true);
  } finally {
    await strangerClient.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await close(server);
  }
});

test("development seed supports an interactive MCP graph query without credentials", async () => {
  const server = createApiServer({ enableDevEndpoints: true, seedDemo: true, tenantId: "default" });
  const baseUrl = await listen(server);
  const client = new Client({ name: "jina-dev-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await client.connect(transport as unknown as Transport);
    const result = (await client.callTool({
      name: "query_graph",
      arguments: {
        repository: "omlabs/example",
        query: "Where is handleWebhook implemented?"
      }
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.match(
      String(result.content[0]?.type === "text" ? result.content[0].text : ""),
      /handleWebhook is function in src\/server\.ts/
    );
  } finally {
    await client.close().catch(() => undefined);
    await close(server);
  }
});

test("API maps validation failures to typed client errors", async () => {
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/context-graph/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "structure" })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      accepted: false,
      error: "repository must be a non-empty string",
      code: "invalid_request"
    });
    const excessiveHistory = await fetch(`${baseUrl}/context-graph/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/example",
        metadata: { source: "jina-v1-dashboard", historyLimit: 10_001 }
      })
    });
    assert.equal(excessiveHistory.status, 400);
    assert.deepEqual(await excessiveHistory.json(), {
      accepted: false,
      error: "metadata.historyLimit must be an integer from 1 to 10000",
      code: "invalid_request"
    });
  } finally {
    await close(server);
  }
});

test("context graph pipeline ingests, asserts, projects, and reuses content-addressed blobs", async () => {
  const server = createApiServer({
    enableDevEndpoints: true,
    tenantId: "default"
  });
  const baseUrl = await listen(server);
  try {
    const created = await fetch(`${baseUrl}/context-graph/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/context-graph-fixture",
        ref: "main",
        requestKey: "test",
        snapshotFirst: true,
        metadata: {
          source: "jina-v1-review",
          pullRequestNumber: 42,
          authorLogin: "alice",
          historyLimit: 2_500
        }
      })
    });
    assert.equal(created.status, 202);
    const createdBody = (await created.json()) as { task: { id: string } };
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const readmeSha = "c".repeat(40);
    const sourceSha = "d".repeat(40);
    let ingestion = await claimTopic(baseUrl, "run-context-graph-ingest");
    assert.equal(ingestion.message.topic, "run-context-graph-ingest");
    assert.equal(ingestion.task.metadata?.pipelinePhase, "snapshot");
    assert.equal(ingestion.task.metadata?.historyLimit, 2_500);

    const renewed = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: ingestion.message.id, leaseId: ingestion.message.leaseId })
    });
    assert.equal(renewed.status, 200);
    const staleRenewal = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: ingestion.message.id, leaseId: "wrong-lease" })
    });
    assert.equal(staleRenewal.status, 409);
    const released = await fetch(`${baseUrl}/internal/worker/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: ingestion.message.id,
        leaseId: ingestion.message.leaseId,
        reason: "worker shutdown"
      })
    });
    assert.equal(released.status, 200);
    const reclaimed = await claimTopic(baseUrl, "run-context-graph-ingest");
    assert.equal(reclaimed.task.id, ingestion.task.id);
    assert.notEqual(reclaimed.message.leaseId, ingestion.message.leaseId);
    ingestion = reclaimed;

    const snapshot = {
      tenantId: "default",
      repository: "omxyz/context-graph-fixture",
      ref: "main",
      commitSha,
      treeSha,
      parents: [],
      recordedAt: new Date().toISOString(),
      taskId: ingestion.task.id,
      files: [
        { path: "README.md", blobSha: readmeSha, size: 40 },
        { path: "src/index.ts", blobSha: sourceSha, size: 80 }
      ]
    };
    const lease = { messageId: ingestion.message.id, leaseId: ingestion.message.leaseId };
    const firstPlan = (await postJson(baseUrl, "/internal/context-graph/ingest/plan", { ...lease, snapshot })) as {
      missingBlobs: unknown[];
      changedPaths: string[];
      observationId: string;
    };
    assert.equal(firstPlan.missingBlobs.length, 2);
    assert.deepEqual(firstPlan.changedPaths, ["README.md", "src/index.ts"]);
    await postJson(baseUrl, "/internal/context-graph/ingest/blobs", {
      taskId: ingestion.task.id,
      ...lease,
      commitSha,
      analyses: [
        {
          blobSha: readmeSha,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "markdown",
          symbols: [],
          imports: [],
          edges: []
        },
        {
          blobSha: sourceSha,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [
            { moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }
          ],
          imports: [],
          edges: []
        }
      ]
    });
    const secondPlan = (await postJson(baseUrl, "/internal/context-graph/ingest/plan", { ...lease, snapshot })) as {
      missingBlobs: unknown[];
      reusedBlobCount: number;
    };
    assert.equal(secondPlan.missingBlobs.length, 0);
    assert.equal(secondPlan.reusedBlobCount, 2);
    assert.equal(
      await completeClaim(baseUrl, ingestion, {
        observationId: firstPlan.observationId,
        commitSha,
        fileCount: 2,
        discoveredBlobCount: 2,
        reusedBlobCount: 0,
        parsedBlobCount: 2,
        parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
        codeCheckpoint: "code-checkpoint",
        evidenceFingerprint: "evidence-fixture"
      }),
      200
    );

    const historyIngestion = await claimTopic(baseUrl, "run-context-graph-ingest");
    assert.equal(historyIngestion.task.metadata?.pipelinePhase, "history");
    assert.equal(
      await completeClaim(baseUrl, historyIngestion, {
        observationId: firstPlan.observationId,
        commitSha,
        fileCount: 2,
        discoveredBlobCount: 2,
        reusedBlobCount: 2,
        parsedBlobCount: 0,
        parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
        codeCheckpoint: "code-checkpoint",
        evidenceFingerprint: "evidence-fixture"
      }),
      200
    );

    const assertion = await claimTopic(baseUrl, "run-context-graph-assert");
    assert.equal(assertion.message.topic, "run-context-graph-assert");
    const asserted = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: assertion.message.id,
        leaseId: assertion.message.leaseId,
        taskId: assertion.task.id,
        outcome: "done",
        assertionBatch: {
          tenantId: "default",
          repository: "omxyz/context-graph-fixture",
          ref: "main",
          commitSha,
          taskId: assertion.task.id,
          generatedAt: new Date().toISOString(),
          generatorVersion: "codex-assertions-v2",
          registryVersion: "context-graph-registry-v1",
          evidenceFingerprint: "evidence-fixture",
          evidenceObservationIds: [],
          model: "fixture",
          summary: "README documents the repository",
          rawOutput: {
            summary: "README documents the repository",
            nodes: [
              { id: "repo", kind: "Repository", label: "fixture", description: "repo", evidence: ["README.md:1"] },
              {
                id: "readme",
                kind: "Document",
                label: "README",
                description: "docs",
                path: "README.md",
                evidence: ["README.md:1"]
              }
            ],
            edges: [
              {
                source: "repo",
                target: "readme",
                predicate: "DOCUMENTED_BY",
                plane: "knowledge",
                confidence: 0.95,
                why: "The README explicitly documents this repository.",
                evidence: ["README.md:1"]
              }
            ]
          }
        }
      })
    });
    assert.equal(asserted.status, 200);

    const snapshotProjection = await claimTopic(baseUrl, "run-context-graph-project");
    assert.equal(snapshotProjection.task.metadata?.pipelinePhase, "snapshot");
    assert.equal(await completeClaim(baseUrl, snapshotProjection, { projected: true }), 200);
    const historyProjection = await claimTopic(baseUrl, "run-context-graph-project");
    assert.equal(historyProjection.task.metadata?.pipelinePhase, "history");
    assert.equal(await completeClaim(baseUrl, historyProjection, { projected: true }), 200);

    const contextGraph = await fetch(`${baseUrl}/context-graph`).then(
      (response) => response.json() as Promise<{ latest: { nodes: unknown[]; edges: unknown[] } | null }>
    );
    assert.equal((contextGraph.latest?.nodes.length ?? 0) >= 4, true);
    assert.equal((contextGraph.latest?.edges.length ?? 0) >= 3, true);

    const contextAnswer = await fetch(`${baseUrl}/context-graph/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/context-graph-fixture",
        ref: "main",
        question: "Where is main implemented?"
      })
    }).then(
      (response) =>
        response.json() as Promise<{
          answer: string;
          citedClaims: { text: string; citations: unknown[] }[];
          calls: { template: string; items: { kind: string }[] }[];
          unresolvedAmbiguities: string[];
          coverageGaps: unknown[];
        }>
    );
    assert.match(contextAnswer.answer, /main is function in src\/index\.ts/);
    assert.equal(contextAnswer.citedClaims[0]?.citations.length, 1);
    assert.equal(contextAnswer.calls[0]?.template, "structure");
    assert.equal(contextAnswer.calls[0]?.items[0]?.kind, "symbol_definition");
    assert.deepEqual(contextAnswer.unresolvedAmbiguities, []);
    assert.deepEqual(contextAnswer.coverageGaps, []);

    const board = await fetch(`${baseUrl}/board`).then(
      (response) =>
        response.json() as Promise<{
          tasks: { id: string; type: string; status: string; metadata: Record<string, unknown> }[];
        }>
    );
    assert.equal(board.tasks.find((task) => task.id === createdBody.task.id)?.status, "done");
    assert.equal(board.tasks.find((task) => task.id === createdBody.task.id)?.metadata.source, "jina-v1-review");
    assert.equal(board.tasks.find((task) => task.id === createdBody.task.id)?.metadata.pullRequestNumber, 42);
    assert.equal(board.tasks.find((task) => task.id === createdBody.task.id)?.metadata.authorLogin, "alice");
    assert.equal(board.tasks.find((task) => task.type === "context_graph_ingest")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "context_graph_assert")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "context_graph_project")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "context_graph_project")?.metadata.commitSha, commitSha);
    const ingestTiming = board.tasks.find((task) => task.type === "context_graph_ingest")?.metadata.timing as
      Record<string, unknown> | undefined;
    assert.ok(ingestTiming, "a completed stage exposes metadata.timing");
    assert.equal(typeof ingestTiming.startedAt, "string");
    assert.equal(typeof ingestTiming.completedAt, "string");
    assert.equal(typeof ingestTiming.durationMs, "number");
  } finally {
    await close(server);
  }
});

test("a new context graph attempt supersedes older active work for the same repository ref", async () => {
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    for (const requestKey of ["first", "second", "second"]) {
      const response = await fetch(`${baseUrl}/context-graph/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository: "omxyz/context-graph-fixture", ref: "main", requestKey })
      });
      assert.equal(response.status, 202);
    }
    const board = await fetch(`${baseUrl}/board`).then(
      (response) =>
        response.json() as Promise<{
          tasks: { type: string; status: string; metadata: Record<string, unknown> }[];
        }>
    );
    const first = board.tasks.filter((task) => task.metadata.requestKey === "first");
    const second = board.tasks.filter((task) => task.metadata.requestKey === "second");
    assert.equal(first.length, 6);
    assert.equal(
      first.every((task) => task.status === "superseded"),
      true
    );
    assert.equal(second.length, 6, "an idempotent request key does not duplicate the attempt");
    assert.equal(second.find((task) => task.type === "context_graph_ingest")?.status, "queued");
    assert.equal(
      "timing" in (second.find((task) => task.type === "context_graph_ingest")?.metadata ?? {}),
      false,
      "a never-started stage omits metadata.timing entirely"
    );
    assert.equal(
      second.some((task) => task.status === "blocked"),
      false
    );
  } finally {
    await close(server);
  }
});

test("durable workers can drain review and publish topics", async () => {
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    const intake = await fetch(`${baseUrl}/dev/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omlabs/example", pullRequestNumber: 22, headSha: "sha-22" })
    });
    assert.equal(intake.status, 202);

    const review = await claimTopic(baseUrl, "run-review");
    assert.equal(review.message.topic, "run-review");
    assert.equal(await completeClaim(baseUrl, review, { summary: "Reviewed", findingCount: 0 }), 200);

    const publish = await claimTopic(baseUrl, "run-publish");
    assert.equal(publish.message.topic, "run-publish");
    assert.equal(await completeClaim(baseUrl, publish, { published: true }), 200);

    const board = await fetch(`${baseUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: { type: string; status: string }[]; publications: unknown[] }>
    );
    assert.equal(board.tasks.find((task) => task.type === "review_pass")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "publish")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "pr_review")?.status, "done");
    assert.equal(board.publications.length, 1);
  } finally {
    await close(server);
  }
});

test("API validation rejects traversal, mixed worker topics, and stale leases with typed errors", async () => {
  const contextGraphStore = new MemoryContextGraphStore();
  await contextGraphStore.save(
    fixtureGraph({ tenantId: "default", repository: "owner/repo", ref: "main", taskId: "fixture" })
  );
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default", contextGraphStore });
  const baseUrl = await listen(server);
  try {
    const invalidRepository = await fetch(`${baseUrl}/context-graph/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "owner/..", ref: "main" })
    });
    assert.equal(invalidRepository.status, 400);
    assert.equal(((await invalidRepository.json()) as { code?: string }).code, "invalid_request");

    const mixedTopics = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "test", topics: ["run-review", "run-unknown"] })
    });
    assert.equal(mixedTopics.status, 400);
    assert.equal(((await mixedTopics.json()) as { code?: string }).code, "invalid_request");

    const staleRenewal = await fetch(`${baseUrl}/internal/worker/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "missing", leaseId: "expired" })
    });
    assert.equal(staleRenewal.status, 409);
    assert.equal(((await staleRenewal.json()) as { code?: string }).code, "stale_lease");

    const missingCompletion = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "missing", leaseId: "expired", taskId: "missing", outcome: "done" })
    });
    assert.equal(missingCompletion.status, 404);
    assert.equal(((await missingCompletion.json()) as { code?: string }).code, "not_found");

    const invalidKind = await fetch(`${baseUrl}/context-graph/assertions?repository=owner/repo&entityKind=Unknown`);
    assert.equal(invalidKind.status, 400);
    assert.equal(((await invalidKind.json()) as { code?: string }).code, "invalid_request");
  } finally {
    await close(server);
  }
});

test("context graph commands require a forwarded principal identity", async () => {
  const contextGraphStore = new MemoryContextGraphStore();
  const server = createApiServer({
    contextGraphStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "tenant-a",
    tenantAdminPrincipalIds: ["user:admin@example.com"]
  });
  const baseUrl = await listen(server);
  try {
    const command = JSON.stringify({
      type: "grant_repository_access",
      repository: "omxyz/a",
      principalId: "user:reader@example.com",
      role: "reader"
    });
    const withoutIdentity = await fetch(`${baseUrl}/context-graph/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" },
      body: command
    });
    assert.equal(withoutIdentity.status, 401, "the svc:api fallback must not execute context graph commands");
    const withIdentity = await fetch(`${baseUrl}/context-graph/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": "user:admin@example.com",
        "content-type": "application/json"
      },
      body: command
    });
    assert.equal(withIdentity.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("context graph reads require authentication and cannot cross tenant boundaries", async () => {
  const contextGraphStore = new MemoryContextGraphStore();
  const tenantAGraph = fixtureGraph({ tenantId: "tenant-a", repository: "omxyz/a", ref: "main", taskId: "task-a" });
  const tenantBGraph = fixtureGraph({ tenantId: "tenant-b", repository: "omxyz/b", ref: "main", taskId: "task-b" });
  await contextGraphStore.save(tenantAGraph);
  await contextGraphStore.save(tenantBGraph);
  await contextGraphStore.executeCommand(
    "tenant-a",
    "svc:test",
    {
      type: "grant_repository_access",
      repository: "omxyz/a",
      principalId: "user:reader@example.com",
      role: "reader"
    },
    "2026-07-20T00:00:00.000Z"
  );
  const server = createApiServer({
    contextGraphStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "tenant-a",
    tenantAdminPrincipalIds: ["user:admin@example.com"]
  });
  const baseUrl = await listen(server);
  try {
    assert.equal((await fetch(`${baseUrl}/context-graph`)).status, 401);
    const list = await authenticatedFetch(`${baseUrl}/context-graph`).then(
      (response) => response.json() as Promise<{ graphs: { id: string; tenantId: string }[] }>
    );
    assert.deepEqual(
      list.graphs.map((graph) => graph.tenantId),
      ["tenant-a"]
    );
    assert.equal((await authenticatedFetch(`${baseUrl}/context-graph/graphs/${tenantAGraph.id}`)).status, 200);
    assert.equal((await authenticatedFetch(`${baseUrl}/context-graph/graphs/${tenantBGraph.id}`)).status, 404);
    const reader = await authenticatedFetch(`${baseUrl}/context-graph`, "user:reader@example.com").then(
      (response) => response.json() as Promise<{ graphs: { repository: string }[] }>
    );
    assert.deepEqual(
      reader.graphs.map((graph) => graph.repository),
      ["omxyz/a"]
    );
    const stranger = await authenticatedFetch(`${baseUrl}/context-graph`, "user:stranger@example.com").then(
      (response) => response.json() as Promise<{ graphs: unknown[] }>
    );
    assert.deepEqual(stranger.graphs, []);
    assert.equal(
      (await authenticatedFetch(`${baseUrl}/context-graph/graphs/${tenantAGraph.id}`, "user:stranger@example.com"))
        .status,
      404
    );
    assert.equal((await authenticatedFetch(`${baseUrl}/context-graph/metrics`, "user:reader@example.com")).status, 403);
    assert.equal((await authenticatedFetch(`${baseUrl}/context-graph/metrics`, "user:admin@example.com")).status, 200);
    const forbiddenCommand = await fetch(`${baseUrl}/context-graph/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": "user:stranger@example.com",
        "content-type": "application/json"
      },
      body: JSON.stringify({ type: "tombstone_repository", repository: "omxyz/a", reason: "not authorized" })
    });
    assert.equal(forbiddenCommand.status, 403);
    const drained = await fetch(`${baseUrl}/internal/context-graph/outbox/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }
    });
    assert.equal(drained.status, 200);
  } finally {
    await close(server);
  }
});

test("public graph REST API exposes authorized topology and cited queries without internal metadata", async () => {
  const contextGraphStore = new MemoryContextGraphStore();
  const graph = fixtureGraph({
    tenantId: "tenant-a",
    repository: "omxyz/a",
    ref: "refs/heads/main",
    taskId: "public-graph"
  });
  await contextGraphStore.save(graph);
  await contextGraphStore.executeCommand(
    "tenant-a",
    "svc:test",
    {
      type: "grant_repository_access",
      repository: "omxyz/a",
      principalId: "user:reader@example.com",
      role: "reader"
    },
    "2026-07-20T00:00:00.000Z"
  );
  const server = createApiServer({ contextGraphStore, internalApiToken: INTERNAL_TOKEN, tenantId: "tenant-a" });
  const baseUrl = await listen(server);
  try {
    assert.equal((await fetch(`${baseUrl}/v1/graphs`)).status, 401);
    const listResponse = await authenticatedFetch(`${baseUrl}/v1/graphs`, "user:reader@example.com");
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as { graphs: Record<string, unknown>[] };
    assert.equal(list.graphs.length, 1);
    assert.deepEqual(list.graphs[0], {
      id: graph.id,
      repository: "omxyz/a",
      versionLabel: "main",
      sourceCommit: "fixture-sha",
      generatedAt: graph.generatedAt,
      summary: "Fixture repository",
      nodeCount: 2,
      edgeCount: 1
    });
    assert.equal("tenantId" in list.graphs[0], false);
    assert.equal("generator" in list.graphs[0], false);

    const detailResponse = await authenticatedFetch(
      `${baseUrl}/v1/graphs/${encodeURIComponent(graph.id)}`,
      "user:reader@example.com"
    );
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as Record<string, unknown>;
    assert.equal(Array.isArray(detail.nodes), true);
    assert.equal(Array.isArray(detail.edges), true);
    assert.equal("rawModelOutput" in detail, false);

    const queryResponse = await fetch(`${baseUrl}/v1/graph/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": "user:reader@example.com",
        "content-type": "application/json"
      },
      body: JSON.stringify({ graphId: graph.id, query: "Where is the repository documentation?" })
    });
    assert.equal(queryResponse.status, 200, await queryResponse.clone().text());
    const query = (await queryResponse.json()) as Record<string, unknown>;
    assert.equal(query.graphId, graph.id);
    assert.equal(typeof query.answer, "string");
    assert.equal(Array.isArray(query.claims), true);
    assert.equal(Array.isArray(query.highlightedNodeIds), true);
    assert.equal(Array.isArray(query.highlightedEdgeIds), true);

    assert.equal(
      (await authenticatedFetch(`${baseUrl}/v1/graphs/${encodeURIComponent(graph.id)}`, "user:stranger@example.com"))
        .status,
      404
    );
  } finally {
    await close(server);
  }
});

test("graph API binds simulation tenants to exact repository ACLs", async () => {
  const contextGraphStore = new MemoryContextGraphStore();
  const tenantId = "tenant-a";
  const principalA = "tenant:11111111-1111-4111-8111-111111111111";
  const principalB = "tenant:22222222-2222-4222-8222-222222222222";
  const graphA = fixtureGraph({ tenantId, repository: "omxyz/a", ref: "main", taskId: "tenant-graph-a" });
  const graphB = fixtureGraph({ tenantId, repository: "other/b", ref: "main", taskId: "tenant-graph-b" });
  await contextGraphStore.save(graphA);
  await contextGraphStore.save(graphB);
  const server = createApiServer({
    contextGraphStore,
    internalApiToken: INTERNAL_TOKEN,
    graphApiToken: GRAPH_TOKEN,
    tenantId
  });
  const baseUrl = await listen(server);
  const sync = (principalId: string, repositories: readonly string[], token = GRAPH_TOKEN) =>
    fetch(`${baseUrl}/internal/graph/access/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ principalId, repositories })
    });
  try {
    assert.equal((await authenticatedFetch(`${baseUrl}/v1/graphs`)).status, 401);
    assert.equal((await sync(principalA, ["omxyz/a"], INTERNAL_TOKEN)).status, 401);
    assert.equal((await sync(principalA, ["omxyz/a"])).status, 200);
    assert.equal((await sync(principalB, ["other/b"])).status, 200);

    const listA = await authenticatedFetch(`${baseUrl}/v1/graphs`, principalA).then(
      (response) => response.json() as Promise<{ graphs: { repository: string }[] }>
    );
    const listB = await authenticatedFetch(`${baseUrl}/v1/graphs`, principalB).then(
      (response) => response.json() as Promise<{ graphs: { repository: string }[] }>
    );
    assert.deepEqual(
      listA.graphs.map((graph) => graph.repository),
      ["omxyz/a"]
    );
    assert.deepEqual(
      listB.graphs.map((graph) => graph.repository),
      ["other/b"]
    );
    assert.equal(
      (await authenticatedFetch(`${baseUrl}/v1/graphs/${encodeURIComponent(graphB.id)}`, principalA)).status,
      404
    );
    assert.equal(
      (await authenticatedFetch(`${baseUrl}/v1/graphs/${encodeURIComponent(graphA.id)}`, principalB)).status,
      404
    );

    const build = (principalId: string | undefined, repository: string) =>
      fetch(`${baseUrl}/context-graph/build`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${GRAPH_TOKEN}`,
          "content-type": "application/json",
          ...(principalId ? { "x-jina-principal-id": principalId } : {})
        },
        body: JSON.stringify({
          repository,
          ref: "main",
          requestKey: `graph-client-${repository}`,
          metadata: { githubInstallationId: 99 }
        })
      });
    assert.equal((await build(undefined, "omxyz/a")).status, 401);
    const missingInstallation = await fetch(`${baseUrl}/context-graph/build`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GRAPH_TOKEN}`,
        "content-type": "application/json",
        "x-jina-principal-id": principalA
      },
      body: JSON.stringify({ repository: "omxyz/a", ref: "main", requestKey: "missing-installation" })
    });
    assert.equal(missingInstallation.status, 400);
    assert.equal((await build(principalA, "omxyz/a")).status, 202);
    assert.equal((await build(principalA, "other/b")).status, 403);

    const crossTenantQuery = await fetch(`${baseUrl}/v1/graph/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": principalA,
        "content-type": "application/json"
      },
      body: JSON.stringify({ graphId: graphB.id, query: "What is in this repository?" })
    });
    assert.equal(crossTenantQuery.status, 404);

    assert.equal((await sync(principalA, [])).status, 200);
    const revoked = await authenticatedFetch(`${baseUrl}/v1/graphs`, principalA).then(
      (response) => response.json() as Promise<{ graphs: unknown[] }>
    );
    assert.deepEqual(revoked.graphs, []);
    assert.equal((await sync("svc:api", ["omxyz/a"])).status, 400);
  } finally {
    await close(server);
  }
});

test("durable state survives an API server restart", async () => {
  const stateStore = new MemoryStateStore();
  const config = { githubWebhookSecret: SECRET, stateStore, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT };
  const first = createApiServer(config);
  const firstUrl = await listen(first);

  const created = await deliver(firstUrl, "issues", "delivery-persisted", issueOpenedPayload());
  assert.equal(created.status, 202);
  await close(first);

  const second = createApiServer(config);
  const secondUrl = await listen(second);
  try {
    const board = await authenticatedFetch(`${secondUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: { type: string }[] }>
    );
    assert.equal(board.tasks.filter((task) => task.type === "issue_triage").length, 1);

    const duplicate = await deliver(secondUrl, "issues", "delivery-persisted", issueOpenedPayload());
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { duplicate: boolean }).duplicate, true);

    const health = await fetch(`${secondUrl}/health`).then(
      (response) => response.json() as Promise<{ storage: string }>
    );
    assert.equal(health.storage, "postgres");
  } finally {
    await close(second);
  }
});

test("context graph task-board state is independent of the legacy JSON board snapshot", async () => {
  const stateStore = new MemoryStateStore();
  const contextGraphCoordinator = new MemoryContextGraphPipelineCoordinator();
  const first = createApiServer({ enableDevEndpoints: true, tenantId: "default", stateStore, contextGraphCoordinator });
  const firstUrl = await listen(first);
  const created = await fetch(`${firstUrl}/context-graph/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository: "omxyz/legacy", ref: "main", requestKey: "legacy" })
  });
  assert.equal(created.status, 202);
  await close(first);

  assert.equal(stateStore.current(), undefined);

  const second = createApiServer({
    enableDevEndpoints: true,
    tenantId: "default",
    stateStore,
    contextGraphCoordinator
  });
  const secondUrl = await listen(second);
  try {
    const board = await fetch(`${secondUrl}/board`).then(
      (response) =>
        response.json() as Promise<{
          tasks: { status: string; metadata: Record<string, unknown> }[];
          outbox: { id: string; status: string; topic: string }[];
        }>
    );
    assert.equal(board.tasks.filter((task) => task.metadata.repository === "omxyz/legacy").length, 6);
    assert.equal(
      board.outbox.some((message) => message.topic === "run-context-graph-ingest" && message.status === "pending"),
      true
    );
  } finally {
    await close(second);
  }
});

test("concurrent API instances mutate the latest durable snapshot", async () => {
  const stateStore = new MemoryStateStore();
  const first = createApiServer({ enableDevEndpoints: true, tenantId: "default", stateStore });
  const second = createApiServer({ enableDevEndpoints: true, tenantId: "default", stateStore });
  const [firstUrl, secondUrl] = await Promise.all([listen(first), listen(second)]);
  try {
    const firstDelivery = await fetch(`${firstUrl}/dev/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omlabs/example", pullRequestNumber: 1, headSha: "first" })
    });
    assert.equal(firstDelivery.status, 202);
    const secondDelivery = await fetch(`${secondUrl}/dev/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omlabs/example", pullRequestNumber: 2, headSha: "second" })
    });
    assert.equal(secondDelivery.status, 202);
  } finally {
    await Promise.all([close(first), close(second)]);
  }

  const restarted = createApiServer({ enableDevEndpoints: true, tenantId: "default", stateStore });
  const restartedUrl = await listen(restarted);
  try {
    const board = await fetch(`${restartedUrl}/board`).then(
      (response) => response.json() as Promise<{ pullRequests: { number: number }[]; tasks: unknown[] }>
    );
    assert.deepEqual(board.pullRequests.map((pullRequest) => pullRequest.number).sort(), [1, 2]);
    assert.equal(board.tasks.length, 6);
  } finally {
    await close(restarted);
  }
});

test("repository builds supersede immediately without waiting for an ingestion data write", async () => {
  class GatedContextGraphStore extends MemoryContextGraphStore {
    private signalEntered!: () => void;
    readonly entered = new Promise<void>((resolve) => {
      this.signalEntered = resolve;
    });
    private releaseWrite!: () => void;
    private readonly released = new Promise<void>((resolve) => {
      this.releaseWrite = resolve;
    });

    release(): void {
      this.releaseWrite();
    }

    override async applyBlobAnalyses(
      scope: { readonly tenantId: string; readonly repository: string; readonly commitSha: string },
      analyses: readonly BlobAnalysis[]
    ): Promise<void> {
      this.signalEntered();
      await this.released;
      await super.applyBlobAnalyses(scope, analyses);
    }
  }

  const stateStore = new MemoryStateStore();
  const contextGraphStore = new GatedContextGraphStore();
  const contextGraphCoordinator = new MemoryContextGraphPipelineCoordinator();
  const first = createApiServer({
    enableDevEndpoints: true,
    tenantId: "default",
    stateStore,
    contextGraphStore,
    contextGraphCoordinator
  });
  const second = createApiServer({
    enableDevEndpoints: true,
    tenantId: "default",
    stateStore,
    contextGraphStore,
    contextGraphCoordinator
  });
  const [firstUrl, secondUrl] = await Promise.all([listen(first), listen(second)]);
  try {
    const build = await fetch(`${firstUrl}/context-graph/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omxyz/fenced", ref: "main", requestKey: "first" })
    });
    assert.equal(build.status, 202);
    const ingestion = await claimTopic(firstUrl, "run-context-graph-ingest");
    const commitSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    await postJson(firstUrl, "/internal/context-graph/ingest/plan", {
      messageId: ingestion.message.id,
      leaseId: ingestion.message.leaseId,
      snapshot: {
        repository: "omxyz/fenced",
        ref: "main",
        commitSha,
        treeSha: "c".repeat(40),
        parents: [],
        recordedAt: "2026-07-20T00:00:00.000Z",
        taskId: ingestion.task.id,
        files: [{ path: "src/index.ts", blobSha, size: 10 }]
      }
    });

    const write = fetch(`${firstUrl}/internal/context-graph/ingest/blobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: ingestion.message.id,
        leaseId: ingestion.message.leaseId,
        taskId: ingestion.task.id,
        commitSha,
        analyses: [
          {
            blobSha,
            parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
            language: "typescript",
            symbols: [],
            imports: [],
            edges: []
          }
        ]
      })
    });
    await contextGraphStore.entered;
    let replacementSettled = false;
    const replacement = fetch(`${secondUrl}/context-graph/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omxyz/fenced", ref: "main", requestKey: "second" })
    }).then((response) => {
      replacementSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(replacementSettled, true, "repository-scoped supersession is independent of the data write");

    contextGraphStore.release();
    assert.equal((await write).status, 200);
    assert.equal((await replacement).status, 202);
    assert.equal(
      await completeClaim(firstUrl, ingestion, {
        commitSha,
        codeCheckpoint: "stale",
        evidenceFingerprint: "stale"
      }),
      409
    );
  } finally {
    await Promise.all([close(first), close(second)]);
  }
});

test("context graph completion does not depend on the legacy board snapshot", async () => {
  const stateStore = new MemoryStateStore();
  const contextGraphStore = new MemoryContextGraphStore();
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default", stateStore, contextGraphStore });
  const baseUrl = await listen(server);
  try {
    const created = await fetch(`${baseUrl}/context-graph/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omxyz/resumable", ref: "main", requestKey: "resumable" })
    });
    assert.equal(created.status, 202);
    const commitSha = "a".repeat(40);
    const ingestion = await claimTopic(baseUrl, "run-context-graph-ingest");
    assert.equal(
      await completeClaim(baseUrl, ingestion, {
        commitSha,
        codeCheckpoint: "code-checkpoint",
        evidenceFingerprint: "evidence-fingerprint"
      }),
      200
    );
    const historyIngestion = await claimTopic(baseUrl, "run-context-graph-ingest");
    assert.equal(historyIngestion.task.metadata?.pipelinePhase, "history");
    assert.equal(
      await completeClaim(baseUrl, historyIngestion, {
        commitSha,
        codeCheckpoint: "code-checkpoint",
        evidenceFingerprint: "evidence-fingerprint"
      }),
      200
    );
    const assertion = await claimTopic(baseUrl, "run-context-graph-assert");
    const firstCompletion = await fetch(`${baseUrl}/internal/worker/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: assertion.message.id,
        leaseId: assertion.message.leaseId,
        taskId: assertion.task.id,
        outcome: "done",
        assertionBatch: {
          tenantId: "default",
          repository: "omxyz/resumable",
          ref: "main",
          commitSha,
          taskId: assertion.task.id,
          generatedAt: "2026-07-20T00:00:00.000Z",
          generatorVersion: "codex-assertions-v2",
          registryVersion: "context-graph-registry-v1",
          evidenceFingerprint: "evidence-fingerprint",
          evidenceObservationIds: [],
          model: "fixture",
          summary: "Repository documentation",
          rawOutput: {
            summary: "Repository documentation",
            nodes: [
              {
                id: "repo",
                kind: "Repository",
                label: "resumable",
                description: "repository",
                evidence: ["README.md:1"]
              },
              {
                id: "readme",
                kind: "Document",
                label: "README",
                description: "documentation",
                path: "README.md",
                evidence: ["README.md:1"]
              }
            ],
            edges: [
              {
                source: "repo",
                target: "readme",
                predicate: "DOCUMENTED_BY",
                plane: "knowledge",
                confidence: 0.95,
                why: "The README explicitly documents this repository.",
                evidence: ["README.md:1"]
              }
            ]
          }
        }
      })
    });
    assert.equal(firstCompletion.status, 200);
    const board = await fetch(`${baseUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: { id: string; status: string }[] }>
    );
    assert.equal(board.tasks.find((task) => task.id === assertion.task.id)?.status, "done");
    assert.equal((await contextGraphStore.listAssertions("default", "omxyz/resumable")).length > 0, true);
  } finally {
    await close(server);
  }
});

test("configured aliases migrate existing tasks and context graph graphs to the canonical tenant", async () => {
  const stateStore = new MemoryStateStore();
  const contextGraphStore = new MemoryContextGraphStore();
  const oldTenant = "github:unscoped";
  const first = createApiServer({
    githubWebhookSecret: SECRET,
    stateStore,
    contextGraphStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: oldTenant
  });
  const firstUrl = await listen(first);
  assert.equal(
    (await deliver(firstUrl, "pull_request", "delivery-old-tenant", pullRequestPayload(55, "old-sha"))).status,
    202
  );
  await contextGraphStore.save(
    fixtureGraph({ tenantId: oldTenant, repository: "omlabs/example", ref: "main", taskId: "old-task" })
  );
  await close(first);

  const second = createApiServer({
    githubWebhookSecret: SECRET,
    stateStore,
    contextGraphStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "omlabs",
    tenantAliases: [oldTenant]
  });
  const secondUrl = await listen(second);
  try {
    const board = await authenticatedFetch(`${secondUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: { metadata: Record<string, unknown> }[] }>
    );
    assert.equal(board.tasks.length, 3);
    assert.equal(
      board.tasks.every((task) => task.metadata.tenantId === "omlabs"),
      true
    );
    const contextGraph = await authenticatedFetch(`${secondUrl}/context-graph`).then(
      (response) => response.json() as Promise<{ graphs: { tenantId: string }[] }>
    );
    assert.deepEqual(
      contextGraph.graphs.map((graph) => graph.tenantId),
      ["omlabs"]
    );
  } finally {
    await close(second);
  }
});

test("overview combines the board and events behind one ETag-validated response", async () => {
  const server = createApiServer({ enableDevEndpoints: true, seedDemo: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    const overviewResponse = await fetch(`${baseUrl}/overview`);
    assert.equal(overviewResponse.status, 200);
    const etag = overviewResponse.headers.get("etag");
    assert.ok(etag);
    const overview = (await overviewResponse.json()) as {
      board: { tasks: { id: string }[] };
      events: { taskId?: string; at: string }[];
    };
    const [board, events] = (await Promise.all(
      [`${baseUrl}/board`, `${baseUrl}/events`].map((url) => fetch(url).then((response) => response.json()))
    )) as [unknown, unknown];
    assert.deepEqual(overview.board, board);
    assert.deepEqual(overview.events, events);
    const revalidated = await fetch(`${baseUrl}/overview`, { headers: { "if-none-match": etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), "");
  } finally {
    await close(server);
  }
});

test("context graph responses can inline the assertion review queue", async () => {
  const server = createApiServer({ enableDevEndpoints: true, seedDemo: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    const plain = (await fetch(`${baseUrl}/context-graph`).then((response) => response.json())) as {
      latest: { repository: string } | null;
      assertions?: unknown;
    };
    assert.ok(plain.latest);
    assert.equal(plain.assertions, undefined);
    const withAssertions = (await fetch(`${baseUrl}/context-graph?include=assertions`).then((response) =>
      response.json()
    )) as { latest: { repository: string } | null; assertions: { status: string }[] };
    assert.ok(Array.isArray(withAssertions.assertions));
    const direct = (await fetch(
      `${baseUrl}/context-graph/assertions?repository=${encodeURIComponent(withAssertions.latest?.repository ?? "")}`
    ).then((response) => response.json())) as { assertions: unknown[] };
    assert.deepEqual(withAssertions.assertions, direct.assertions);
  } finally {
    await close(server);
  }
});

test("dashboard context graph revalidation skips graph hydration and assertion reads", async () => {
  class CountingStore extends MemoryContextGraphStore {
    readonly calls = { latest: 0, summaries: 0, assertions: 0, get: 0 };

    override async latest(
      tenantId: string,
      repositories?: readonly string[],
      filter?: { repository?: string; ref?: string }
    ) {
      this.calls.latest += 1;
      return super.latest(tenantId, repositories, filter);
    }

    override async listSummaries(tenantId: string, filter?: { repository?: string; ref?: string }) {
      this.calls.summaries += 1;
      return super.listSummaries(tenantId, filter);
    }

    override async listAssertions(
      tenantId: string,
      repository: string,
      filter?: Parameters<MemoryContextGraphStore["listAssertions"]>[2]
    ) {
      this.calls.assertions += 1;
      return super.listAssertions(tenantId, repository, filter);
    }

    override async get(graphId: string, tenantId: string) {
      this.calls.get += 1;
      return super.get(graphId, tenantId);
    }
  }

  const store = new CountingStore();
  await store.save(fixtureGraph({ tenantId: "tenant-a", repository: "omxyz/a", ref: "main", taskId: "task-a" }));
  const server = createApiServer({ contextGraphStore: store, internalApiToken: INTERNAL_TOKEN, tenantId: "tenant-a" });
  const baseUrl = await listen(server);
  const route = `${baseUrl}/context-graph?view=dashboard&include=assertions&assertionStatus=proposed&assertionLimit=25`;
  try {
    const initial = await authenticatedFetch(route);
    assert.equal(initial.status, 200);
    assert.ok(initial.headers.get("etag"));
    assert.equal(store.calls.summaries, 0, "dashboard view must not load the summary page");
    assert.equal(store.calls.latest, 1);
    assert.equal(store.calls.assertions, 1);

    store.calls.latest = 0;
    store.calls.summaries = 0;
    store.calls.assertions = 0;
    store.calls.get = 0;
    const revalidated = await fetch(route, {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "if-none-match": initial.headers.get("etag")! }
    });
    assert.equal(revalidated.status, 304);
    assert.deepEqual(store.calls, { latest: 0, summaries: 0, assertions: 0, get: 0 });
  } finally {
    await close(server);
  }
});

async function listen(server: ReturnType<typeof createApiServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createApiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

class MemoryStateStore implements ApiStateStore {
  private snapshot?: ApiSnapshot;
  private readonly deliveries = new Set<string>();
  private updates = Promise.resolve();
  private updatesUntilFailure: number | undefined;

  failUpdateAfter(successfulUpdates: number): void {
    this.updatesUntilFailure = successfulUpdates;
  }

  current(): ApiSnapshot | undefined {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }

  replace(snapshot: ApiSnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }

  async load(): Promise<ApiSnapshot | undefined> {
    return this.snapshot;
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    return this.deliveries.has(deliveryId);
  }

  async ping(): Promise<void> {}

  async save(snapshot: ApiSnapshot, deliveryId?: string): Promise<boolean> {
    if (deliveryId && this.deliveries.has(deliveryId)) {
      return false;
    }
    if (deliveryId) {
      this.deliveries.add(deliveryId);
    }
    this.snapshot = structuredClone(snapshot);
    return true;
  }

  async update<T>(
    operation: (snapshot: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>,
    deliveryId?: string
  ): Promise<{ readonly committed: boolean; readonly result?: T }> {
    let outcome: { readonly committed: boolean; readonly result?: T } | undefined;
    const update = this.updates.then(async () => {
      if (deliveryId && this.deliveries.has(deliveryId)) {
        outcome = { committed: false };
        return;
      }
      const next = await operation(this.snapshot ? structuredClone(this.snapshot) : undefined);
      if (this.updatesUntilFailure === 0) {
        this.updatesUntilFailure = undefined;
        throw new Error("simulated durable state failure");
      }
      if (this.updatesUntilFailure !== undefined) this.updatesUntilFailure -= 1;
      if (deliveryId) this.deliveries.add(deliveryId);
      this.snapshot = structuredClone(next.state);
      outcome = { committed: true, result: next.result };
    });
    this.updates = update.then(
      () => undefined,
      () => undefined
    );
    await update;
    return outcome!;
  }

  async close(): Promise<void> {}
}

interface TestClaim {
  readonly message: { readonly id: string; readonly leaseId: string; readonly topic: string };
  readonly task: { readonly id: string; readonly metadata?: Record<string, unknown> };
}

async function claimTopic(baseUrl: string, topic: string): Promise<TestClaim> {
  const response = await fetch(`${baseUrl}/internal/worker/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: `test-${topic}`, topics: [topic] })
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<TestClaim>;
}

async function completeClaim(baseUrl: string, work: TestClaim, result: Record<string, unknown>): Promise<number> {
  const response = await fetch(`${baseUrl}/internal/worker/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messageId: work.message.id,
      leaseId: work.message.leaseId,
      taskId: work.task.id,
      outcome: "done",
      result
    })
  });
  return response.status;
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}

function fixtureGraph(request: {
  tenantId: string;
  repository: string;
  ref: string;
  taskId: string;
  commitSha?: string;
}) {
  return createContextGraph({
    request,
    commitSha: request.commitSha ?? "fixture-sha",
    generatedAt: new Date().toISOString(),
    executor: "fixture",
    model: "fixture",
    generated: {
      summary: "Fixture repository",
      nodes: [
        {
          id: "repo",
          kind: "Repository",
          label: request.repository,
          description: "Repository",
          evidence: ["README.md:1"]
        },
        {
          id: "file:README.md",
          kind: "File",
          label: "README.md",
          description: "Documentation",
          path: "README.md",
          evidence: ["README.md:1"]
        }
      ],
      edges: [
        { source: "repo", target: "file:README.md", predicate: "CONTAINS", plane: "code", evidence: ["README.md:1"] }
      ]
    }
  });
}

function authenticatedFetch(url: string, principalId?: string): Promise<Response> {
  return fetch(url, {
    headers: {
      authorization: `Bearer ${INTERNAL_TOKEN}`,
      ...(principalId ? { "x-jina-principal-id": principalId } : {})
    }
  });
}

async function deliver(
  baseUrl: string,
  eventName: string,
  deliveryId: string,
  payload: unknown,
  secret = SECRET
): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventName,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature
    },
    body: rawBody
  });
}

function issueOpenedPayload(): unknown {
  return {
    action: "opened",
    issue: {
      number: 7,
      title: "Investigate flaky test",
      html_url: "https://github.com/omlabs/example/issues/7",
      user: { id: 101, login: "octocat", type: "User" }
    },
    repository: { id: 10, full_name: "omlabs/example", owner: { id: 202, login: "omlabs", type: "Organization" } },
    installation: { id: 99 },
    sender: { id: 101, login: "octocat", type: "User" }
  };
}

function pullRequestPayload(number: number, headSha: string, action = "opened"): unknown {
  return {
    action,
    number,
    pull_request: {
      number,
      title: "Make it work",
      html_url: `https://github.com/omlabs/example/pull/${number}`,
      draft: false,
      user: { id: 101, login: "octocat", type: "User" },
      head: { sha: headSha }
    },
    repository: { id: 10, full_name: "omlabs/example", owner: { id: 202, login: "omlabs", type: "Organization" } },
    installation: { id: 99 },
    sender: { id: 101, login: "octocat", type: "User" }
  };
}

function pushPayload(headSha: string): unknown {
  return {
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: headSha,
    deleted: false,
    repository: { id: 10, full_name: "omlabs/example" },
    installation: { id: 99 },
    sender: { login: "octocat" }
  };
}
