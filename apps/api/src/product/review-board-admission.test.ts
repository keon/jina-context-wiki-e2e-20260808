import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReviewBoardAdmission,
  buildReviewBoardV2Admission,
  REVIEW_BOARD_PIPELINE_VERSION,
  REVIEW_BOARD_V2_PIPELINE_VERSION,
} from "./review-board-admission.js";

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

test("review Board v2 planner creates one high-level review task with exact Trigger dispatch", () => {
  const triggerPayload = {
    delivery_id: "delivery-v2",
    review_idempotency_key: "review:456:123:42:head-sha-v2:code_review",
    source_event: "pull_request",
    github_installation_id: 456,
    repository: { github_repo_id: 123, full_name: "acme/example" },
    pull_request: { number: 42, head_sha: "head-sha-v2" },
    trigger: "webhook",
  } as const;
  const triggerOptions = {
    idempotencyKey: "review:456:123:42:head-sha-v2:code_review",
    concurrencyKey: "review:456:123:42:head-sha-v2:code_review",
    tags: ["installation:456", "repo:123", "pr:42", "bot:code_review"],
    ttl: "30m",
  } as const;
  const admission = buildReviewBoardV2Admission({
    tenantId: "00000000-0000-4000-8000-000000000002",
    arrival: {
      input: {
        idempotencyKey: triggerOptions.idempotencyKey,
        deliveryId: "delivery-v2",
        sourceEvent: "pull_request",
        triggerSource: "webhook",
        installationId: 456,
        repository: { githubRepoId: 123, fullName: "acme/example" },
        pullRequest: { number: 42, headSha: "head-sha-v2" },
        orchestrationPayload: triggerPayload,
      },
      triggerPayload,
      triggerOptions,
    },
  });

  assert.equal(admission.pipelineVersion, REVIEW_BOARD_V2_PIPELINE_VERSION);
  assert.equal(admission.workflowType, "pr_review");
  assert.equal(admission.subjectId, "123:42:head-sha-v2");
  assert.equal(admission.concurrencyKey, triggerOptions.idempotencyKey);
  assert.equal(admission.tasks.length, 1);
  assert.deepEqual(admission.dependencies, []);
  assert.deepEqual(
    admission.tasks.map((task) => [task.taskType, task.topic, task.status, task.maxAttempts]),
    [["review", "run-review", "queued", 3]],
  );
  assert.deepEqual(admission.tasks[0].metadata?.trigger_payload, triggerPayload);
  assert.deepEqual(admission.tasks[0].metadata?.trigger_options, triggerOptions);
  assert.equal(admission.tasks[0].metadata?.trigger_task_id, "review");
  assert.match(String(admission.tasks[0].metadata?.request_digest), /^[0-9a-f]{64}$/);
});

test("review Board v2 requires the Trigger idempotency key used for ambiguous dispatch replay", () => {
  const arrival = {
    input: {
      idempotencyKey: "review:456:123:42:head-sha-v2:code_review",
      installationId: 456,
      repository: { githubRepoId: 123, fullName: "omxyz/jina" },
      pullRequest: { number: 42, headSha: "head-sha-v2" },
    },
    triggerPayload: {
      github_installation_id: 456,
      repository: { github_repo_id: 123, full_name: "omxyz/jina" },
      pull_request: { number: 42, head_sha: "head-sha-v2" },
    },
    triggerOptions: {},
  } as const;
  assert.throws(
    () =>
      buildReviewBoardV2Admission({
        tenantId: "00000000-0000-4000-8000-000000000002",
        arrival,
      }),
    /must be present and match/,
  );
});

test("manual v2 Board identity stays comment-stable while Trigger concurrency remains head-specific", () => {
  const idempotencyKey = "review:456:123:42:issue_comment:9001";
  const triggerOptions = {
    idempotencyKey,
    concurrencyKey: "review:456:123:42:new-head-sha",
    tags: ["manual-command:1:issue_comment:9001"],
  } as const;
  const admission = buildReviewBoardV2Admission({
    tenantId: "00000000-0000-4000-8000-000000000002",
    arrival: {
      input: {
        idempotencyKey,
        deliveryId: "manual-delivery",
        sourceEvent: "issue_comment",
        triggerSource: "manual",
        installationId: 456,
        repository: { githubRepoId: 123, fullName: "acme/example" },
        pullRequest: { number: 42, headSha: "new-head-sha" },
      },
      triggerPayload: {
        source_event: "issue_comment",
        requested_by: { login: "octocat", comment_id: 9001 },
      },
      triggerOptions,
    },
  });

  assert.equal(admission.subjectId, "123:42:issue_comment:9001");
  assert.equal(admission.concurrencyKey, idempotencyKey);
  assert.equal(
    (admission.tasks[0].metadata?.trigger_options as { concurrencyKey?: string }).concurrencyKey,
    triggerOptions.concurrencyKey,
  );
});
