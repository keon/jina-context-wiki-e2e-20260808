import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

test("worker reviews a pull request, renews its lease, and completes it", async (context) => {
  let claimed = false;
  let renewals = 0;
  let completion: Record<string, unknown> | undefined;
  let resolveCompletion!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompletion = resolve; });

  const mock = createServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === "/internal/worker/claim") {
      const topics = (body as { topics?: unknown }).topics;
      assert.deepEqual(topics, ["run-review"]);
      if (claimed) return json(response, 204, {});
      claimed = true;
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
      completion = body as Record<string, unknown>;
      resolveCompletion();
      return json(response, 200, { accepted: true });
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
      WORKER_TOPICS: "run-review",
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
  assert.equal(completion?.outcome, "done");
  assert.equal(completion?.leaseId, "lease-1");
  const result = completion?.result as Record<string, unknown>;
  assert.equal(result.summary, "Looks safe.");
  assert.equal(result.findingCount, 0);
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
