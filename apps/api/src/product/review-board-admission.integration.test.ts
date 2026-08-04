import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { RelationalBoardRepository } from "@jina/db";
import { Pool } from "pg";

import { getPool } from "./db.js";
import { admitScheduledBillingRetry } from "./billing-board-admission.js";
import { admitBoardReview } from "./review-board-admission.js";

const execFileAsync = promisify(execFile);
const runtimeMigration = fileURLToPath(new URL("../../../../packages/db/dist/migrate.js", import.meta.url));
const productMigration = fileURLToPath(new URL("./migrate.js", import.meta.url));
// This test drops public, jina_runtime, and jina_context. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "product review and relational Board workflow share one commit, replay, and rollback boundary",
  { skip: !databaseUrl },
  async () => {
    const previousProductUrl = process.env.JINA_PRODUCT_DATABASE_URL;
    const previousProductMode = process.env.JINA_PRODUCT_DATABASE_MODE;
    process.env.JINA_PRODUCT_DATABASE_URL = databaseUrl;
    process.env.JINA_PRODUCT_DATABASE_MODE = "url";
    const control = new Pool({
      connectionString: databaseUrl,
      application_name: "jina-review-board-admission-test",
    });
    try {
      await resetDatabase(control);
      await migrateDatabase(databaseUrl!);

      const first = await admitBoardReview(reviewInput("head-sha-1"));
      const replay = await admitBoardReview(reviewInput("head-sha-1"));
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.reviewRunId, first.reviewRunId);
      assert.equal(replay.workflowId, first.workflowId);

      const bound = await control.query<{
        orchestrator: string;
        board_workflow_id: string;
        workflow_count: string;
        task_count: string;
      }>(
        `select review.orchestrator,review.board_workflow_id,
                (select count(*)::text from jina_runtime.board_workflows) workflow_count,
                (select count(*)::text from jina_runtime.board_tasks) task_count
         from review_runs review
         where review.id=$1`,
        [first.reviewRunId],
      );
      assert.deepEqual(bound.rows[0], {
        orchestrator: "board",
        board_workflow_id: first.workflowId,
        workflow_count: "1",
        task_count: "6",
      });

      await assert.rejects(
        admitBoardReview(reviewInput("head-sha-rollback"), new FailingBoardRepository()),
        /injected Board admission failure/,
      );
      const rolledBack = await control.query<{ reviews: string; workflows: string }>(`
        select
          (select count(*)::text from review_runs where head_sha='head-sha-rollback') reviews,
          (select count(*)::text from jina_runtime.board_workflows
            where subject_id like '%:head-sha-rollback') workflows
      `);
      assert.deepEqual(rolledBack.rows[0], { reviews: "0", workflows: "0" });

      const billingFirst = await admitScheduledBillingRetry({
        schedule_time: "2026-08-04T10:30:00.000Z",
      });
      const billingReplay = await admitScheduledBillingRetry({
        schedule_time: "2026-08-04T10:44:59.000Z",
      });
      assert.equal(billingFirst.replayed, false);
      assert.equal(billingReplay.replayed, true);
      assert.equal(billingReplay.id, billingFirst.id);
      const billing = await control.query<{
        workflow_type: string;
        task_type: string;
        status: string;
        max_attempts: number;
      }>(
        `select workflow.workflow_type,task.task_type,task.status,task.max_attempts
         from jina_runtime.board_workflows workflow
         join jina_runtime.board_tasks task on task.workflow_id=workflow.id
         where workflow.id=$1`,
        [billingFirst.id],
      );
      assert.deepEqual(billing.rows[0], {
        workflow_type: "billing_retry",
        task_type: "billing-retry",
        status: "queued",
        max_attempts: 3,
      });
    } finally {
      await getPool().end().catch(() => undefined);
      await resetDatabase(control);
      await migrateDatabase(databaseUrl!);
      await control.end();
      restoreEnvironment("JINA_PRODUCT_DATABASE_URL", previousProductUrl);
      restoreEnvironment("JINA_PRODUCT_DATABASE_MODE", previousProductMode);
    }
  },
);

class FailingBoardRepository extends RelationalBoardRepository {
  override async admitWorkflow(): Promise<never> {
    throw new Error("injected Board admission failure");
  }
}

function reviewInput(headSha: string) {
  return {
    idempotencyKey: `review:456:123:42:${headSha}:code_review`,
    deliveryId: `delivery-${headSha}`,
    sourceEvent: "pull_request",
    triggerSource: "webhook",
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
      title: "Review Board admission",
      htmlUrl: "https://github.com/acme/example/pull/42",
      author: "octocat",
      headSha,
      baseSha: "base-sha",
      headRef: "feature",
      baseRef: "main",
      draft: false,
    },
    orchestrationPayload: {
      delivery_id: `delivery-${headSha}`,
      action: "opened",
      github_installation_id: 456,
      repository: { github_repo_id: 123, full_name: "acme/example" },
      pull_request: { number: 42, head_sha: headSha },
      trigger: "webhook",
    },
  } as const;
}

async function migrateDatabase(url: string): Promise<void> {
  const environment = {
    ...process.env,
    DATABASE_URL: url,
    TEST_DATABASE_URL: url,
    JINA_PRODUCT_DATABASE_URL: url,
    JINA_PRODUCT_DATABASE_MODE: "url",
  };
  await execFileAsync(process.execPath, [runtimeMigration], { env: environment });
  await execFileAsync(process.execPath, [productMigration], { env: environment });
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query("drop schema if exists jina_context cascade");
  await pool.query("drop schema if exists jina_runtime cascade");
  await pool.query("drop schema if exists public cascade");
  await pool.query("create schema public");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
