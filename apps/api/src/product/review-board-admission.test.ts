import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReviewBoardAdmission, REVIEW_BOARD_PIPELINE_VERSION } from "./review-board-admission.js";

test("review Board planner creates the full versioned fan-out, join, publication, and settlement graph", () => {
  const admission = buildReviewBoardAdmission({
    reviewRunId: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-000000000002",
    input: {
      idempotencyKey: "review:456:123:42:head-sha-1:code_review",
      deliveryId: "delivery-1",
      sourceEvent: "pull_request",
      triggerSource: "webhook",
      installationId: 456,
      repository: { githubRepoId: 123, fullName: "acme/example" },
      pullRequest: { number: 42, headSha: "head-sha-1" },
      orchestrationPayload: { action: "opened", delivery_id: "delivery-1" },
    },
  });

  assert.equal(admission.pipelineVersion, REVIEW_BOARD_PIPELINE_VERSION);
  assert.equal(admission.dedupeKey, "review:456:123:42:head-sha-1:code_review");
  assert.deepEqual(
    admission.tasks.map((task) => [task.taskType, task.status, task.maxAttempts]),
    [
      ["prepare-review", "queued", 3],
      ["summary-review", "blocked", 3],
      ["runtime-review", "blocked", 3],
      ["finalize-review", "blocked", 3],
      ["publish-review", "blocked", 5],
      ["settle-review", "blocked", 5],
    ],
  );
  assert.equal(admission.dependencies?.length, 6);
  assert.equal(admission.dependencies?.filter((dependency) => dependency.condition === "terminal").length, 3);
  assert.equal(admission.tasks.at(-1)?.cleanupTask, true);
});

test("review Board planner refuses an admission that cannot be executed by a worker", () => {
  assert.throws(
    () =>
      buildReviewBoardAdmission({
        reviewRunId: "00000000-0000-4000-8000-000000000001",
        tenantId: "00000000-0000-4000-8000-000000000002",
        input: {
          installationId: 456,
          repository: { githubRepoId: 123, fullName: "acme/example" },
          pullRequest: { number: 42, headSha: "head-sha-1" },
        },
      }),
    /orchestrationPayload must be an object/,
  );
});
