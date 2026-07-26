import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  MemoryContextEngineStore,
  MemoryContextPipelineCoordinator,
  repositoryAclFingerprint,
  type ContextPipelineCoordinator
} from "@jina/context-engine";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const tenantId = "tenant-a";
const repository = "omlabs/context-engine-fixture";
const principalId = "user:reader@example.com";
const internalToken = "internal-test-token";
const contextToken = "context-test-token";
const commitSha = "a".repeat(40);
const blobSha = "b".repeat(40);
const readme = [
  "# Repository Context",
  "",
  "The context engine indexes immutable repository evidence.",
  "",
  "Use queryContext to retrieve cited answers."
].join("\n");

const coordinator = new MemoryContextPipelineCoordinator();
const store = new MemoryContextEngineStore(coordinator);
const server = createApiServer({
  tenantId,
  enableDevEndpoints: true,
  seedDemo: false,
  internalApiToken: internalToken,
  contextApiToken: contextToken,
  contextCoordinator: coordinator,
  contextStore: store,
  tenantAdminPrincipalIds: [principalId]
});
let baseUrl = "";

before(async () => {
  await store.replaceRepositoryAccess(tenantId, principalId, [repository]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("clean context API executes ingest, baseline index, derivation, enriched index, and query", async () => {
  const created = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      ref: "main",
      commitSha,
      githubInstallationId: 140435029,
      requestKey: "acceptance-build"
    })
  });
  assert.equal(created.response.status, 202);
  const build = record(created.body.build);
  assert.equal(build.repository, repository);
  assert.equal(build.refSequence, 1);
  assert.deepEqual(
    array(build.stages).map((stage) => record(stage).type),
    ["ingest-evidence", "derive-knowledge", "index-context"]
  );

  const ingest = await claim(coordinator, "run-ingest-evidence");
  assert.equal(ingest.stage.metadata.commitSha, commitSha);
  assert.equal(ingest.stage.metadata.githubInstallationId, 140435029);
  assert.equal(ingest.stage.metadata.refSequence, 1);
  const ingested = await api("/internal/context/ingest", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      ...leaseBody(ingest),
      input: {
        tenantId,
        repository,
        ref: "main",
        refSequence: 1,
        commitSha,
        files: [
          { path: "README.md", blobSha, body: readme, language: "markdown" },
          {
            path: "src/query.ts",
            blobSha: "c".repeat(40),
            body: 'export function queryContext() { return "cited"; }',
            language: "typescript"
          }
        ],
        observations: [
          {
            sourceType: "observation",
            sourceId: `github:repository:${repository}:${commitSha}`,
            title: repository,
            payload: { default_branch: "main", description: "Evidence-first repository context" },
            observedAt: "2026-07-26T12:00:00.000Z",
            metadata: { provider: "github", kind: "repository" }
          }
        ],
        git: {
          commit: {
            treeSha: "d".repeat(40),
            parentShas: ["e".repeat(40)],
            author: "Jina Test <test@example.com>",
            authoredAt: "2026-07-26T11:59:00.000Z",
            committedAt: "2026-07-26T12:00:00.000Z",
            message: "Add repository context fixture"
          },
          changes: [
            { kind: "add", path: "README.md", newBlobSha: blobSha },
            { kind: "add", path: "src/query.ts", newBlobSha: "c".repeat(40) }
          ]
        },
        aclFingerprint: repositoryAclFingerprint(tenantId, repository),
        observationFrontier: `${commitSha}:fixture`,
        createdAt: "2026-07-26T12:00:00.000Z",
        sourceComplete: true
      }
    })
  });
  assert.equal(ingested.response.status, 200);
  const checkpointId = string(ingested.body.checkpointId);
  await complete(ingest, record(ingested.body));

  // A combined worker must claim the required baseline before optional model work.
  const baseline = await claim(coordinator, "run-index-context");
  const indexed = await api("/internal/context/index", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ ...leaseBody(baseline), checkpointId })
  });
  assert.equal(indexed.response.status, 200);
  assert.equal(indexed.body.status, "published");
  await complete(baseline, record(indexed.body));

  const derived = await claim(coordinator, "run-derive-knowledge");
  const prepared = await api("/internal/context/derive/prepare", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ ...leaseBody(derived), checkpointId })
  });
  assert.equal(prepared.response.status, 200);
  assert.match(string(prepared.body.prompt), /immutable repository evidence/);

  const committed = await api("/internal/context/derive/commit", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      ...leaseBody(derived),
      checkpointId,
      rawOutput: {
        documents: [
          {
            logicalId: `repository:${repository}:architecture`,
            kind: "architecture",
            title: "Repository context architecture",
            summary: "Evidence is indexed before it is queried.",
            bodyMarkdown: "The context engine indexes immutable repository evidence.",
            structuredSummary: { approach: "evidence-first" },
            scope: {
              paths: ["README.md"],
              symbols: [],
              pullRequests: [],
              issues: []
            },
            confidence: 0.96,
            citations: [
              {
                claim: "The context engine indexes immutable repository evidence.",
                sourceType: "blob",
                sourceId: blobSha,
                pathOrUrl: "README.md",
                startLine: 3,
                endLine: 3
              }
            ]
          }
        ]
      }
    })
  });
  assert.equal(committed.response.status, 200);
  assert.equal(committed.body.status, "succeeded");
  assert.match(string(committed.body.enrichedGenerationId), /^ig_/);
  await complete(derived, record(committed.body));

  const finished = await coordinator.get(string(build.id));
  assert.equal(finished?.status, "succeeded");
  assert.equal(finished?.stages.find((stage) => stage.type === "index-context")?.attempt, 1);

  const queried = await api("/context/query", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      ref: "main",
      question: "What does the context engine index?"
    })
  });
  assert.equal(queried.response.status, 200);
  assert.match(string(queried.body.answer), /repository evidence/i);
  const citations = array(queried.body.citations).map(record);
  assert.ok(citations.length > 0);
  const anchors = citations.flatMap((citation) => array(citation.anchors).map(record));
  assert.ok(
    anchors.some(
      (anchor) => anchor.repository === repository && anchor.commitSha === commitSha && anchor.pathOrUrl === "README.md"
    )
  );
  assert.equal(record(queried.body.generation).commitSha, commitSha);
  assert.notEqual(record(queried.body.generation).derivedKnowledge, "unavailable");
  assert.match(string(queried.body.traceId), /^trace_/);

  const generations = await api(`/context/generations?repository=${encodeURIComponent(repository)}`, {
    headers: contextHeaders()
  });
  assert.equal(generations.response.status, 200);
  assert.equal(generations.response.headers.get("x-jina-schema-version"), "context-api-v1");
  assert.equal(array(generations.body.generations).length, 1);
  const generationId = string(record(array(generations.body.generations)[0]).id);
  const generationDetail = await api(`/context/generations/${encodeURIComponent(generationId)}`, {
    headers: contextHeaders()
  });
  assert.equal(generationDetail.response.status, 200);
  assert.equal(record(generationDetail.body.generation).id, generationId);

  const documents = await api(`/context/documents?repository=${encodeURIComponent(repository)}`, {
    headers: contextHeaders()
  });
  assert.equal(documents.response.status, 200);
  const document = record(array(documents.body.documents)[0]);
  assert.equal(document.logicalId, `repository:${repository}:architecture`);

  const detail = await api(`/context/documents/${encodeURIComponent(string(document.id))}`, {
    headers: contextHeaders()
  });
  assert.equal(detail.response.status, 200);
  assert.equal(record(detail.body.document).bodyMarkdown, "The context engine indexes immutable repository evidence.");
  const nonAdminPrincipal = "user:repository-reader@example.com";
  await store.replaceRepositoryAccess(tenantId, nonAdminPrincipal, [repository]);
  const forbiddenReview = await api(`/context/knowledge/${encodeURIComponent(string(document.id))}/review`, {
    method: "POST",
    headers: { ...contextHeaders(), "x-jina-principal-id": nonAdminPrincipal },
    body: JSON.stringify({ action: "accept", reason: "reader must not mutate review state" })
  });
  assert.equal(forbiddenReview.response.status, 403);

  const structure = await api(`/context/structure?repository=${encodeURIComponent(repository)}&ref=main`, {
    headers: contextHeaders()
  });
  assert.equal(structure.response.status, 200);
  assert.ok(array(structure.body.relations).some((relation) => record(relation).kind === "defines"));

  const metrics = await api("/context/metrics", { headers: contextHeaders() });
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.body.publishedGenerationCount, 1);
  assert.equal(record(metrics.body.query).count, 1);

  const board = await api("/board", { headers: contextHeaders() });
  assert.equal(board.response.status, 200);
  const taskTypes = array(board.body.tasks).map((task) => record(task).type);
  assert.ok(taskTypes.includes("ingest-evidence"));
  assert.ok(taskTypes.includes("derive-knowledge"));
  assert.ok(taskTypes.includes("index-context"));
  assert.equal(
    taskTypes.some((type) => String(type).includes("graph")),
    false
  );
});

test("MCP exposes only query_context and returns the API generation with original evidence", async () => {
  const client = new Client({ name: "jina-context-api-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: contextHeaders() }
  });
  try {
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["query_context"]
    );
    const result = await client.callTool({
      name: "query_context",
      arguments: {
        repository,
        ref: "main",
        question: "Where is queryContext defined?",
        taskKind: "structure",
        targets: { symbols: ["queryContext"] }
      }
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.structuredContent), /src\/query\.ts/);
    assert.match(JSON.stringify(result.structuredContent), new RegExp(commitSha));
  } finally {
    await client.close();
  }
});

test("evidence erasure invalidates generations, hides derived documents, and rebuilds without resurrection", async () => {
  const documentsBefore = await api(`/context/documents?repository=${encodeURIComponent(repository)}`, {
    headers: contextHeaders()
  });
  const revisionId = string(record(array(documentsBefore.body.documents)[0]).id);
  const erased = await api("/context/erasure", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      ref: "main",
      sourceType: "blob",
      sourceId: blobSha,
      reason: "fixture verifies source erasure"
    })
  });
  assert.equal(erased.response.status, 202);
  assert.ok(Number(erased.body.erasedGenerationCount) >= 1);
  assert.match(string(erased.body.generationId), /^ig_/);

  const detail = await api(`/context/documents/${encodeURIComponent(revisionId)}`, {
    headers: contextHeaders()
  });
  assert.equal(detail.response.status, 404);

  const queried = await api("/context/query", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      ref: "main",
      question: "Where is queryContext defined?",
      taskKind: "structure",
      targets: { symbols: ["queryContext"] }
    })
  });
  assert.equal(queried.response.status, 200);
  const anchors = array(queried.body.citations)
    .map(record)
    .flatMap((citation) => array(citation.anchors).map(record));
  assert.equal(
    anchors.some((anchor) => anchor.sourceType === "blob" && anchor.sourceId === blobSha),
    false
  );
});

test("legacy graph routes and tool names are absent, ACL failures do not reveal repository existence", async () => {
  const legacy = await api("/context-graph", { headers: contextHeaders() });
  assert.equal(legacy.response.status, 404);

  const stranger = await api("/context/query", {
    method: "POST",
    headers: { ...contextHeaders(), "x-jina-principal-id": "user:stranger@example.com" },
    body: JSON.stringify({ repository, question: "What is indexed?" })
  });
  assert.equal(stranger.response.status, 404);

  const invalid = await api("/context/query", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({ repository, question: "What is indexed?", taskKind: "graph" })
  });
  assert.equal(invalid.response.status, 400);
});

test("all public context routes require a bound principal in production", async () => {
  const protectedCoordinator = new MemoryContextPipelineCoordinator();
  const protectedStore = new MemoryContextEngineStore(protectedCoordinator);
  const protectedServer = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextCoordinator: protectedCoordinator,
    contextStore: protectedStore
  });
  await new Promise<void>((resolve) => protectedServer.listen(0, "127.0.0.1", resolve));
  const protectedUrl = `http://127.0.0.1:${(protectedServer.address() as AddressInfo).port}`;
  try {
    for (const path of [
      "/context/generations",
      "/context/generations/ig_hidden",
      "/context/documents",
      "/context/documents/kr_hidden",
      `/context/structure?repository=${encodeURIComponent(repository)}`,
      "/context/metrics"
    ]) {
      const response = await fetch(`${protectedUrl}${path}`, {
        headers: { authorization: `Bearer ${contextToken}` }
      });
      assert.equal(response.status, 401, path);
    }
    for (const path of [
      "/context/build",
      "/context/query",
      "/context/knowledge/kr_hidden/review",
      "/context/rebuild",
      "/context/erasure"
    ]) {
      const response = await fetch(`${protectedUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${internalToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ repository })
      });
      assert.equal(response.status, 401, path);
    }
  } finally {
    await new Promise<void>((resolve, reject) => protectedServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("shared-database workers claim across provisioned tenants without a tenant header", async () => {
  const sharedTenant = "eff0efc9-b103-494a-b7a3-1ae7f95c2d26";
  const sharedCoordinator = new MemoryContextPipelineCoordinator();
  await sharedCoordinator.createBuild({
    tenantId: sharedTenant,
    repository,
    ref: "main",
    requestKey: "shared-claim",
    createdAt: new Date().toISOString()
  });
  const sharedStore = new MemoryContextEngineStore(sharedCoordinator);
  const sharedServer = createApiServer({
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextCoordinator: sharedCoordinator,
    contextStore: sharedStore,
    sharedIdentityResolver: {
      async resolveRepository() {
        return undefined;
      },
      async listTenantIds() {
        return [sharedTenant];
      },
      async ping() {},
      async close() {}
    }
  });
  await new Promise<void>((resolve) => sharedServer.listen(0, "127.0.0.1", resolve));
  const sharedUrl = `http://127.0.0.1:${(sharedServer.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${sharedUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ workerId: "shared-worker", topics: ["run-ingest-evidence"] })
    });
    assert.equal(response.status, 200);
    const body = record(await response.json());
    const task = record(body.task);
    assert.equal(record(task.metadata).tenantId, sharedTenant);
    assert.equal(typeof record(body.message).writeFenceToken, "string");
  } finally {
    await new Promise<void>((resolve, reject) => sharedServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("malformed persisted runtime state is ignored instead of breaking unrelated API reads", async () => {
  const malformedServer = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    seedDemo: false,
    stateStore: readOnlyStateStore({ unrelated: "legacy snapshot" } as unknown as ApiSnapshot)
  });
  await new Promise<void>((resolve) => malformedServer.listen(0, "127.0.0.1", resolve));
  const malformedUrl = `http://127.0.0.1:${(malformedServer.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${malformedUrl}/board`);
    assert.equal(response.status, 200);
    assert.deepEqual(record(await response.json()).tasks, []);
  } finally {
    await new Promise<void>((resolve, reject) => malformedServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("persisted tasks unsupported by the current runtime are removed with their references", async () => {
  const staleSnapshot = {
    intakeState: {
      board: {
        tasks: [
          {
            id: "task_removed",
            type: "removed-extension-task",
            title: "Removed extension work",
            status: "triage",
            assigneeRole: "removed_worker",
            dedupeKey: "removed:1",
            required: true,
            attempt: 0,
            createdAt: "2026-07-26T00:00:00.000Z",
            updatedAt: "2026-07-26T00:00:00.000Z",
            metadata: {},
            kind: "dispatchable",
            dispatchTopic: "run-removed-extension"
          }
        ],
        dependencies: [],
        outbox: [
          {
            id: "message_removed",
            taskId: "task_removed",
            topic: "run-removed-extension",
            idempotencyKey: "removed:1",
            status: "pending",
            payload: { taskId: "task_removed", attempt: 0 },
            createdAt: "2026-07-26T00:00:00.000Z"
          }
        ],
        events: [
          {
            id: "event_removed",
            seq: 1,
            type: "task.created",
            at: "2026-07-26T00:00:00.000Z",
            taskId: "task_removed"
          }
        ]
      },
      pullRequests: []
    },
    publications: [],
    devDeliverySequence: 0
  } as unknown as ApiSnapshot;
  const staleServer = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    seedDemo: false,
    stateStore: readOnlyStateStore(staleSnapshot)
  });
  await new Promise<void>((resolve) => staleServer.listen(0, "127.0.0.1", resolve));
  const staleUrl = `http://127.0.0.1:${(staleServer.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${staleUrl}/board`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.deepEqual(body.tasks, []);
    assert.deepEqual(body.dependencies, []);
  } finally {
    await new Promise<void>((resolve, reject) => staleServer.close((error) => (error ? reject(error) : resolve())));
  }
});

function readOnlyStateStore(snapshot: ApiSnapshot): ApiStateStore {
  return {
    async load() {
      return snapshot;
    },
    async ping() {},
    async hasDelivery() {
      return false;
    },
    async save() {
      return true;
    },
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>
    ) {
      const updated = await operation(snapshot);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}

interface Lease {
  readonly build: { readonly id: string };
  readonly stage: {
    readonly id: string;
    readonly topic: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
  readonly fence: { readonly leaseId: string; readonly attempt: number; readonly token: string };
}

async function claim(
  contextCoordinator: ContextPipelineCoordinator,
  expectedTopic: "run-ingest-evidence" | "run-index-context" | "run-derive-knowledge"
): Promise<Lease> {
  const value = await contextCoordinator.claim({
    tenantId,
    workerId: "api-test-worker",
    topics: ["run-ingest-evidence", "run-index-context", "run-derive-knowledge"],
    now: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
  });
  assert.ok(value);
  assert.equal(value.stage.topic, expectedTopic);
  return value;
}

async function complete(lease: Lease, result: Record<string, unknown>): Promise<void> {
  const completed = await api("/internal/worker/complete", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      messageId: lease.stage.id,
      taskId: lease.stage.id,
      leaseId: lease.fence.leaseId,
      attempt: lease.fence.attempt,
      writeFenceToken: lease.fence.token,
      outcome: "done",
      result
    })
  });
  assert.equal(completed.response.status, 200);
}

function leaseBody(lease: Lease): Record<string, unknown> {
  return {
    messageId: lease.stage.id,
    taskId: lease.stage.id,
    leaseId: lease.fence.leaseId,
    attempt: lease.fence.attempt,
    writeFenceToken: lease.fence.token
  };
}

function contextHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${contextToken}`,
    "content-type": "application/json",
    "x-jina-principal-id": principalId
  };
}

function internalHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${internalToken}`,
    "content-type": "application/json"
  };
}

async function api(
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const value: unknown = await response.json();
  return { response, body: record(value) };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
