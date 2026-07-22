import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { shouldReconcileRecentPullRequest } from "./github-reconciliation.js";

test("known-head reconciliation includes linked, known-commit, and untracked repair pull requests", () => {
  const merged = {
    number: 5,
    merged_at: "2026-07-20T19:22:28Z",
    merge_commit_sha: "a".repeat(40),
    title: "Restore administrator delete access"
  };
  assert.equal(shouldReconcileRecentPullRequest({ ...merged, body: "Fixes #4." }, false), true);
  assert.equal(shouldReconcileRecentPullRequest({ ...merged, body: "References #4." }, false), true);
  assert.equal(
    shouldReconcileRecentPullRequest(
      { ...merged, body: "Align administrator and member handling for destructive actions." },
      false,
      new Set(["a".repeat(40)])
    ),
    true
  );
  assert.equal(
    shouldReconcileRecentPullRequest({ ...merged, body: "Repairs the broken policy without a tracked issue." }, false),
    true
  );
  assert.equal(shouldReconcileRecentPullRequest({ ...merged, body: "Adds a new policy feature." }, false), false);
  assert.equal(shouldReconcileRecentPullRequest({ ...merged, body: "Fixes #4." }, true), false);
  assert.equal(
    shouldReconcileRecentPullRequest({ ...merged, body: "Fixes #4." }, true, new Set(["a".repeat(40)])),
    false
  );
  assert.equal(shouldReconcileRecentPullRequest({ ...merged, body: "Fixes #4.", merged_at: null }, false), false);
});

test("worker reviews pull requests and incrementally ingests context graph source blobs", async (context) => {
  let claimCount = 0;
  let renewals = 0;
  let projectionDrains = 0;
  let ingestedPullRequestNumbers: number[] = [];
  const completions: Record<string, unknown>[] = [];
  let resolveCompletion!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      assert.equal(request.headers["x-jina-tenant-id"], undefined);
      const topics = (body as { topics?: unknown }).topics;
      assert.deepEqual(topics, ["run-review", "run-context-graph-ingest"]);
      claimCount += 1;
      if (claimCount === 2) {
        json(response, 200, {
          message: {
            id: "message-2",
            topic: "run-context-graph-ingest",
            leaseId: "lease-2",
            leaseExpiresAt: new Date(Date.now() + 300_000).toISOString()
          },
          task: {
            id: "task-2",
            metadata: { tenantId: "omlabs", repository: "omlabs/example", ref: "main", pipelinePhase: "snapshot" }
          }
        });
        return;
      }
      if (claimCount > 2) {
        json(response, 204, {});
        return;
      }
      json(response, 200, {
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
      return;
    }
    if (request.url === "/internal/worker/renew") {
      assert.equal(request.headers["x-jina-tenant-id"], "omlabs");
      renewals += 1;
      json(response, 200, { accepted: true });
      return;
    }
    if (request.url === "/internal/worker/complete") {
      assert.equal(request.headers["x-jina-tenant-id"], "omlabs");
      completions.push(body as Record<string, unknown>);
      if (completions.length === 2) resolveCompletion();
      json(response, 200, { accepted: true });
      return;
    }
    if (request.url === "/internal/context-graph/ingest/plan") {
      assert.equal(request.headers["x-jina-tenant-id"], "omlabs");
      const snapshot = (body as { snapshot: { commitSha: string; files: unknown[] } }).snapshot;
      assert.equal(snapshot.commitSha, "a".repeat(40));
      assert.equal(snapshot.files.length, 1);
      json(response, 200, {
        observationId: "observation-1",
        commitSha: "a".repeat(40),
        fileCount: 1,
        discoveredBlobCount: 1,
        reusedBlobCount: 0,
        changedPaths: ["src/index.test.ts"],
        changes: [{ path: "src/index.test.ts", change: "add", newBlobSha: "c".repeat(40) }],
        missingBlobs: [{ blobSha: "c".repeat(40), path: "src/index.test.ts", size: 42 }]
      });
      return;
    }
    if (request.url === "/internal/context-graph/ingest/known") {
      json(response, 200, { knownCommitShas: ["a".repeat(40)] });
      return;
    }
    if (request.url === "/internal/context-graph/outbox/drain") {
      assert.equal(request.headers["x-jina-tenant-id"], undefined);
      projectionDrains += 1;
      json(response, 200, { processedEventCount: 0, rebuiltRepositories: [] });
      return;
    }
    if (request.url === "/internal/context-graph/ingest/blobs") {
      const analyses = (body as { analyses: { symbols: unknown[] }[] }).analyses;
      assert.equal(analyses.length, 1);
      assert.equal(analyses[0]?.symbols.length, 1);
      json(response, 200, { accepted: true, count: 1 });
      return;
    }
    if (request.url === "/internal/context-graph/ingest/github") {
      const observations = (body as { observations: { kind: string; number?: number }[] }).observations;
      ingestedPullRequestNumbers = observations.flatMap((observation) =>
        observation.kind === "pull_request" && observation.number ? [observation.number] : []
      );
      json(response, 200, {
        observationCount: observations.length,
        observationIds: ["observation-pr-11"],
        assertionCount: 0,
        newObservationCount: observations.length,
        updatedObservationCount: 0,
        confirmedObservationCount: 0
      });
      return;
    }
    if (request.url === "/github/repos/omlabs/example/commits/main") {
      json(response, 200, {
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
        parents: []
      });
      return;
    }
    if (request.url === "/github/repos/omlabs/example") {
      json(response, 200, { default_branch: "main" });
      return;
    }
    if (request.url === `/github/repos/omlabs/example/commits?sha=${"a".repeat(40)}&per_page=50`) {
      json(response, 200, [{ sha: "a".repeat(40) }]);
      return;
    }
    if (request.url === `/github/repos/omlabs/example/commits/${"a".repeat(40)}/pulls`) {
      json(response, 200, []);
      return;
    }
    if (request.url === "/github/repos/omlabs/example/pulls?state=closed&sort=updated&direction=desc&per_page=100") {
      json(response, 200, [
        {
          number: 11,
          title: "Restore the broken export order",
          body: "Fixes the regression without a tracked issue.",
          state: "closed",
          html_url: "https://github.com/omlabs/example/pull/11",
          merged_at: "2026-07-21T00:00:00Z",
          updated_at: "2026-07-21T00:00:00Z",
          merge_commit_sha: "d".repeat(40),
          user: { login: "reviewer" }
        }
      ]);
      return;
    }
    if (request.url === `/github/repos/omlabs/example/compare/${"d".repeat(40)}...${"a".repeat(40)}`) {
      json(response, 200, { status: "ahead" });
      return;
    }
    if (request.url === "/github/repos/omlabs/example/pulls/11/commits?per_page=100&page=1") {
      json(response, 200, [{ sha: "d".repeat(40) }]);
      return;
    }
    if (request.url === "/github/repos/omlabs/example/pulls/11/files?per_page=100&page=1") {
      json(response, 200, [{ filename: "src/index.test.ts" }]);
      return;
    }
    if (request.url === `/github/repos/omlabs/example/git/trees/${"b".repeat(40)}?recursive=1`) {
      json(response, 200, {
        truncated: false,
        tree: [{ type: "blob", path: "src/index.test.ts", sha: "c".repeat(40), size: 42 }]
      });
      return;
    }
    if (request.url === `/github/repos/omlabs/example/git/blobs/${"c".repeat(40)}`) {
      json(response, 200, {
        encoding: "base64",
        content: Buffer.from("export function main() { return true; }\n").toString("base64")
      });
      return;
    }
    if (request.url === "/github/repos/omlabs/example/deployments?per_page=100") {
      json(response, 200, []);
      return;
    }
    if (request.url === "/github/repos/omlabs/example/actions/runs?status=completed&per_page=100") {
      json(response, 200, { workflow_runs: [] });
      return;
    }
    if (request.url === "/github/repos/omlabs/example/issues?state=all&labels=incident&per_page=100") {
      json(response, 200, []);
      return;
    }
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
      json(response, 200, {
        output_text: JSON.stringify({ summary: "Looks safe.", findings: [] })
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        mock.close((error) => {
          if (error) reject(error);
          else resolve();
        })
      )
  );
  const address = mock.address() as AddressInfo;
  const mockUrl = `http://127.0.0.1:${address.port}`;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: "0",
      JINA_API_URL: mockUrl,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-review|run-context-graph-ingest",
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
  worker.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  context.after(() => worker.kill("SIGTERM"));

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`worker timed out: ${stderr}`));
        }, 5_000);
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
  assert.equal(ingestionResult.ingestedCommitCount, 1);
  assert.equal(ingestionResult.newCommitCount, 1);
  assert.equal(ingestionResult.confirmedCommitCount, 0);
  assert.equal(ingestionResult.parsedBlobCount, 1);
  assert.equal(ingestionResult.reusedBlobCount, 0);
  assert.deepEqual(ingestionResult.sourcePullRequestNumbers, []);
  assert.deepEqual(ingestionResult.problemEvidencePullRequestNumbers, []);
  assert.deepEqual(ingestedPullRequestNumbers, []);
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
            message: {
              id: "message",
              topic: "run-review",
              leaseId: "lease",
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
            },
            task: { id: "task", metadata: { tenantId: "omlabs", repository: "omlabs/example" } }
          })
        : json(response, 204, {});
    }
    if (request.url === "/internal/worker/complete") completions += 1;
    return json(response, 200, {});
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve, reject) => mock.close((error) => (error ? reject(error) : resolve())))
  );
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
  const diagnostic = new Promise<void>((resolve) => {
    resolveDiagnostic = resolve;
  });
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
        diagnosticTimeout = setTimeout(() => reject(new Error(`worker diagnostic timed out: ${stderr}`)), 5_000);
      })
    ]);
  } finally {
    if (diagnosticTimeout) clearTimeout(diagnosticTimeout);
  }
  assert.match(stderr, /task pullRequestNumber is required/);
  assert.equal(completions, 0);
});

test("context graph worker configuration preserves the explicit staged topics", async (context) => {
  let resolveClaim!: (topics: unknown) => void;
  const claimed = new Promise<unknown>((resolve) => {
    resolveClaim = resolve;
  });
  const mock = createServer(async (request, response) => {
    const body = (await readJson(request)) as { topics?: unknown };
    if (request.url === "/internal/worker/claim") {
      resolveClaim(body.topics);
      return json(response, 204, {});
    }
    if (request.url === "/internal/context-graph/outbox/drain") return json(response, 200, { processedEventCount: 0 });
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address() as AddressInfo;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: "0",
      JINA_API_URL: `http://127.0.0.1:${address.port}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-graph-ingest|run-context-graph-assert|run-context-graph-project",
      WORKER_POLL_INTERVAL_MS: "10"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await stopWorker(worker);
    const closed = new Promise<void>((resolve, reject) => mock.close((error) => (error ? reject(error) : resolve())));
    mock.closeAllConnections();
    await closed;
  });

  assert.deepEqual(await claimed, [
    "run-context-graph-ingest",
    "run-context-graph-assert",
    "run-context-graph-project"
  ]);
});

test("worker aborts active work and never completes after lease renewal is rejected", async (context) => {
  let claims = 0;
  let completions = 0;
  const mock = createServer(async (request, response) => {
    await readJson(request);
    if (request.url === "/internal/worker/claim") {
      claims += 1;
      return claims === 1
        ? json(response, 200, {
            message: {
              id: "message",
              topic: "run-review",
              leaseId: "lease",
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
            },
            task: { id: "task", metadata: { tenantId: "omlabs", repository: "omlabs/example", pullRequestNumber: 2 } }
          })
        : json(response, 204, {});
    }
    if (request.url === "/internal/worker/renew") return json(response, 409, { code: "stale_lease" });
    if (request.url === "/internal/worker/complete") {
      completions += 1;
      return json(response, 200, { accepted: true });
    }
    if (request.url === "/github/repos/omlabs/example/pulls/2") {
      if (request.headers.accept?.includes("diff")) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("diff --git a/a.ts b/a.ts\n+const value = 1;\n");
      } else json(response, 200, { title: "Test change" });
      return;
    }
    if (request.url === "/openai/responses") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return json(response, 200, { output_text: JSON.stringify({ summary: "Too late", findings: [] }) });
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address() as AddressInfo;
  const workerPort = await availablePort();
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${address.port}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-review",
      WORKER_HEARTBEAT_INTERVAL_MS: "10",
      WORKER_POLL_INTERVAL_MS: "10",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}/github`,
      OPENAI_API_URL: `http://127.0.0.1:${address.port}/openai`,
      OPENAI_API_KEY: "test-openai-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await stopWorker(worker);
    const closed = new Promise<void>((resolve, reject) => mock.close((error) => (error ? reject(error) : resolve())));
    mock.closeAllConnections();
    await closed;
  });

  const health = await waitForHealth(workerPort, (payload) => payload.lastWork?.outcome === "lease_lost");
  assert.equal(health.payload.lastWork?.outcome, "lease_lost");
  assert.equal(completions, 0);
});

test("worker health remains degraded when context graph outbox draining fails", async (context) => {
  const mock = createServer(async (request, response) => {
    await readJson(request);
    if (request.url === "/internal/worker/claim") return json(response, 204, {});
    if (request.url === "/internal/context-graph/outbox/drain")
      return json(response, 500, { error: "drain unavailable" });
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address() as AddressInfo;
  const workerPort = await availablePort();
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${address.port}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-graph-project",
      WORKER_POLL_INTERVAL_MS: "10"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await stopWorker(worker);
    const closed = new Promise<void>((resolve, reject) => mock.close((error) => (error ? reject(error) : resolve())));
    mock.closeAllConnections();
    await closed;
  });

  const health = await waitForHealth(workerPort, (payload) => typeof payload.lastApiError === "string");
  assert.equal(health.status, 503);
  assert.equal(health.payload.ok, false);
  assert.match(String(health.payload.lastApiError), /context-graph.*outbox\/drain failed with 500/i);
  assert.equal(Number(health.payload.consecutiveApiFailures) > 0, true);
});

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(status === 204 ? undefined : JSON.stringify(payload));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(
  port: number,
  predicate: (payload: WorkerHealth) => boolean
): Promise<{ readonly status: number; readonly payload: WorkerHealth }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const payload = (await response.json()) as WorkerHealth;
      if (predicate(payload)) return { status: response.status, payload };
    } catch {
      // The worker may not have bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("worker health did not reach the expected state");
}

interface WorkerHealth extends Record<string, unknown> {
  readonly lastWork?: { readonly outcome?: unknown };
}

async function stopWorker(worker: ReturnType<typeof spawn>): Promise<void> {
  if (worker.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  worker.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }, 1_000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
