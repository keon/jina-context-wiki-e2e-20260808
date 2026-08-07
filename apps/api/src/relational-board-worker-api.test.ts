import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { PostgresRelationalBoardWorkerStore } from "@jina/db";
import { canonicalReviewTriggerRequest } from "@jina/shared-kernel";

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
  const store: Pick<
    PostgresRelationalBoardWorkerStore,
    | "claim"
    | "renew"
    | "release"
    | "beginEffect"
    | "waitExternal"
    | "rescheduleExternal"
    | "retryEffect"
    | "complete"
    | "retry"
    | "fail"
  > = {
    async claim(input) {
      calls.push(
        `claim:${input.topics.join(",")}:${input.tenantId}:${input.workerService}:${input.workerRelease}:${input.workerRevision}`
      );
      const runReview = input.topics.includes("run-review");
      const triggerPayload = {
        action: "opened",
        repository: { full_name: "omxyz/jina" },
        pull_request: { number: 312 }
      };
      const triggerOptions = { idempotencyKey: "review:d599444c-5752-52e5-9502-6179269a53bc" };
      const requestDigest = createHash("sha256")
        .update(
          canonicalReviewTriggerRequest({ taskIdentifier: "review", payload: triggerPayload, options: triggerOptions }),
          "utf8"
        )
        .digest("hex");
      return {
        tenantId,
        workflowId,
        workflowType: "pr_review",
        pipelineVersion: runReview ? "pr_review.board.v2" : "pr_review.board.v1",
        taskId,
        taskType: runReview ? "run-review" : "prepare-review",
        topic: runReview ? "run-review" : "prepare-review",
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
        metadata: runReview
          ? {
              schema_version: 2,
              request_digest: requestDigest,
              trigger_task_id: "review",
              trigger_payload: triggerPayload,
              trigger_options: triggerOptions
            }
          : { review_run_id: "52d68f74-8f64-45ee-8fef-9d0e58ae75ab" },
        workflowMetadata: { review_payload: { action: "opened" } },
        dependencyResults: [],
        effectReceipts: []
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
    async beginEffect(input) {
      calls.push(`effect-start:${input.deliveryId}:${input.effectType}`);
      return {
        accepted: true,
        replayed: false,
        effectReceipt: {
          idempotencyKey: input.effectIdempotencyKey,
          effectType: input.effectType,
          effectVersion: input.effectVersion,
          provider: input.provider,
          status: "started",
          requestDigest: input.requestDigest,
          metadata: input.metadata ?? {}
        }
      };
    },
    async waitExternal(input) {
      calls.push(`wait-external:${input.deliveryId}:${input.providerId}`);
      return { accepted: true, replayed: false };
    },
    async rescheduleExternal(input) {
      calls.push(`reschedule-external:${input.deliveryId}:${input.providerId}`);
      return { accepted: true, replayed: false };
    },
    async retryEffect(input) {
      calls.push(`effect-retry:${input.deliveryId}:${input.receiptStatus}`);
      return { accepted: true, replayed: false, terminal: false };
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
    relationalBoardWorkerStore: store,
    relationalReviewTopicEnabled: true
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

    const v2Claim = await request("/internal/worker/claim", {
      workerId: "review-worker-v2",
      topics: ["run-review"],
      workerRuntimeService: "jina-task-worker",
      workerRuntimeRevision: "jina-task-worker-staging-00012-p9b"
    });
    assert.equal(v2Claim.status, 200);
    const v2ClaimBody = (await v2Claim.json()) as Record<string, Record<string, unknown>>;
    assert.equal(v2ClaimBody.message?.topic, "run-review");
    assert.equal(v2ClaimBody.task?.id, taskId);
    const v2Metadata = v2ClaimBody.task?.metadata as Record<string, unknown>;
    assert.equal(v2Metadata.tenantId, tenantId);
    assert.equal(v2Metadata.workflowId, workflowId);
    assert.equal(v2Metadata.workflowType, "pr_review");
    assert.equal(v2Metadata.pipelineVersion, "pr_review.board.v2");
    assert.equal(v2Metadata.schema_version, 2);
    assert.equal(v2Metadata.trigger_task_id, "review");
    assert.equal(typeof v2Metadata.trigger_payload, "object");
    assert.equal(typeof v2Metadata.trigger_options, "object");
    assert.match(String(v2Metadata.request_digest), /^[0-9a-f]{64}$/);
    assert.deepEqual(v2Metadata.workflowMetadata, { review_payload: { action: "opened" } });
    assert.deepEqual(v2Metadata.effectReceipts, []);

    const fence = {
      messageId: deliveryId,
      taskId,
      attempt: 1,
      leaseId: "a26f1796-a074-48d2-8740-c608df51c5f0",
      writeFenceToken: "worker-fence-token"
    };
    const renewed = await request("/internal/worker/renew", fence);
    assert.equal(renewed.status, 200);
    const requestDigest = "d".repeat(64);
    const effectStarted = await request("/internal/worker/effects/start", {
      ...fence,
      transitionId: "transition-effect-start",
      effectIdempotencyKey: "review-dispatch:test",
      effectType: "trigger.review.dispatch",
      effectVersion: 1,
      provider: "trigger.dev",
      requestDigest,
      metadata: { trigger_task_id: "review" }
    });
    assert.equal(effectStarted.status, 200);
    const waiting = await request("/internal/worker/wait-external", {
      ...fence,
      transitionId: "transition-provider-handoff",
      operation: "provider_handoff",
      effectIdempotencyKey: "review-dispatch:test",
      requestDigest,
      providerId: "run_test_12345678",
      providerStatus: "QUEUED",
      nextCheckAt: "2026-08-04T12:01:00.000Z"
    });
    assert.equal(waiting.status, 200);
    const rescheduled = await request("/internal/worker/wait-external", {
      ...fence,
      transitionId: "transition-poll-reschedule",
      operation: "reschedule",
      effectIdempotencyKey: "review-dispatch:test",
      providerId: "run_test_12345678",
      providerStatus: "EXECUTING",
      nextCheckAt: "2026-08-04T12:02:00.000Z"
    });
    assert.equal(rescheduled.status, 200);
    const effectRetried = await request("/internal/worker/effects/retry", {
      ...fence,
      transitionId: "transition-effect-retry",
      effectIdempotencyKey: "review-dispatch:test",
      effectType: "trigger.review.dispatch",
      effectVersion: 1,
      provider: "trigger.dev",
      requestDigest,
      receiptStatus: "ambiguous",
      failureCategory: "provider_timeout",
      diagnostic: "acceptance unknown"
    });
    assert.equal(effectRetried.status, 200);
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
    assert.equal(calls[1], `claim:run-review:${tenantId}:jina-task-worker:ungated:jina-task-worker-staging-00012-p9b`);
    assert.equal(calls[2], `renew:${deliveryId}`);
    assert.equal(calls[3], `effect-start:${deliveryId}:trigger.review.dispatch`);
    assert.equal(calls[4], `wait-external:${deliveryId}:run_test_12345678`);
    assert.equal(calls[5], `reschedule-external:${deliveryId}:run_test_12345678`);
    assert.equal(calls[6], `effect-retry:${deliveryId}:ambiguous`);
    assert.match(calls[7] ?? "", new RegExp(`^complete:${deliveryId}:[0-9a-f]{64}$`));
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
      beginEffect: async () => ({ accepted: false, replayed: false }),
      waitExternal: async () => ({ accepted: false, replayed: false }),
      rescheduleExternal: async () => ({ accepted: false, replayed: false }),
      retryEffect: async () => ({ accepted: false, replayed: false }),
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
