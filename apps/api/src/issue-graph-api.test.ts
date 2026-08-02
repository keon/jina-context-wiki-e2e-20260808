import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileContextArtifactStore,
  MemoryContextEngineStore,
  materializeIssueGraph,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type ContextArtifactWrite
} from "@jina/context-engine";
import { createApiServer } from "./server.js";

const TENANT = "tenant-issue-graph";
const PRINCIPAL = "user:reader@example.com";
const REPOSITORY = "acme/widget";
const BUILD_ID = "task_issue_graph_build";
const INTRODUCED_SHA = "1".repeat(40);
const RESOLVED_SHA = "2".repeat(40);

class CountingArtifactStore implements ContextArtifactStore {
  reads = 0;

  constructor(readonly delegate: ContextArtifactStore) {}

  put(input: ContextArtifactWrite): Promise<ContextArtifactRef> {
    return this.delegate.put(input);
  }

  get(ref: ContextArtifactRef): Promise<Uint8Array> {
    this.reads += 1;
    return this.delegate.get(ref);
  }
}

test("issue graph API authorizes through the current pointer and serves cached artifact reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-issue-graph-api-"));
  const artifacts = new CountingArtifactStore(new FileContextArtifactStore(root));
  const store = new MemoryContextEngineStore();
  await store.replaceRepositoryAccess(TENANT, PRINCIPAL, [REPOSITORY]);
  const graph = materializeIssueGraph({
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: "main",
    refSequence: 1,
    commitSha: RESOLVED_SHA,
    generatedAt: "2026-08-01T12:00:00.000Z",
    historyComplete: true,
    history: [
      {
        sha: RESOLVED_SHA,
        parentShas: [INTRODUCED_SHA],
        message: "fix(pool): isolate graph publication\n\nStops graph writes from slowing context reads.",
        committedAt: "2026-08-01T12:00:00.000Z"
      },
      {
        sha: INTRODUCED_SHA,
        parentShas: [],
        message: "feat(graph): persist every relationship\n\nThe graph projector writes one row per edge.",
        committedAt: "2026-07-01T12:00:00.000Z"
      }
    ],
    candidate: {
      version: 1,
      summary: "Commit history shows graph write fan-out and its later isolation.",
      issues: [
        {
          key: "write-fanout",
          title: "Graph write fan-out slowed reads",
          summary: "Per-edge persistence caused write amplification and database contention.",
          evidence: [
            { commitSha: INTRODUCED_SHA, role: "introduced", messageStartLine: 1, messageEndLine: 3 },
            { commitSha: RESOLVED_SHA, role: "resolved", messageStartLine: 1, messageEndLine: 3 }
          ]
        },
        {
          key: "shared-pool",
          title: "Graph traffic shared the query pool",
          summary: "Graph publication and context queries competed for shared database capacity.",
          evidence: [{ commitSha: RESOLVED_SHA, role: "observed", messageStartLine: 1, messageEndLine: 3 }]
        }
      ],
      causalities: [
        {
          subjectKey: "shared-pool",
          predicate: "CAUSED_BY",
          objectKind: "issue",
          objectRef: "write-fanout",
          why: "The per-edge projector consumed the database capacity needed by reads.",
          confidence: "explicit",
          evidence: [{ commitSha: RESOLVED_SHA, role: "observed", messageStartLine: 1, messageEndLine: 3 }]
        }
      ]
    },
    generator: { name: "codex", version: "1", model: "test-model", promptVersion: "issue-graph-v1" }
  });
  const artifact = await artifacts.put({
    tenantId: TENANT,
    repository: REPOSITORY,
    buildId: BUILD_ID,
    kind: "issue-graph",
    name: `${graph.id}.json`,
    contentType: "application/json",
    content: JSON.stringify(graph)
  });
  await store.publishIssueGraphRelease({
    id: graph.id,
    tenantId: TENANT,
    repository: REPOSITORY,
    ref: graph.ref,
    refSequence: graph.refSequence,
    commitSha: graph.commitSha,
    buildId: BUILD_ID,
    contentDigest: graph.contentDigest,
    artifact,
    issueCount: graph.issues.length,
    causalityCount: graph.causalities.length,
    historyComplete: graph.coverage.complete,
    publishedAt: graph.generatedAt
  });

  const server = createApiServer({
    tenantId: TENANT,
    enableDevEndpoints: true,
    contextStore: store,
    contextArtifactStore: artifacts
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { "x-jina-tenant-id": TENANT, "x-jina-principal-id": PRINCIPAL };
  try {
    const searched = await fetch(`${baseUrl}/context/issues?repository=${REPOSITORY}&q=fan-out&limit=10`, { headers });
    assert.equal(searched.status, 200, await searched.clone().text());
    const searchBody = record(await searched.json());
    assert.equal(array(searchBody.issues).length, 1);
    const rootIssueId = String(record(array(searchBody.issues)[0]).id);

    const detail = await fetch(
      `${baseUrl}/context/issues/${encodeURIComponent(rootIssueId)}?repository=${REPOSITORY}`,
      { headers }
    );
    assert.equal(detail.status, 200, await detail.clone().text());

    const trace = await fetch(
      `${baseUrl}/context/issues/${encodeURIComponent(rootIssueId)}/trace?repository=${REPOSITORY}&depth=2`,
      { headers }
    );
    assert.equal(trace.status, 200, await trace.clone().text());
    assert.equal(array(record(await trace.json()).causalities).length, 1);

    const full = await fetch(`${baseUrl}/context/issue-graph?repository=${REPOSITORY}`, { headers });
    assert.equal(full.status, 200, await full.clone().text());
    assert.equal(array(record(await full.json()).issues).length, 2);
    assert.equal(artifacts.reads, 1, "immutable graph bytes should be loaded once per API process");

    const forbidden = await fetch(`${baseUrl}/context/issues?repository=${REPOSITORY}`, {
      headers: { ...headers, "x-jina-principal-id": "user:stranger@example.com" }
    });
    assert.equal(forbidden.status, 404);

    const adminHeaders = {
      "x-jina-tenant-id": TENANT,
      "x-jina-principal-id": "svc:dev",
      "content-type": "application/json"
    };
    const buildBody = JSON.stringify({
      repository: REPOSITORY,
      ref: "main",
      commitSha: RESOLVED_SHA,
      requestKey: "manual-issue-graph-test"
    });
    const admitted = await fetch(`${baseUrl}/context/issues/build`, {
      method: "POST",
      headers: adminHeaders,
      body: buildBody
    });
    assert.equal(admitted.status, 202, await admitted.clone().text());
    const replay = await fetch(`${baseUrl}/context/issues/build`, {
      method: "POST",
      headers: adminHeaders,
      body: buildBody
    });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(record(await replay.json()).duplicate, true);
    const board = await fetch(`${baseUrl}/board`, { headers: adminHeaders });
    const tasks = array(record(await board.json()).tasks).map((task) => String(record(task).type));
    const issueTaskTypes = new Set([
      "build-context-issues",
      "snapshot-context-issue-history",
      "derive-context-issues",
      "publish-context-issues"
    ]);
    assert.deepEqual(
      tasks.filter((type) => issueTaskTypes.has(type)),
      [...issueTaskTypes]
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
