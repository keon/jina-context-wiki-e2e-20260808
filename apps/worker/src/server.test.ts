import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

test("worker reviews pull requests and incrementally ingests ontology source blobs", async (context) => {
  let claimCount = 0;
  let renewals = 0;
  let projectionDrains = 0;
  let ingestedPullRequestNumbers: number[] = [];
  const completions: Record<string, unknown>[] = [];
  let resolveCompletion!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompletion = resolve; });

  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      const topics = (body as { topics?: unknown }).topics;
      assert.deepEqual(topics, ["run-review", "run-ontology-ingest"]);
      claimCount += 1;
      if (claimCount === 2) {
        return json(response, 200, {
          message: {
            id: "message-2",
            topic: "run-ontology-ingest",
            leaseId: "lease-2",
            leaseExpiresAt: new Date(Date.now() + 300_000).toISOString()
          },
          task: {
            id: "task-2",
            metadata: { tenantId: "omlabs", repository: "omlabs/example", ref: "main" }
          }
        });
      }
      if (claimCount > 2) return json(response, 204, {});
      return json(response, 200, {
        message: {
          id: "message-1",
          topic: "run-review",
          leaseId: "lease-1",
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString()
        },
        task: {
          id: "task-1",
          metadata: { tenantId: "omlabs", repository: "omlabs/example", pullRequestNumber: 2 }
        }
      });
    }
    if (request.url === "/internal/worker/renew") {
      renewals += 1;
      return json(response, 200, { accepted: true });
    }
    if (request.url === "/internal/worker/complete") {
      completions.push(body as Record<string, unknown>);
      if (completions.length === 2) resolveCompletion();
      return json(response, 200, { accepted: true });
    }
    if (request.url === "/internal/ontology/ingest/plan") {
      const snapshot = (body as { snapshot: { commitSha: string; files: unknown[] } }).snapshot;
      assert.equal(snapshot.commitSha, "a".repeat(40));
      assert.equal(snapshot.files.length, 1);
      return json(response, 200, {
        observationId: "observation-1",
        commitSha: "a".repeat(40),
        fileCount: 1,
        discoveredBlobCount: 1,
        reusedBlobCount: 0,
        changedPaths: ["src/index.test.ts"],
        changes: [{ path: "src/index.test.ts", change: "add", newBlobSha: "c".repeat(40) }],
        missingBlobs: [{ blobSha: "c".repeat(40), path: "src/index.test.ts", size: 42 }]
      });
    }
    if (request.url === "/internal/ontology/ingest/known") {
      return json(response, 200, { knownCommitShas: ["a".repeat(40)] });
    }
    if (request.url === "/internal/ontology/outbox/drain") {
      projectionDrains += 1;
      return json(response, 200, { processedEventCount: 0, rebuiltRepositories: [] });
    }
    if (request.url === "/internal/ontology/ingest/blobs") {
      const analyses = (body as { analyses: Array<{ symbols: unknown[] }> }).analyses;
      assert.equal(analyses.length, 1);
      assert.equal(analyses[0]?.symbols.length, 1);
      return json(response, 200, { accepted: true, count: 1 });
    }
    if (request.url === "/internal/ontology/ingest/github") {
      const observations = (body as { observations: Array<{ kind: string; number?: number }> }).observations;
      ingestedPullRequestNumbers = observations.flatMap((observation) =>
        observation.kind === "pull_request" && observation.number ? [observation.number] : []
      );
      return json(response, 200, {
        observationCount: observations.length,
        observationIds: ["observation-pr-11"],
        assertionCount: 0,
        newObservationCount: observations.length,
        updatedObservationCount: 0,
        confirmedObservationCount: 0
      });
    }
    if (request.url === "/github/repos/omlabs/example/commits/main") {
      return json(response, 200, {
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
        parents: []
      });
    }
    if (request.url === "/github/repos/omlabs/example") {
      return json(response, 200, { default_branch: "main" });
    }
    if (request.url === `/github/repos/omlabs/example/commits?sha=${"a".repeat(40)}&per_page=50`) {
      return json(response, 200, [{ sha: "a".repeat(40) }]);
    }
    if (request.url === `/github/repos/omlabs/example/commits/${"a".repeat(40)}/pulls`) {
      return json(response, 200, []);
    }
    if (request.url === "/github/repos/omlabs/example/pulls?state=closed&sort=updated&direction=desc&per_page=100") {
      return json(response, 200, [{
        number: 11,
        title: "Restore the broken export order",
        body: "Fixes the regression without a tracked issue.",
        state: "closed",
        html_url: "https://github.com/omlabs/example/pull/11",
        merged_at: "2026-07-21T00:00:00Z",
        updated_at: "2026-07-21T00:00:00Z",
        merge_commit_sha: "d".repeat(40),
        user: { login: "reviewer" }
      }]);
    }
    if (request.url === `/github/repos/omlabs/example/compare/${"d".repeat(40)}...${"a".repeat(40)}`) {
      return json(response, 200, { status: "ahead" });
    }
    if (request.url === "/github/repos/omlabs/example/pulls/11/commits?per_page=100&page=1") {
      return json(response, 200, [{ sha: "d".repeat(40) }]);
    }
    if (request.url === "/github/repos/omlabs/example/pulls/11/files?per_page=100&page=1") {
      return json(response, 200, [{ filename: "src/index.test.ts" }]);
    }
    if (request.url === `/github/repos/omlabs/example/git/trees/${"b".repeat(40)}?recursive=1`) {
      return json(response, 200, {
        truncated: false,
        tree: [{ type: "blob", path: "src/index.test.ts", sha: "c".repeat(40), size: 42 }]
      });
    }
    if (request.url === `/github/repos/omlabs/example/git/blobs/${"c".repeat(40)}`) {
      return json(response, 200, {
        encoding: "base64",
        content: Buffer.from("export function main() { return true; }\n").toString("base64")
      });
    }
    if (request.url === "/github/repos/omlabs/example/deployments?per_page=100") return json(response, 200, []);
    if (request.url === "/github/repos/omlabs/example/actions/runs?status=completed&per_page=100") return json(response, 200, { workflow_runs: [] });
    if (request.url === "/github/repos/omlabs/example/issues?state=all&labels=incident&per_page=100") return json(response, 200, []);
    if (request.url === "/github/repos/omlabs/example/pulls/2") {
      if (request.headers.accept?.includes("diff")) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("diff --git a/a.ts b/a.ts\n+const value = 1;\n");
      } else {
        json(response, 200, { title: "Test change" });
      }
      return;
    }
    if (request.url === "/openai/responses") {
      assert.equal((body as { model?: unknown }).model, "gpt-5.6-sol");
      await new Promise((resolve) => setTimeout(resolve, 80));
      return json(response, 200, { output_text: JSON.stringify({ summary: "Looks safe.", findings: [] }) });
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve())));
  const address = mock.address() as AddressInfo;
  const mockUrl = `http://127.0.0.1:${address.port}`;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: "0",
      JINA_API_URL: mockUrl,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-review|run-ontology-ingest",
      WORKER_HEARTBEAT_INTERVAL_MS: "10",
      WORKER_POLL_INTERVAL_MS: "10",
      GITHUB_API_URL: `${mockUrl}/github`,
      OPENAI_API_URL: `${mockUrl}/openai`,
      OPENAI_API_KEY: "test-openai-key",
      GITHUB_CLONE_TOKEN: "test-github-token"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  worker.stderr.on("data", (chunk) => { stderr += String(chunk); });
  context.after(() => worker.kill("SIGTERM"));

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`worker timed out: ${stderr}`)), 5_000);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  assert.ok(renewals > 0);
  assert.equal(completions[0]?.outcome, "done");
  assert.equal(completions[0]?.leaseId, "lease-1");
  const reviewResult = completions[0]?.result as Record<string, unknown>;
  assert.equal(reviewResult.summary, "Looks safe.");
  assert.equal(reviewResult.findingCount, 0);
  assert.equal(completions[1]?.outcome, "done");
  assert.equal(completions[1]?.leaseId, "lease-2");
  const ingestionResult = completions[1]?.result as Record<string, unknown>;
  assert.equal(ingestionResult.commitSha, "a".repeat(40));
  assert.equal(ingestionResult.effect, "changed");
  assert.equal(ingestionResult.ingestedCommitCount, 0);
  assert.equal(ingestionResult.newCommitCount, 0);
  assert.equal(ingestionResult.confirmedCommitCount, 1);
  assert.equal(ingestionResult.parsedBlobCount, 1);
  assert.equal(ingestionResult.reusedBlobCount, 0);
  assert.deepEqual(ingestionResult.sourcePullRequestNumbers, [11]);
  assert.deepEqual(ingestionResult.problemEvidencePullRequestNumbers, [11]);
  assert.deepEqual(ingestedPullRequestNumbers, [11]);
  assert.equal(projectionDrains > 0, true);
});

test("worker rejects malformed topic metadata before dispatch", async (context) => {
  let claims = 0;
  let completions = 0;
  const mock = createServer(async (request, response) => {
    await readJson(request);
    if (request.url === "/internal/worker/claim") {
      claims += 1;
      return claims === 1
        ? json(response, 200, {
            message: { id: "message", topic: "run-review", leaseId: "lease", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
            task: { id: "task", metadata: { repository: "omlabs/example" } }
          })
        : json(response, 204, {});
    }
    if (request.url === "/internal/worker/complete") completions += 1;
    return json(response, 200, {});
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve())));
  const address = mock.address() as AddressInfo;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: "0",
      JINA_API_URL: `http://127.0.0.1:${address.port}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-review",
      WORKER_POLL_INTERVAL_MS: "10"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let resolveDiagnostic: (() => void) | undefined;
  const diagnostic = new Promise<void>((resolve) => { resolveDiagnostic = resolve; });
  worker.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.includes("task pullRequestNumber is required")) resolveDiagnostic?.();
  });
  context.after(() => worker.kill("SIGTERM"));
  let diagnosticTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      diagnostic,
      new Promise<never>((_, reject) => {
        diagnosticTimeout = setTimeout(
          () => reject(new Error(`worker diagnostic timed out: ${stderr}`)),
          5_000
        );
      })
    ]);
  } finally {
    if (diagnosticTimeout) clearTimeout(diagnosticTimeout);
  }
  assert.match(stderr, /task pullRequestNumber is required/);
  assert.equal(completions, 0);
});

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(status === 204 ? undefined : JSON.stringify(payload));
}
