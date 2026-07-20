import assert from "node:assert/strict";
import test from "node:test";
import { runProductionOntologyAcceptance } from "./acceptance.js";

test("production acceptance waits for all chunks and verifies cited canonical output", async () => {
  let boardReads = 0;
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/ontology/build")) return json({ task: { id: "ontology-root" } }, 202);
    if (url.endsWith("/board")) {
      boardReads += 1;
      return json({ tasks: [{ id: "ontology-root", status: boardReads === 1 ? "in_progress" : "done" }] });
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
    pollIntervalMs: 1, timeoutMs: 100, log: () => undefined
  }, fetchImpl);

  assert.deepEqual(result, {
    taskId: "ontology-root", repository: "omxyz/jina-ontology-e2e", commitSha: "a".repeat(40),
    nodeCount: 1, edgeCount: 1, citationCount: 3
  });
  assert.deepEqual(requests, [
    "POST /ontology/build", "GET /board", "GET /board", "GET /ontology", "POST /ontology/ask", "GET /ontology/metrics"
  ]);
});

test("production acceptance fails on a terminal task failure", async () => {
  const fetchImpl: typeof fetch = async (input) => String(input).endsWith("/ontology/build")
    ? json({ task: { id: "ontology-root" } }, 202)
    : json({ tasks: [{ id: "ontology-root", status: "failed" }] });

  await assert.rejects(
    runProductionOntologyAcceptance({
      apiUrl: "https://api.example.test", token: "secret", requestKey: "deploy-2",
      pollIntervalMs: 1, timeoutMs: 100, log: () => undefined
    }, fetchImpl),
    /ended as failed/
  );
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
