import assert from "node:assert/strict";
import test from "node:test";
import { productionAcceptanceExitCode, runProductionOntologyAcceptance } from "./acceptance.js";

test("production acceptance exposes coarse failure categories without log access", () => {
  assert.equal(productionAcceptanceExitCode(new Error("production ontology task task-1 ended as failed")), 20);
  assert.equal(productionAcceptanceExitCode(new Error("latest ontology graph does not match")), 21);
  assert.equal(productionAcceptanceExitCode(new Error("production ontology graph is empty")), 22);
  assert.equal(productionAcceptanceExitCode(new Error("production ontology graph contains uncited items")), 23);
  assert.equal(productionAcceptanceExitCode(new Error("production context retrieval did not return cited results")), 24);
  assert.equal(productionAcceptanceExitCode(new Error("production ontology backlog is not empty")), 25);
  assert.equal(productionAcceptanceExitCode(new Error("/ontology returned invalid JSON")), 26);
});

test("production acceptance waits for all chunks and verifies cited canonical output", async () => {
  let boardReads = 0;
  const requests: string[] = [];
  const logs: string[] = [];
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
    "POST /ontology/build", "GET /board", "GET /board", "GET /ontology", "POST /ontology/ask", "GET /ontology/metrics"
  ]);
  assert.deepEqual(logs, [
    "Production ontology task ontology-root: root=in_progress, ontology_ingest=done, ontology_assert=in_progress, ontology_project=triage",
    "Production ontology task ontology-root: root=done, ontology_ingest=done, ontology_assert=done, ontology_project=done"
  ]);
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
