import assert from "node:assert/strict";
import test from "node:test";
import { ContextTriggerClient } from "./context-trigger-client.js";

test("Context Trigger client dispatches with global idempotency and preview routing", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new ContextTriggerClient({
    apiBaseUrl: "https://api.trigger.dev/",
    secretKey: "tr_test_secret",
    previewBranch: "context-wiki",
    requestTimeoutMs: 1_000,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return Response.json({ id: "run_abc123" });
    }
  });

  const run = await client.dispatch(
    "generate-wiki",
    { requestDigest: "a".repeat(64) },
    {
      idempotencyKey: "wiki:build-1:attempt-1",
      concurrencyKey: "wiki:tenant:repo:ref:en",
      queue: "context-wiki",
      tags: ["build_123"]
    }
  );

  assert.deepEqual(run, { id: "run_abc123" });
  assert.equal(requests[0]?.url, "https://api.trigger.dev/api/v1/tasks/generate-wiki/trigger");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["x-trigger-branch"], "context-wiki");
  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body, {
    payload: { requestDigest: "a".repeat(64) },
    options: {
      idempotencyKey: "wiki:build-1:attempt-1",
      concurrencyKey: "wiki:tenant:repo:ref:en",
      queue: { name: "context-wiki" },
      tags: ["build_123"]
    }
  });
});

test("Context Trigger client rejects an undeclared named queue before dispatch", async () => {
  let requested = false;
  const client = new ContextTriggerClient({
    apiBaseUrl: "https://api.trigger.dev",
    secretKey: "tr_test_secret",
    requestTimeoutMs: 1_000,
    fetch: async () => {
      requested = true;
      return Response.json({ id: "run_unexpected" });
    }
  });

  await assert.rejects(
    () =>
      client.dispatch(
        "generate-wiki",
        {},
        {
          idempotencyKey: "wiki:build-1",
          concurrencyKey: "wiki:tenant:repo:ref:en",
          queue: "undeclared-wiki-queue",
          tags: []
        }
      ),
    /must be context-wiki/
  );
  assert.equal(requested, false);
});

test("Context Trigger client normalizes terminal success and failure", async () => {
  const responses = [
    { id: "run_success", status: "COMPLETED", output: { status: "completed" } },
    { id: "run_failure", status: "FAILED", error: { message: "boom" } }
  ];
  const client = new ContextTriggerClient({
    apiBaseUrl: "https://api.trigger.dev",
    secretKey: "tr_test_secret",
    requestTimeoutMs: 1_000,
    fetch: async () => Response.json(responses.shift())
  });

  assert.deepEqual(await client.retrieve("run_success"), {
    id: "run_success",
    status: "COMPLETED",
    output: { status: "completed" },
    isCompleted: true,
    isSuccess: true,
    isFailed: false
  });
  assert.deepEqual(await client.retrieve("run_failure"), {
    id: "run_failure",
    status: "FAILED",
    error: { message: "boom" },
    isCompleted: true,
    isSuccess: false,
    isFailed: true
  });
});

test("Context Trigger client rejects malformed run identities and bounded API failures", async () => {
  const client = new ContextTriggerClient({
    apiBaseUrl: "https://api.trigger.dev",
    secretKey: "tr_test_secret",
    requestTimeoutMs: 1_000,
    fetch: async () => new Response("not found", { status: 404 })
  });
  await assert.rejects(() => client.retrieve("bad"), /run ID is invalid/);
  await assert.rejects(() => client.retrieve("run_missing"), /returned 404: not found/);
});
