import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  blockedContextTaskIds,
  cloudRunCandidateIdentityTarget,
  iapServiceAccountJwt,
  productionAcceptanceExitCode,
  requestProductionRemediation,
  runProductionContextAcceptance,
  verifyProductionContextIsolation,
  verifyProductionMcp,
  verifyProductionRetrievalQuality,
  verifyProductionWebSurfaces
} from "./acceptance.js";

test("Cloud Run candidate requests keep tagged URLs distinct from stable token audiences", () => {
  assert.deepEqual(
    cloudRunCandidateIdentityTarget(
      "https://candidate---jina-context-worker-abc-uc.a.run.app/",
      "https://jina-context-worker-abc-uc.a.run.app/"
    ),
    {
      url: "https://candidate---jina-context-worker-abc-uc.a.run.app",
      audience: "https://jina-context-worker-abc-uc.a.run.app"
    }
  );
  assert.throws(
    () =>
      cloudRunCandidateIdentityTarget(
        "https://jina-context-worker-abc-uc.a.run.app",
        "https://jina-context-worker-abc-uc.a.run.app"
      ),
    /release-tagged and distinct/
  );
  assert.throws(
    () =>
      cloudRunCandidateIdentityTarget(
        "https://candidate---jina-context-worker-abc-uc.a.run.app/health",
        "https://jina-context-worker-abc-uc.a.run.app"
      ),
    /must not contain a path/
  );
});

test("IAP service-account JWTs use a bounded candidate URL wildcard", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/email")) return new Response("jina-acceptance@example.iam.gserviceaccount.com");
    if (url.endsWith("/token")) return json({ access_token: "metadata-access-token" });
    return json({ signedJwt: "header.payload.signature" });
  };

  assert.equal(
    await iapServiceAccountJwt("https://candidate---dashboard.example.run.app/*", fetchImpl, 1_700_000_000),
    "header.payload.signature"
  );
  assert.equal(requests.length, 3);
  assert.match(requests[2]!.url, /jina-acceptance%40example\.iam\.gserviceaccount\.com:signJwt$/);
  const headers = new Headers(requests[2]!.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer metadata-access-token");
  assert.deepEqual(JSON.parse(String(requests[2]!.init?.body)), {
    payload: JSON.stringify({
      iss: "jina-acceptance@example.iam.gserviceaccount.com",
      sub: "jina-acceptance@example.iam.gserviceaccount.com",
      aud: "https://candidate---dashboard.example.run.app/*",
      iat: 1_700_000_000,
      exp: 1_700_003_600
    })
  });
  await assert.rejects(
    iapServiceAccountJwt("https://candidate---dashboard.example.run.app", fetchImpl),
    /ending in \/\*/
  );
});

test("production acceptance has stable coarse failure categories", () => {
  assert.equal(productionAcceptanceExitCode(new Error("worker health verification failed")), 19);
  assert.equal(productionAcceptanceExitCode(new Error("production context task index-context-release failed")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("no published release")), 21);
  assert.equal(productionAcceptanceExitCode(new Error("context document catalog is empty")), 22);
  assert.equal(productionAcceptanceExitCode(new Error("query returned no citations")), 23);
  assert.equal(productionAcceptanceExitCode(new Error("production retrieval quality missed its target")), 23);
  assert.equal(productionAcceptanceExitCode(new Error("context backlog is not empty")), 24);
  assert.equal(productionAcceptanceExitCode(new Error("invalid JSON")), 25);
});

test("production acceptance cancels its exact build when the polling deadline expires", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/internal/context/access/sync") return json({ accepted: true });
    if (url.pathname === "/context/build") return json({ build: { id: "cb_timeout" } }, 202);
    if (url.pathname === "/internal/context/builds/cb_timeout/cancel") {
      assert.deepEqual(JSON.parse(String(init?.body)), { reason: "production acceptance timeout" });
      return json({
        accepted: true,
        buildId: "cb_timeout",
        status: "canceled",
        canceled: true,
        changed: true
      });
    }
    return json({ error: "unexpected request" }, 500);
  };

  await assert.rejects(
    runProductionContextAcceptance({
      apiUrl: "https://api.example.test",
      internalToken: "internal",
      principalId: "user:reader@example.com",
      adminPrincipalId: "user:admin@example.com",
      repository: "omlabs/repo",
      timeoutMs: 0,
      pollIntervalMs: 0,
      fetchImpl,
      log: () => undefined
    }),
    /cb_timeout timed out and was canceled/
  );
  assert.deepEqual(requests, [
    "POST /internal/context/access/sync",
    "POST /context/build",
    "POST /internal/context/builds/cb_timeout/cancel"
  ]);
});

test("blocked task detection is dynamic and scoped to repository and ref", () => {
  assert.deepEqual(
    blockedContextTaskIds(
      [
        {
          id: "same",
          type: "index-context-release",
          status: "queued",
          metadata: { repository: "omlabs/repo", ref: "main" }
        },
        {
          id: "complete",
          type: "write-context-page",
          status: "done",
          metadata: { repository: "omlabs/repo", ref: "main" }
        },
        {
          id: "other",
          type: "research-context-subject",
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

test("production acceptance resumes one explicitly eligible checkpoint branch", async () => {
  const requests: { readonly path: string; readonly body?: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
    });
    if (url.pathname.endsWith("/progress")) {
      return json({
        retryEligibility: {
          eligible: true,
          mode: "page_remediation",
          recoverableTaskIds: ["task_page_failed"]
        }
      });
    }
    return json({ accepted: true }, 202);
  };

  assert.equal(
    await requestProductionRemediation({
      fetchImpl,
      apiUrl: "https://api.example.test",
      internalHeaders: { authorization: "Bearer internal" },
      buildId: "task_build",
      attempt: 2
    }),
    "page_remediation"
  );
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/context/builds/task_build/progress", "/context/builds/task_build/retry"]
  );
  assert.deepEqual(requests[1]?.body?.taskIds, ["task_page_failed"]);
  assert.equal(requests[1]?.body?.requestKey, "production-acceptance:task_build:page-remediation:2:task_page_failed");

  const ineligibleFetch: typeof fetch = async () =>
    json({ retryEligibility: { eligible: false, mode: "ordinary", recoverableTaskIds: [] } });
  assert.equal(
    await requestProductionRemediation({
      fetchImpl: ineligibleFetch,
      apiUrl: "https://api.example.test",
      internalHeaders: { authorization: "Bearer internal" },
      buildId: "task_build",
      attempt: 1
    }),
    undefined
  );

  const gateRequests: { readonly path: string; readonly body?: Record<string, unknown> }[] = [];
  const gateFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    gateRequests.push({
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
    });
    if (url.pathname.endsWith("/progress")) {
      return json({
        retryEligibility: {
          eligible: true,
          mode: "gate_remediation",
          recoverableTaskIds: ["task_certification"]
        }
      });
    }
    return json({ accepted: true }, 202);
  };
  assert.equal(
    await requestProductionRemediation({
      fetchImpl: gateFetch,
      apiUrl: "https://api.example.test",
      internalHeaders: { authorization: "Bearer internal" },
      buildId: "task_build",
      attempt: 3
    }),
    "gate_remediation"
  );
  assert.equal(
    gateRequests[1]?.body?.requestKey,
    "production-acceptance:task_build:gate-remediation:3:task_certification"
  );

  const checkpointRequests: { readonly path: string; readonly body?: Record<string, unknown> }[] = [];
  const checkpointFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    checkpointRequests.push({
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
    });
    return url.pathname.endsWith("/progress")
      ? json({
          retryEligibility: {
            eligible: true,
            recoverableTaskIds: ["task_publication_plan"],
            blockers: []
          }
        })
      : json({ accepted: true }, 202);
  };
  assert.equal(
    await requestProductionRemediation({
      fetchImpl: checkpointFetch,
      apiUrl: "https://api.example.test",
      internalHeaders: { authorization: "Bearer internal" },
      buildId: "task_build",
      attempt: 1
    }),
    "checkpoint_retry"
  );
  assert.equal(
    checkpointRequests[1]?.body?.requestKey,
    "production-acceptance:task_build:checkpoint-retry:1:task_publication_plan"
  );
});

test("production acceptance creates, observes, queries, and verifies MCP", async () => {
  let boardReads = 0;
  let tokenRevoked = false;
  let staleTokenRevoked = false;
  const requested: string[] = [];
  const requestedAuthorization: string[] = [];
  let buildRequest: Record<string, unknown> | undefined;
  let accessSyncRequest: Record<string, unknown> | undefined;
  let tokenMintRequest: Record<string, unknown> | undefined;
  let principalSpoofRejected = false;
  const candidateReleaseId = "release-candidate";
  const contextWorkerRevision = "jina-context-worker-release-candidate";
  const taskWorkerRevision = "jina-task-worker-release-candidate";
  const issuedSecret = `jina_atk_${"q".repeat(43)}`;
  const issuedCreatedAt = new Date().toISOString();
  const issuedToken = {
    id: "atk_acceptance",
    principalId: "user:reader@example.com",
    name: "production-acceptance-cb_acceptance",
    scopes: ["context:read", "context:query"],
    createdAt: issuedCreatedAt,
    expiresAt: new Date(Date.parse(issuedCreatedAt) + 5 * 60_000).toISOString()
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
    requestedAuthorization.push(authorization);
    if (url.hostname === "context-worker.example.test" && url.pathname === "/health") {
      return json({
        ok: true,
        workerId: "context-worker",
        claimMode: "enabled",
        workerReleaseId: candidateReleaseId,
        workerService: "jina-context-worker",
        workerRevision: contextWorkerRevision,
        topics: [
          "run-context-input-snapshot",
          "run-context-research-plan",
          "run-context-research",
          "run-context-publication-plan",
          "run-context-page-write",
          "run-context-page-audit",
          "run-context-page-repair",
          "run-context-source-challenge",
          "run-context-task-evaluation",
          "run-context-gap-repair",
          "run-context-certification",
          "run-context-publication",
          "run-context-pageindex"
        ],
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
        claimMode: "enabled",
        workerReleaseId: candidateReleaseId,
        workerService: "jina-task-worker",
        workerRevision: taskWorkerRevision,
        topics: ["run-review"],
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
    if (url.pathname === "/internal/context/tokens") {
      if (authorization === `Bearer ${issuedSecret}`) {
        return json({ error: "internal credential required" }, 401);
      }
      assert.equal(authorization, "Bearer internal");
      if (method === "GET") {
        return json({
          tokens: staleTokenRevoked ? [] : [{ ...issuedToken, id: "atk_stale_acceptance" }]
        });
      }
      assert.ok(boardReads > 1, "token must be minted only after the build completes");
      tokenMintRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ secret: issuedSecret, token: issuedToken }, 201);
    }
    if (
      url.pathname === `/internal/context/tokens/${issuedToken.id}/revoke` ||
      url.pathname === "/internal/context/tokens/atk_stale_acceptance/revoke"
    ) {
      assert.equal(authorization, "Bearer internal");
      const tokenId = url.pathname.split("/").at(-2);
      if (tokenId === issuedToken.id) tokenRevoked = true;
      if (tokenId === "atk_stale_acceptance") staleTokenRevoked = true;
      return json({ token: { ...issuedToken, id: tokenId, revokedAt: new Date().toISOString() } });
    }
    if (url.pathname === "/context/build") {
      if (authorization === `Bearer ${issuedSecret}`) {
        return json({ error: "token scope does not permit this route", code: "insufficient_scope" }, 403);
      }
      buildRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ build: { id: "cb_acceptance" } }, 202);
    }
    if (url.pathname === "/board") {
      if (authorization === `Bearer ${issuedSecret}`) {
        return json({ error: "token scope does not permit this route", code: "insufficient_scope" }, 403);
      }
      boardReads += 1;
      const done = boardReads > 1;
      return json({
        tasks: [
          { id: "cb_acceptance", type: "build-context", status: done ? "done" : "in_progress" },
          {
            id: "snapshot",
            parentTaskId: "cb_acceptance",
            type: "snapshot-context-input",
            status: done ? "done" : "in_progress",
            attempt: 1,
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "graph",
            parentTaskId: "cb_acceptance",
            type: "context-build-graph",
            status: done ? "done" : "blocked",
            attempt: 0,
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "page",
            parentTaskId: "cb_acceptance",
            type: "context-page",
            status: done ? "done" : "blocked",
            attempt: 0,
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "old-audit",
            parentTaskId: "page",
            type: "audit-context-page",
            status: "superseded",
            attempt: 1,
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "page-write",
            parentTaskId: "page",
            type: "write-context-page",
            status: done ? "done" : "triage",
            attempt: 1,
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "publication",
            parentTaskId: "cb_acceptance",
            type: "publish-context-release",
            status: done ? "done" : "triage",
            attempt: 1,
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "pageindex",
            parentTaskId: "cb_acceptance",
            type: "index-context-release",
            status: done ? "done" : "triage",
            attempt: 1,
            metadata: { repository: "omlabs/repo", ref: "main" }
          }
        ]
      });
    }
    if (url.pathname === "/internal/context/builds/cb_acceptance/worker-completions") {
      assert.equal(authorization, "Bearer internal");
      return json({
        buildId: "cb_acceptance",
        repository: "omlabs/repo",
        completions: ["snapshot", "page-write", "publication", "pageindex"].map((taskId) => ({
          taskId,
          taskType:
            taskId === "snapshot"
              ? "snapshot-context-input"
              : taskId === "page-write"
                ? "write-context-page"
                : taskId === "publication"
                  ? "publish-context-release"
                  : "index-context-release",
          attempt: 1,
          outcome: "done",
          workerReleaseId: candidateReleaseId,
          workerService: "jina-context-worker",
          workerRevision: contextWorkerRevision
        }))
      });
    }
    if (url.pathname === "/context/releases") {
      if (
        authorization === `Bearer ${issuedSecret}` &&
        headers.get("x-jina-principal-id") !== issuedToken.principalId
      ) {
        principalSpoofRejected = true;
        return json({ error: "unauthorized" }, 401);
      }
      if (authorization === `Bearer ${issuedSecret}` && headers.get("x-jina-tenant-id")) {
        return json({ error: "unauthorized" }, 401);
      }
      if (authorization === `Bearer ${issuedSecret}` && tokenRevoked) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({
        releases: [
          {
            id: "ig_current",
            repository: "omlabs/repo",
            ref: "main",
            commitSha: "a".repeat(40),
            contextStatus: "available"
          }
        ]
      });
    }
    if (url.pathname === "/context/list") {
      const requestedRepository = url.searchParams.get("repository");
      if (requestedRepository !== "omlabs/repo") {
        return json({ accepted: false, code: "not_found", error: "repository context not found" }, 404);
      }
      if (url.searchParams.get("releaseId")?.startsWith("ig_acceptance_missing_")) {
        return json({ accepted: false, code: "not_found", error: "context not found" }, 404);
      }
      return json({
        release: {
          id: "ig_current",
          repository: "omlabs/repo",
          ref: "main",
          commitSha: "a".repeat(40)
        },
        documents: [
          {
            id: "kr_architecture",
            logicalId: "repository:omlabs/repo:architecture",
            title: "Repository architecture",
            summary: "How the repository is structured.",
            citations: [
              {
                claim: "Architecture",
                anchor: {
                  repository: "omlabs/repo",
                  commitSha: "a".repeat(40),
                  sourceType: "blob",
                  contentDigest: "b".repeat(64)
                }
              }
            ]
          }
        ],
        tree: [
          {
            id: "node-architecture",
            documentId: "kr_architecture",
            children: []
          }
        ]
      });
    }
    if (url.pathname === "/context/read") {
      return json({
        release: {
          id: "ig_current",
          repository: "omlabs/repo",
          ref: "main",
          commitSha: "a".repeat(40)
        },
        document: {
          id: "kr_architecture",
          bodyMarkdown: "# Architecture\n\nGrounded context.",
          citations: [
            {
              claim: "Architecture",
              anchor: {
                repository: "omlabs/repo",
                commitSha: "a".repeat(40),
                sourceType: "blob",
                contentDigest: "b".repeat(64)
              }
            }
          ]
        }
      });
    }
    if (url.pathname === "/context/diff") {
      const release = {
        id: "ig_current",
        repository: "omlabs/repo",
        ref: "main",
        commitSha: "a".repeat(40)
      };
      return json({
        from: release,
        to: release,
        added: [],
        removed: [],
        changed: [],
        unchanged: ["architecture"]
      });
    }
    if (url.pathname === "/context/search") {
      return json({
        release: {
          id: "ig_current",
          repository: "omlabs/repo",
          ref: "main",
          commitSha: "a".repeat(40)
        },
        results: [
          {
            documentId: "kr_architecture",
            citations: [
              {
                claim: "Architecture",
                anchor: {
                  repository: "omlabs/repo",
                  commitSha: "a".repeat(40),
                  sourceType: "blob",
                  contentDigest: "b".repeat(64)
                }
              }
            ]
          }
        ],
        retrieval: { method: "lexical_tree", selector: "pageindex-lexical-tree-v1" }
      });
    }
    if (url.pathname === "/context/metrics") {
      return authorization === `Bearer ${issuedSecret}`
        ? json({ error: "token scope does not permit this route", code: "insufficient_scope" }, 403)
        : json({ outboxDepthByConsumer: { lexical: 0 } });
    }
    if (url.pathname === "/mcp" && tokenRevoked && authorization === `Bearer ${issuedSecret}`) {
      return json({ error: "unauthorized" }, 401);
    }
    return json({ error: "unexpected request" }, 500);
  };

  const summary = await runProductionContextAcceptance({
    apiUrl: "https://api.example.test",
    internalToken: "internal",
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
        expectedTopics: [
          "run-context-input-snapshot",
          "run-context-research-plan",
          "run-context-research",
          "run-context-publication-plan",
          "run-context-page-write",
          "run-context-page-audit",
          "run-context-page-repair",
          "run-context-source-challenge",
          "run-context-task-evaluation",
          "run-context-gap-repair",
          "run-context-certification",
          "run-context-publication",
          "run-context-pageindex"
        ],
        expectedReleaseId: candidateReleaseId,
        expectedRevision: contextWorkerRevision
      },
      {
        url: "https://task-worker.example.test",
        authorization: "Bearer task-worker-identity",
        expectedTopics: ["run-review"],
        expectedReleaseId: candidateReleaseId,
        expectedRevision: taskWorkerRevision
      }
    ],
    expectedWorkerReleaseId: candidateReleaseId,
    expectedContextWorkerRevision: contextWorkerRevision,
    fetchImpl,
    verifyMcp: async ({ headers, commitSha, releaseId, documentId, fromReleaseId, fromCommitSha }) => {
      assert.equal(headers.authorization, `Bearer ${issuedSecret}`);
      assert.equal(headers["x-jina-principal-id"], "user:reader@example.com");
      assert.equal(commitSha, "a".repeat(40));
      assert.equal(releaseId, "ig_current");
      assert.equal(documentId, "kr_architecture");
      assert.equal(fromReleaseId, "ig_current");
      assert.equal(fromCommitSha, "a".repeat(40));
      return 2;
    },
    log: () => undefined
  });

  assert.equal(summary.buildId, "cb_acceptance");
  assert.equal(summary.releaseId, "ig_current");
  assert.equal(summary.documentCount, 1);
  assert.equal(summary.citationCount, 1);
  assert.equal(summary.mcpCitationCount, 2);
  assert.equal(summary.webSurfaceCount, 0);
  assert.equal(buildRequest?.githubInstallationId, 140435029);
  assert.deepEqual(accessSyncRequest, { repositories: ["omlabs/repo"], mode: "merge" });
  assert.deepEqual(tokenMintRequest, {
    principalId: "user:reader@example.com",
    name: "production-acceptance-cb_acceptance",
    scopes: ["context:read", "context:query"],
    expiresInMinutes: 5
  });
  assert.equal(tokenRevoked, true);
  assert.equal(staleTokenRevoked, true);
  assert.equal(principalSpoofRejected, true);
  assert.deepEqual(requested, [
    "GET /health",
    "GET /health",
    "POST /internal/context/access/sync",
    "POST /context/build",
    "GET /board",
    "GET /board",
    "GET /internal/context/builds/cb_acceptance/worker-completions",
    "POST /internal/context/tokens",
    "POST /context/build",
    "GET /context/metrics",
    "GET /board",
    "GET /context/releases",
    "GET /context/releases",
    "POST /internal/context/tokens",
    "GET /context/releases",
    "GET /context/list",
    "GET /context/list",
    "GET /context/list",
    "GET /context/read",
    "GET /context/diff",
    "POST /context/search",
    "POST /internal/context/tokens/atk_acceptance/revoke",
    "GET /internal/context/tokens",
    "POST /internal/context/tokens/atk_stale_acceptance/revoke",
    "GET /internal/context/tokens",
    "GET /context/releases",
    "POST /mcp",
    "GET /context/metrics"
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
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    "Bearer internal",
    "Bearer internal",
    "Bearer internal",
    "Bearer internal",
    `Bearer ${issuedSecret}`,
    `Bearer ${issuedSecret}`,
    "Bearer internal"
  ]);
});

test("production acceptance revokes and verifies the issued token when a query assertion fails", async () => {
  const issuedSecret = `jina_atk_${"f".repeat(43)}`;
  const tokenId = "atk_failure_cleanup";
  const issuedCreatedAt = new Date().toISOString();
  let buildCompleted = false;
  let revoked = false;
  let revokedHttpRejected = false;
  let revokedMcpRejected = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (url.pathname === "/internal/context/access/sync") return json({ repositoryCount: 1 });
    if (url.pathname === "/context/build") {
      return authorization === `Bearer ${issuedSecret}`
        ? json({ error: "token scope does not permit this route", code: "insufficient_scope" }, 403)
        : json({ build: { id: "cb_failure_cleanup" } }, 202);
    }
    if (url.pathname === "/board") {
      if (authorization === `Bearer ${issuedSecret}`) {
        return json({ error: "token scope does not permit this route", code: "insufficient_scope" }, 403);
      }
      buildCompleted = true;
      return json({
        tasks: [
          { id: "cb_failure_cleanup", type: "build-context", status: "done" },
          {
            id: "publication",
            parentTaskId: "cb_failure_cleanup",
            type: "publish-context-release",
            status: "done",
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "pageindex",
            parentTaskId: "cb_failure_cleanup",
            type: "index-context-release",
            status: "done",
            metadata: { repository: "omlabs/repo", ref: "main" }
          }
        ]
      });
    }
    if (url.pathname === "/internal/context/tokens") {
      if (authorization === `Bearer ${issuedSecret}`) {
        return json({ error: "internal credential required" }, 401);
      }
      assert.equal(buildCompleted, true);
      if (method === "GET") return json({ tokens: [] });
      return json(
        {
          secret: issuedSecret,
          token: {
            id: tokenId,
            principalId: "user:reader@example.com",
            name: "production-acceptance-cb_failure_cleanup",
            scopes: ["context:read", "context:query"],
            createdAt: issuedCreatedAt,
            expiresAt: new Date(Date.parse(issuedCreatedAt) + 5 * 60_000).toISOString()
          }
        },
        201
      );
    }
    if (url.pathname === `/internal/context/tokens/${tokenId}/revoke`) {
      revoked = true;
      return json({ token: { id: tokenId, revokedAt: new Date().toISOString() } });
    }
    if (url.pathname === "/context/metrics") {
      return json({ error: "token scope does not permit this route", code: "insufficient_scope" }, 403);
    }
    if (url.pathname === "/context/releases") {
      if (headers.get("x-jina-principal-id") !== "user:reader@example.com") {
        return json({ error: "unauthorized" }, 401);
      }
      if (headers.get("x-jina-tenant-id")) return json({ error: "unauthorized" }, 401);
      if (revoked) {
        revokedHttpRejected = true;
        return json({ error: "unauthorized" }, 401);
      }
      return json({ releases: [] });
    }
    if (url.pathname === "/mcp" && revoked) {
      revokedMcpRejected = true;
      return json({ error: "unauthorized" }, 401);
    }
    return json({ error: "unexpected request" }, 500);
  };

  await assert.rejects(
    runProductionContextAcceptance({
      apiUrl: "https://api.example.test",
      internalToken: "internal",
      principalId: "user:reader@example.com",
      adminPrincipalId: "user:admin@example.com",
      repository: "omlabs/repo",
      ref: "main",
      pollIntervalMs: 0,
      fetchImpl,
      log: () => undefined
    }),
    /no published release/
  );
  assert.equal(revoked, true);
  assert.equal(revokedHttpRejected, true);
  assert.equal(revokedMcpRejected, true);
});

for (const scenario of [
  {
    mode: "invalid-json" as const,
    title: "malformed mint JSON",
    error: /internal\/context\/tokens returned invalid JSON/,
    expectedListReads: 2,
    expectedBearerProof: false
  },
  {
    mode: "missing-id" as const,
    title: "a mint response without token.id",
    error: /issued token\.id is required/,
    expectedListReads: 2,
    expectedBearerProof: true
  },
  {
    mode: "wrong-ttl" as const,
    title: "a mint response without an exact five-minute TTL",
    error: /does not have an exact five-minute TTL/,
    expectedListReads: 1,
    expectedBearerProof: true
  }
]) {
  test(`production acceptance cleans up ${scenario.title}`, async () => {
    const result = await runTokenContractFailureScenario(scenario.mode);
    assert.match(result.error, scenario.error);
    assert.deepEqual(result.revokedTokenIds, ["atk_mint_cleanup"]);
    assert.equal(result.listReads, scenario.expectedListReads);
    assert.equal(result.revokedHttpRejected, scenario.expectedBearerProof);
    assert.equal(result.revokedMcpRejected, scenario.expectedBearerProof);
  });
}

test("production MCP acceptance invokes and validates all four Context tools", async () => {
  const repository = "omlabs/repo";
  const commitSha = "a".repeat(40);
  const releaseId = "ig_current";
  const documentId = "kr_architecture";
  const calls: string[] = [];
  const release = { id: releaseId, repository, ref: "main", commitSha };
  const citation = {
    claim: "Architecture",
    anchor: {
      repository,
      commitSha,
      sourceType: "blob",
      contentDigest: "b".repeat(64)
    }
  };
  const document = {
    id: documentId,
    citations: [citation]
  };
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body = await readJson(request);
    const mcp = new McpServer({ name: "acceptance-test", version: "1.0.0" });
    const tool = (name: string, value: Record<string, unknown>) => {
      mcp.registerTool(
        name,
        {
          inputSchema: {},
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        },
        async () => {
          calls.push(name);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
            structuredContent: value
          };
        }
      );
    };
    tool("search_context", {
      release,
      results: [{ documentId, citations: [citation] }],
      retrieval: { method: "lexical_tree", selector: "pageindex-lexical-tree-v1" }
    });
    tool("list_context", {
      release,
      documents: [document],
      tree: [{ id: "node-architecture", documentId, children: [] }]
    });
    tool("read_context", {
      release,
      document: { ...document, bodyMarkdown: "# Architecture\n\nGrounded context." }
    });
    tool("diff_context", {
      from: release,
      to: release,
      added: [],
      removed: [],
      changed: [],
      unchanged: ["architecture"]
    });
    const transportOptions = {
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    } as unknown as StreamableHTTPServerTransportOptions;
    const transport = new StreamableHTTPServerTransport(transportOptions);
    await mcp.connect(transport as unknown as Transport);
    response.once("close", () => {
      void transport.close();
      void mcp.close();
    });
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const citationCount = await verifyProductionMcp({
      apiUrl: `http://127.0.0.1:${address.port}`,
      headers: {
        authorization: "Bearer context",
        "x-jina-principal-id": "user:reader@example.com"
      },
      repository,
      ref: "main",
      commitSha,
      releaseId,
      documentId,
      fromReleaseId: releaseId,
      fromCommitSha: commitSha
    });
    assert.equal(citationCount, 3);
    assert.deepEqual(calls.sort(), ["diff_context", "list_context", "read_context", "search_context"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("production web acceptance exercises the dashboard proxy and admin server render", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${url.hostname}${url.pathname}`);
    const headers = new Headers(init?.headers);
    if (url.hostname === "dashboard.example.test") {
      assert.equal(headers.get("authorization"), "Bearer dashboard-iap");
      if (url.pathname === "/context") {
        return new Response(
          '<!doctype html><html><body><section id="context-page"><h1>Evidence-backed workspace</h1></section></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
      return json({
        releases: [{ id: "ig_current", repository: "omlabs/repo" }]
      });
    }
    assert.equal(headers.get("authorization"), "Basic acceptance");
    return new Response("<!doctype html><html><body>omlabs/repo <code>ig_current</code></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  };
  assert.equal(
    await verifyProductionWebSurfaces(
      fetchImpl,
      {
        dashboardUrl: "https://dashboard.example.test",
        adminUrl: "https://admin.example.test",
        dashboardAuthorization: "Bearer dashboard-iap",
        adminAuthorization: "Basic acceptance"
      },
      { repository: "omlabs/repo", releaseId: "ig_current", timeoutMs: 1_000 }
    ),
    3
  );
  assert.deepEqual(requests, [
    "dashboard.example.test/api/context/releases",
    "dashboard.example.test/context",
    "admin.example.test/"
  ]);
});

test("production isolation probes require opaque bounded not-found responses", async () => {
  const requested: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    return url.searchParams.get("repository") === "omlabs/repo"
      ? json({ accepted: false, code: "not_found", error: "context not found" }, 404)
      : json({ accepted: false, code: "not_found", error: "repository context not found" }, 404);
  };
  await verifyProductionContextIsolation(fetchImpl, {
    apiUrl: "https://api.example.test/",
    headers: { authorization: "Bearer issued" },
    repository: "omlabs/repo",
    releaseId: "ig_current",
    buildId: "task_build_123",
    timeoutMs: 1_000
  });
  assert.equal(requested.length, 2);
  assert.equal(requested[0]?.searchParams.get("repository"), "omlabs/context-acceptance-forbidden-task-build-123");
  assert.equal(requested[1]?.searchParams.get("releaseId"), "ig_acceptance_missing_task_build_123");

  await assert.rejects(
    verifyProductionContextIsolation(
      async (input) => {
        const url = new URL(String(input));
        return json(
          {
            accepted: false,
            code: "not_found",
            error: url.searchParams.get("repository") ?? "context not found"
          },
          404
        );
      },
      {
        apiUrl: "https://api.example.test",
        headers: { authorization: "Bearer issued" },
        repository: "omlabs/repo",
        releaseId: "ig_current",
        buildId: "task_build_123",
        timeoutMs: 1_000
      }
    ),
    /bounded not-found contract|leaked the requested identifier/
  );
});

test("production retrieval samples bounded Board-owned titles and requires every owning document", async () => {
  const repository = "omlabs/repo";
  const ref = "main";
  const releaseId = "ig_current";
  const commitSha = "a".repeat(40);
  const documents = [
    { id: "doc-delta", logicalId: "topic:omlabs/repo:delta", title: "Delta operations" },
    { id: "doc-bravo", logicalId: "topic:omlabs/repo:bravo", title: "Bravo lifecycle" },
    { id: "doc-alpha", logicalId: "topic:omlabs/repo:alpha", title: "Alpha architecture" },
    { id: "doc-charlie", logicalId: "topic:omlabs/repo:charlie", title: "Charlie recovery" }
  ];
  const documentIdByTitle = new Map(documents.map((document) => [document.title, document.id]));
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    queries.push(body.query);
    return json({
      release: { id: releaseId, repository, ref, commitSha },
      results: [
        {
          documentId: documentIdByTitle.get(body.query),
          citations: [
            {
              claim: body.query,
              anchor: {
                repository,
                commitSha,
                sourceType: "blob",
                contentDigest: "b".repeat(64)
              }
            }
          ]
        }
      ],
      retrieval: { method: "lexical_tree", selector: "pageindex-lexical-tree-v1" }
    });
  };

  const citations = await verifyProductionRetrievalQuality(fetchImpl, {
    apiUrl: "https://api.example.test",
    headers: { authorization: "Bearer issued" },
    repository,
    ref,
    releaseId,
    commitSha,
    documents
  });
  assert.deepEqual(queries, ["Alpha architecture", "Bravo lifecycle", "Charlie recovery"]);
  assert.equal(citations.length, 3);

  await assert.rejects(
    verifyProductionRetrievalQuality(
      async () =>
        json({
          release: { id: releaseId, repository, ref, commitSha },
          results: [],
          retrieval: { method: "model_tree", selector: "forbidden-model-selector" }
        }),
      {
        apiUrl: "https://api.example.test",
        headers: { authorization: "Bearer issued" },
        repository,
        ref,
        releaseId,
        commitSha,
        documents: documents.slice(0, 1)
      }
    ),
    /deterministic model-free PageIndex tree retrieval/
  );

  await assert.rejects(
    verifyProductionRetrievalQuality(
      async () =>
        json({
          release: { id: releaseId, repository, ref, commitSha },
          results: [
            { documentId: "doc-delta", citations: [] },
            {
              documentId: "different-document",
              citations: [
                {
                  claim: "unrelated evidence",
                  anchor: {
                    repository,
                    commitSha,
                    sourceType: "blob",
                    contentDigest: "b".repeat(64)
                  }
                }
              ]
            }
          ],
          retrieval: { method: "lexical_tree", selector: "pageindex-lexical-tree-v1" }
        }),
      {
        apiUrl: "https://api.example.test",
        headers: { authorization: "Bearer issued" },
        repository,
        ref,
        releaseId,
        commitSha,
        documents: documents.slice(0, 1)
      }
    ),
    /returned no citations/
  );
});

async function runTokenContractFailureScenario(mode: "invalid-json" | "missing-id" | "wrong-ttl"): Promise<{
  readonly error: string;
  readonly revokedTokenIds: string[];
  readonly listReads: number;
  readonly revokedHttpRejected: boolean;
  readonly revokedMcpRejected: boolean;
}> {
  const principalId = "user:reader@example.com";
  const tokenName = "production-acceptance-cb_mint_cleanup";
  const tokenId = "atk_mint_cleanup";
  const issuedSecret = `jina_atk_${"m".repeat(43)}`;
  const createdAt = new Date().toISOString();
  const matchingToken = {
    id: tokenId,
    principalId,
    name: tokenName,
    scopes: ["context:read", "context:query"],
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString()
  };
  const unrelatedTokens = [
    { ...matchingToken, id: "atk_other_principal", principalId: "user:other@example.com" },
    { ...matchingToken, id: "atk_other_name", name: "production-acceptance-unrelated" }
  ];
  const revokedTokenIds: string[] = [];
  let matchingActive = true;
  let listReads = 0;
  let revokedHttpRejected = false;
  let revokedMcpRejected = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (url.pathname === "/internal/context/access/sync") return json({ repositoryCount: 1 });
    if (url.pathname === "/context/build") return json({ build: { id: "cb_mint_cleanup" } }, 202);
    if (url.pathname === "/board") {
      return json({
        tasks: [
          { id: "cb_mint_cleanup", type: "build-context", status: "done" },
          {
            id: "publication",
            parentTaskId: "cb_mint_cleanup",
            type: "publish-context-release",
            status: "done",
            metadata: { repository: "omlabs/repo", ref: "main" }
          },
          {
            id: "pageindex",
            parentTaskId: "cb_mint_cleanup",
            type: "index-context-release",
            status: "done",
            metadata: { repository: "omlabs/repo", ref: "main" }
          }
        ]
      });
    }
    if (url.pathname === "/internal/context/tokens" && method === "POST") {
      assert.equal(authorization, "Bearer internal");
      if (mode === "invalid-json") {
        return new Response("{", { status: 201, headers: { "content-type": "application/json" } });
      }
      if (mode === "missing-id") {
        const { id: _id, ...withoutId } = matchingToken;
        return json({ secret: issuedSecret, token: withoutId }, 201);
      }
      return json(
        {
          secret: issuedSecret,
          token: {
            ...matchingToken,
            expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000 + 1_000).toISOString()
          }
        },
        201
      );
    }
    if (url.pathname === "/internal/context/tokens" && method === "GET") {
      assert.equal(authorization, "Bearer internal");
      listReads += 1;
      return json({ tokens: [...(matchingActive ? [matchingToken] : []), ...unrelatedTokens] });
    }
    if (url.pathname.startsWith("/internal/context/tokens/") && url.pathname.endsWith("/revoke")) {
      const revokedId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
      assert.equal(revokedId, tokenId, "cleanup must not revoke a token with a different name or principal");
      revokedTokenIds.push(revokedId);
      matchingActive = false;
      return json({ token: { id: revokedId, revokedAt: new Date().toISOString() } });
    }
    if (url.pathname === "/context/releases" && authorization === `Bearer ${issuedSecret}` && !matchingActive) {
      revokedHttpRejected = true;
      return json({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/mcp" && authorization === `Bearer ${issuedSecret}` && !matchingActive) {
      revokedMcpRejected = true;
      return json({ error: "unauthorized" }, 401);
    }
    return json({ error: "unexpected request" }, 500);
  };

  let error = "";
  try {
    await runProductionContextAcceptance({
      apiUrl: "https://api.example.test",
      internalToken: "internal",
      principalId,
      adminPrincipalId: "user:admin@example.com",
      repository: "omlabs/repo",
      ref: "main",
      pollIntervalMs: 0,
      fetchImpl,
      log: () => undefined
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  assert.ok(error, "the invalid mint contract must fail acceptance");
  assert.equal(matchingActive, false);
  return { error, revokedTokenIds, listReads, revokedHttpRejected, revokedMcpRejected };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
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
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}
