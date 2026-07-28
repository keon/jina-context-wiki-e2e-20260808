import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

test("context operation timeout still allows delayed terminal completion", async (context) => {
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
          topic: "run-index-context",
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
            checkpointId: "ec_completion_timeout",
            commitSha: "a".repeat(40)
          }
        }
      });
      return;
    }
    if (request.url === "/internal/context/index") {
      await delay(80);
      json(response, 200, { effect: "changed", generationId: "ig_too_late" });
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
      WORKER_TOPICS: "run-index-context",
      WORKER_POLL_INTERVAL_MS: "10",
      WORKER_API_TIMEOUT_MS: "40",
      CONTEXT_API_TIMEOUT_MS: "40",
      CONTEXT_COMPLETION_TIMEOUT_MS: "400",
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

  const health = await waitForHealth(workerPort, (value) => recordOrUndefined(value.lastWork)?.outcome === "failed");
  assert.equal(completion?.outcome, "failed");
  assert.match(String(completion?.reason), /timed out|aborted|timeout/i);
  assert.equal(recordOrUndefined(health.lastWork)?.outcome, "failed", output);
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
