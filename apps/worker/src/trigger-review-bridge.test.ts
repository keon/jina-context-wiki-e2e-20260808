import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { canonicalReviewTriggerRequest } from "@jina/shared-kernel";

import {
  REVIEW_TRIGGER_EFFECT_TYPE,
  REVIEW_TRIGGER_EFFECT_VERSION,
  REVIEW_TRIGGER_PROVIDER,
  TRIGGER_REVIEW_RUN_STATUS_KINDS,
  compactCompletedReviewResult,
  createTriggerReviewClient,
  matchingReviewTriggerReceipt,
  parseRelationalReviewTaskMetadata,
  reviewTriggerEffectIdempotencyKey,
  triggerReviewPollIntervalMs,
  triggerReviewRunStatusKind,
  type ReviewTriggerOptions,
  type TriggerReviewRunStatus
} from "./trigger-review-bridge.js";

const payload = {
  delivery_id: "delivery-1",
  review_idempotency_key: "review:1:2:3:abc:code_review",
  repository: { full_name: "omxyz/jina" },
  pull_request: { number: 42 }
};
const options = {
  idempotencyKey: "review:1:2:3:abc:code_review",
  concurrencyKey: "review:1:2:3:abc:code_review",
  queue: { name: "reviews", concurrencyLimit: 5 },
  tags: ["repo:omxyz/jina", "pr:42"],
  ttl: "1h",
  machine: "small-1x"
} as const satisfies ReviewTriggerOptions;

test("relational review metadata preserves the exact Trigger request and verifies its digest", () => {
  const metadata = parseRelationalReviewTaskMetadata(metadataValue());
  assert.deepEqual(metadata.triggerPayload, payload);
  assert.deepEqual(metadata.triggerOptions, options);
  assert.equal(metadata.requestDigest, requestDigest());
  assert.equal(metadata.pipelineVersion, "pr_review.board.v2");

  assert.throws(
    () => parseRelationalReviewTaskMetadata({ ...metadataValue(), request_digest: "0".repeat(64) }),
    /does not match/
  );
  assert.throws(
    () =>
      parseRelationalReviewTaskMetadata({
        ...metadataValue(),
        trigger_options: { ...options, delay: "1m" }
      }),
    /unsupported fields/
  );
});

test("dispatch uses the original Trigger HTTP contract without rewriting options", async () => {
  const requests: Array<{ url: string; authorization?: string; branch?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers["x-trigger-branch"] === "string"
          ? { branch: request.headers["x-trigger-branch"] }
          : {}),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "run_exact" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    const client = createTriggerReviewClient({
      TRIGGER_SECRET_KEY: "tr_dev_secret",
      TRIGGER_API_URL: `http://127.0.0.1:${address.port}`,
      TRIGGER_PREVIEW_BRANCH: "review-cutover"
    });
    assert.deepEqual(await client.trigger("review", payload, options), { id: "run_exact" });
    assert.deepEqual(requests, [
      {
        url: "/api/v1/tasks/review/trigger",
        authorization: "Bearer tr_dev_secret",
        branch: "review-cutover",
        body: { payload, options }
      }
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("the Trigger 4.4.6 run status set is classified exhaustively", () => {
  const expected: TriggerReviewRunStatus[] = [
    "PENDING_VERSION",
    "QUEUED",
    "DEQUEUED",
    "EXECUTING",
    "WAITING",
    "DELAYED",
    "COMPLETED",
    "CANCELED",
    "FAILED",
    "CRASHED",
    "SYSTEM_FAILURE",
    "EXPIRED",
    "TIMED_OUT"
  ];
  assert.deepEqual(Object.keys(TRIGGER_REVIEW_RUN_STATUS_KINDS).sort(), [...expected].sort());
  for (const status of expected.slice(0, 6)) assert.equal(triggerReviewRunStatusKind(status), "nonterminal");
  assert.equal(triggerReviewRunStatusKind("COMPLETED"), "completed");
  for (const status of expected.slice(7)) assert.equal(triggerReviewRunStatusKind(status), "failed");
});

test("completed projection ignores large output and retains only Board scalars", () => {
  const metadata = parseRelationalReviewTaskMetadata(metadataValue());
  const result = compactCompletedReviewResult(
    {
      id: "run_123",
      status: "COMPLETED",
      output: {
        status: "completed_superseded",
        review_run_id: "review-1",
        repository: "omxyz/jina",
        pull_request_number: 42,
        stage_results: [{ payload: "x".repeat(100_000) }]
      }
    },
    metadata
  );
  assert.deepEqual(result, {
    status: "completed_superseded",
    trigger_run_id: "run_123",
    review_run_id: "review-1",
    repository: "omxyz/jina",
    pull_request_number: 42
  });
  assert.ok(JSON.stringify(result).length < 1_000);
});

test("matching receipt is identity- and digest-bound", () => {
  const key = reviewTriggerEffectIdempotencyKey("workflow-1");
  const metadata = parseRelationalReviewTaskMetadata({
    ...metadataValue(),
    effectReceipts: [
      {
        idempotencyKey: key,
        effectType: REVIEW_TRIGGER_EFFECT_TYPE,
        effectVersion: REVIEW_TRIGGER_EFFECT_VERSION,
        provider: REVIEW_TRIGGER_PROVIDER,
        status: "succeeded",
        requestDigest: requestDigest(),
        providerId: "run_123",
        metadata: {}
      }
    ]
  });
  assert.equal(matchingReviewTriggerReceipt(metadata)?.providerId, "run_123");
});

test("poll interval is bounded", () => {
  assert.equal(triggerReviewPollIntervalMs(undefined), 30_000);
  assert.equal(triggerReviewPollIntervalMs("5000"), 5_000);
  assert.equal(triggerReviewPollIntervalMs("300000"), 300_000);
  assert.throws(() => triggerReviewPollIntervalMs("4999"), /between 5000 and 300000/);
  assert.throws(() => triggerReviewPollIntervalMs("300001"), /between 5000 and 300000/);
});

function requestDigest(): string {
  return createHash("sha256")
    .update(canonicalReviewTriggerRequest({ taskIdentifier: "review", payload, options }), "utf8")
    .digest("hex");
}

function metadataValue(): Record<string, unknown> {
  return {
    tenantId: "tenant-1",
    workflowId: "workflow-1",
    workflowType: "pr_review",
    pipelineVersion: "pr_review.board.v2",
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    schema_version: 2,
    request_digest: requestDigest(),
    trigger_task_id: "review",
    trigger_payload: payload,
    trigger_options: options,
    workflowMetadata: { repository: "omxyz/jina", pull_request_number: 42 },
    effectReceipts: []
  };
}
