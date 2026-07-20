import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  createOntologyGraph,
  stableId
} from "@jina/ontology";
import { PostgresJsonStateStore } from "./postgres-json-state-store.js";
import { PostgresOntologyGraphStore } from "./postgres-ontology-graph-store.js";

const connectionString = process.env.TEST_DATABASE_URL;

test("Postgres atomically stores board completion and an immutable graph", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const stateStore = new PostgresJsonStateStore<{ readonly boardStatus: string }>({ connectionString });
  const graphStore = new PostgresOntologyGraphStore({ connectionString });
  const graph = createOntologyGraph({
    request: { tenantId: "legacy", repository: "omlabs/db-fixture", ref: "main", taskId: "db-test-generation" },
    commitSha: "db-test-sha",
    generatedAt: "2026-07-19T12:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated: {
      summary: "Database fixture",
      nodes: [
        { id: "repo", kind: "Repository", label: "Fixture", description: "Fixture", evidence: ["README.md:1"] },
        { id: "readme", kind: "File", label: "README", description: "Readme", path: "README.md", evidence: ["README.md:1"] }
      ],
      edges: [{ source: "repo", target: "readme", predicate: "CONTAINS", plane: "code", evidence: ["README.md:1"] }]
    }
  });

  try {
    await stateStore.saveWithOntologyGraph({ boardStatus: "done" }, graph);
    assert.deepEqual(await stateStore.load(), { boardStatus: "done" });
    await graphStore.migrateTenantAliases("omlabs", ["legacy"]);
    const summaries = await graphStore.listSummaries("omlabs");
    assert.equal(summaries.find((summary) => summary.id === graph.id)?.nodeCount, 2);
    assert.equal(summaries.find((summary) => summary.id === graph.id)?.edgeCount, 1);
    assert.equal((await graphStore.get(graph.id, "omlabs"))?.nodes.length, 2);
    assert.equal(await graphStore.get(graph.id, "legacy"), undefined);
  } finally {
    await stateStore.close();
    await graphStore.close();
  }
});

test("Postgres reuses content-addressed blobs and projects canonical assertions", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
  const suffix = Date.now().toString(36);
  const snapshot = {
    tenantId: `pipeline-${suffix}`,
    repository: "omlabs/db-pipeline-fixture",
    ref: "main",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    parents: [],
    recordedAt: "2026-07-19T12:00:00.000Z",
    taskId: `ingest-${suffix}`,
    files: [
      { path: "README.md", blobSha: "c".repeat(40), size: 20 },
      { path: "src/index.ts", blobSha: "d".repeat(40), size: 40 }
    ]
  };
  try {
    const first = await store.planIngestion(snapshot);
    assert.equal(first.missingBlobs.length, 2);
    assert.deepEqual(first.changedPaths, ["README.md", "src/index.ts"]);
    await store.applyBlobAnalyses(snapshot, [
      { blobSha: "c".repeat(40), parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [], edges: [] },
      {
        blobSha: "d".repeat(40),
        parserVersion: ONTOLOGY_PARSER_VERSION,
        language: "typescript",
        symbols: [{ moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }],
        imports: [], edges: []
      }
    ]);
    assert.equal((await store.planIngestion({ ...snapshot, taskId: `retry-${suffix}` })).reusedBlobCount, 2);
    const asserted = await store.saveAssertionBatch({
      tenantId: snapshot.tenantId,
      repository: snapshot.repository,
      ref: snapshot.ref,
      commitSha: snapshot.commitSha,
      taskId: `assert-${suffix}`,
      generatedAt: "2026-07-19T12:01:00.000Z",
      generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: ONTOLOGY_REGISTRY_VERSION,
      model: "fixture",
      summary: "README documents the repository",
      rawOutput: {
        summary: "README documents the repository",
        nodes: [
          { id: "repo", kind: "Repository", label: "fixture", description: "repo", evidence: ["README.md:1"] },
          { id: "readme", kind: "Document", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
        ],
        edges: [{ source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge", confidence: 0.95, evidence: ["README.md:1"] }]
      },
      assertions: [{
        subject: { kind: "Repository", naturalKey: `github:repo:${snapshot.repository}`, label: "fixture" },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document", naturalKey: `repo:${snapshot.repository}:path:README.md`, label: "README" },
        confidence: 0.95,
        evidence: ["README.md:1"]
      }]
    });
    assert.equal(asserted.activeCount, 0);
    assert.equal(asserted.proposedCount, 1);
    assert.equal((await store.hasAssertionGeneration(snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_GENERATOR_VERSION))?.cached, true);
    const graph = await store.project({
      tenantId: snapshot.tenantId,
      repository: snapshot.repository,
      ref: snapshot.ref,
      commitSha: snapshot.commitSha,
      taskId: `project-${suffix}`,
      generatedAt: "2026-07-19T12:02:00.000Z"
    });
    assert.equal(graph.generator.executor, "projection");
    assert.equal(graph.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), false);
    assert.equal(graph.nodes.some((node) => node.kind === "Symbol"), true);
  } finally {
    await store.close();
  }
});

test("Postgres repository context runs intake, knowledge, outbox projections, ACLs, and cited retrieval end to end", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
  const suffix = Date.now().toString(36);
  const tenantId = `v51-${suffix}`;
  const repository = `omlabs/v51-${suffix}`;
  const parentSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  const readmeBlob = "a".repeat(40);
  const movedBlob = "b".repeat(40);
  const oldAppBlob = "c".repeat(40);
  const newAppBlob = "d".repeat(40);
  const deletedBlob = "e".repeat(40);
  const addedBlob = "f".repeat(40);
  const parent = {
    tenantId, repository, ref: "main", commitSha: parentSha, treeSha: "3".repeat(40), parents: [],
    authorExternalId: "alice@example.com", authorGitHubLogin: "alice", authorName: "Alice",
    committedAt: "2026-07-18T00:00:00.000Z", message: "initial implementation", isDefaultRef: true,
    updateRef: false, recordedAt: "2026-07-20T00:00:00.000Z", taskId: `ingest-${suffix}`,
    files: [
      { path: "README.md", blobSha: readmeBlob, size: 20 },
      { path: "src/old.ts", blobSha: movedBlob, size: 20 },
      { path: "src/app.ts", blobSha: oldAppBlob, size: 30 },
      { path: "src/deleted.ts", blobSha: deletedBlob, size: 10 }
    ]
  } as const;
  const head = {
    ...parent, commitSha: headSha, treeSha: "4".repeat(40), parents: [parentSha],
    committedAt: "2026-07-19T00:00:00.000Z", message: "fixes #7 and updates app", updateRef: true,
    recordedAt: "2026-07-20T00:01:00.000Z",
    files: [
      { path: "README.md", blobSha: readmeBlob, size: 20 },
      { path: "src/new.ts", blobSha: movedBlob, size: 20 },
      { path: "src/app.ts", blobSha: newAppBlob, size: 40 },
      { path: "src/added.ts", blobSha: addedBlob, size: 10 }
    ]
  } as const;
  try {
    await store.planIngestion(parent);
    await store.applyBlobAnalyses(parent, [
      { blobSha: readmeBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [], edges: [] },
      { blobSha: movedBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] },
      { blobSha: oldAppBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] },
      { blobSha: deletedBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] }
    ]);
    const plan = await store.planIngestion(head);
    assert.deepEqual(plan.changes, [
      { path: "src/added.ts", change: "add", newBlobSha: addedBlob },
      { path: "src/app.ts", change: "modify", oldBlobSha: oldAppBlob, newBlobSha: newAppBlob },
      { path: "src/deleted.ts", change: "delete", oldBlobSha: deletedBlob },
      { path: "src/new.ts", change: "rename", oldPath: "src/old.ts", oldBlobSha: movedBlob, newBlobSha: movedBlob }
    ]);
    await store.applyBlobAnalyses(head, [
      {
        blobSha: newAppBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript",
        symbols: [
          { moniker: "typescript:main#1", name: "main", kind: "function", signatureHash: "1".repeat(64), startLine: 1, endLine: 3 },
          { moniker: "typescript:helper#2", name: "helper", kind: "function", signatureHash: "2".repeat(64), startLine: 5, endLine: 5 }
        ],
        imports: [],
        edges: [{ fromMoniker: "main", kind: "calls", toMoniker: "helper", startLine: 2, endLine: 2 }]
      },
      { blobSha: addedBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] }
    ]);

    const source = await store.applyGitHubObservations([
      {
        tenantId, repository, kind: "pull_request", number: 3, title: "Update app", body: "Fixes #7",
        state: "closed", url: `https://github.com/${repository}/pull/3`, authorLogin: "alice",
        occurredAt: "2026-07-19T00:00:00.000Z", recordedAt: "2026-07-20T00:02:00.000Z",
        commitShas: [headSha], resolvesIssueNumbers: [7], referencesIssueNumbers: []
      },
      {
        tenantId, repository, kind: "issue", number: 7, title: "App is outdated", state: "closed",
        url: `https://github.com/${repository}/issues/7`, authorLogin: "alice",
        occurredAt: "2026-07-19T00:00:00.000Z", recordedAt: "2026-07-20T00:02:00.000Z"
      },
      {
        tenantId, repository, kind: "codeowners", commitSha: headSha, path: ".github/CODEOWNERS",
        entries: [{ pattern: "/src/**", owners: ["@omlabs/owners"] }],
        recordedAt: "2026-07-20T00:02:00.000Z"
      }
    ]);
    assert.equal(source.observationCount, 3);
    assert.equal(source.assertionCount >= 4, true);

    const batch = {
      tenantId, repository, ref: "main", commitSha: headSha, taskId: `assert-${suffix}`,
      generatedAt: "2026-07-20T00:03:00.000Z", generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: ONTOLOGY_REGISTRY_VERSION, model: "fixture", summary: "README documents the repository",
      rawOutput: {
        summary: "README documents the repository",
        nodes: [
          { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
          { id: "readme", kind: "Document" as const, label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
        ],
        edges: [{ source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge" as const, confidence: 0.99, evidence: ["README.md:1"] }]
      },
      assertions: [{
        subject: { kind: "Repository" as const, naturalKey: `github:repo:${repository}`, label: repository }, predicate: "DOCUMENTED_BY",
        object: { kind: "Document" as const, naturalKey: `repo:${repository}:path:README.md`, label: "README" }, confidence: 0.99, evidence: ["README.md:1"]
      }]
    };
    const proposed = await store.saveAssertionBatch(batch);
    assert.equal(proposed.proposedCount, 1);
    const assertionId = stableId("assertion", `${tenantId}:${repository}:${headSha}:Repository:github:repo:${repository}:DOCUMENTED_BY:Document:repo:${repository}:path:README.md:{}`);
    await store.executeCommand(tenantId, "svc:api", {
      type: "grant_repository_access", repository, principalId: "user:curator", role: "writer"
    }, "2026-07-20T00:03:30.000Z");
    await store.executeCommand(tenantId, "user:curator", {
      type: "review_assertion", assertionId, decision: "accept", reason: "verified against README"
    }, "2026-07-20T00:04:00.000Z");
    await store.executeCommand(tenantId, "user:curator", {
      type: "assign_relationship", repository,
      subject: { kind: "File", key: `repo:${repository}:path:src/app.ts`, displayName: "src/app.ts" },
      predicate: "OWNED_BY", object: { kind: "Team", key: "team:platform", displayName: "Platform" },
      qualifiers: { pattern: "src/**" }, reason: "curated ownership"
    }, "2026-07-20T00:05:00.000Z");
    await store.executeCommand(tenantId, "svc:api", {
      type: "grant_repository_access", repository, principalId: "user:reader", role: "reader"
    }, "2026-07-20T00:05:30.000Z");
    assert.deepEqual(await store.repositoriesForPrincipal(tenantId, "user:reader"), [repository]);

    const rebuilt = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:06:00.000Z");
    assert.equal(rebuilt.manifestFileCount, 4);
    assert.equal(rebuilt.searchDocumentCount > 0, true);
    const allowedRepositories = [repository];
    const structure = await store.retrieve({ tenantId, allowedRepositories, repository, ref: "main", template: "structure", symbol: "main" });
    assert.equal(structure.items.some((item) => item.kind === "calls" && item.citations[0]?.path === "src/app.ts"), true);
    const change = await store.retrieve({ tenantId, allowedRepositories, repository, template: "change", pullRequestNumber: 3 });
    assert.equal(change.items.some((item) => item.title === "modify src/app.ts"), true);
    const intent = await store.retrieve({ tenantId, allowedRepositories, repository, template: "intent", path: "src/app.ts", query: "fixes app" });
    assert.equal(intent.items.some((item) => item.citations[0]?.kind === "commit_change"), true);
    assert.equal(intent.items.some((item) => item.kind === "work_intent" && item.title.includes("Issue #7")), true);
    const ownership = await store.retrieve({ tenantId, allowedRepositories, repository, template: "ownership", path: "src/app.ts" });
    assert.equal(ownership.items.some((item) => item.title.includes("Platform")), true);
    assert.equal(ownership.items.some((item) => item.title.includes("@omlabs/owners") && item.data.authority === "codeowners"), true);
    await assert.rejects(
      store.retrieve({ tenantId, allowedRepositories: [], repository, template: "structure" }),
      /access denied/
    );
    const metrics = await store.operationalMetrics(tenantId, "2026-07-20T00:07:00.000Z");
    assert.equal(metrics.unparsedBlobCount, 0);
    assert.equal(metrics.acceptanceRates.some((item) => item.predicate === "DOCUMENTED_BY" && item.accepted === 1), true);

    const graph = await store.project({
      tenantId, repository, ref: "main", commitSha: headSha, taskId: `project-${suffix}`, generatedAt: "2026-07-20T00:08:00.000Z"
    });
    assert.equal(graph.edges.some((edge) => edge.predicate === "CALLS"), true);
    assert.equal(graph.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), true);
    const sourceOwnership = graph.edges.find((edge) => edge.predicate === "OWNED_BY");
    assert.equal(sourceOwnership?.evidence[0]?.startsWith("observation:"), true);
    assert.equal([...graph.nodes, ...graph.edges].every((item) => item.evidence.length > 0), true);

    const otherRepository = `${repository}-other`;
    await store.planIngestion({
      tenantId, repository: otherRepository, ref: "main", commitSha: "9".repeat(40), treeSha: "8".repeat(40),
      parents: [], committedAt: "2026-07-20T00:08:30.000Z", isDefaultRef: true, updateRef: true,
      recordedAt: "2026-07-20T00:08:30.000Z", taskId: `other-${suffix}`,
      files: [{ path: "README.md", blobSha: readmeBlob, size: 20 }]
    });
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:08:40.000Z");
    const beforeDrain = await store.operationalMetrics(tenantId, "2026-07-20T00:08:45.000Z");
    assert.equal(Object.values(beforeDrain.outboxDepth).reduce((sum, count) => sum + count, 0) > 0, true);
    const drained = await store.drainDerivedProjectionEvents(tenantId, "2026-07-20T00:08:50.000Z");
    assert.equal(drained.processedEventCount > 0, true);
    assert.equal(drained.rebuiltRepositories.includes(otherRepository), true);
    await store.applyGitHubObservations([{
      tenantId, repository, kind: "codeowners", commitSha: headSha, path: ".github/CODEOWNERS",
      entries: [{ pattern: "/src/**", owners: ["@omlabs/owners"] }],
      recordedAt: "2026-07-20T00:02:00.000Z"
    }]);
    const afterSourceReplay = await store.operationalMetrics(tenantId, "2026-07-20T00:08:52.000Z");
    assert.equal(Object.values(afterSourceReplay.outboxDepth).reduce((sum, count) => sum + count, 0), 0);
    const noOpProjection = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:08:55.000Z");
    assert.equal(noOpProjection.rebuilt, false);
    assert.equal(noOpProjection.processedEventCount, 0);
    const otherStructure = await store.retrieve({
      tenantId, allowedRepositories: [otherRepository], repository: otherRepository, ref: "main", template: "structure"
    });
    assert.equal(otherStructure.repository, otherRepository);

    const githubObservationId = stableId(
      "observation",
      `${tenantId}:github:${repository}:pull_request:3:2026-07-19T00:00:00.000Z`
    );
    const redaction = await store.executeCommand(tenantId, "user:privacy", {
      type: "redact_observation", observationId: githubObservationId, reason: "fixture redaction", commitShas: [headSha]
    }, "2026-07-20T00:09:00.000Z", true);
    assert.equal(redaction.affectedIds.includes(githubObservationId), true);
    const engineerId = stableId("entity", `${tenantId}:Engineer:github:user:alice`);
    const erased = await store.executeCommand(tenantId, "user:privacy", {
      type: "erase_person", entityId: engineerId, reason: "fixture erasure"
    }, "2026-07-20T00:10:00.000Z", true);
    assert.equal(erased.affectedIds.includes(engineerId), true);
  } finally {
    await store.close();
  }
});
