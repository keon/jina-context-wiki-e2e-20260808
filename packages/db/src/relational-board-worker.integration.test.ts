import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { Pool } from "pg";

import { RelationalBoardRepository } from "./board/repository.js";
import { RelationalBoardWorkerRepository } from "./board/worker-repository.js";
import { JINA_RUNTIME_SCHEMA_SQL } from "./postgres-json-state-store.js";
import { applyRuntimeMigrations } from "./runtime-migrations.js";

// This test drops and recreates jina_runtime. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;

test("relational Board worker leases, fences, retries, and reduces workflows", { skip: !databaseUrl }, async () => {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "jina-relational-board-worker-test",
    max: 2
  });
  const admission = new RelationalBoardRepository();
  const worker = new RelationalBoardWorkerRepository();
  const workflowId = randomUUID();
  const prepareTaskId = randomUUID();
  const summaryTaskId = randomUUID();
  const runtimeTaskId = randomUUID();
  const finalizeTaskId = randomUUID();

  try {
    await pool.query("drop schema if exists jina_runtime cascade");
    await pool.query(JINA_RUNTIME_SCHEMA_SQL);
    await applyRuntimeMigrations(pool);

    await inTransaction(pool, (client) =>
      admission.admitWorkflow(client, {
        workflowId,
        tenantId: "tenant-worker-lifecycle",
        workflowType: "pr_review",
        pipelineVersion: "pr_review.v1",
        subjectType: "github_pull_request",
        subjectId: "321:7:head-sha",
        dedupeKey: "review:321:7:head-sha",
        concurrencyKey: "review:321:7",
        triggerType: "webhook",
        tasks: [
          {
            id: prepareTaskId,
            taskType: "prepare-review",
            topic: "prepare-review",
            status: "queued",
            maxAttempts: 3,
            metadata: { repository: "omxyz/jina" }
          },
          {
            id: summaryTaskId,
            parentTaskId: prepareTaskId,
            taskType: "summary-review",
            topic: "summary-review",
            status: "blocked",
            maxAttempts: 3
          },
          {
            id: runtimeTaskId,
            parentTaskId: prepareTaskId,
            taskType: "runtime-review",
            topic: "runtime-review",
            status: "blocked",
            maxAttempts: 3
          },
          {
            id: finalizeTaskId,
            parentTaskId: prepareTaskId,
            taskType: "finalize-review",
            topic: "finalize-review",
            status: "blocked",
            maxAttempts: 3
          }
        ],
        dependencies: [
          {
            taskId: summaryTaskId,
            dependsOnTaskId: prepareTaskId,
            condition: "success",
            relationship: "prepared-input"
          },
          {
            taskId: runtimeTaskId,
            dependsOnTaskId: prepareTaskId,
            condition: "success",
            relationship: "prepared-input"
          },
          {
            taskId: finalizeTaskId,
            dependsOnTaskId: summaryTaskId,
            condition: "success",
            relationship: "summary-result"
          },
          {
            taskId: finalizeTaskId,
            dependsOnTaskId: runtimeTaskId,
            condition: "success",
            relationship: "runtime-result"
          }
        ]
      })
    );

    const firstClaim = await claim(pool, worker, ["prepare-review", "summary-review", "runtime-review"]);
    assert.ok(firstClaim);
    assert.equal(firstClaim.taskId, prepareTaskId);
    assert.equal(firstClaim.attempt, 1);
    assert.equal(firstClaim.claim, 1);
    assert.deepEqual(firstClaim.metadata, { repository: "omxyz/jina" });

    const badRenew = await inTransaction(pool, (client) =>
      worker.renewAttempt(client, { ...fence(firstClaim), writeFenceToken: "incorrect-fence" })
    );
    assert.equal(badRenew.accepted, false);

    const renewed = await inTransaction(pool, (client) =>
      worker.renewAttempt(client, { ...fence(firstClaim), leaseDurationMs: 120_000 })
    );
    assert.equal(renewed.accepted, true);
    assert.ok(renewed.leaseExpiresAt);

    const released = await inTransaction(pool, (client) => worker.releaseAttempt(client, fence(firstClaim)));
    assert.equal(released.accepted, true);

    const secondClaim = await claim(pool, worker, ["prepare-review"]);
    assert.ok(secondClaim);
    assert.equal(secondClaim.taskId, prepareTaskId);
    assert.equal(secondClaim.deliveryId, firstClaim.deliveryId);
    assert.equal(secondClaim.attempt, 1);
    assert.equal(secondClaim.claim, 2);
    assert.notEqual(secondClaim.leaseId, firstClaim.leaseId);

    const staleRelease = await inTransaction(pool, (client) => worker.releaseAttempt(client, fence(firstClaim)));
    assert.equal(staleRelease.accepted, false);

    const prepared = await complete(pool, worker, secondClaim, "prepared");
    assert.equal(prepared.accepted, true);
    assert.equal(prepared.replayed, false);
    const preparedReplay = await complete(pool, worker, secondClaim, "prepared");
    assert.equal(preparedReplay.accepted, true);
    assert.equal(preparedReplay.replayed, true);
    const conflictingReplay = await complete(pool, worker, secondClaim, "different-result");
    assert.equal(conflictingReplay.accepted, false);

    const summaryClaim = await claim(pool, worker, ["summary-review"]);
    assert.ok(summaryClaim);
    assert.equal(summaryClaim.taskId, summaryTaskId);
    const retry = await inTransaction(pool, (client) =>
      worker.retryAttempt(client, {
        ...fence(summaryClaim),
        failureCategory: "provider_transient",
        diagnostic: "temporary upstream failure",
        retryDelayMs: 0
      })
    );
    assert.equal(retry.accepted, true);
    assert.equal(retry.terminal, false);

    const retriedSummary = await claim(pool, worker, ["summary-review"]);
    assert.ok(retriedSummary);
    assert.equal(retriedSummary.taskId, summaryTaskId);
    assert.equal(retriedSummary.attempt, 2);
    assert.equal(retriedSummary.claim, 2);
    assert.notEqual(retriedSummary.deliveryId, summaryClaim.deliveryId);
    assert.equal((await complete(pool, worker, retriedSummary, "summary")).accepted, true);

    const runtimeClaim = await claim(pool, worker, ["runtime-review"]);
    assert.ok(runtimeClaim);
    assert.equal(runtimeClaim.taskId, runtimeTaskId);
    assert.equal((await complete(pool, worker, runtimeClaim, "runtime")).accepted, true);

    const finalizeClaim = await claim(pool, worker, ["finalize-review"]);
    assert.ok(finalizeClaim);
    assert.equal(finalizeClaim.taskId, finalizeTaskId);
    assert.equal((await complete(pool, worker, finalizeClaim, "finalized")).accepted, true);
    const terminalReplay = await complete(pool, worker, finalizeClaim, "finalized");
    assert.equal(terminalReplay.accepted, true);
    assert.equal(terminalReplay.replayed, true);

    const state = await pool.query<{
      workflow_status: string;
      active_tasks: string;
      attempt_count: string;
      release_count: string;
      retry_count: string;
    }>(
      `select
         (select status from jina_runtime.board_workflows where id=$1) workflow_status,
         (select count(*)::text from jina_runtime.board_tasks
           where workflow_id=$1 and status in ('blocked','queued','leased','retry_wait')) active_tasks,
         (select count(*)::text from jina_runtime.board_attempts where workflow_id=$1) attempt_count,
         (select count(*)::text from jina_runtime.board_events
           where workflow_id=$1 and event_type='attempt.released') release_count,
         (select count(*)::text from jina_runtime.board_events
           where workflow_id=$1 and event_type='task.retry_scheduled') retry_count`,
      [workflowId]
    );
    assert.deepEqual(state.rows[0], {
      workflow_status: "succeeded",
      active_tasks: "0",
      attempt_count: "6",
      release_count: "1",
      retry_count: "1"
    });
  } finally {
    await pool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
    await pool.end();
  }
});

test(
  "relational Board external effects wait without holding a lease and replay lost responses",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "jina-relational-board-external-wait-test",
      max: 2
    });
    const admission = new RelationalBoardRepository();
    const worker = new RelationalBoardWorkerRepository();
    const tenantId = "tenant-external-wait";
    const workflowId = randomUUID();
    const taskId = randomUUID();
    const effectKey = `trigger-review:${workflowId}`;
    const requestDigest = digest("exact-trigger-request");

    try {
      await pool.query("drop schema if exists jina_runtime cascade");
      await pool.query(JINA_RUNTIME_SCHEMA_SQL);
      await applyRuntimeMigrations(pool);
      await inTransaction(pool, (client) =>
        admission.admitWorkflow(client, {
          workflowId,
          tenantId,
          workflowType: "pr_review",
          pipelineVersion: "pr_review.board.v2",
          subjectType: "github_pull_request",
          subjectId: "321:9:head-sha",
          dedupeKey: "review:321:9:head-sha",
          concurrencyKey: "review:321:9:head-sha",
          triggerType: "webhook",
          tasks: [
            {
              id: taskId,
              taskType: "review",
              topic: "run-review",
              status: "queued",
              maxAttempts: 2
            }
          ]
        })
      );

      const first = await claim(pool, worker, ["run-review"], tenantId);
      assert.ok(first);
      const startInput = {
        ...fence(first),
        transitionId: `${first.attemptId}:effect-start`,
        effectIdempotencyKey: effectKey,
        effectType: "trigger.review.dispatch",
        effectVersion: 1,
        provider: "trigger.dev",
        requestDigest,
        metadata: { trigger_task_id: "review" }
      } as const;
      const started = await inTransaction(pool, (client) => worker.beginEffectAttempt(client, startInput));
      assert.equal(started.accepted, true);
      assert.equal(started.replayed, false);
      assert.equal(started.effectReceipt?.status, "started");
      const startResponseLossReplay = await inTransaction(pool, (client) =>
        worker.beginEffectAttempt(client, startInput)
      );
      assert.equal(startResponseLossReplay.accepted, true);
      assert.equal(startResponseLossReplay.replayed, true);

      const waitInput = {
        ...fence(first),
        transitionId: `${first.attemptId}:provider-handoff`,
        effectIdempotencyKey: effectKey,
        requestDigest,
        providerId: "run_trigger_external_wait_12345678",
        providerStatus: "QUEUED",
        nextCheckAt: new Date(Date.now() + 60_000).toISOString()
      } as const;
      const waiting = await inTransaction(pool, (client) => worker.waitExternalAttempt(client, waitInput));
      assert.equal(waiting.accepted, true);
      assert.equal(waiting.effectReceipt?.status, "succeeded");
      assert.equal(waiting.effectReceipt?.providerId, waitInput.providerId);
      const waitResponseLossReplay = await inTransaction(pool, (client) =>
        worker.waitExternalAttempt(client, waitInput)
      );
      assert.equal(waitResponseLossReplay.accepted, true);
      assert.equal(waitResponseLossReplay.replayed, true);

      const durableWait = await pool.query<{
        status: string;
        current_attempt_id: string | null;
        attempt_count: number;
      }>("select status,current_attempt_id,attempt_count from jina_runtime.board_tasks where id=$1", [taskId]);
      assert.deepEqual(durableWait.rows[0], {
        status: "waiting_external",
        current_attempt_id: null,
        attempt_count: 1
      });
      assert.equal(await claim(pool, worker, ["run-review"], tenantId), undefined);
      await pool.query("update jina_runtime.board_tasks set available_at=clock_timestamp() where id=$1", [taskId]);

      const poll = await claim(pool, worker, ["run-review"], tenantId);
      assert.ok(poll);
      assert.equal(poll.attempt, 1);
      assert.equal(poll.claim, 2);
      assert.equal(poll.effectReceipts[0]?.providerId, waitInput.providerId);
      const rescheduleInput = {
        ...fence(poll),
        transitionId: `${poll.attemptId}:poll-reschedule`,
        effectIdempotencyKey: effectKey,
        providerId: waitInput.providerId,
        providerStatus: "EXECUTING",
        nextCheckAt: new Date(Date.now() + 60_000).toISOString()
      } as const;
      assert.equal(
        (await inTransaction(pool, (client) => worker.rescheduleExternalWait(client, rescheduleInput))).accepted,
        true
      );
      const rescheduleReplay = await inTransaction(pool, (client) =>
        worker.rescheduleExternalWait(client, rescheduleInput)
      );
      assert.equal(rescheduleReplay.accepted, true);
      assert.equal(rescheduleReplay.replayed, true);

      const staleMutation = await inTransaction(pool, (client) =>
        worker.beginEffectAttempt(client, {
          ...startInput,
          transitionId: `${first.attemptId}:stale-new-transition`
        })
      );
      assert.equal(staleMutation.accepted, false);

      await pool.query("update jina_runtime.board_tasks set available_at=clock_timestamp() where id=$1", [taskId]);
      const finalPoll = await claim(pool, worker, ["run-review"], tenantId);
      assert.ok(finalPoll);
      assert.equal(finalPoll.attempt, 1);
      assert.equal(finalPoll.claim, 3);
      assert.equal((await complete(pool, worker, finalPoll, "trigger-completed")).accepted, true);

      const terminal = await pool.query<{ workflow_status: string; task_status: string; attempt_count: number }>(
        `select
         (select status from jina_runtime.board_workflows where id=$1) workflow_status,
         (select status from jina_runtime.board_tasks where id=$2) task_status,
         (select attempt_count from jina_runtime.board_tasks where id=$2) attempt_count`,
        [workflowId, taskId]
      );
      assert.deepEqual(terminal.rows[0], {
        workflow_status: "succeeded",
        task_status: "succeeded",
        attempt_count: 1
      });

      const retryWorkflowId = randomUUID();
      const retryTaskId = randomUUID();
      const retryEffectKey = `trigger-review:${retryWorkflowId}`;
      await inTransaction(pool, (client) =>
        admission.admitWorkflow(client, {
          workflowId: retryWorkflowId,
          tenantId,
          workflowType: "pr_review",
          pipelineVersion: "pr_review.board.v2",
          subjectType: "github_pull_request",
          subjectId: "321:10:head-sha",
          dedupeKey: "review:321:10:head-sha",
          concurrencyKey: "review:321:10:head-sha",
          triggerType: "webhook",
          tasks: [
            {
              id: retryTaskId,
              taskType: "review",
              topic: "run-review",
              status: "queued",
              maxAttempts: 2
            }
          ]
        })
      );
      const dispatch = await claim(pool, worker, ["run-review"], tenantId);
      assert.ok(dispatch);
      const retryStart = {
        ...fence(dispatch),
        transitionId: `${dispatch.attemptId}:effect-start`,
        effectIdempotencyKey: retryEffectKey,
        effectType: "trigger.review.dispatch",
        effectVersion: 1,
        provider: "trigger.dev",
        requestDigest,
        metadata: {}
      } as const;
      assert.equal(
        (await inTransaction(pool, (client) => worker.beginEffectAttempt(client, retryStart))).accepted,
        true
      );
      const ambiguousInput = {
        ...retryStart,
        transitionId: `${dispatch.attemptId}:effect-ambiguous`,
        receiptStatus: "ambiguous" as const,
        failureCategory: "provider_timeout",
        diagnostic: "request acceptance is unknown",
        retryDelayMs: 0
      };
      const ambiguous = await inTransaction(pool, (client) => worker.failOrRetryEffectAttempt(client, ambiguousInput));
      assert.equal(ambiguous.accepted, true);
      assert.equal(ambiguous.terminal, false);
      assert.equal(ambiguous.effectReceipt?.status, "ambiguous");
      const ambiguousReplay = await inTransaction(pool, (client) =>
        worker.failOrRetryEffectAttempt(client, ambiguousInput)
      );
      assert.equal(ambiguousReplay.accepted, true);
      assert.equal(ambiguousReplay.replayed, true);

      const retryDispatch = await claim(pool, worker, ["run-review"], tenantId);
      assert.ok(retryDispatch);
      assert.equal(retryDispatch.attempt, 2);
      assert.equal(retryDispatch.effectReceipts[0]?.status, "ambiguous");
      const reopened = await inTransaction(pool, (client) =>
        worker.beginEffectAttempt(client, {
          ...retryStart,
          ...fence(retryDispatch),
          transitionId: `${retryDispatch.attemptId}:effect-reopen`
        })
      );
      assert.equal(reopened.accepted, true);
      assert.equal(reopened.effectReceipt?.status, "started");
      const exhausted = await inTransaction(pool, (client) =>
        worker.failOrRetryEffectAttempt(client, {
          ...retryStart,
          ...fence(retryDispatch),
          transitionId: `${retryDispatch.attemptId}:effect-failed`,
          receiptStatus: "failed",
          failureCategory: "provider_rejected",
          diagnostic: "definite failure",
          retryDelayMs: 0
        })
      );
      assert.equal(exhausted.accepted, true);
      assert.equal(exhausted.terminal, true);
      assert.equal(exhausted.effectReceipt?.status, "failed");

      const failedState = await pool.query<{ workflow_status: string; task_status: string; receipt_status: string }>(
        `select
         (select status from jina_runtime.board_workflows where id=$1) workflow_status,
         (select status from jina_runtime.board_tasks where id=$2) task_status,
         (select status from jina_runtime.board_effect_receipts where idempotency_key=$3) receipt_status`,
        [retryWorkflowId, retryTaskId, retryEffectKey]
      );
      assert.deepEqual(failedState.rows[0], {
        workflow_status: "failed",
        task_status: "failed",
        receipt_status: "failed"
      });
    } finally {
      await pool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
      await pool.end();
    }
  }
);

async function claim(
  pool: Pool,
  worker: RelationalBoardWorkerRepository,
  topics: readonly string[],
  tenantId = "tenant-worker-lifecycle"
) {
  return inTransaction(pool, (client) =>
    worker.claimTask(client, {
      topics,
      workerId: "worker-test-1",
      workerService: "jina-task-worker",
      workerRelease: "review-board-test",
      workerRevision: "revision-test",
      leaseDurationMs: 60_000,
      tenantId
    })
  );
}

function fence(claimed: NonNullable<Awaited<ReturnType<typeof claim>>>) {
  return {
    deliveryId: claimed.deliveryId,
    leaseId: claimed.leaseId,
    writeFenceToken: claimed.writeFenceToken
  };
}

async function complete(
  pool: Pool,
  worker: RelationalBoardWorkerRepository,
  claimed: NonNullable<Awaited<ReturnType<typeof claim>>>,
  result: string
) {
  return inTransaction(pool, (client) =>
    worker.completeAttempt(client, {
      ...fence(claimed),
      resultArtifact: { result },
      resultDigest: digest(result),
      usage: { model: "test", tokens: 1 },
      usageDigest: digest("usage:test:1")
    })
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function inTransaction<T>(pool: Pool, operation: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
