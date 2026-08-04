import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

test("paused drain workers stay healthy without issuing Board claims", async (context) => {
  let claimCount = 0;
  const mock = createServer(async (request, response) => {
    if (request.url === "/internal/worker/claim") claimCount += 1;
    await readJson(request);
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      JINA_WORKER_CLAIM_MODE: "paused",
      WORKER_POLL_INTERVAL_MS: "20"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  const health = await waitForHealth(workerPort, (value) => value.ok === true);
  assert.equal(health.claimMode, "paused");
  assert.equal(health.active, false);
  assert.equal(health.lastApiSuccessAt, undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(claimCount, 0);
});

test("Context quota claim backpressure remains healthy and poll-cadenced", async (context) => {
  const claimTimes: number[] = [];
  const privateDetail = "private-tenant-detail-must-not-be-logged";
  const mock = createServer(async (request, response) => {
    await readJson(request);
    if (request.url === "/internal/worker/claim") {
      claimTimes.push(Date.now());
      json(response, 429, {
        code: "context_quota_exceeded",
        message: privateDetail
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "40",
      WORKER_API_TIMEOUT_MS: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });
  let output = "";
  worker.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  worker.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  const health = await waitForHealth(workerPort, (value) => metricCounter(value, "worker.claim_backpressure") >= 3);
  assert.equal(health.ok, true);
  assert.equal(health.consecutiveApiFailures, 0);
  assert.equal(health.lastApiErrorAt, undefined);
  assert.equal(metricCounter(health, "worker.poll_failures"), 0);
  assert.ok(claimTimes.length >= 3);
  assert.ok(
    claimTimes.slice(1).every((time, index) => time - claimTimes[index]! >= 20),
    `claim requests bypassed the configured poll cadence: ${JSON.stringify(claimTimes)}`
  );
  assert.equal((output.match(/"event":"worker\.claim_backpressure"/g) ?? []).length, 1, output);
  assert.doesNotMatch(output, new RegExp(privateDetail));
});

test("claim errors other than Context quota backpressure remain health failures", async (context) => {
  const mock = createServer(async (request, response) => {
    await readJson(request);
    if (request.url === "/internal/worker/claim") {
      json(response, 429, { code: "other_rate_limit", message: "ordinary failure" });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "40",
      WORKER_API_TIMEOUT_MS: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  const health = await waitForHealth(workerPort, (value) => metricCounter(value, "worker.poll_failures") >= 1);
  assert.equal(health.ok, false);
  assert.equal(health.lastApiSuccessAt, undefined);
  assert.ok(Number(health.consecutiveApiFailures) >= 1);
  assert.equal(metricCounter(health, "worker.claim_backpressure"), 0);
});

test("a failed Context completion releases exactly its own lease", async (context) => {
  const taskIds = ["cs_completion_success", "cs_completion_failure"] as const;
  let claimIndex = 0;
  const completionTaskIds: string[] = [];
  const releases: Record<string, unknown>[] = [];
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      const taskId = taskIds[claimIndex];
      if (!taskId) {
        response.writeHead(204);
        response.end();
        return;
      }
      claimIndex += 1;
      json(response, 200, publicationWork(taskId));
      return;
    }
    if (request.url === "/internal/context/board/publish") {
      json(response, 200, {
        version: 1,
        outputArtifact: artifact("context-release"),
        releaseId: "cr_0123456789abcdef0123456789abcdef"
      });
      return;
    }
    if (request.url === "/internal/worker/complete") {
      const taskId = String(body.taskId);
      completionTaskIds.push(taskId);
      if (taskId === taskIds[0]) {
        json(response, 200, { accepted: true });
      } else {
        json(response, 500, { code: "completion_store_unavailable" });
      }
      return;
    }
    if (request.url === "/internal/worker/release") {
      releases.push(body);
      json(response, 409, { accepted: false, code: "lease_already_released" });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "20",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_API_TIMEOUT_MS: "2000",
      CONTEXT_COMPLETION_TIMEOUT_MS: "2000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  await waitForCondition(() => releases.length === 1 && completionTaskIds.length === 2);
  await delay(100);
  assert.deepEqual(completionTaskIds, [...taskIds]);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.taskId, taskIds[1]);
  assert.equal(releases[0]?.messageId, taskIds[1]);
  assert.match(String(releases[0]?.reason), /completion failed with 500/);
});

test("a stale completion fence is an expected lease loss and does not poison worker health", async (context) => {
  let claimed = false;
  let completionCount = 0;
  const releases: Record<string, unknown>[] = [];
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      if (claimed) {
        response.writeHead(204);
        response.end();
        return;
      }
      claimed = true;
      json(response, 200, publicationWork("cs_stale_completion"));
      return;
    }
    if (request.url === "/internal/context/board/publish") {
      json(response, 200, {
        version: 1,
        outputArtifact: artifact("context-release"),
        releaseId: "cr_0123456789abcdef0123456789abcdef"
      });
      return;
    }
    if (request.url === "/internal/worker/complete") {
      completionCount += 1;
      json(response, 409, { accepted: false, code: "stale_lease" });
      return;
    }
    if (request.url === "/internal/worker/release") {
      releases.push(body);
      json(response, 409, { accepted: false, code: "stale_lease" });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "20",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_API_TIMEOUT_MS: "2000",
      CONTEXT_COMPLETION_TIMEOUT_MS: "2000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  const health = await waitForHealth(
    workerPort,
    (value) => recordOrUndefined(value.lastWork)?.outcome === "lease_lost"
  );
  assert.equal(health.ok, true);
  assert.equal(health.consecutiveApiFailures, 0);
  assert.equal(metricCounter(health, "worker.poll_failures"), 0);
  assert.equal(completionCount, 1);
  assert.deepEqual(releases, []);
});

test("Board context API timeout requests a bounded retry with diagnostics", async (context) => {
  let completion: Record<string, unknown> | undefined;
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      // Redeliver until the work is actually completed, rather than counting
      // attempts. The worker claims with a 40ms timeout, so on a loaded machine
      // its first claim can time out after this server has already answered —
      // and counting attempts would then retire the message the worker never
      // received, leaving it idle until the test's own deadline. A real queue
      // redelivers an unacknowledged lease; so does this one.
      if (completion) {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 200, {
        message: {
          id: "cs_completion_timeout",
          topic: "run-context-publication",
          leaseId: "lease_completion_timeout",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: 1,
          writeFenceToken: "fence_completion_timeout"
        },
        task: {
          id: "cs_completion_timeout",
          metadata: {
            tenantId: "tenant-completion-timeout",
            repository: "acme/large-repository",
            ref: "main",
            refSequence: 1,
            commitSha: "a".repeat(40),
            contextBuildId: "cb_completion_timeout",
            planArtifact: artifact("publication-plan"),
            dependencyResults: [
              {
                taskId: "certification",
                taskType: "certify-context-release",
                result: { version: 1, outputArtifact: artifact("certification") }
              }
            ]
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts/read") {
      // Intentionally leave the response open. A delayed response can become
      // observable before the client's shorter abort timer when the full test
      // suite starves the worker process, making this timeout test flaky.
      return;
    }
    if (request.url === "/internal/worker/complete") {
      completion = body;
      await delay(120);
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "40",
      CONTEXT_API_TIMEOUT_MS: "40",
      CONTEXT_COMPLETION_TIMEOUT_MS: "2000",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });
  let output = "";
  worker.stdout?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-4_000);
  });
  worker.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-4_000);
  });

  const health = await waitForHealth(workerPort, (value) => recordOrUndefined(value.lastWork)?.outcome === "retry");
  assert.equal(completion?.outcome, "retry");
  assert.match(String(completion?.reason), /timed out|aborted|timeout/i);
  assert.equal(completion?.failureCategory, "api_transport");
  assert.equal(recordOrUndefined(health.lastWork)?.outcome, "retry", output);
  assert.equal(recordOrUndefined(health.lastWork)?.failureCategory, "api_transport");
});

test("a worker voluntarily releases a Context lease after renewal rejects it", async (context) => {
  let release: Record<string, unknown> | undefined;
  let claimed = false;
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      if (claimed) {
        response.writeHead(204);
        response.end();
        return;
      }
      claimed = true;
      json(response, 200, {
        message: {
          id: "cs_lease_loss",
          topic: "run-context-publication",
          leaseId: "lease_loss",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: 1,
          writeFenceToken: "fence_lease_loss"
        },
        task: {
          id: "cs_lease_loss",
          metadata: {
            tenantId: "tenant-lease-loss",
            repository: "acme/large-repository",
            ref: "main",
            refSequence: 1,
            commitSha: "a".repeat(40),
            contextBuildId: "cb_lease_loss",
            planArtifact: artifact("publication-plan"),
            dependencyResults: [
              {
                taskId: "certification",
                taskType: "certify-context-release",
                result: { version: 1, outputArtifact: artifact("certification") }
              }
            ]
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/board/artifacts/read") {
      await delay(1_000);
      json(response, 200, {
        version: 1,
        outputArtifact: artifact("context-release"),
        releaseId: "cr_0123456789abcdef0123456789abcdef"
      });
      return;
    }
    if (request.url === "/internal/worker/renew") {
      json(response, 409, { accepted: false, code: "context_quota_invariant" });
      return;
    }
    if (request.url === "/internal/worker/release") {
      release = body;
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_HEARTBEAT_INTERVAL_MS: "20",
      CONTEXT_API_TIMEOUT_MS: "2000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  await waitForHealth(workerPort, (value) => recordOrUndefined(value.lastWork)?.outcome === "lease_lost");
  assert.equal(release?.messageId, "cs_lease_loss");
  assert.equal(release?.taskId, "cs_lease_loss");
  assert.equal(release?.leaseId, "lease_loss");
  assert.equal(release?.writeFenceToken, "fence_lease_loss");
  assert.match(String(release?.reason), /renewal failed with 409/);
});

test("SIGTERM keeps the worker alive until its fenced Context lease release settles", async (context) => {
  let claimed = false;
  const releases: Record<string, unknown>[] = [];
  let settleRelease: (() => void) | undefined;
  let releaseReceived: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    releaseReceived = resolve;
  });
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      if (claimed) {
        response.writeHead(204);
        response.end();
        return;
      }
      claimed = true;
      json(response, 200, publicationWork("cs_shutdown_release"));
      return;
    }
    if (request.url === "/internal/context/board/artifacts/read") {
      // Keep the leased operation active until SIGTERM aborts its request.
      return;
    }
    if (request.url === "/internal/worker/release") {
      releases.push(body);
      releaseReceived?.();
      await new Promise<void>((resolve) => {
        settleRelease = resolve;
      });
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_API_TIMEOUT_MS: "2000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    settleRelease?.();
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  await waitForHealth(workerPort, (value) => value.active === true);
  assert.equal(worker.kill("SIGTERM"), true);
  await Promise.race([
    received,
    delay(2_000).then(() => {
      throw new Error("worker did not request its fenced lease release after SIGTERM");
    })
  ]);

  const duringRelease = await fetch(`http://127.0.0.1:${workerPort}/health`);
  assert.equal(duringRelease.status, 503);
  assert.equal(worker.exitCode, null);
  assert.equal(worker.signalCode, null);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.taskId, "cs_shutdown_release");
  assert.equal(releases[0]?.leaseId, "lease_cs_shutdown_release");
  assert.equal(releases[0]?.writeFenceToken, "fence_cs_shutdown_release");
  assert.equal(releases[0]?.reason, "worker shutdown");

  settleRelease?.();
  await waitForExit(worker);
  await delay(50);
  assert.equal(releases.length, 1);
});

test("SIGTERM drains a delayed successful claim without executing it and releases its fence exactly once", async (context) => {
  const releases: Record<string, unknown>[] = [];
  let executionRequests = 0;
  let allowClaimResponse: (() => void) | undefined;
  let claimReceived: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    claimReceived = resolve;
  });
  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      claimReceived?.();
      await new Promise<void>((resolve) => {
        allowClaimResponse = resolve;
      });
      json(response, 200, publicationWork("cs_shutdown_delayed_claim"));
      return;
    }
    if (request.url === "/internal/context/board/publish") {
      executionRequests += 1;
      json(response, 500, { code: "must_not_execute_after_shutdown" });
      return;
    }
    if (request.url === "/internal/worker/release") {
      releases.push(body);
      json(response, 200, { accepted: true });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));

  const workerPort = await availablePort();
  const mockPort = (mock.address() as AddressInfo).port;
  const worker = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(workerPort),
      JINA_API_URL: `http://127.0.0.1:${mockPort}`,
      INTERNAL_API_TOKEN: "test-token",
      WORKER_TOPICS: "run-context-publication",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "2000",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      CONTEXT_API_TIMEOUT_MS: "2000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(async () => {
    allowClaimResponse?.();
    await terminate(worker);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  await Promise.race([
    received,
    delay(2_000).then(() => {
      throw new Error("worker did not begin its claim request");
    })
  ]);
  assert.equal(worker.kill("SIGTERM"), true);
  await delay(50);
  assert.equal(worker.exitCode, null);
  assert.equal(worker.signalCode, null);

  allowClaimResponse?.();
  await waitForExit(worker);
  await delay(50);

  assert.equal(executionRequests, 0);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.messageId, "cs_shutdown_delayed_claim");
  assert.equal(releases[0]?.taskId, "cs_shutdown_delayed_claim");
  assert.equal(releases[0]?.leaseId, "lease_cs_shutdown_delayed_claim");
  assert.equal(releases[0]?.attempt, 1);
  assert.equal(releases[0]?.writeFenceToken, "fence_cs_shutdown_delayed_claim");
  assert.equal(releases[0]?.reason, "worker shutdown");
});

async function waitForHealth(
  port: number,
  predicate: (value: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      last = (await response.json()) as Record<string, unknown>;
      if (predicate(last)) return last;
    } catch {
      // The worker may not have bound its port yet.
    }
    await delay(20);
  }
  throw new Error(`worker health did not reach the expected terminal state: ${JSON.stringify(last)}`);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("condition did not become true before the deadline");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => {
      throw new Error("worker did not exit after its lease release settled");
    })
  ]);
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  request.setEncoding("utf8");
  let raw = "";
  for await (const chunk of request as AsyncIterable<string>) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function metricCounter(health: Record<string, unknown>, name: string): number {
  const metrics = recordOrUndefined(health.metrics);
  const counterValues: unknown = metrics?.counters;
  const counters: unknown[] = Array.isArray(counterValues) ? (counterValues as unknown[]) : [];
  const counter = counters.find((value) => recordOrUndefined(value)?.name === name);
  return Number(recordOrUndefined(counter)?.value ?? 0);
}

function publicationWork(taskId: string): Record<string, unknown> {
  return {
    message: {
      id: taskId,
      topic: "run-context-publication",
      leaseId: `lease_${taskId}`,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1,
      writeFenceToken: `fence_${taskId}`
    },
    task: {
      id: taskId,
      metadata: {
        tenantId: "tenant-completion-release",
        repository: "acme/large-repository",
        ref: "main",
        refSequence: 1,
        commitSha: "a".repeat(40),
        contextBuildId: `cb_${taskId}`,
        planArtifact: artifact("publication-plan"),
        dependencyResults: [
          {
            taskId: `certification_${taskId}`,
            taskType: "certify-context-release",
            result: { version: 1, outputArtifact: artifact("certification") }
          }
        ]
      }
    }
  };
}

function artifact(kind: string): Record<string, unknown> {
  return {
    uri: `gs://context-artifacts/${kind}.json`,
    key: `context/tenants/tenant-completion-timeout/repositories/acme/large-repository/builds/cb_completion_timeout/${kind}.json`,
    contentType: "application/json",
    bytes: 123,
    sha256: "b".repeat(64),
    objectGeneration: "1"
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
