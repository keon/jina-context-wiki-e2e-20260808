import assert from "node:assert/strict";
import test from "node:test";
import { blockedOntologyTaskIds, productionAcceptanceExitCode, runProductionOntologyAcceptance } from "./acceptance.js";

test("production acceptance exposes coarse failure categories without log access", () => {
  assert.equal(productionAcceptanceExitCode(new Error("production ontology task task-1 ended as failed")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("production board retains blocked ontology tasks")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("latest ontology graph does not match")), 21);
  assert.equal(productionAcceptanceExitCode(new Error("production ontology graph is empty")), 22);
  assert.equal(productionAcceptanceExitCode(new Error("production ontology graph contains uncited items")), 23);
  assert.equal(productionAcceptanceExitCode(new Error("production context retrieval did not return cited results")), 24);
  assert.equal(productionAcceptanceExitCode(new Error("production ontology backlog is not empty")), 25);
  assert.equal(productionAcceptanceExitCode(new Error("/ontology returned invalid JSON")), 26);
});

test("blocked ontology detection is scoped to the accepted repository and ref", () => {
  assert.deepEqual(blockedOntologyTaskIds([
    { id: "same", type: "ontology_project", status: "blocked", metadata: { repository: "omxyz/repo", ref: "main" } },
    { id: "other-ref", type: "ontology_project", status: "blocked", metadata: { repository: "omxyz/repo", ref: "dev" } },
    { id: "other-workflow", type: "review_pass", status: "blocked", metadata: { repository: "omxyz/repo", ref: "main" } },
    { id: "historical", type: "ontology_project", status: "superseded", metadata: { repository: "omxyz/repo", ref: "main" } }
  ], "omxyz/repo", "main"), ["same"]);
});

test("production acceptance waits for all chunks and verifies cited canonical output", async () => {
  let boardReads = 0;
  const requests: string[] = [];
  const logs: string[] = [];
  let askReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/ontology/build")) return json({ task: { id: "ontology-root" } }, 202);
    if (url.endsWith("/board")) {
      boardReads += 1;
      return json({ tasks: [
        { id: "ontology-root", type: "ontology_build", status: boardReads === 1 ? "in_progress" : "done" },
        { id: "ontology-ingest", parentTaskId: "ontology-root", type: "ontology_ingest", status: "done" },
        { id: "ontology-assert", parentTaskId: "ontology-root", type: "ontology_assert", status: boardReads === 1 ? "in_progress" : "done" },
        { id: "ontology-project", parentTaskId: "ontology-root", type: "ontology_project", status: boardReads === 1 ? "triage" : "done" }
      ] });
    }
    if (url.endsWith("/ontology/ask")) {
      askReads += 1;
      if (askReads === 2) return json({
        calls: [{
          template: "issue_trace",
          items: [{
            data: { issue: { number: 1, title: "Document guest access denial semantics" }, resolutions: [{ pullRequestNumber: 2, commits: [{ sha: "b".repeat(40) }] }] },
            citations: [{ kind: "assertion", id: "resolves" }]
          }]
        }],
        citations: [{ kind: "assertion", id: "resolves" }]
      });
      return json({
        calls: ["change", "intent", "ownership"].map((template) => ({ template, items: [{ citations: [{ kind: "assertion", id: template }] }] })),
        citations: [{ kind: "assertion", id: "change" }, { kind: "assertion", id: "intent" }, { kind: "assertion", id: "ownership" }]
      });
    }
    if (url.endsWith("/ontology/metrics")) return json({ outboxDepth: {}, unparsedBlobCount: 0 });
    if (url.endsWith("/ontology")) {
      return json({ latest: {
        repository: "omxyz/jina-ontology-e2e", ref: "main", commitSha: "a".repeat(40),
        nodes: [{ evidence: ["src/index.ts:1"] }], edges: [{ evidence: ["src/index.ts:1"] }]
      } });
    }
    return json({ error: "not found" }, 404);
  };

  const result = await runProductionOntologyAcceptance({
    apiUrl: "https://api.example.test", token: "secret", requestKey: "deploy-1",
    pollIntervalMs: 1, timeoutMs: 100, log: (message) => logs.push(message)
  }, fetchImpl);

  assert.deepEqual(result, {
    taskId: "ontology-root", repository: "omxyz/jina-ontology-e2e", commitSha: "a".repeat(40),
    nodeCount: 1, edgeCount: 1, citationCount: 3
  });
  assert.deepEqual(requests, [
    "POST /ontology/build", "GET /board", "GET /board", "GET /ontology", "POST /ontology/ask", "POST /ontology/ask", "GET /ontology/metrics"
  ]);
  assert.deepEqual(logs, [
    "Production ontology task ontology-root: root=in_progress, ontology_ingest=done, ontology_assert=in_progress, ontology_project=triage",
    "Production ontology task ontology-root: root=done, ontology_ingest=done, ontology_assert=done, ontology_project=done"
  ]);
});

test("production acceptance reviews causality, queries it in both directions, and verifies the graph edge", async () => {
  const causingCommitSha = "c".repeat(40);
  let buildCount = 0;
  let ontologyReads = 0;
  let reviewed = false;
  const causalQuestions: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/ontology/build") return json({ task: { id: `ontology-${++buildCount}` } }, 202);
    if (url.pathname === "/board") {
      const taskId = buildCount === 1 ? "ontology-1" : "ontology-2";
      return json({ tasks: [
        { id: taskId, type: "ontology_build", status: "done" },
        { id: `${taskId}-ingest`, parentTaskId: taskId, type: "ontology_ingest", status: "done" },
        { id: `${taskId}-assert`, parentTaskId: taskId, type: "ontology_assert", status: "done" },
        { id: `${taskId}-project`, parentTaskId: taskId, type: "ontology_project", status: "done" }
      ] });
    }
    if (url.pathname === "/ontology") {
      ontologyReads += 1;
      return json({ latest: {
        repository: "omxyz/jina-ontology-e2e", ref: "main", commitSha: "a".repeat(40),
        nodes: ontologyReads === 1
          ? [{ id: "repo", kind: "Repository", evidence: ["README.md:1"] }]
          : [
              { id: "issue", kind: "Issue", description: "github:issue:omxyz/jina-ontology-e2e#7", evidence: ["ROOT_CAUSE.md:2"] },
              { id: "commit", kind: "Commit", description: `repo:omxyz/jina-ontology-e2e:sha:${causingCommitSha}`, evidence: ["ROOT_CAUSE.md:2"] }
            ],
        edges: ontologyReads === 1
          ? [{ source: "repo", target: "repo", predicate: "CONTAINS", evidence: ["README.md:1"] }]
          : [{ source: "issue", target: "commit", predicate: "INTRODUCED_BY", why: "The guard was bypassed.", evidence: ["ROOT_CAUSE.md:2"] }]
      } });
    }
    if (url.pathname === "/ontology/assertions") return json({ assertions: [{
      id: "cause-assertion", status: "proposed",
      subjectNaturalKey: "github:issue:omxyz/jina-ontology-e2e#7",
      objectNaturalKey: `repo:omxyz/jina-ontology-e2e:sha:${causingCommitSha}`,
      evidence: ["ROOT_CAUSE.md:2"], qualifiers: { reason: "The guard was bypassed." }
    }] });
    if (url.pathname === "/ontology/commands") {
      reviewed = true;
      return json({ affectedIds: ["cause-assertion"] });
    }
    if (url.pathname === "/ontology/ask") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { question?: string };
      if (body.question?.includes("resolved issue")) return json({ calls: [{
        template: "issue_trace", items: [{
          data: { issue: { number: 7, title: "Application guard bypassed" }, resolutions: [{ pullRequestNumber: 8, commits: [{ sha: "b".repeat(40) }] }] },
          citations: [{ kind: "assertion", id: "resolves" }]
        }]
      }], citations: [{ kind: "assertion", id: "resolves" }] });
      if (body.question?.includes("caused") || body.question?.includes("cause")) {
        causalQuestions.push(body.question);
        return json({ calls: [{ template: "issue_trace", items: [{
          data: {
            issue: { number: 7 },
            introducedBy: [{
              sha: causingCommitSha, why: "The guard was bypassed.", evidence: ["ROOT_CAUSE.md:2"], evidenceCommitSha: "a".repeat(40),
              pullRequests: [{ number: 6, title: "Introduce regression", url: "https://github.com/omxyz/jina-ontology-e2e/pull/6" }]
            }]
          },
          citations: [
            { kind: "assertion", id: "cause-assertion" },
            { kind: "code", id: "evidence", commitSha: "a".repeat(40) }
          ]
        }] }], citations: [{ kind: "assertion", id: "cause-assertion" }] });
      }
      return json({
        calls: ["change", "intent", "ownership"].map((template) => ({ template, items: [{ citations: [{ kind: "assertion", id: template }] }] })),
        citations: [{ kind: "assertion", id: "change" }]
      });
    }
    if (url.pathname === "/ontology/metrics") return json({ outboxDepth: {}, unparsedBlobCount: 0 });
    return json({ error: "not found" }, 404);
  };

  const result = await runProductionOntologyAcceptance({
    apiUrl: "https://api.example.test", token: "secret", requestKey: "deploy-causal",
    expectedIssueNumber: 7, expectedResolutionPullRequestNumber: 8,
    causality: { causingCommitSha, causingPullRequestNumber: 6, reasonIncludes: "guard" },
    pollIntervalMs: 1, timeoutMs: 1_000, log: () => undefined
  }, fetchImpl);

  assert.equal(reviewed, true);
  assert.equal(buildCount, 2);
  assert.equal(causalQuestions.length, 4);
  assert.equal(causalQuestions.some((question) => question.includes('"Application guard bypassed"')), true);
  assert.equal(result.edgeCount, 1);
});

test("production acceptance fails on a terminal task failure", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/ontology/build")) return json({ task: { id: "ontology-root" } }, 202);
    if (url.endsWith("/events")) return json([]);
    return json({ tasks: [{ id: "ontology-root", status: "failed" }] });
  };

  await assert.rejects(
    runProductionOntologyAcceptance({
      apiUrl: "https://api.example.test", token: "secret", requestKey: "deploy-2",
      pollIntervalMs: 1, timeoutMs: 100, log: () => undefined
    }, fetchImpl),
    /ended as failed/
  );
});

test("production acceptance rejects lingering blocked tasks from an older attempt", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/ontology/build")) return json({ task: { id: "ontology-root" } }, 202);
    return json({ tasks: [
      { id: "ontology-root", type: "ontology_build", status: "done", metadata: { repository: "omxyz/jina-ontology-e2e", ref: "main" } },
      { id: "old-project", type: "ontology_project", status: "blocked", metadata: { repository: "omxyz/jina-ontology-e2e", ref: "main" } }
    ] });
  };

  await assert.rejects(
    runProductionOntologyAcceptance({
      apiUrl: "https://api.example.test", token: "secret", requestKey: "deploy-stale",
      pollIntervalMs: 1, timeoutMs: 100, log: () => undefined
    }, fetchImpl),
    /retains blocked ontology tasks.*old-project/
  );
});

test("production acceptance treats a blocked aggregate as terminal and reports its failed chunk", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(new URL(url).pathname);
    if (url.endsWith("/ontology/build")) return json({ task: { id: "ontology-root" } }, 202);
    if (url.endsWith("/events")) {
      return json([{
        taskId: "ontology-assert",
        type: "run-ontology-assert.failed",
        payload: { reason: "Daytona assertion failed\nwithout leaking credentials" }
      }]);
    }
    return json({ tasks: [
      { id: "ontology-root", type: "ontology_build", status: "blocked" },
      { id: "ontology-ingest", parentTaskId: "ontology-root", type: "ontology_ingest", status: "done" },
      { id: "ontology-assert", parentTaskId: "ontology-root", type: "ontology_assert", status: "failed" },
      { id: "ontology-project", parentTaskId: "ontology-root", type: "ontology_project", status: "blocked" }
    ] });
  };

  await assert.rejects(
    runProductionOntologyAcceptance({
      apiUrl: "https://api.example.test", token: "secret", requestKey: "deploy-3",
      pollIntervalMs: 1, timeoutMs: 100, log: () => undefined
    }, fetchImpl),
    /ended as blocked .*failures: ontology_assert: Daytona assertion failed without leaking credentials/
  );
  assert.deepEqual(requests, ["/ontology/build", "/board", "/events"]);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
