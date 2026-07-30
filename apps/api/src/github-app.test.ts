import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  MemoryContextEngineStore,
  artifactSha256,
  contextArtifactKey,
  type ContextArtifactRef,
  type ContextArtifactStore
} from "@jina/context-engine";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const tenantId = "tenant-a";
const repository = "omlabs/context-engine-fixture";
const mixedCaseRepository = "OmLabs/Context-Engine-Fixture";
const principalId = "user:reader@example.com";
const internalToken = "internal-test-token";
const contextToken = "context-test-token";
const githubWebhookSecret = "github-webhook-test-secret";
const commitSha = "a".repeat(40);
const privateArtifacts = new Map<string, Uint8Array>();
const artifactStore: ContextArtifactStore = {
  async put(input) {
    const bytes = typeof input.content === "string" ? Buffer.from(input.content) : Buffer.from(input.content);
    const key = contextArtifactKey(input);
    privateArtifacts.set(key, bytes);
    return {
      uri: `memory://${key}`,
      key,
      contentType: input.contentType,
      bytes: bytes.byteLength,
      sha256: artifactSha256(bytes)
    };
  },
  async get(ref: ContextArtifactRef) {
    const bytes = privateArtifacts.get(ref.key);
    if (!bytes) throw new Error("artifact absent");
    return bytes;
  }
};

const store = new MemoryContextEngineStore();
const serverConfig = {
  tenantId,
  enableDevEndpoints: true,
  internalApiToken: internalToken,
  contextApiToken: contextToken,
  githubWebhookSecret,
  contextStore: store,
  contextArtifactStore: artifactStore,
  contextQuotaService: new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: {
      queryRequestsPerWindow: 1_000_000,
      buildRequestsPerWindow: 1_000_000,
      maxActiveBuilds: 1_000_000,
      maxActiveModelTasks: 1_000_000
    }
  }),
  tenantAdminPrincipalIds: [principalId]
};
const server = createApiServer(serverConfig);
let baseUrl = "";

before(async () => {
  await store.replaceRepositoryAccess(tenantId, principalId, [repository]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("manual Context admission creates a resumable board build and exposes only public checkpoints", async () => {
  const overBudget = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository: mixedCaseRepository,
      ref: "main",
      commitSha,
      githubInstallationId: 140435029,
      derivationBudgetSeconds: 10_801,
      requestKey: "over-budget-build"
    })
  });
  assert.equal(overBudget.response.status, 400);
  assert.match(JSON.stringify(overBudget.body), /between 300 and 10800/);

  const overTokenBudget = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository: mixedCaseRepository,
      derivationTokenBudget: 50_000_001,
      requestKey: "over-token-budget-build"
    })
  });
  assert.equal(overTokenBudget.response.status, 400);
  assert.match(JSON.stringify(overTokenBudget.body), /between 250000 and 50000000/);

  const created = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository: mixedCaseRepository,
      ref: "main",
      commitSha,
      githubInstallationId: 140435029,
      derivationBudgetSeconds: 10_800,
      requestKey: "acceptance-build"
    })
  });
  assert.equal(created.response.status, 202);
  const build = record(created.body.build);
  const buildId = string(build.id);
  assert.equal(build.repository, repository);
  assert.equal(build.ref, "main");
  assert.equal(build.commitSha, commitSha);
  assert.equal(build.refSequence, 1);
  assert.equal(build.status, "triage");
  assert.equal(build.derivationBudgetSeconds, 10_800);
  assert.equal(build.derivationTokenBudget, 8_000_000);
  assert.equal(build.consumedModelTokens, 0);
  assert.equal(typeof build.derivationDeadlineAt, "string");
  assert.equal("stages" in build, false);

  const duplicate = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      ref: "main",
      commitSha,
      githubInstallationId: 140435029,
      derivationBudgetSeconds: 10_800,
      requestKey: "acceptance-build"
    })
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(record(duplicate.body.build).id, buildId);

  const initialProgress = await api("/context/builds/" + encodeURIComponent(buildId) + "/progress", {
    headers: contextHeaders()
  });
  assert.equal(initialProgress.response.status, 200);
  assert.equal(initialProgress.body.status, "active");
  assert.equal(initialProgress.body.derivationTokenBudget, 8_000_000);
  assert.equal(initialProgress.body.consumedModelTokens, 0);
  assert.deepEqual(
    array(initialProgress.body.stages).map((stage) => record(stage).type),
    ["snapshot-context-input"]
  );
  assert.deepEqual(initialProgress.body.pages, []);

  const claimed = await api("/internal/worker/claim", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      workerId: "board-snapshot-test",
      topics: ["run-context-input-snapshot"]
    })
  });
  assert.equal(claimed.response.status, 200);
  const message = record(claimed.body.message);
  const task = record(claimed.body.task);
  assert.equal(task.type, "snapshot-context-input");
  assert.equal(record(task.metadata).contextBuildId, buildId);
  assert.equal(record(task.metadata).githubInstallationId, 140435029);
  const lease = {
    messageId: string(message.id),
    taskId: string(task.id),
    leaseId: string(message.leaseId),
    attempt: Number(message.attempt),
    writeFenceToken: string(message.writeFenceToken)
  };

  const uploaded = await api("/internal/context/board/artifacts", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      ...lease,
      kind: "evidence-snapshot",
      name: "snapshot.json",
      contentType: "application/json",
      contentBase64: Buffer.from(JSON.stringify({ repository, ref: "main", commitSha })).toString("base64")
    })
  });
  assert.equal(uploaded.response.status, 201);
  const outputArtifact = record(uploaded.body.artifact);
  const completed = await api("/internal/worker/complete", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      ...lease,
      outcome: "done",
      result: { version: 1, outputArtifact, commitSha }
    })
  });
  assert.equal(completed.response.status, 200);

  const resumedProgress = await api("/context/builds/" + encodeURIComponent(buildId) + "/progress", {
    headers: contextHeaders()
  });
  assert.equal(resumedProgress.response.status, 200);
  const resumedStages = array(resumedProgress.body.stages).map(record);
  assert.equal(resumedStages.find((stage) => stage.type === "snapshot-context-input")?.status, "done");
  assert.equal(resumedStages.find((stage) => stage.type === "plan-context-research")?.status, "queued");
  assert.deepEqual(resumedProgress.body.pages, []);

  const missingPage = await api(
    "/context/builds/" + encodeURIComponent(buildId) + "/page?path=" + encodeURIComponent("architecture"),
    { headers: contextHeaders() }
  );
  assert.equal(missingPage.response.status, 404);

  const builds = await api("/context/builds", { headers: contextHeaders() });
  assert.equal(builds.response.status, 200);
  assert.ok(
    array(builds.body.builds)
      .map(record)
      .some((candidate) => candidate.id === buildId)
  );

  const board = await api("/board", { headers: contextHeaders() });
  assert.equal(board.response.status, 200);
  const publicTasks = array(board.body.tasks).map(record);
  assert.ok(publicTasks.some((candidate) => candidate.id === buildId && candidate.type === "build-context"));
  assert.equal(
    publicTasks.some((candidate) =>
      ["inputArtifact", "outputArtifact", "planArtifact", "dependencyResults", "githubInstallationId"].some(
        (key) => key in record(candidate.metadata)
      )
    ),
    false
  );
  const events = await fetch(`${baseUrl}/events`, { headers: contextHeaders() });
  assert.equal(events.status, 200);
  assert.equal(
    array(await events.json())
      .map(record)
      .some(
        (event) =>
          event.payload !== undefined &&
          ["inputArtifact", "outputArtifact", "planArtifact", "dependencyResults"].some(
            (key) => key in record(event.payload)
          )
      ),
    false
  );
});

test("MCP exposes exactly the four context-pack tools and never synthesizes an answer", async () => {
  const client = new Client({ name: "jina-context-api-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: contextHeaders() }
  });
  try {
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["search_context", "list_context", "read_context", "diff_context"]
    );
    const result = await client.callTool({
      name: "search_context",
      arguments: {
        repository: mixedCaseRepository,
        ref: "main",
        query: "What does the context engine do?"
      }
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /context not found/i);
    assert.doesNotMatch(JSON.stringify(result), /"answer"\s*:/);
  } finally {
    await client.close();
  }
});

test("incremental manual admission advances the ref frontier and remains idempotent", async () => {
  const incrementalCommitSha = "2".repeat(40);
  const request = {
    repository,
    ref: "main",
    commitSha: incrementalCommitSha,
    githubInstallationId: 140435029,
    requestKey: "incremental-commit-pr-issue"
  };
  const created = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify(request)
  });
  assert.equal(created.response.status, 202);
  const build = record(created.body.build);
  assert.equal(build.refSequence, 2);
  assert.equal(build.commitSha, incrementalCommitSha);
  assert.equal(build.trigger, "manual");
  assert.equal("stages" in build, false);

  const replay = await api("/context/build", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify(request)
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(record(replay.body.build).id, build.id);
  assert.equal(record(replay.body.build).refSequence, 2);

  const builds = await api("/context/builds", { headers: contextHeaders() });
  assert.equal(builds.response.status, 200);
  const mainBuilds = array(builds.body.builds)
    .map(record)
    .filter((candidate) => candidate.repository === repository && candidate.ref === "main");
  assert.ok(mainBuilds.some((candidate) => candidate.id === build.id && candidate.commitSha === incrementalCommitSha));
  assert.ok(mainBuilds.some((candidate) => candidate.commitSha === commitSha));

  const progress = await api("/context/builds/" + encodeURIComponent(string(build.id)) + "/progress", {
    headers: contextHeaders()
  });
  assert.equal(progress.response.status, 200);
  assert.equal(progress.body.status, "active");
  assert.deepEqual(
    array(progress.body.stages).map((stage) => record(stage).type),
    ["snapshot-context-input"]
  );
  assert.deepEqual(progress.body.pages, []);
});

test("public context search bounds query, result count, and request body", async () => {
  const tooManyResults = await api("/context/search", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      query: "What is indexed?",
      limit: 26
    })
  });
  assert.equal(tooManyResults.response.status, 400);

  const oversizedQuery = await api("/context/search", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      query: "x".repeat(4_001)
    })
  });
  assert.equal(oversizedQuery.response.status, 400);

  const oversizedBody = await api("/context/search", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      query: "What is indexed?",
      padding: "x".repeat(129 * 1024)
    })
  });
  assert.equal(oversizedBody.response.status, 413);
});

test("unpublished board checkpoints never masquerade as published Context", async () => {
  const releases = await api("/context/releases?repository=" + encodeURIComponent(repository), {
    headers: contextHeaders()
  });
  assert.equal(releases.response.status, 200);
  assert.deepEqual(releases.body.releases, []);

  const searched = await api("/context/search", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({
      repository,
      ref: "main",
      query: "What does the context engine index?"
    })
  });
  assert.equal(searched.response.status, 404);
  assert.equal("answer" in searched.body, false);

  const listed = await api("/context/list?repository=" + encodeURIComponent(repository), {
    headers: contextHeaders()
  });
  assert.equal(listed.response.status, 404);
});

test("ACL failures do not reveal repository existence", async () => {
  const stranger = await api("/context/search", {
    method: "POST",
    headers: { ...contextHeaders(), "x-jina-principal-id": "user:stranger@example.com" },
    body: JSON.stringify({ repository, query: "What is indexed?" })
  });
  assert.equal(stranger.response.status, 404);
  const forbiddenBuild = await api("/context/build", {
    method: "POST",
    headers: { ...contextHeaders(), "x-jina-principal-id": "user:stranger@example.com" },
    body: JSON.stringify({ repository, ref: "main" })
  });
  assert.equal(forbiddenBuild.response.status, 403);

  const invalid = await api("/context/search", {
    method: "POST",
    headers: contextHeaders(),
    body: JSON.stringify({ repository, query: "What is indexed?", limit: 0 })
  });
  assert.equal(invalid.response.status, 400);
});

test("all public context routes require a bound principal in production", async () => {
  const protectedStore = new MemoryContextEngineStore();
  const protectedServer = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextStore: protectedStore
  });
  await new Promise<void>((resolve) => protectedServer.listen(0, "127.0.0.1", resolve));
  const protectedUrl = `http://127.0.0.1:${(protectedServer.address() as AddressInfo).port}`;
  try {
    for (const path of [
      `/context/releases?repository=${encodeURIComponent(repository)}`,
      `/context/list?repository=${encodeURIComponent(repository)}`,
      `/context/read?repository=${encodeURIComponent(repository)}&document=kr_hidden`,
      `/context/diff?repository=${encodeURIComponent(repository)}&fromReleaseId=ig_a&toReleaseId=ig_b`,
      "/context/metrics"
    ]) {
      const response = await fetch(`${protectedUrl}${path}`, {
        headers: { authorization: `Bearer ${contextToken}` }
      });
      assert.equal(response.status, 401, path);
    }
    for (const path of ["/context/build", "/context/search"]) {
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

test("unsigned dev webhooks coexist with strict token-bound API identity", async () => {
  const strictDevStore = new MemoryContextEngineStore();
  await strictDevStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const strictDevServer = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    trustDevIdentityHeaders: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: principalId,
    contextStore: strictDevStore
  });
  await new Promise<void>((resolve) => strictDevServer.listen(0, "127.0.0.1", resolve));
  const strictDevUrl = `http://127.0.0.1:${(strictDevServer.address() as AddressInfo).port}`;
  try {
    const devWebhook = await fetch(`${strictDevUrl}/dev/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository,
        push: true,
        ref: "main",
        headSha: "b".repeat(40)
      })
    });
    assert.equal(devWebhook.status, 202);

    const spoofedWithoutToken = await fetch(
      `${strictDevUrl}/context/releases?repository=${encodeURIComponent(repository)}`,
      {
        headers: {
          "x-jina-tenant-id": tenantId,
          "x-jina-principal-id": `tenant:${tenantId}`
        }
      }
    );
    assert.equal(spoofedWithoutToken.status, 401);

    const wrongTenant = await fetch(`${strictDevUrl}/context/releases?repository=${encodeURIComponent(repository)}`, {
      headers: {
        authorization: `Bearer ${contextToken}`,
        "x-jina-tenant-id": "tenant-attacker"
      }
    });
    assert.equal(wrongTenant.status, 401);

    const contextAuthenticated = await fetch(
      `${strictDevUrl}/context/releases?repository=${encodeURIComponent(repository)}`,
      { headers: { authorization: `Bearer ${contextToken}` } }
    );
    assert.notEqual(contextAuthenticated.status, 401);

    const internalAuthenticated = await fetch(`${strictDevUrl}/board`, {
      headers: { authorization: `Bearer ${internalToken}` }
    });
    assert.equal(internalAuthenticated.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => strictDevServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("context bearer is query-only and server-side bound to its configured tenant and principal", async () => {
  const boundStore = new MemoryContextEngineStore();
  const boundServer = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: principalId,
    contextStore: boundStore
  });
  await new Promise<void>((resolve) => boundServer.listen(0, "127.0.0.1", resolve));
  const boundUrl = `http://127.0.0.1:${(boundServer.address() as AddressInfo).port}`;
  try {
    await boundStore.replaceRepositoryAccess(tenantId, principalId, [repository, "acme/other"]);
    const merged = await fetch(`${boundUrl}/internal/context/access/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
        "x-jina-principal-id": principalId
      },
      body: JSON.stringify({ repositories: [repository], mode: "merge" })
    });
    assert.equal(merged.status, 200);
    assert.deepEqual(await boundStore.repositoriesForPrincipal(tenantId, principalId), ["acme/other", repository]);
    const spoofedAccessSync = await fetch(`${boundUrl}/internal/context/access/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
        "x-jina-tenant-id": "tenant-attacker",
        "x-jina-principal-id": "user:attacker@example.com"
      },
      body: JSON.stringify({ repositories: ["attacker/repository"], mode: "replace" })
    });
    assert.equal(spoofedAccessSync.status, 401);
    assert.deepEqual(await boundStore.repositoriesForPrincipal("tenant-attacker", "user:attacker@example.com"), []);
    const accepted = await fetch(`${boundUrl}/context/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${contextToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ repository, query: "What is indexed?" })
    });
    assert.notEqual(accepted.status, 401);
    const rejected = await fetch(`${boundUrl}/context/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${contextToken}`,
        "content-type": "application/json",
        "x-jina-tenant-id": "tenant-attacker",
        "x-jina-principal-id": "tenant:tenant-attacker"
      },
      body: JSON.stringify({ repository, query: "What is indexed?" })
    });
    assert.equal(rejected.status, 401);
    // Browsing stays bound to the same tenant and repository access as search.
    for (const path of [
      `/context/releases?repository=${encodeURIComponent(repository)}`,
      `/context/list?repository=${encodeURIComponent(repository)}`,
      `/context/read?repository=${encodeURIComponent(repository)}&document=kr_missing`,
      `/context/diff?repository=${encodeURIComponent(repository)}&fromReleaseId=ig_a&toReleaseId=ig_b`
    ]) {
      const response = await fetch(`${boundUrl}${path}`, {
        headers: { authorization: `Bearer ${contextToken}` }
      });
      assert.notEqual(response.status, 401, `GET ${path}`);
    }
    for (const [method, path] of [
      ["POST", "/context/build"],
      ["POST", "/internal/context/access/sync"],
      // Writes must not ride in on a read path, administration stays internal,
      // and a deeper path under an allowed parent is not itself allowed.
      ["POST", "/context/releases"],
      ["GET", "/context/metrics"],
      ["GET", "/board"],
      ["GET", "/overview"]
    ] as const) {
      const response = await fetch(`${boundUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${contextToken}`,
          "content-type": "application/json"
        },
        ...(method === "POST" ? { body: JSON.stringify({ repository, repositories: [repository] }) } : {})
      });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => boundServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("shared-database builds bind repository and installation to the authoritative tenant identity", async () => {
  const sharedTenant = "eff0efc9-b103-494a-b7a3-1ae7f95c2d26";
  const otherTenant = "4976982e-e48f-423a-8520-5ea8c2883d62";
  const provisionedRepository = "omxyz/jina";
  const provisionedInstallationId = 140435029;
  const sharedStore = new MemoryContextEngineStore();
  const sharedServer = createApiServer({
    internalApiToken: internalToken,
    contextStore: sharedStore,
    sharedIdentityResolver: {
      async resolveRepository(input) {
        if (
          input.tenantId !== sharedTenant ||
          input.repository.toLowerCase() !== provisionedRepository ||
          (input.githubInstallationId !== undefined && input.githubInstallationId !== provisionedInstallationId)
        ) {
          return undefined;
        }
        return {
          tenantId: sharedTenant,
          githubAccountId: "1",
          githubAccountLogin: "omxyz",
          githubAccountType: "Organization",
          githubRepositoryId: "2",
          githubInstallationId: String(provisionedInstallationId),
          repository: "omxyz/jina",
          defaultBranch: "main"
        };
      },
      async listTenantIds() {
        return [sharedTenant, otherTenant];
      },
      async ping() {},
      async close() {}
    }
  });
  await new Promise<void>((resolve) => sharedServer.listen(0, "127.0.0.1", resolve));
  const sharedUrl = `http://127.0.0.1:${(sharedServer.address() as AddressInfo).port}`;
  const headers = {
    authorization: `Bearer ${internalToken}`,
    "content-type": "application/json",
    "x-jina-tenant-id": sharedTenant,
    "x-jina-principal-id": `tenant:${sharedTenant}`
  };
  try {
    const mismatchedInstallation = await fetch(`${sharedUrl}/context/build`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repository: provisionedRepository,
        githubInstallationId: 147869268,
        requestKey: "mismatched-installation"
      })
    });
    assert.equal(mismatchedInstallation.status, 404);

    const crossTenantRepository = await fetch(`${sharedUrl}/context/build`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repository: "Alliancexyz/alliance-network",
        githubInstallationId: 147869268,
        requestKey: "cross-tenant-repository"
      })
    });
    assert.equal(crossTenantRepository.status, 404);

    const accepted = await fetch(`${sharedUrl}/context/build`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repository: "OmXYZ/Jina", requestKey: "provisioned-repository" })
    });
    assert.equal(accepted.status, 202);
    const build = record(record(await accepted.json()).build);
    assert.equal(build.repository, provisionedRepository);
    assert.equal(build.ref, "main");
    assert.equal(build.refSequence, 1);
    assert.equal("stages" in build, false);

    const claimed = await fetch(`${sharedUrl}/internal/worker/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workerId: "shared-board-snapshot",
        topics: ["run-context-input-snapshot"]
      })
    });
    assert.equal(claimed.status, 200);
    const task = record(record(await claimed.json()).task);
    assert.equal(task.type, "snapshot-context-input");
    assert.equal(record(task.metadata).tenantId, sharedTenant);
    assert.equal(record(task.metadata).repository, provisionedRepository);
    assert.equal(record(task.metadata).ref, "main");
    assert.equal(record(task.metadata).githubInstallationId, provisionedInstallationId);
  } finally {
    await new Promise<void>((resolve, reject) => sharedServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("shared-database workers claim across provisioned tenants without a tenant header", async () => {
  const sharedTenant = "eff0efc9-b103-494a-b7a3-1ae7f95c2d26";
  const sharedStore = new MemoryContextEngineStore();
  const sharedServer = createApiServer({
    internalApiToken: internalToken,
    contextApiToken: contextToken,
    contextWorkerLeaseMs: 90_000,
    contextStore: sharedStore,
    sharedIdentityResolver: {
      async resolveRepository(input) {
        if (input.repository !== repository) return undefined;
        return {
          tenantId: sharedTenant,
          githubAccountId: "1",
          githubAccountLogin: "omlabs",
          githubAccountType: "Organization",
          githubRepositoryId: "2",
          githubInstallationId: "140435029",
          repository,
          defaultBranch: "main"
        };
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
    const admitted = await fetch(`${sharedUrl}/context/build`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
        "x-jina-tenant-id": sharedTenant,
        "x-jina-principal-id": `tenant:${sharedTenant}`
      },
      body: JSON.stringify({
        repository,
        commitSha: "7".repeat(40),
        requestKey: "shared-board-claim"
      })
    });
    assert.equal(admitted.status, 202);

    const claimStartedAt = Date.now();
    const response = await fetch(`${sharedUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ workerId: "shared-worker", topics: ["run-context-input-snapshot"] })
    });
    const claimCompletedAt = Date.now();
    assert.equal(response.status, 200);
    const body = record(await response.json());
    const message = record(body.message);
    const task = record(body.task);
    assert.equal(task.type, "snapshot-context-input");
    assert.equal(record(task.metadata).tenantId, sharedTenant);
    assert.equal(typeof message.writeFenceToken, "string");
    const leaseExpiresAt = Date.parse(String(message.leaseExpiresAt));
    assert.ok(leaseExpiresAt >= claimStartedAt + 90_000);
    assert.ok(leaseExpiresAt <= claimCompletedAt + 90_000);

    const renewStartedAt = Date.now();
    const renewed = await fetch(`${sharedUrl}/internal/worker/renew`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
        "x-jina-tenant-id": sharedTenant
      },
      body: JSON.stringify({
        messageId: message.id,
        leaseId: message.leaseId,
        attempt: message.attempt,
        writeFenceToken: message.writeFenceToken
      })
    });
    const renewCompletedAt = Date.now();
    assert.equal(renewed.status, 200);
    const renewedBoard = record(
      await (
        await fetch(`${sharedUrl}/board`, {
          headers: {
            authorization: `Bearer ${internalToken}`,
            "x-jina-tenant-id": sharedTenant,
            "x-jina-principal-id": `tenant:${sharedTenant}`
          }
        })
      ).json()
    );
    const renewedMessage = array(renewedBoard.outbox)
      .map(record)
      .find((candidate) => candidate.id === message.id);
    assert.ok(renewedMessage);
    const renewedLeaseExpiresAt = Date.parse(String(renewedMessage.leaseExpiresAt));
    assert.ok(renewedLeaseExpiresAt >= renewStartedAt + 90_000);
    assert.ok(renewedLeaseExpiresAt <= renewCompletedAt + 90_000);
  } finally {
    await new Promise<void>((resolve, reject) => sharedServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("worker lease duration rejects unsafe API configuration", () => {
  assert.throws(
    () => createApiServer({ contextWorkerLeaseMs: 0 }),
    /contextWorkerLeaseMs must be a positive safe integer/
  );
  assert.throws(
    () => createApiServer({ contextWorkerLeaseMs: Number.MAX_SAFE_INTEGER + 1 }),
    /contextWorkerLeaseMs must be a positive safe integer/
  );
});

test("pull-request intake queues review work and a PR-preview context build", async () => {
  const delivery = await api("/dev/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repository,
      pullRequestNumber: 77,
      headSha: "f".repeat(40)
    })
  });
  assert.equal(delivery.response.status, 202);

  const board = await api("/board", { headers: contextHeaders() });
  const tasks = array(board.body.tasks)
    .map(record)
    .filter((task) => record(task.metadata).pullRequestNumber === 77);
  assert.deepEqual(tasks.map((task) => task.type).sort(), ["pr_review", "review_pass"]);
  assert.deepEqual(
    tasks.flatMap((task) => (task.dispatchTopic ? [task.dispatchTopic] : [])),
    ["run-review"]
  );
  const contextBuild = array(board.body.tasks)
    .map(record)
    .find(
      (candidate) =>
        candidate.type === "build-context" &&
        record(candidate.metadata).ref === "pull/77/head" &&
        record(candidate.metadata).commitSha === "f".repeat(40)
    );
  assert.ok(contextBuild);
  assert.equal(record(contextBuild.metadata).trigger, "pull_request");
  const snapshot = array(board.body.tasks)
    .map(record)
    .find(
      (candidate) =>
        candidate.type === "snapshot-context-input" && record(candidate.metadata).contextBuildId === contextBuild.id
    );
  assert.ok(snapshot);
  assert.equal(snapshot.status, "queued");
  assert.equal(
    ["inputArtifact", "planArtifact", "dependencyResults", "githubInstallationId"].some(
      (key) => key in record(snapshot.metadata)
    ),
    false
  );

  const catalog = await fetch(`${baseUrl}/task-types`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(
    array(await catalog.json())
      .map(record)
      .map((entry) => entry.type)
      .filter((type) => ["context", "publish", "cleanup"].includes(String(type))),
    []
  );
});

test("generic board work is fenced by attempt, lease id, and token", async () => {
  const delivery = await api("/dev/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repository,
      pullRequestNumber: 78,
      headSha: "e".repeat(40)
    })
  });
  assert.equal(delivery.response.status, 202);
  const claimed = await api("/internal/worker/claim", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ workerId: "review-worker", topics: ["run-review"] })
  });
  assert.equal(claimed.response.status, 200);
  const message = record(claimed.body.message);
  const task = record(claimed.body.task);
  const messageId = string(message.id);
  const taskId = string(task.id);
  const leaseId = string(message.leaseId);
  const attempt = Number(message.attempt);
  const writeFenceToken = string(message.writeFenceToken);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0);

  const boardView = await api("/board", { headers: contextHeaders() });
  const publicMessage = array(boardView.body.outbox)
    .map(record)
    .find((candidate) => candidate.id === messageId);
  assert.ok(publicMessage);
  assert.equal("leaseId" in publicMessage, false);
  assert.equal("writeFenceToken" in publicMessage, false);

  const staleRenewal = await api("/internal/worker/renew", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      messageId,
      leaseId,
      attempt,
      writeFenceToken: "wrong-fence"
    })
  });
  assert.equal(staleRenewal.response.status, 409);

  const renewed = await api("/internal/worker/renew", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ messageId, leaseId, attempt, writeFenceToken })
  });
  assert.equal(renewed.response.status, 200);

  const staleCompletion = await api("/internal/worker/complete", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      messageId,
      taskId,
      leaseId,
      attempt: attempt + 1,
      writeFenceToken,
      outcome: "done"
    })
  });
  assert.equal(staleCompletion.response.status, 409);

  const completed = await api("/internal/worker/complete", {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      messageId,
      taskId,
      leaseId,
      attempt,
      writeFenceToken,
      outcome: "done",
      result: { effect: "reviewed" }
    })
  });
  assert.equal(completed.response.status, 200);
});

test("push and issue intake create context builds on their event-specific refs", async () => {
  const pushSha = "6".repeat(40);
  const pushed = await api("/dev/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository, push: true, ref: "release", headSha: pushSha })
  });
  assert.equal(pushed.response.status, 202);
  const afterPush = await api("/board", { headers: contextHeaders() });
  const pushedBuild = array(afterPush.body.tasks)
    .map(record)
    .find(
      (candidate) =>
        candidate.type === "build-context" &&
        record(candidate.metadata).ref === "release" &&
        record(candidate.metadata).commitSha === pushSha
    );
  assert.ok(pushedBuild);
  assert.equal(record(pushedBuild.metadata).trigger, "push");

  const issue = await api("/dev/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository, issueNumber: 92, title: "Investigate retries", defaultBranch: "trunk" })
  });
  assert.equal(issue.response.status, 202);
  const afterIssue = await api("/board", { headers: contextHeaders() });
  const issueBuild = array(afterIssue.body.tasks)
    .map(record)
    .find(
      (candidate) =>
        candidate.type === "build-context" &&
        record(candidate.metadata).ref === "trunk" &&
        record(candidate.metadata).trigger === "issue"
    );
  assert.ok(issueBuild);
  assert.equal("commitSha" in record(issueBuild.metadata), false);

  const contextBuildCount = array(afterIssue.body.tasks)
    .map(record)
    .filter((candidate) => candidate.type === "build-context").length;
  const issueComment = await signedGitHubWebhook("issue_comment", "comment-no-context-build", {
    action: "created",
    repository: { full_name: repository },
    issue: { number: 92 },
    comment: { id: 9201, body: "This must not start Context generation." }
  });
  assert.equal(issueComment.status, 202);
  const editedIssue = await signedGitHubWebhook("issues", "edited-no-context-build", {
    action: "edited",
    repository: { full_name: repository }
  });
  assert.equal(editedIssue.status, 202);

  const afterNonTriggers = await api("/board", { headers: contextHeaders() });
  assert.equal(
    array(afterNonTriggers.body.tasks)
      .map(record)
      .filter((candidate) => candidate.type === "build-context").length,
    contextBuildCount
  );
});

test("signed push redelivery is idempotent while a distinct rollback delivery advances the ref", async () => {
  const ref = "refs/heads/rollback-proof";
  const firstHead = "7".repeat(40);
  const secondHead = "8".repeat(40);
  const payload = (before: string, after: string) => ({
    ref,
    before,
    after,
    deleted: false,
    repository: { full_name: repository },
    installation: { id: 140435029 }
  });

  const first = await signedGitHubWebhook("push", "rollback-proof-first", payload("0".repeat(40), firstHead));
  assert.equal(first.status, 202);
  const second = await signedGitHubWebhook("push", "rollback-proof-second", payload(firstHead, secondHead));
  assert.equal(second.status, 202);

  const replay = await signedGitHubWebhook("push", "rollback-proof-second", payload(firstHead, secondHead));
  assert.equal(replay.status, 200);
  assert.equal(record(await replay.json()).duplicate, true);

  const rollback = await signedGitHubWebhook("push", "rollback-proof-rollback", payload(secondHead, firstHead));
  assert.equal(rollback.status, 202);

  const board = await api("/board", { headers: contextHeaders() });
  const builds = array(board.body.tasks)
    .map(record)
    .filter(
      (candidate) =>
        candidate.type === "build-context" &&
        record(candidate.metadata).repository === repository &&
        record(candidate.metadata).ref === "rollback-proof"
    )
    .sort((left, right) => Number(record(left.metadata).refSequence) - Number(record(right.metadata).refSequence));
  assert.deepEqual(
    builds.map((build) => ({
      refSequence: record(build.metadata).refSequence,
      commitSha: record(build.metadata).commitSha
    })),
    [
      { refSequence: 1, commitSha: firstHead },
      { refSequence: 2, commitSha: secondHead },
      { refSequence: 3, commitSha: firstHead }
    ]
  );
});

test("malformed persisted runtime state is ignored instead of breaking unrelated API reads", async () => {
  const malformedServer = createApiServer({
    tenantId,
    enableDevEndpoints: true,
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
    devDeliverySequence: 0
  } as unknown as ApiSnapshot;
  const staleServer = createApiServer({
    tenantId,
    enableDevEndpoints: true,
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

async function signedGitHubWebhook(
  event: string,
  deliveryId: string,
  payload: Readonly<Record<string, unknown>>
): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", githubWebhookSecret).update(rawBody).digest("hex")}`;
  return fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature
    },
    body: rawBody
  });
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
