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
import {
  prepareReviewRun,
  reconcileBoardReviewTerminal,
  ReviewDispatchNotBoundError,
  ReviewDispatchProvenanceError,
} from "./store.js";

const execFileAsync = promisify(execFile);
const runtimeMigration = fileURLToPath(new URL("../../../../packages/db/dist/migrate.js", import.meta.url));
const productMigration = fileURLToPath(new URL("./migrate.js", import.meta.url));
// This test drops public, jina_runtime, and jina_context. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "product review and relational Board workflow share one commit, replay, and rollback boundary",
  { skip: !databaseUrl },
  async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousProductMode = process.env.JINA_PRODUCT_DATABASE_MODE;
    process.env.DATABASE_URL = databaseUrl;
    process.env.JINA_PRODUCT_DATABASE_MODE = "url";
    const control = new Pool({
      connectionString: databaseUrl,
      application_name: "jina-review-board-admission-test",
    });
    try {
      await resetDatabase(control);
      await migrateDatabase(databaseUrl!);

      const v2First = await admitBoardReview(reviewArrival("head-sha-v2"));
      const v2Replay = await admitBoardReview(reviewArrival("head-sha-v2"));
      assert.equal(v2First.replayed, false);
      assert.equal(v2Replay.replayed, true);
      assert.equal(v2Replay.workflowId, v2First.workflowId);
      const changedRedelivery = reviewArrival("head-sha-v2-redelivered-after-push");
      const immutableReplay = await admitBoardReview({
        ...changedRedelivery,
        input: { ...changedRedelivery.input, idempotencyKey: reviewInput("head-sha-v2").idempotencyKey },
        triggerOptions: {
          ...changedRedelivery.triggerOptions,
          idempotencyKey: reviewInput("head-sha-v2").idempotencyKey,
        },
      });
      assert.equal(immutableReplay.replayed, true);
      assert.equal(immutableReplay.workflowId, v2First.workflowId);
      const v2State = await control.query<{
        review_count: string;
        task_count: string;
        task_type: string;
        topic: string;
        pipeline_version: string;
      }>(
        `select
           (select count(*)::text from review_runs where head_sha='head-sha-v2') review_count,
           count(*)::text task_count,
           min(task.task_type) task_type,
           min(task.topic) topic,
           min(workflow.pipeline_version) pipeline_version
         from jina_runtime.board_workflows workflow
         join jina_runtime.board_tasks task on task.workflow_id=workflow.id
         where workflow.id=$1`,
        [v2First.workflowId],
      );
      assert.deepEqual(v2State.rows[0], {
        review_count: "0",
        task_count: "1",
        task_type: "review",
        topic: "run-review",
        pipeline_version: "pr_review.board.v2",
      });

      const v2Task = await control.query<{ task_id: string; request_digest: string }>(
        `select task.id task_id,task.metadata->>'request_digest' request_digest
         from jina_runtime.board_tasks task
         where task.workflow_id=$1`,
        [v2First.workflowId],
      );
      const v2TaskRow = v2Task.rows[0];
      const effectKey = `trigger-review:${v2First.workflowId}`;
      await control.query(
        `insert into jina_runtime.board_effect_receipts
           (idempotency_key,tenant_id,workflow_id,task_id,effect_type,effect_version,
            provider,status,request_digest)
         values ($1,$2,$3,$4,'trigger.review.dispatch',1,'trigger.dev','started',$5)`,
        [effectKey, v2First.tenantId, v2First.workflowId, v2TaskRow.task_id, v2TaskRow.request_digest],
      );
      const preparedInput = {
        ...reviewInput("head-sha-v2"),
        triggerRunId: "run_v2_exact_provider",
      } as const;
      await assert.rejects(prepareReviewRun(preparedInput), ReviewDispatchNotBoundError);
      await control.query(
        `update jina_runtime.board_effect_receipts
            set status='succeeded',provider_id=$2,completed_at=now(),updated_at=now()
          where idempotency_key=$1`,
        [effectKey, preparedInput.triggerRunId],
      );
      const preparedReviewRunId = await prepareReviewRun(preparedInput);
      const preparedState = await control.query<{
        orchestrator: string;
        board_workflow_id: string;
        trigger_run_id: string;
        authority_record_id: string;
      }>(
        `select review.orchestrator,review.board_workflow_id,review.trigger_run_id,
                receipt.authority_record_id
         from review_runs review
         join jina_runtime.board_effect_receipts receipt
           on receipt.authority_record_id=review.id::text
         where review.id=$1`,
        [preparedReviewRunId],
      );
      assert.deepEqual(preparedState.rows[0], {
        orchestrator: "board",
        board_workflow_id: v2First.workflowId,
        trigger_run_id: preparedInput.triggerRunId,
        authority_record_id: preparedReviewRunId,
      });
      const reconciled = await reconcileBoardReviewTerminal({
        boardWorkflowId: v2First.workflowId,
        triggerRunId: preparedInput.triggerRunId,
        providerStatus: "SYSTEM_FAILURE",
        status: "failed",
        diagnostic: "Trigger worker stopped after prepare",
      });
      assert.deepEqual(reconciled, { outcome: "updated", reviewRunId: preparedReviewRunId });
      const reconciliationReplay = await reconcileBoardReviewTerminal({
        boardWorkflowId: v2First.workflowId,
        triggerRunId: preparedInput.triggerRunId,
        providerStatus: "SYSTEM_FAILURE",
        status: "failed",
        diagnostic: "Trigger worker stopped after prepare",
      });
      assert.deepEqual(reconciliationReplay, {
        outcome: "already_terminal",
        reviewRunId: preparedReviewRunId,
      });
      await assert.rejects(
        reconcileBoardReviewTerminal({
          boardWorkflowId: "00000000-0000-4000-8000-000000000099",
          triggerRunId: "run_before_prepare",
          providerStatus: "FAILED",
          status: "failed",
          diagnostic: "failed before prepare",
        }),
        ReviewDispatchProvenanceError,
      );
      await assert.rejects(
        reconcileBoardReviewTerminal({
          boardWorkflowId: v2First.workflowId,
          triggerRunId: "run_wrong",
          providerStatus: "FAILED",
          status: "failed",
          diagnostic: "identity mismatch",
        }),
        ReviewDispatchProvenanceError,
      );
      const postPrepareReplay = await admitBoardReview(reviewArrival("head-sha-v2"));
      assert.equal(postPrepareReplay.replayed, true);
      assert.equal(postPrepareReplay.workflowId, v2First.workflowId);

      await assert.rejects(
        admitBoardReview(reviewArrival("head-sha-v2-rollback"), new FailingBoardRepository()),
        /injected Board admission failure/,
      );
      const v2RolledBack = await control.query<{ reviews: string; workflows: string }>(`
        select
          (select count(*)::text from review_runs where head_sha='head-sha-v2-rollback') reviews,
          (select count(*)::text from jina_runtime.board_workflows
            where subject_id like '%:head-sha-v2-rollback') workflows
      `);
      assert.deepEqual(v2RolledBack.rows[0], { reviews: "0", workflows: "0" });

      const decoyAdmission = await admitBoardReview(reviewArrival("head-sha-v2-decoy"));
      const decoyTask = await control.query<{ task_id: string; request_digest: string }>(
        `select id task_id,metadata->>'request_digest' request_digest
         from jina_runtime.board_tasks where workflow_id=$1`,
        [decoyAdmission.workflowId],
      );
      await control.query(
        `insert into jina_runtime.board_effect_receipts
           (idempotency_key,tenant_id,workflow_id,task_id,effect_type,effect_version,
            provider,status,request_digest,provider_id,completed_at)
         values ($1,$2,$3,$4,'trigger.review.dispatch',2,'trigger.dev','succeeded',$5,$6,now())`,
        [
          `trigger-review-decoy:${decoyAdmission.workflowId}`,
          decoyAdmission.tenantId,
          decoyAdmission.workflowId,
          decoyTask.rows[0].task_id,
          decoyTask.rows[0].request_digest,
          "run_v2_decoy_receipt",
        ],
      );
      await assert.rejects(
        prepareReviewRun({
          ...reviewInput("head-sha-v2-decoy"),
          triggerRunId: "run_v2_decoy_receipt",
        }),
        ReviewDispatchProvenanceError,
      );
      const decoyProductRows = await control.query<{ count: string }>(
        `select count(*)::text count from review_runs where head_sha='head-sha-v2-decoy'`,
      );
      assert.equal(decoyProductRows.rows[0]?.count, "0");

      const prePrepareAdmission = await admitBoardReview(reviewArrival("head-sha-v2-preprepare"));
      const prePrepareTask = await control.query<{ task_id: string; request_digest: string }>(
        `select id task_id,metadata->>'request_digest' request_digest
         from jina_runtime.board_tasks where workflow_id=$1`,
        [prePrepareAdmission.workflowId],
      );
      const prePrepareEffectKey = `trigger-review:${prePrepareAdmission.workflowId}`;
      await control.query(
        `insert into jina_runtime.board_effect_receipts
           (idempotency_key,tenant_id,workflow_id,task_id,effect_type,effect_version,
            provider,status,request_digest,provider_id,completed_at)
         values ($1,$2,$3,$4,'trigger.review.dispatch',1,'trigger.dev','succeeded',$5,$6,now())`,
        [
          prePrepareEffectKey,
          prePrepareAdmission.tenantId,
          prePrepareAdmission.workflowId,
          prePrepareTask.rows[0].task_id,
          prePrepareTask.rows[0].request_digest,
          "run_before_prepare",
        ],
      );
      assert.deepEqual(
        await reconcileBoardReviewTerminal({
          boardWorkflowId: prePrepareAdmission.workflowId,
          triggerRunId: "run_before_prepare",
          providerStatus: "FAILED",
          status: "failed",
          diagnostic: "failed before prepare",
        }),
        { outcome: "no_row" },
      );
      const closedReceipt = await control.query<{ prepare_closed: boolean; provider_status: string }>(
        `select (metadata->>'prepare_closed')::boolean prepare_closed,
                metadata->>'terminal_provider_status' provider_status
         from jina_runtime.board_effect_receipts where idempotency_key=$1`,
        [prePrepareEffectKey],
      );
      assert.deepEqual(closedReceipt.rows[0], {
        prepare_closed: true,
        provider_status: "FAILED",
      });
      await assert.rejects(
        prepareReviewRun({
          ...reviewInput("head-sha-v2-preprepare"),
          triggerRunId: "run_before_prepare",
        }),
        ReviewDispatchProvenanceError,
      );
      const prePrepareProductRows = await control.query<{ count: string }>(
        `select count(*)::text count from review_runs where head_sha='head-sha-v2-preprepare'`,
      );
      assert.equal(prePrepareProductRows.rows[0]?.count, "0");

      const raceAdmission = await admitBoardReview(reviewArrival("head-sha-v2-race"));
      const raceTask = await control.query<{ task_id: string; request_digest: string }>(
        `select id task_id,metadata->>'request_digest' request_digest
         from jina_runtime.board_tasks where workflow_id=$1`,
        [raceAdmission.workflowId],
      );
      const raceEffectKey = `trigger-review:${raceAdmission.workflowId}`;
      await control.query(
        `insert into jina_runtime.board_effect_receipts
           (idempotency_key,tenant_id,workflow_id,task_id,effect_type,effect_version,
            provider,status,request_digest,provider_id,completed_at)
         values ($1,$2,$3,$4,'trigger.review.dispatch',1,'trigger.dev','succeeded',$5,$6,now())`,
        [
          raceEffectKey,
          raceAdmission.tenantId,
          raceAdmission.workflowId,
          raceTask.rows[0].task_id,
          raceTask.rows[0].request_digest,
          "run_prepare_reconcile_race",
        ],
      );
      const [raceReconciliation, racePrepare] = await Promise.allSettled([
        reconcileBoardReviewTerminal({
          boardWorkflowId: raceAdmission.workflowId,
          triggerRunId: "run_prepare_reconcile_race",
          providerStatus: "TIMED_OUT",
          status: "failed",
          diagnostic: "prepare and terminal reconciliation raced",
        }),
        prepareReviewRun({
          ...reviewInput("head-sha-v2-race"),
          triggerRunId: "run_prepare_reconcile_race",
        }),
      ]);
      assert.equal(raceReconciliation.status, "fulfilled");
      const raceProductState = await control.query<{
        id: string;
        status: string;
        authority_record_id: string | null;
        prepare_closed: boolean;
      }>(
        `select review.id,review.status,receipt.authority_record_id,
                coalesce((receipt.metadata->>'prepare_closed')::boolean,false) prepare_closed
         from jina_runtime.board_effect_receipts receipt
         left join review_runs review on review.board_workflow_id=receipt.workflow_id
         where receipt.idempotency_key=$1`,
        [raceEffectKey],
      );
      if (
        raceReconciliation.status === "fulfilled" &&
        raceReconciliation.value.outcome === "no_row"
      ) {
        assert.equal(racePrepare.status, "rejected");
        assert.equal(raceProductState.rows[0]?.id, null);
        assert.equal(raceProductState.rows[0]?.authority_record_id, null);
        assert.equal(raceProductState.rows[0]?.prepare_closed, true);
      } else {
        assert.equal(racePrepare.status, "fulfilled");
        assert.equal(raceReconciliation.status, "fulfilled");
        assert.equal(raceReconciliation.value.outcome, "updated");
        assert.equal(raceProductState.rows[0]?.status, "failed");
        assert.equal(raceProductState.rows[0]?.authority_record_id, raceProductState.rows[0]?.id);
        assert.equal(raceProductState.rows[0]?.prepare_closed, false);
      }

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
      restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
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

function reviewArrival(headSha: string) {
  const input = reviewInput(headSha);
  const triggerOptions = {
    idempotencyKey: input.idempotencyKey,
    concurrencyKey: input.idempotencyKey,
    tags: ["installation:456", "repo:123", "pr:42", "bot:code_review"],
    ttl: "30m",
  } as const;
  return {
    input,
    triggerPayload: input.orchestrationPayload,
    triggerOptions,
  } as const;
}

async function migrateDatabase(url: string): Promise<void> {
  const environment = {
    ...process.env,
    DATABASE_URL: url,
    TEST_DATABASE_URL: url,
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
