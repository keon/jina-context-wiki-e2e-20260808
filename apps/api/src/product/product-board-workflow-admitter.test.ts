import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProductBoardWorkflowAdmitter,
  reviewBoardInputFromArrival,
} from "./product-board-workflow-admitter.js";
import { REVIEW_TASK_ID } from "./review-task-routing.js";
import type { DispatchOptions } from "./board-admission-contract.js";

const OPTIONS: DispatchOptions = {
  idempotencyKey: "review:456:123:42:head-sha-1:code_review",
  concurrencyKey: "review:456:123:42:head-sha-1:code_review",
};
const PAYLOAD = {
  delivery_id: "delivery-1",
  action: "opened",
  review_idempotency_key: OPTIONS.idempotencyKey,
  source_event: "pull_request",
  github_installation_id: 456,
  repository: {
    github_repo_id: 123,
    owner: "acme",
    owner_id: 789,
    owner_type: "Organization",
    name: "example",
    full_name: "acme/example",
    default_branch: "main",
    private: true,
  },
  pull_request: {
    number: 42,
    title: "Review me",
    html_url: "https://github.com/acme/example/pull/42",
    head_sha: "head-sha-1",
    base_sha: "base-sha",
    head_ref: "feature",
    base_ref: "main",
    author: "octocat",
    draft: false,
  },
  trigger: "webhook",
};

test("review admission receives the exact normalized arrival and Trigger options", async () => {
  const admitted: unknown[] = [];
  const dispatcher = new ProductBoardWorkflowAdmitter({
    dependencies: {
      admitReview: async (arrival) => {
        admitted.push(arrival);
        return {
          tenantId: "tenant-1",
          workflowId: "board-workflow-v2",
          traceId: "a".repeat(32),
          replayed: false,
          taskIds: ["review-task"],
        };
      },
    },
  });
  assert.deepEqual(await dispatcher.admitBoardWorkflow(REVIEW_TASK_ID, PAYLOAD, OPTIONS), {
    id: "board-workflow-v2",
  });
  const entry = admitted[0] as { triggerPayload: unknown; triggerOptions: unknown };
  assert.strictEqual(entry.triggerPayload, PAYLOAD);
  assert.strictEqual(entry.triggerOptions, OPTIONS);
});

test("admits installation backfill to Board", async () => {
  const admitted: unknown[] = [];
  const dispatcher = new ProductBoardWorkflowAdmitter({
    dependencies: {
      admitInstallationBackfill: async (payload, options) => {
        admitted.push({ payload, options });
        return { id: "installation-workflow-1" };
      },
    },
  });
  const payload = {
    delivery_id: "delivery-installation-1",
    github_installation_id: 456,
  };
  const options = { idempotencyKey: "installation-backfill:456:delivery-installation-1" };
  assert.deepEqual(
    await dispatcher.admitBoardWorkflow("github-installation-backfill", payload, options),
    { id: "installation-workflow-1" },
  );
  assert.deepEqual(admitted, [{ payload, options }]);
});

test("refuses unknown workflows instead of failing over to another orchestrator", async () => {
  const dispatcher = new ProductBoardWorkflowAdmitter();
  await assert.rejects(
    () => dispatcher.admitBoardWorkflow("unknown-workflow", {}, {}),
    /Unsupported Board workflow/,
  );
});

test("review dispatch parser preserves the exact product review identity", () => {
  assert.deepEqual(reviewBoardInputFromArrival(PAYLOAD, OPTIONS), {
    idempotencyKey: OPTIONS.idempotencyKey,
    deliveryId: "delivery-1",
    sourceEvent: "pull_request",
    triggerSource: "webhook",
    orchestrationPayload: PAYLOAD,
    installationId: 456,
    account: { id: 789, login: "acme", type: "Organization" },
    repository: {
      githubRepoId: 123,
      owner: "acme",
      name: "example",
      fullName: "acme/example",
      defaultBranch: "main",
      private: true,
    },
    pullRequest: {
      number: 42,
      title: "Review me",
      htmlUrl: "https://github.com/acme/example/pull/42",
      author: "octocat",
      headSha: "head-sha-1",
      baseSha: "base-sha",
      headRef: "feature",
      baseRef: "main",
      draft: false,
    },
  });
});
