import assert from "node:assert/strict";
import test from "node:test";
import { blockedContextTaskIds, productionAcceptanceExitCode, runProductionContextAcceptance } from "./acceptance.js";

test("production acceptance has stable coarse failure categories", () => {
  assert.equal(productionAcceptanceExitCode(new Error("worker health verification failed")), 19);
  assert.equal(productionAcceptanceExitCode(new Error("production context stage index-context failed")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("no published generation")), 21);
  assert.equal(productionAcceptanceExitCode(new Error("knowledge document catalog is empty")), 22);
  assert.equal(productionAcceptanceExitCode(new Error("query returned no citations")), 23);
  assert.equal(productionAcceptanceExitCode(new Error("context backlog is not empty")), 24);
  assert.equal(productionAcceptanceExitCode(new Error("invalid JSON")), 25);
});

test("blocked stage detection is scoped to repository and ref", () => {
  assert.deepEqual(
    blockedContextTaskIds(
      [
        {
          id: "same",
          type: "index-context",
          status: "queued",
          metadata: { repository: "omlabs/repo", ref: "main" }
        },
        {
          id: "complete",
          type: "derive-knowledge",
          status: "done",
          metadata: { repository: "omlabs/repo", ref: "main" }
        },
        {
          id: "other",
          type: "ingest-evidence",
          status: "in_progress",
          metadata: { repository: "omlabs/repo", ref: "dev" }
        }
      ],
      "omlabs/repo",
      "main"
    ),
    ["same"]
  );
});

test("production acceptance creates, observes, queries, verifies MCP, and rejects the legacy route", async () => {
  let boardReads = 0;
  const requested: string[] = [];
  const requestedAuthorization: string[] = [];
  let buildRequest: Record<string, unknown> | undefined;
  let accessSyncRequest: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
    requestedAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.hostname === "context-worker.example.test" && url.pathname === "/health") {
      return json({
        ok: true,
        workerId: "context-worker",
        topics: ["run-ingest-evidence", "run-derive-knowledge", "run-index-context"],
        active: false,
        lastApiSuccessAt: new Date().toISOString(),
        consecutiveApiFailures: 0,
        metrics: {}
      });
    }
    if (url.hostname === "task-worker.example.test" && url.pathname === "/health") {
      return json({
        ok: true,
        workerId: "task-worker",
        topics: ["run-review", "run-research", "run-publish", "run-cleanup"],
        active: false,
        lastApiSuccessAt: new Date().toISOString(),
        consecutiveApiFailures: 0,
        metrics: {}
      });
    }
    if (url.pathname === "/internal/context/access/sync") {
      accessSyncRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ repositoryCount: 1 });
    }
    if (url.pathname === "/context/build") {
      buildRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ build: { id: "cb_acceptance" } }, 202);
    }
    if (url.pathname === "/board") {
      boardReads += 1;
      const done = boardReads > 1;
      return json({
        tasks: [
          { id: "cb_acceptance", type: "build-context", status: done ? "done" : "in_progress" },
          ...["ingest-evidence", "derive-knowledge", "index-context"].map((type, index) => ({
            id: `cs_${index}`,
            parentTaskId: "cb_acceptance",
            type,
            status: done ? "done" : index === 0 ? "in_progress" : "triage",
            metadata: { repository: "omlabs/repo", ref: "main" }
          }))
        ]
      });
    }
    if (url.pathname === "/context/generations") {
      return json({
        generations: [
          {
            id: "ig_current",
            ref: "main",
            status: "published",
            commitSha: "a".repeat(40),
            derivedKnowledge: "available"
          }
        ]
      });
    }
    if (url.pathname === "/context/documents") {
      return json({ documents: [{ id: "kr_architecture" }] });
    }
    if (url.pathname === "/context/query") {
      return json({
        answer: "Cited answer",
        generation: { id: "ig_current", commitSha: "a".repeat(40) },
        citations: [
          {
            anchors: [
              {
                repository: "omlabs/repo",
                commitSha: "a".repeat(40),
                sourceType: "blob",
                contentDigest: "b".repeat(64)
              }
            ]
          }
        ]
      });
    }
    if (url.pathname === "/context/metrics") return json({ outboxDepthByConsumer: { lexical: 0 } });
    if (url.pathname === "/context-graph") return json({ error: "not found" }, 404);
    return json({ error: "unexpected request" }, 500);
  };

  const summary = await runProductionContextAcceptance({
    apiUrl: "https://api.example.test",
    internalToken: "internal",
    contextToken: "context",
    principalId: "user:reader@example.com",
    adminPrincipalId: "user:admin@example.com",
    repository: "omlabs/repo",
    ref: "main",
    githubInstallationId: 140435029,
    pollIntervalMs: 0,
    workerHealthChecks: [
      {
        url: "https://context-worker.example.test",
        authorization: "Bearer context-worker-identity",
        expectedTopics: ["run-ingest-evidence", "run-derive-knowledge", "run-index-context"]
      },
      {
        url: "https://task-worker.example.test",
        authorization: "Bearer task-worker-identity",
        expectedTopics: ["run-review", "run-research", "run-publish", "run-cleanup"]
      }
    ],
    fetchImpl,
    verifyMcp: async ({ commitSha }) => {
      assert.equal(commitSha, "a".repeat(40));
      return 2;
    },
    log: () => undefined
  });

  assert.equal(summary.buildId, "cb_acceptance");
  assert.equal(summary.generationId, "ig_current");
  assert.equal(summary.documentCount, 1);
  assert.equal(summary.citationCount, 1);
  assert.equal(summary.mcpCitationCount, 2);
  assert.equal(buildRequest?.githubInstallationId, 140435029);
  assert.deepEqual(accessSyncRequest, { repositories: ["omlabs/repo"], mode: "merge" });
  assert.deepEqual(requested, [
    "GET /health",
    "GET /health",
    "POST /internal/context/access/sync",
    "POST /context/build",
    "GET /board",
    "GET /board",
    "GET /context/generations",
    "GET /context/documents",
    "POST /context/query",
    "GET /context/metrics",
    "GET /context-graph"
  ]);
  assert.deepEqual(requestedAuthorization, [
    "Bearer context-worker-identity",
    "Bearer task-worker-identity",
    "Bearer internal",
    "Bearer internal",
    "Bearer internal",
    "Bearer internal",
    "Bearer internal",
    "Bearer internal",
    "Bearer context",
    "Bearer internal",
    "Bearer internal"
  ]);
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
