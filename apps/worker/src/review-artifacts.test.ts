import assert from "node:assert/strict";
import test from "node:test";

import { decodeReviewTaskResult, encodeReviewTaskResult, parseReviewArtifactRef } from "./review-artifacts.js";

test("small review task results remain inline and round trip without object storage", async () => {
  const encoded = await encodeReviewTaskResult({
    tenantId: "tenant-1",
    workflowId: "workflow-1",
    taskId: "task-1",
    kind: "review-summary",
    value: { stageResult: { stage: "summary", status: "success" } }
  });
  assert.deepEqual(encoded, {
    version: 1,
    kind: "review-summary",
    value: { stageResult: { stage: "summary", status: "success" } }
  });
  assert.deepEqual(await decodeReviewTaskResult(encoded, "review-summary"), {
    stageResult: { stage: "summary", status: "success" }
  });
});

test("large review task results fail closed without the staging artifact bucket", async () => {
  await assert.rejects(
    encodeReviewTaskResult({
      tenantId: "tenant-1",
      workflowId: "workflow-1",
      taskId: "task-1",
      kind: "review-runtime",
      value: { markdown: "x".repeat(13_000) }
    }),
    /JINA_REVIEW_GCS_BUCKET/
  );
});

test("review artifact references require canonical immutable GCS identity", () => {
  const sha256 = "a".repeat(64);
  assert.deepEqual(
    parseReviewArtifactRef({
      version: 1,
      storage: "gcs",
      uri: `gs://staging-review/review-board/v1/tenant-1/workflow-1/task-1/review-runtime/${sha256}.json`,
      key: `review-board/v1/tenant-1/workflow-1/task-1/review-runtime/${sha256}.json`,
      contentType: "application/json",
      bytes: 100,
      sha256,
      objectGeneration: "1730000000000000"
    }),
    {
      version: 1,
      storage: "gcs",
      uri: `gs://staging-review/review-board/v1/tenant-1/workflow-1/task-1/review-runtime/${sha256}.json`,
      key: `review-board/v1/tenant-1/workflow-1/task-1/review-runtime/${sha256}.json`,
      contentType: "application/json",
      bytes: 100,
      sha256,
      objectGeneration: "1730000000000000"
    }
  );
  assert.throws(
    () =>
      parseReviewArtifactRef({
        version: 1,
        storage: "gcs",
        uri: "gs://staging-review/not-canonical",
        key: "../not-canonical",
        contentType: "application/json",
        bytes: 100,
        sha256,
        objectGeneration: "1"
      }),
    /not canonical/
  );
});
