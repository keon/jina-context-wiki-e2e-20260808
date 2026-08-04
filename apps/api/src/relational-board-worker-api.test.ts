import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { PostgresRelationalBoardWorkerStore } from "@jina/db";

import { createApiServer, normalizedTenantId } from "./server.js";

const tenantId = "c0f4ff2b-d896-45c1-87f0-06d872daab39";
const taskId = "ed65cb54-42dc-5f85-a455-24ab86c47f08";
const workflowId = "d599444c-5752-52e5-9502-6179269a53bc";
const deliveryId = `outbox_${taskId}_1`;

test("internal worker tenancy accepts only exact reserved control scopes", () => {
  assert.equal(normalizedTenantId("system:billing"), "system:billing");
  assert.equal(normalizedTenantId("system:github-installation:123"), "system:github-installation:123");
  assert.equal(normalizedTenantId("system:github-installation:0"), undefined);
  assert.equal(normalizedTenantId("system:customer:123"), undefined);
  assert.equal(normalizedTenantId("system:billing:other"), undefined);
});

test("worker HTTP protocol delegates versioned review topics to the relational Board", async () => {
  const calls: string[] = [];
  const store: Pick<PostgresRelationalBoardWorkerStore, "claim" | "renew" | "release" | "complete" | "retry" | "fail"> =
    {
      async claim(input) {
        calls.push(
          `claim:${input.topics.join(",")}:${input.tenantId}:${input.workerService}:${input.workerRelease}:${input.workerRevision}`
        );
        return {
          tenantId,
          workflowId,
          workflowType: "pr_review",
          pipelineVersion: "pr_review.board.v1",
          taskId,
          taskType: "prepare-review",
          topic: "prepare-review",
          attempt: 1,
          maxAttempts: 3,
          claim: 1,
          attemptId: "9a530735-291d-47da-8e45-4687a93db20b",
          deliveryId,
          leaseId: "a26f1796-a074-48d2-8740-c608df51c5f0",
          writeFenceToken: "worker-fence-token",
          leaseExpiresAt: "2026-08-04T12:00:00.000Z",
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          metadata: { review_run_id: "52d68f74-8f64-45ee-8fef-9d0e58ae75ab" },
          workflowMetadata: { review_payload: { action: "opened" } },
          dependencyResults: []
        };
      },
      async renew(input) {
        calls.push(`renew:${input.deliveryId}`);
        return { accepted: true, replayed: false, leaseExpiresAt: "2026-08-04T12:30:00.000Z" };
      },
      async release(input) {
        calls.push(`release:${input.deliveryId}`);
        return { accepted: true, replayed: false };
      },
      async complete(input) {
        calls.push(`complete:${input.deliveryId}:${input.resultDigest}`);
        return { accepted: true, replayed: false, terminal: true };
      },
      async retry(input) {
        calls.push(`retry:${input.deliveryId}:${input.retryDelayMs}`);
        return { accepted: true, replayed: false, terminal: false };
      },
      async fail(input) {
        calls.push(`fail:${input.deliveryId}`);
        return { accepted: true, replayed: false, terminal: true };
      }
    };
  const server = createApiServer({
    tenantId,
    internalApiToken: "relational-worker-test-token",
    trustDevIdentityHeaders: false,
    relationalBoardWorkerStore: store
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer relational-worker-test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

  try {
    const claimed = await request("/internal/worker/claim", {
      workerId: "review-worker-1",
      topics: ["prepare-review", "runtime-review"],
      workerRuntimeService: "jina-task-worker",
      workerRuntimeRevision: "jina-task-worker-staging-00012-p9b"
    });
    assert.equal(claimed.status, 200);
    const claimBody = (await claimed.json()) as Record<string, Record<string, unknown>>;
    assert.equal(claimBody.message?.id, deliveryId);
    assert.equal(claimBody.message?.topic, "prepare-review");
    assert.equal(claimBody.task?.id, taskId);
    assert.equal((claimBody.task?.metadata as Record<string, unknown>).tenantId, tenantId);

    const fence = {
      messageId: deliveryId,
      taskId,
      attempt: 1,
      leaseId: "a26f1796-a074-48d2-8740-c608df51c5f0",
      writeFenceToken: "worker-fence-token"
    };
    const renewed = await request("/internal/worker/renew", fence);
    assert.equal(renewed.status, 200);
    const completed = await request("/internal/worker/complete", {
      ...fence,
      outcome: "done",
      result: { version: 1, artifact: "review-result" }
    });
    assert.equal(completed.status, 200);
    assert.equal(((await completed.json()) as Record<string, unknown>).terminal, true);

    assert.equal(
      calls[0],
      `claim:prepare-review,runtime-review:${tenantId}:jina-task-worker:ungated:jina-task-worker-staging-00012-p9b`
    );
    assert.equal(calls[1], `renew:${deliveryId}`);
    assert.match(calls[2] ?? "", new RegExp(`^complete:${deliveryId}:[0-9a-f]{64}$`));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("relational review claims cannot mix scheduler authorities", async () => {
  const server = createApiServer({
    tenantId,
    internalApiToken: "relational-worker-test-token",
    trustDevIdentityHeaders: false,
    relationalBoardWorkerStore: {
      claim: async () => undefined,
      renew: async () => ({ accepted: false, replayed: false }),
      release: async () => ({ accepted: false, replayed: false }),
      complete: async () => ({ accepted: false, replayed: false }),
      retry: async () => ({ accepted: false, replayed: false }),
      fail: async () => ({ accepted: false, replayed: false })
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: {
        authorization: "Bearer relational-worker-test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ workerId: "worker", topics: ["prepare-review", "run-review"] })
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /cannot be mixed/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
