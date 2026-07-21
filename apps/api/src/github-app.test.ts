import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  createOntologyGraph,
  MemoryOntologyGraphStore,
  ONTOLOGY_PARSER_VERSION,
  type RetrievalRequest,
  type RetrievalResult
} from "@jina/ontology";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const SECRET = "test-webhook-secret";
const INTERNAL_TOKEN = "test-internal-token";
const TENANT = "github:installation:99";

test("signed GitHub App deliveries create idempotent PR and issue tasks", async (context) => {
  const server = createApiServer({ githubWebhookSecret: SECRET, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const issuePayload = issueOpenedPayload();

  const rejected = await deliver(baseUrl, "issues", "delivery-bad", issuePayload, "wrong-secret");
  assert.equal(rejected.status, 401);

  const issue = await deliver(baseUrl, "issues", "delivery-issue-1", issuePayload);
  assert.equal(issue.status, 202);
  assert.equal((await issue.json() as { outcome: string }).outcome, "created");

  const repeatedDelivery = await deliver(baseUrl, "issues", "delivery-issue-1", issuePayload);
  assert.equal(repeatedDelivery.status, 200);
  assert.equal((await repeatedDelivery.json() as { duplicate: boolean }).duplicate, true);

  const sameIssueNewDelivery = await deliver(baseUrl, "issues", "delivery-issue-redelivery", issuePayload);
  assert.equal((await sameIssueNewDelivery.json() as { outcome: string }).outcome, "duplicate");

  const pullRequest = await deliver(baseUrl, "pull_request", "delivery-pr-1", pullRequestPayload(42, "abc123"));
  assert.equal(pullRequest.status, 202);
  assert.equal((await pullRequest.json() as { createdTaskIds: string[] }).createdTaskIds.length, 3);

  await deliver(baseUrl, "pull_request", "delivery-pr-2", pullRequestPayload(43, "other123"));
  await deliver(baseUrl, "pull_request", "delivery-pr-1-sync", pullRequestPayload(42, "def456", "synchronize"));

  assert.equal((await fetch(`${baseUrl}/board`)).status, 401);
  const boardResponse = await authenticatedFetch(`${baseUrl}/board`);
  const board = await boardResponse.json() as {
    tasks: Array<{ type: string; status: string; metadata: Record<string, unknown> }>;
    dependencies: Array<{
      taskId: string;
      dependsOnTaskId: string;
      relationship: string;
      required: boolean;
    }>;
    outbox: Array<{ topic: string }>;
  };

  assert.equal(board.tasks.filter((task) => task.type === "issue_triage").length, 1);
  assert.equal(board.tasks.find((task) => task.type === "issue_triage")?.status, "triage");
  assert.equal(board.tasks.filter((task) => task.type === "pr_review").length, 3);
  assert.equal(
    board.tasks
      .filter((task) => task.metadata.pullRequestNumber === 43)
      .some((task) => task.status === "superseded"),
    false,
    "synchronizing one PR must not supersede another PR's tasks"
  );
  assert.equal(
    board.tasks.find(
      (task) => task.type === "review_pass" && task.metadata.pullRequestNumber === 42 && task.metadata.headSha === "def456"
    )?.status,
    "queued"
  );
  assert.equal(board.outbox.filter((message) => message.topic === "run-review").length, 3);
  assert.equal(board.dependencies.length, 12);
  assert.equal(
    board.dependencies.some(
      (dependency) => dependency.relationship === "blocks" && dependency.required
    ),
    true
  );

  const taskTypes = await fetch(`${baseUrl}/task-types`).then(
    (response) => response.json() as Promise<Array<{
      type: string;
      kind: string;
      description: string;
      triggeredBy: Array<{ source: string; description: string; workflows: string[]; conditions: string[] }>;
      dependsOn: Array<{ taskType: string; relationships: string[]; conditions: string[] }>;
      requiredBy: Array<{ taskType: string; relationships: string[] }>;
    }>>
  );
  assert.equal(taskTypes.length, 11);
  assert.deepEqual(
    taskTypes.map((definition) => definition.type),
    [
      "pr_review", "review_pass", "context", "publish", "cleanup", "issue_triage", "human_decision",
      "ontology_build", "ontology_ingest", "ontology_assert", "ontology_project"
    ]
  );
  assert.equal(taskTypes.every((definition) => definition.kind.length > 0 && definition.description.length > 0), true);
  assert.deepEqual(
    taskTypes.find((definition) => definition.type === "ontology_ingest")?.triggeredBy,
    [
      {
        source: "POST /ontology/build",
        description: "Creates and queues the first executable Ontology task.",
        workflows: ["ontology_build"],
        conditions: []
      },
      {
        source: "GitHub push webhook",
        description: "Queues repository intake for a pushed branch head.",
        workflows: ["ontology_build"],
        conditions: []
      }
    ]
  );
  assert.equal(taskTypes.find((definition) => definition.type === "ontology_assert")?.triggeredBy[0]?.source, "POST /ontology/build");
  assert.equal(taskTypes.find((definition) => definition.type === "ontology_project")?.triggeredBy[0]?.source, "POST /ontology/build");
  assert.equal(taskTypes.find((definition) => definition.type === "publish")?.triggeredBy[0]?.source, "GitHub pull_request webhook");
  assert.deepEqual(
    taskTypes.find((definition) => definition.type === "ontology_project")?.dependsOn,
    [{ taskType: "ontology_assert", relationships: ["blocks"], workflows: ["ontology_build"], required: true, conditions: [] }]
  );
  assert.deepEqual(
    taskTypes.find((definition) => definition.type === "review_pass")?.dependsOn,
    [{
      taskType: "context",
      relationships: ["context_for"],
      workflows: ["pr_review"],
      required: true,
      conditions: ["when external context is requested"]
    }]
  );
  assert.deepEqual(
    taskTypes.find((definition) => definition.type === "review_pass")?.requiredBy.map((dependency) => dependency.taskType),
    ["pr_review", "publish"]
  );
});

test("branch pushes create and supersede the existing ontology workflow", async (context) => {
  const server = createApiServer({ githubWebhookSecret: SECRET, internalApiToken: INTERNAL_TOKEN, tenantId: TENANT });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const first = await deliver(baseUrl, "push", "push-1", pushPayload("a".repeat(40)));
  assert.equal(first.status, 202);
  assert.equal((await first.json() as { createdTaskIds: string[] }).createdTaskIds.length, 4);
  const repeatedHead = await deliver(baseUrl, "push", "push-2", pushPayload("a".repeat(40)));
  assert.equal((await repeatedHead.json() as { outcome: string }).outcome, "duplicate");
  const second = await deliver(baseUrl, "push", "push-3", pushPayload("b".repeat(40)));
  assert.equal((await second.json() as { createdTaskIds: string[] }).createdTaskIds.length, 4);
  const returned = await deliver(baseUrl, "push", "push-4", pushPayload("a".repeat(40)));
  assert.equal((await returned.json() as { createdTaskIds: string[] }).createdTaskIds.length, 4,
    "moving a branch back to an earlier SHA is a new ref transition, not a redelivery");

  const board = await authenticatedFetch(`${baseUrl}/board`).then((response) => response.json() as Promise<{
    tasks: Array<{ type: string; status: string; metadata: Record<string, unknown> }>;
  }>);
  const current = board.tasks.filter((task) => task.metadata.githubDeliveryId === "push-4");
  const old = board.tasks.filter((task) => task.metadata.githubDeliveryId === "push-3");
  assert.deepEqual(current.map((task) => task.type).sort(), ["ontology_assert", "ontology_build", "ontology_ingest", "ontology_project"]);
  assert.equal(current.find((task) => task.type === "ontology_ingest")?.status, "queued");
  assert.equal(old.every((task) => task.status === "superseded"), true);
});

test("ontology retrieval forwards generalized Issue identity and Feature text", async () => {
  class CapturingOntologyStore extends MemoryOntologyGraphStore {
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
  const ontologyStore = new CapturingOntologyStore();
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default", ontologyStore });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/ontology/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/ontology-fixture",
        template: "issue_trace",
        issueEntityId: "entity_virtual_issue"
      })
    });
    assert.equal(response.status, 200);
    assert.equal(ontologyStore.request?.issueEntityId, "entity_virtual_issue");
    const featureResponse = await fetch(`${baseUrl}/ontology/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/ontology-fixture",
        template: "feature_trace",
        featureText: "administrator deletion"
      })
    });
    assert.equal(featureResponse.status, 200);
    assert.equal(ontologyStore.request?.featureText, "administrator deletion");
  } finally {
    await close(server);
  }
});

test("ontology pipeline ingests, asserts, projects, and reuses content-addressed blobs", async () => {
  const server = createApiServer({
    enableDevEndpoints: true,
    tenantId: "default"
  });
  const baseUrl = await listen(server);
  try {
    const created = await fetch(`${baseUrl}/ontology/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "omxyz/ontology-fixture", ref: "main", requestKey: "test" })
    });
    assert.equal(created.status, 202);
    const createdBody = await created.json() as { task: { id: string } };
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const readmeSha = "c".repeat(40);
    const sourceSha = "d".repeat(40);
    const ingestion = await claimTopic(baseUrl, "run-ontology-ingest");
    assert.equal(ingestion.message.topic, "run-ontology-ingest");

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

    const snapshot = {
      tenantId: "default",
      repository: "omxyz/ontology-fixture",
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
    const firstPlan = await postJson(baseUrl, "/internal/ontology/ingest/plan", { ...lease, snapshot }) as {
      missingBlobs: unknown[];
      changedPaths: string[];
      observationId: string;
    };
    assert.equal(firstPlan.missingBlobs.length, 2);
    assert.deepEqual(firstPlan.changedPaths, ["README.md", "src/index.ts"]);
    await postJson(baseUrl, "/internal/ontology/ingest/blobs", {
      taskId: ingestion.task.id,
      ...lease,
      commitSha,
      analyses: [
        { blobSha: readmeSha, parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [], edges: [] },
        {
          blobSha: sourceSha,
          parserVersion: ONTOLOGY_PARSER_VERSION,
          language: "typescript",
          symbols: [{ moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }],
          imports: [], edges: []
        }
      ]
    });
    const secondPlan = await postJson(baseUrl, "/internal/ontology/ingest/plan", { ...lease, snapshot }) as { missingBlobs: unknown[]; reusedBlobCount: number };
    assert.equal(secondPlan.missingBlobs.length, 0);
    assert.equal(secondPlan.reusedBlobCount, 2);
    assert.equal(await completeClaim(baseUrl, ingestion, {
      observationId: firstPlan.observationId,
      commitSha,
      fileCount: 2,
      discoveredBlobCount: 2,
      reusedBlobCount: 0,
      parsedBlobCount: 2,
      parserVersion: ONTOLOGY_PARSER_VERSION,
      codeCheckpoint: "code-checkpoint",
      evidenceFingerprint: "evidence-fixture"
    }), 200);

    const assertion = await claimTopic(baseUrl, "run-ontology-assert");
    assert.equal(assertion.message.topic, "run-ontology-assert");
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
          repository: "omxyz/ontology-fixture",
          ref: "main",
          commitSha,
          taskId: assertion.task.id,
          generatedAt: new Date().toISOString(),
          generatorVersion: "codex-assertions-v2",
          registryVersion: "ontology-registry-v1",
          evidenceFingerprint: "evidence-fixture",
          evidenceObservationIds: [],
          model: "fixture",
          summary: "README documents the repository",
          rawOutput: {
            summary: "README documents the repository",
            nodes: [
              { id: "repo", kind: "Repository", label: "fixture", description: "repo", evidence: ["README.md:1"] },
              { id: "readme", kind: "Document", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
            ],
            edges: [{
              source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge", confidence: 0.95,
              why: "The README explicitly documents this repository.", evidence: ["README.md:1"]
            }]
          }
        }
      })
    });
    assert.equal(asserted.status, 200);

    const projection = await claimTopic(baseUrl, "run-ontology-project");
    assert.equal(await completeClaim(baseUrl, projection, { projected: true }), 200);

    const ontology = await fetch(`${baseUrl}/ontology`).then(
      (response) => response.json() as Promise<{ latest: { nodes: unknown[]; edges: unknown[] } | null }>
    );
    assert.equal((ontology.latest?.nodes.length ?? 0) >= 4, true);
    assert.equal((ontology.latest?.edges.length ?? 0) >= 3, true);

    const contextAnswer = await fetch(`${baseUrl}/ontology/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "omxyz/ontology-fixture",
        ref: "main",
        question: "Where is main implemented?"
      })
    }).then((response) => response.json() as Promise<{
      answer: string;
      citedClaims: Array<{ text: string; citations: unknown[] }>;
      calls: Array<{ template: string; items: Array<{ kind: string }> }>;
      unresolvedAmbiguities: string[];
      coverageGaps: unknown[];
    }>);
    assert.match(contextAnswer.answer, /main is function in src\/index\.ts/);
    assert.equal(contextAnswer.citedClaims[0]?.citations.length, 1);
    assert.equal(contextAnswer.calls[0]?.template, "structure");
    assert.equal(contextAnswer.calls[0]?.items[0]?.kind, "symbol_definition");
    assert.deepEqual(contextAnswer.unresolvedAmbiguities, []);
    assert.deepEqual(contextAnswer.coverageGaps, []);

    const board = await fetch(`${baseUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: Array<{ id: string; type: string; status: string; metadata: Record<string, unknown> }> }>
    );
    assert.equal(board.tasks.find((task) => task.id === createdBody.task.id)?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "ontology_ingest")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "ontology_assert")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "ontology_project")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "ontology_project")?.metadata.commitSha, commitSha);
  } finally {
    await close(server);
  }
});

test("a new ontology attempt supersedes older active work for the same repository ref", async () => {
  const server = createApiServer({ enableDevEndpoints: true, tenantId: "default" });
  const baseUrl = await listen(server);
  try {
    for (const requestKey of ["first", "second", "second"]) {
      const response = await fetch(`${baseUrl}/ontology/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository: "omxyz/ontology-fixture", ref: "main", requestKey })
      });
      assert.equal(response.status, 202);
    }
    const board = await fetch(`${baseUrl}/board`).then((response) => response.json() as Promise<{
      tasks: Array<{ type: string; status: string; metadata: Record<string, unknown> }>;
    }>);
    const first = board.tasks.filter((task) => task.metadata.requestKey === "first");
    const second = board.tasks.filter((task) => task.metadata.requestKey === "second");
    assert.equal(first.length, 4);
    assert.equal(first.every((task) => task.status === "superseded"), true);
    assert.equal(second.length, 4, "an idempotent request key does not duplicate the attempt");
    assert.equal(second.find((task) => task.type === "ontology_ingest")?.status, "queued");
    assert.equal(second.some((task) => task.status === "blocked"), false);
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
      (response) => response.json() as Promise<{ tasks: Array<{ type: string; status: string }>; publications: unknown[] }>
    );
    assert.equal(board.tasks.find((task) => task.type === "review_pass")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "publish")?.status, "done");
    assert.equal(board.tasks.find((task) => task.type === "pr_review")?.status, "done");
    assert.equal(board.publications.length, 1);
  } finally {
    await close(server);
  }
});

test("ontology reads require authentication and cannot cross tenant boundaries", async () => {
  const ontologyStore = new MemoryOntologyGraphStore();
  const tenantAGraph = fixtureGraph({ tenantId: "tenant-a", repository: "omxyz/a", ref: "main", taskId: "task-a" });
  const tenantBGraph = fixtureGraph({ tenantId: "tenant-b", repository: "omxyz/b", ref: "main", taskId: "task-b" });
  await ontologyStore.save(tenantAGraph);
  await ontologyStore.save(tenantBGraph);
  await ontologyStore.executeCommand("tenant-a", "svc:test", {
    type: "grant_repository_access", repository: "omxyz/a", principalId: "user:reader@example.com", role: "reader"
  }, "2026-07-20T00:00:00.000Z");
  const server = createApiServer({
    ontologyStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "tenant-a",
    tenantAdminPrincipalIds: ["user:admin@example.com"]
  });
  const baseUrl = await listen(server);
  try {
    assert.equal((await fetch(`${baseUrl}/ontology`)).status, 401);
    const list = await authenticatedFetch(`${baseUrl}/ontology`).then(
      (response) => response.json() as Promise<{ graphs: Array<{ id: string; tenantId: string }> }>
    );
    assert.deepEqual(list.graphs.map((graph) => graph.tenantId), ["tenant-a"]);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/graphs/${tenantAGraph.id}`)).status, 200);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/graphs/${tenantBGraph.id}`)).status, 404);
    const reader = await authenticatedFetch(`${baseUrl}/ontology`, "user:reader@example.com").then(
      (response) => response.json() as Promise<{ graphs: Array<{ repository: string }> }>
    );
    assert.deepEqual(reader.graphs.map((graph) => graph.repository), ["omxyz/a"]);
    const stranger = await authenticatedFetch(`${baseUrl}/ontology`, "user:stranger@example.com").then(
      (response) => response.json() as Promise<{ graphs: unknown[] }>
    );
    assert.deepEqual(stranger.graphs, []);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/graphs/${tenantAGraph.id}`, "user:stranger@example.com")).status, 404);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/metrics`, "user:reader@example.com")).status, 403);
    assert.equal((await authenticatedFetch(`${baseUrl}/ontology/metrics`, "user:admin@example.com")).status, 200);
    const forbiddenCommand = await fetch(`${baseUrl}/ontology/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-jina-principal-id": "user:stranger@example.com",
        "content-type": "application/json"
      },
      body: JSON.stringify({ type: "tombstone_repository", repository: "omxyz/a", reason: "not authorized" })
    });
    assert.equal(forbiddenCommand.status, 403);
    const drained = await fetch(`${baseUrl}/internal/ontology/outbox/drain`, {
      method: "POST", headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }
    });
    assert.equal(drained.status, 200);
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
      (response) => response.json() as Promise<{ tasks: Array<{ type: string }> }>
    );
    assert.equal(board.tasks.filter((task) => task.type === "issue_triage").length, 1);

    const duplicate = await deliver(secondUrl, "issues", "delivery-persisted", issueOpenedPayload());
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);

    const health = await fetch(`${secondUrl}/health`).then(
      (response) => response.json() as Promise<{ storage: string }>
    );
    assert.equal(health.storage, "postgres");
  } finally {
    await close(second);
  }
});

test("configured aliases migrate existing tasks and ontology graphs to the canonical tenant", async () => {
  const stateStore = new MemoryStateStore();
  const ontologyStore = new MemoryOntologyGraphStore();
  const oldTenant = "github:unscoped";
  const first = createApiServer({
    githubWebhookSecret: SECRET,
    stateStore,
    ontologyStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: oldTenant
  });
  const firstUrl = await listen(first);
  assert.equal((await deliver(firstUrl, "pull_request", "delivery-old-tenant", pullRequestPayload(55, "old-sha"))).status, 202);
  await ontologyStore.save(fixtureGraph({ tenantId: oldTenant, repository: "omlabs/example", ref: "main", taskId: "old-task" }));
  await close(first);

  const second = createApiServer({
    githubWebhookSecret: SECRET,
    stateStore,
    ontologyStore,
    internalApiToken: INTERNAL_TOKEN,
    tenantId: "omlabs",
    tenantAliases: [oldTenant]
  });
  const secondUrl = await listen(second);
  try {
    const board = await authenticatedFetch(`${secondUrl}/board`).then(
      (response) => response.json() as Promise<{ tasks: Array<{ metadata: Record<string, unknown> }> }>
    );
    assert.equal(board.tasks.length, 3);
    assert.equal(board.tasks.every((task) => task.metadata.tenantId === "omlabs"), true);
    const ontology = await authenticatedFetch(`${secondUrl}/ontology`).then(
      (response) => response.json() as Promise<{ graphs: Array<{ tenantId: string }> }>
    );
    assert.deepEqual(ontology.graphs.map((graph) => graph.tenantId), ["omlabs"]);
  } finally {
    await close(second);
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

  async close(): Promise<void> {}
}

interface TestClaim {
  readonly message: { readonly id: string; readonly leaseId: string; readonly topic: string };
  readonly task: { readonly id: string };
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

function fixtureGraph(request: { tenantId: string; repository: string; ref: string; taskId: string; commitSha?: string }) {
    return createOntologyGraph({
      request,
      commitSha: request.commitSha ?? "fixture-sha",
      generatedAt: new Date().toISOString(),
      executor: "fixture",
      model: "fixture",
      generated: {
        summary: "Fixture repository",
        nodes: [
          { id: "repo", kind: "Repository", label: request.repository, description: "Repository", evidence: ["README.md:1"] },
          { id: "file:README.md", kind: "File", label: "README.md", description: "Documentation", path: "README.md", evidence: ["README.md:1"] }
        ],
        edges: [{ source: "repo", target: "file:README.md", predicate: "CONTAINS", plane: "code", evidence: ["README.md:1"] }]
      }
    });
}

function authenticatedFetch(url: string, principalId?: string): Promise<Response> {
  return fetch(url, { headers: {
    authorization: `Bearer ${INTERNAL_TOKEN}`,
    ...(principalId ? { "x-jina-principal-id": principalId } : {})
  } });
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
      user: { login: "octocat" }
    },
    repository: { id: 10, full_name: "omlabs/example" },
    installation: { id: 99 },
    sender: { login: "octocat" }
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
      user: { login: "octocat" },
      head: { sha: headSha }
    },
    repository: { id: 10, full_name: "omlabs/example" },
    installation: { id: 99 },
    sender: { login: "octocat" }
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
