import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedContextGraphTaskIds,
  productionAcceptanceExitCode,
  runProductionContextGraphAcceptance
} from "./acceptance.js";

test("production acceptance exposes coarse failure categories without log access", () => {
  assert.equal(productionAcceptanceExitCode(new Error("production contextGraph task task-1 ended as failed")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("production board retains blocked contextGraph tasks")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("latest contextGraph graph does not match")), 21);
  assert.equal(productionAcceptanceExitCode(new Error("production contextGraph graph is empty")), 22);
  assert.equal(productionAcceptanceExitCode(new Error("production contextGraph graph contains uncited items")), 23);
  assert.equal(
    productionAcceptanceExitCode(new Error("production context retrieval did not return cited results")),
    24
  );
  assert.equal(productionAcceptanceExitCode(new Error("production contextGraph backlog is not empty")), 25);
  assert.equal(productionAcceptanceExitCode(new Error("/context-graph returned invalid JSON")), 26);
});

test("blocked contextGraph detection is scoped to the accepted repository and ref", () => {
  assert.deepEqual(
    blockedContextGraphTaskIds(
      [
        {
          id: "same",
          type: "context_graph_project",
          status: "blocked",
          metadata: { repository: "omxyz/repo", ref: "main" }
        },
        {
          id: "other-ref",
          type: "context_graph_project",
          status: "blocked",
          metadata: { repository: "omxyz/repo", ref: "dev" }
        },
        {
          id: "other-workflow",
          type: "review_pass",
          status: "blocked",
          metadata: { repository: "omxyz/repo", ref: "main" }
        },
        {
          id: "historical",
          type: "context_graph_project",
          status: "superseded",
          metadata: { repository: "omxyz/repo", ref: "main" }
        }
      ],
      "omxyz/repo",
      "main"
    ),
    ["same"]
  );
});

test("production acceptance waits for all chunks and verifies cited canonical output", async () => {
  let boardReads = 0;
  const requests: string[] = [];
  const logs: string[] = [];
  let askReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/context-graph/build")) return json({ task: { id: "context-graph-root" } }, 202);
    if (url.endsWith("/board")) {
      boardReads += 1;
      return json({
        tasks: [
          {
            id: "context-graph-root",
            type: "context_graph_build",
            status: boardReads === 1 ? "in_progress" : "done"
          },
          {
            id: "context-graph-ingest",
            parentTaskId: "context-graph-root",
            type: "context_graph_ingest",
            status: "done"
          },
          {
            id: "context-graph-assert",
            parentTaskId: "context-graph-root",
            type: "context_graph_assert",
            status: boardReads === 1 ? "in_progress" : "done"
          },
          {
            id: "context-graph-project",
            parentTaskId: "context-graph-root",
            type: "context_graph_project",
            status: boardReads === 1 ? "triage" : "done",
            ...(boardReads === 1 ? {} : { metadata: { result: { graphId: "graph-e2e", commitSha: "a".repeat(40) } } })
          }
        ]
      });
    }
    if (url.endsWith("/context-graph/ask")) {
      askReads += 1;
      if (askReads === 2)
        return json({
          calls: [
            {
              template: "issue_trace",
              items: [
                {
                  data: {
                    issue: { number: 1, title: "Document guest access denial semantics" },
                    resolutions: [{ pullRequestNumber: 2, commits: [{ sha: "b".repeat(40) }] }]
                  },
                  citations: [{ kind: "assertion", id: "resolves" }]
                }
              ]
            }
          ],
          citations: [{ kind: "assertion", id: "resolves" }]
        });
      return json({
        calls: ["change", "intent", "ownership"].map((template) => ({
          template,
          items: [{ citations: [{ kind: "assertion", id: template }] }]
        })),
        citations: [
          { kind: "assertion", id: "change" },
          { kind: "assertion", id: "intent" },
          { kind: "assertion", id: "ownership" }
        ]
      });
    }
    if (url.endsWith("/context-graph/metrics")) return json({ outboxDepth: {}, unparsedBlobCount: 0 });
    if (url.endsWith("/context-graph/graphs/graph-e2e")) {
      return json({
        id: "graph-e2e",
        repository: "omxyz/jina-context-graph-e2e",
        ref: "main",
        commitSha: "a".repeat(40),
        nodes: [{ evidence: ["src/index.ts:1"] }],
        edges: [{ evidence: ["src/index.ts:1"] }]
      });
    }
    if (new URL(url).pathname === "/context-graph") {
      // Another repository's fresher build owns the tenant-wide latest head;
      // acceptance must still resolve its own repository's newest graph.
      return json({
        latest: { repository: "omxyz/other-production-repo", ref: "main" },
        graphs: [
          {
            id: "graph-other",
            repository: "omxyz/other-production-repo",
            ref: "main",
            commitSha: "d".repeat(40),
            generatedAt: "2026-07-21T12:00:00.000Z"
          },
          {
            id: "graph-e2e",
            repository: "omxyz/jina-context-graph-e2e",
            ref: "main",
            commitSha: "a".repeat(40),
            generatedAt: "2026-07-20T12:00:00.000Z"
          },
          {
            id: "graph-e2e-stale",
            repository: "omxyz/jina-context-graph-e2e",
            ref: "main",
            commitSha: "e".repeat(40),
            generatedAt: "2026-07-19T12:00:00.000Z"
          }
        ]
      });
    }
    return json({ error: "not found" }, 404);
  };

  const result = await runProductionContextGraphAcceptance(
    {
      apiUrl: "https://api.example.test",
      token: "secret",
      requestKey: "deploy-1",
      repository: "omxyz/jina-context-graph-e2e",
      pollIntervalMs: 1,
      timeoutMs: 100,
      log: (message) => logs.push(message)
    },
    fetchImpl
  );

  assert.deepEqual(result, {
    taskId: "context-graph-root",
    repository: "omxyz/jina-context-graph-e2e",
    graphId: "graph-e2e",
    commitSha: "a".repeat(40),
    nodeCount: 1,
    edgeCount: 1,
    citationCount: 3
  });
  assert.deepEqual(requests, [
    "POST /context-graph/build",
    "GET /board",
    "GET /board",
    "GET /context-graph/graphs/graph-e2e",
    "POST /context-graph/ask",
    "POST /context-graph/ask",
    "GET /context-graph/metrics"
  ]);
  assert.deepEqual(logs, [
    "Production contextGraph task context-graph-root: root=in_progress, context_graph_ingest=done, context_graph_assert=in_progress, context_graph_project=triage",
    "Production contextGraph task context-graph-root: root=done, context_graph_ingest=done, context_graph_assert=done, context_graph_project=done"
  ]);
});

test("production acceptance certifies the current same-commit head when the receipt graph was replaced", async () => {
  let askReads = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/context-graph/build") return json({ task: { id: "context-graph-root" } }, 202);
    if (url.pathname === "/board") {
      return json({
        tasks: [
          { id: "context-graph-root", type: "context_graph_build", status: "done" },
          {
            id: "context-graph-project",
            parentTaskId: "context-graph-root",
            type: "context_graph_project",
            status: "done",
            metadata: { result: { graphId: "graph-receipt", commitSha: "a".repeat(40) } }
          }
        ]
      });
    }
    // A later publication replaced the receipt graph as the durable head.
    if (url.pathname === "/context-graph/graphs/graph-receipt") return json({ error: "not found" }, 404);
    if (url.pathname === "/context-graph/graphs/graph-successor") {
      return json({
        id: "graph-successor",
        repository: "omxyz/jina-context-graph-e2e",
        ref: "main",
        commitSha: "a".repeat(40),
        nodes: [{ evidence: ["src/index.ts:1"] }],
        edges: [{ evidence: ["src/index.ts:1"] }]
      });
    }
    if (url.pathname === "/context-graph") {
      return json({
        latest: null,
        graphs: [
          {
            id: "graph-successor",
            repository: "omxyz/jina-context-graph-e2e",
            ref: "main",
            commitSha: "a".repeat(40),
            generatedAt: "2026-07-22T03:00:00.000Z"
          }
        ]
      });
    }
    if (url.pathname === "/context-graph/ask") {
      askReads += 1;
      if (askReads === 2)
        return json({
          calls: [
            {
              template: "issue_trace",
              items: [
                {
                  data: {
                    issue: { number: 1, title: "Document guest access denial semantics" },
                    resolutions: [{ pullRequestNumber: 2, commits: [{ sha: "b".repeat(40) }] }]
                  },
                  citations: [{ kind: "assertion", id: "resolves" }]
                }
              ]
            }
          ],
          citations: [{ kind: "assertion", id: "resolves" }]
        });
      return json({
        calls: ["change", "intent", "ownership"].map((template) => ({
          template,
          items: [{ citations: [{ kind: "assertion", id: template }] }]
        })),
        citations: [{ kind: "assertion", id: "change" }]
      });
    }
    if (url.pathname === "/context-graph/metrics") return json({ outboxDepth: {}, unparsedBlobCount: 0 });
    return json({ error: "not found" }, 404);
  };

  const result = await runProductionContextGraphAcceptance(
    {
      apiUrl: "https://api.example.test",
      token: "secret",
      requestKey: "deploy-replaced-head",
      repository: "omxyz/jina-context-graph-e2e",
      pollIntervalMs: 1,
      timeoutMs: 100,
      log: () => undefined
    },
    fetchImpl
  );
  assert.equal(result.graphId, "graph-successor");
  assert.equal(result.commitSha, "a".repeat(40));
});

test("production acceptance rejects a direct receipt graph projecting a different commit", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/context-graph/build") return json({ task: { id: "context-graph-root" } }, 202);
    if (url.pathname === "/board") {
      return json({
        tasks: [
          { id: "context-graph-root", type: "context_graph_build", status: "done" },
          {
            id: "context-graph-project",
            parentTaskId: "context-graph-root",
            type: "context_graph_project",
            status: "done",
            metadata: { result: { graphId: "graph-e2e", commitSha: "a".repeat(40) } }
          }
        ]
      });
    }
    if (url.pathname.startsWith("/context-graph/graphs/")) {
      // Same id, repository, and ref — but the served graph projects another
      // commit than the receipt recorded.
      return json({
        id: "graph-e2e",
        repository: "omxyz/jina-context-graph-e2e",
        ref: "main",
        commitSha: "b".repeat(40),
        nodes: [{ evidence: ["src/index.ts:1"] }],
        edges: [{ evidence: ["src/index.ts:1"] }]
      });
    }
    return json({ error: "not found" }, 404);
  };

  await assert.rejects(
    runProductionContextGraphAcceptance(
      {
        apiUrl: "https://api.example.test",
        token: "secret",
        requestKey: "deploy-commit-mismatch",
        repository: "omxyz/jina-context-graph-e2e",
        pollIntervalMs: 1,
        timeoutMs: 100,
        log: () => undefined
      },
      fetchImpl
    ),
    /latest contextGraph graph does not match the acceptance repository and ref/
  );
});

test("production acceptance rejects a fetched graph whose own identity does not match", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/context-graph/build") return json({ task: { id: "context-graph-root" } }, 202);
    if (url.pathname === "/board") {
      return json({
        tasks: [
          { id: "context-graph-root", type: "context_graph_build", status: "done" },
          {
            id: "context-graph-project",
            parentTaskId: "context-graph-root",
            type: "context_graph_project",
            status: "done",
            metadata: { result: { graphId: "graph-e2e", commitSha: "a".repeat(40) } }
          }
        ]
      });
    }
    if (url.pathname.startsWith("/context-graph/graphs/")) {
      // The summary advertised the acceptance repository, but the direct
      // response carries another repository's graph.
      return json({
        id: "graph-e2e",
        repository: "omxyz/other-production-repo",
        ref: "main",
        commitSha: "d".repeat(40),
        nodes: [{ evidence: ["src/index.ts:1"] }],
        edges: [{ evidence: ["src/index.ts:1"] }]
      });
    }
    if (url.pathname === "/context-graph") {
      return json({
        latest: null,
        graphs: [
          {
            id: "graph-e2e",
            repository: "omxyz/jina-context-graph-e2e",
            ref: "main",
            commitSha: "a".repeat(40),
            generatedAt: "2026-07-21T12:00:00.000Z"
          }
        ]
      });
    }
    return json({ error: "not found" }, 404);
  };

  await assert.rejects(
    runProductionContextGraphAcceptance(
      {
        apiUrl: "https://api.example.test",
        token: "secret",
        requestKey: "deploy-mismatch",
        repository: "omxyz/jina-context-graph-e2e",
        pollIntervalMs: 1,
        timeoutMs: 100,
        log: () => undefined
      },
      fetchImpl
    ),
    /latest contextGraph graph does not match the acceptance repository and ref/
  );
});

test("production acceptance rejects a newest project stage without a published graphId", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/context-graph/build") return json({ task: { id: "context-graph-root" } }, 202);
    if (url.pathname === "/board") {
      // The newest completion is malformed; an older stage still advertises a
      // graphId. Acceptance must fail rather than certify the older graph.
      return json({
        tasks: [
          { id: "context-graph-root", type: "context_graph_build", status: "done" },
          {
            id: "project-old",
            parentTaskId: "context-graph-root",
            type: "context_graph_project",
            status: "done",
            metadata: {
              result: { graphId: "graph-old", commitSha: "a".repeat(40) },
              timing: { completedAt: "2026-07-22T01:00:00.000Z" }
            }
          },
          {
            id: "project-new",
            parentTaskId: "context-graph-root",
            type: "context_graph_project",
            status: "done",
            metadata: { result: {}, timing: { completedAt: "2026-07-22T02:00:00.000Z" } }
          }
        ]
      });
    }
    return json({ error: "not found" }, 404);
  };

  await assert.rejects(
    runProductionContextGraphAcceptance(
      {
        apiUrl: "https://api.example.test",
        token: "secret",
        requestKey: "deploy-malformed",
        repository: "omxyz/jina-context-graph-e2e",
        pollIntervalMs: 1,
        timeoutMs: 100,
        log: () => undefined
      },
      fetchImpl
    ),
    /latest contextGraph graph receipt is missing/
  );
});

test("production acceptance reviews causality, queries it in both directions, and verifies the graph edge", async () => {
  const causingCommitSha = "c".repeat(40);
  let buildCount = 0;
  let contextGraphReads = 0;
  let reviewed = false;
  const causalQuestions: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/context-graph/build") return json({ task: { id: `context-graph-${++buildCount}` } }, 202);
    if (url.pathname === "/board") {
      const taskId = buildCount === 1 ? "context-graph-1" : "context-graph-2";
      return json({
        tasks: [
          { id: taskId, type: "context_graph_build", status: "done" },
          { id: `${taskId}-ingest`, parentTaskId: taskId, type: "context_graph_ingest", status: "done" },
          { id: `${taskId}-assert`, parentTaskId: taskId, type: "context_graph_assert", status: "done" },
          {
            id: `${taskId}-project`,
            parentTaskId: taskId,
            type: "context_graph_project",
            status: "done",
            metadata: { result: { graphId: "graph-e2e", commitSha: "a".repeat(40) } }
          }
        ]
      });
    }
    if (url.pathname.startsWith("/context-graph/graphs/")) {
      contextGraphReads += 1;
      return json({
        id: "graph-e2e",
        repository: "omxyz/jina-context-graph-e2e",
        ref: "main",
        commitSha: "a".repeat(40),
        nodes:
          contextGraphReads === 1
            ? [{ id: "repo", kind: "Repository", evidence: ["README.md:1"] }]
            : [
                {
                  id: "issue",
                  kind: "Issue",
                  description: "github:issue:omxyz/jina-context-graph-e2e#7",
                  evidence: ["ROOT_CAUSE.md:2"]
                },
                {
                  id: "commit",
                  kind: "Commit",
                  description: `repo:omxyz/jina-context-graph-e2e:sha:${causingCommitSha}`,
                  evidence: ["ROOT_CAUSE.md:2"]
                }
              ],
        edges:
          contextGraphReads === 1
            ? [
                {
                  source: "repo",
                  target: "repo",
                  predicate: "CONTAINS",
                  evidence: ["README.md:1"]
                }
              ]
            : [
                {
                  source: "issue",
                  target: "commit",
                  predicate: "INTRODUCED_BY",
                  why: "The guard was bypassed.",
                  evidence: ["ROOT_CAUSE.md:2"]
                }
              ]
      });
    }
    if (url.pathname === "/context-graph") {
      return json({
        latest: null,
        graphs: [
          {
            id: "graph-e2e",
            repository: "omxyz/jina-context-graph-e2e",
            ref: "main",
            commitSha: "a".repeat(40),
            generatedAt: "2026-07-21T12:00:00.000Z"
          }
        ]
      });
    }
    if (url.pathname === "/context-graph/assertions")
      return json({
        assertions: [
          {
            id: "cause-assertion",
            status: "proposed",
            subjectNaturalKey: "github:issue:omxyz/jina-context-graph-e2e#7",
            objectNaturalKey: `repo:omxyz/jina-context-graph-e2e:sha:${causingCommitSha}`,
            evidence: ["ROOT_CAUSE.md:2"],
            qualifiers: { reason: "The guard was bypassed." }
          }
        ]
      });
    if (url.pathname === "/context-graph/commands") {
      reviewed = true;
      return json({ affectedIds: ["cause-assertion"] });
    }
    if (url.pathname === "/context-graph/ask") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        question?: string;
        operation?: string;
      };
      if (body.question?.includes("resolved issue"))
        return json({
          calls: [
            {
              template: "issue_trace",
              items: [
                {
                  data: {
                    issue: { number: 7, title: "Application guard bypassed" },
                    resolutions: [{ pullRequestNumber: 8, commits: [{ sha: "b".repeat(40) }] }]
                  },
                  citations: [{ kind: "assertion", id: "resolves" }]
                }
              ]
            }
          ],
          citations: [{ kind: "assertion", id: "resolves" }]
        });
      if (body.operation === "counterfactual") {
        const causing = body.question?.includes("PR #6");
        return json({
          operation: "counterfactual",
          answer: "Removing the PR eliminates every currently known reviewed path to the issue.",
          calls: [
            {
              template: "counterfactual",
              items: [{ citations: [{ kind: "assertion", id: causing ? "cause" : "fix" }] }]
            }
          ],
          citedClaims: [
            {
              text: "supported",
              citations: [{ kind: "assertion", id: causing ? "cause" : "fix" }]
            }
          ],
          counterfactual: {
            basis: "graph-derived",
            removedPaths: [{ citations: [{ kind: "assertion", id: causing ? "cause" : "fix" }] }],
            remainingPaths: []
          }
        });
      }
      if (body.question?.includes("caused") || body.question?.includes("cause")) {
        causalQuestions.push(body.question);
        return json({
          calls: [
            {
              template: "issue_trace",
              items: [
                {
                  data: {
                    issue: { number: 7 },
                    introducedBy: [
                      {
                        sha: causingCommitSha,
                        why: "The guard was bypassed.",
                        evidence: ["ROOT_CAUSE.md:2"],
                        evidenceCommitSha: "a".repeat(40),
                        pullRequests: [
                          {
                            number: 6,
                            title: "Introduce regression",
                            url: "https://github.com/omxyz/jina-context-graph-e2e/pull/6"
                          }
                        ]
                      }
                    ]
                  },
                  citations: [
                    { kind: "assertion", id: "cause-assertion" },
                    { kind: "code", id: "evidence", commitSha: "a".repeat(40) }
                  ]
                }
              ]
            }
          ],
          citations: [{ kind: "assertion", id: "cause-assertion" }]
        });
      }
      return json({
        calls: ["change", "intent", "ownership"].map((template) => ({
          template,
          items: [{ citations: [{ kind: "assertion", id: template }] }]
        })),
        citations: [{ kind: "assertion", id: "change" }]
      });
    }
    if (url.pathname === "/context-graph/metrics") return json({ outboxDepth: {}, unparsedBlobCount: 0 });
    return json({ error: "not found" }, 404);
  };

  const result = await runProductionContextGraphAcceptance(
    {
      apiUrl: "https://api.example.test",
      token: "secret",
      requestKey: "deploy-causal",
      repository: "omxyz/jina-context-graph-e2e",
      expectedIssueNumber: 7,
      expectedResolutionPullRequestNumber: 8,
      causality: { causingCommitSha, causingPullRequestNumber: 6, reasonIncludes: "guard" },
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      log: () => undefined
    },
    fetchImpl
  );

  assert.equal(reviewed, true);
  assert.equal(buildCount, 2);
  assert.equal(causalQuestions.length, 4);
  assert.equal(
    causalQuestions.some((question) => question.includes('"Application guard bypassed"')),
    true
  );
  assert.equal(result.edgeCount, 1);
});

test("production acceptance fails on a terminal task failure", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/context-graph/build")) return json({ task: { id: "context-graph-root" } }, 202);
    if (url.endsWith("/events")) return json([]);
    return json({ tasks: [{ id: "context-graph-root", status: "failed" }] });
  };

  await assert.rejects(
    runProductionContextGraphAcceptance(
      {
        apiUrl: "https://api.example.test",
        token: "secret",
        requestKey: "deploy-2",
        pollIntervalMs: 1,
        timeoutMs: 100,
        log: () => undefined
      },
      fetchImpl
    ),
    /ended as failed/
  );
});

test("production acceptance rejects lingering blocked tasks from an older attempt", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/context-graph/build")) return json({ task: { id: "context-graph-root" } }, 202);
    return json({
      tasks: [
        {
          id: "context-graph-root",
          type: "context_graph_build",
          status: "done",
          metadata: { repository: "omxyz/jina-context-graph-e2e", ref: "main" }
        },
        {
          id: "old-project",
          type: "context_graph_project",
          status: "blocked",
          metadata: { repository: "omxyz/jina-context-graph-e2e", ref: "main" }
        }
      ]
    });
  };

  await assert.rejects(
    runProductionContextGraphAcceptance(
      {
        apiUrl: "https://api.example.test",
        token: "secret",
        requestKey: "deploy-stale",
        repository: "omxyz/jina-context-graph-e2e",
        pollIntervalMs: 1,
        timeoutMs: 100,
        log: () => undefined
      },
      fetchImpl
    ),
    /retains blocked contextGraph tasks.*old-project/
  );
});

test("production acceptance treats a blocked aggregate as terminal and reports its failed chunk", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(new URL(url).pathname);
    if (url.endsWith("/context-graph/build")) return json({ task: { id: "context-graph-root" } }, 202);
    if (url.endsWith("/events")) {
      return json([
        {
          taskId: "context-graph-assert",
          type: "run-context-graph-assert.failed",
          payload: { reason: "Daytona assertion failed\nwithout leaking credentials" }
        }
      ]);
    }
    return json({
      tasks: [
        { id: "context-graph-root", type: "context_graph_build", status: "blocked" },
        {
          id: "context-graph-ingest",
          parentTaskId: "context-graph-root",
          type: "context_graph_ingest",
          status: "done"
        },
        {
          id: "context-graph-assert",
          parentTaskId: "context-graph-root",
          type: "context_graph_assert",
          status: "failed"
        },
        {
          id: "context-graph-project",
          parentTaskId: "context-graph-root",
          type: "context_graph_project",
          status: "blocked"
        }
      ]
    });
  };

  await assert.rejects(
    runProductionContextGraphAcceptance(
      {
        apiUrl: "https://api.example.test",
        token: "secret",
        requestKey: "deploy-3",
        pollIntervalMs: 1,
        timeoutMs: 100,
        log: () => undefined
      },
      fetchImpl
    ),
    /ended as blocked .*failures: context_graph_assert: Daytona assertion failed without leaking credentials/
  );
  assert.deepEqual(requests, ["/context-graph/build", "/board", "/events"]);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
