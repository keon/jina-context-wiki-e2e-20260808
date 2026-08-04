import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

export interface ClaimRelationalBoardTaskInput {
  readonly topics: readonly string[];
  readonly workerId: string;
  readonly workerService: "jina-context-worker" | "jina-causal-graph-worker" | "jina-task-worker";
  readonly workerRelease: string;
  readonly workerRevision: string;
  readonly leaseDurationMs: number;
  readonly tenantId?: string;
  readonly requireReleaseGate?: boolean;
}

export interface ClaimedRelationalBoardTask {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly pipelineVersion: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly topic: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly claim: number;
  readonly attemptId: string;
  readonly deliveryId: string;
  readonly leaseId: string;
  readonly writeFenceToken: string;
  readonly leaseExpiresAt: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly metadata: Record<string, unknown>;
  readonly workflowMetadata: Record<string, unknown>;
  readonly dependencyResults: readonly RelationalBoardDependencyResult[];
}

export interface RelationalBoardDependencyResult {
  readonly taskId: string;
  readonly taskType: string;
  readonly status: string;
  readonly resultArtifact?: Record<string, unknown>;
  readonly resultDigest?: string;
}

export interface RelationalBoardFenceInput {
  readonly deliveryId: string;
  readonly leaseId: string;
  readonly writeFenceToken: string;
  readonly leaseDurationMs?: number;
}

export interface CompleteRelationalBoardTaskInput extends RelationalBoardFenceInput {
  readonly resultArtifact?: Readonly<Record<string, unknown>>;
  readonly resultDigest: string;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly usageDigest: string;
  readonly completionTraceparent?: string;
}

export interface RetryRelationalBoardTaskInput extends RelationalBoardFenceInput {
  readonly failureCategory: string;
  readonly diagnostic: string;
  readonly retryDelayMs: number;
}

export type FailRelationalBoardTaskInput = Omit<RetryRelationalBoardTaskInput, "retryDelayMs">;

export interface RelationalBoardMutationResult {
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly workflowId?: string;
  readonly taskId?: string;
  readonly terminal?: boolean;
  readonly leaseExpiresAt?: string;
}

interface CandidateWorkflowRow {
  readonly workflow_id: string;
}

interface WorkflowRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workflow_type: string;
  readonly pipeline_version: string;
  readonly status: string;
  readonly trace_id: string;
  readonly metadata: Record<string, unknown>;
}

interface DependencyResultRow {
  readonly id: string;
  readonly task_type: string;
  readonly status: string;
  readonly result_artifact: Record<string, unknown> | null;
  readonly result_digest: string | null;
}

interface TaskRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workflow_id: string;
  readonly task_type: string;
  readonly topic: string | null;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly delivery_id: string | null;
  readonly delivery_idempotency_key: string | null;
  readonly current_attempt_id: string | null;
  readonly metadata: Record<string, unknown>;
}

interface AttemptLocatorRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workflow_id: string;
  readonly task_id: string;
  readonly attempt_number: number;
  readonly claim_number: number;
  readonly lease_id: string;
  readonly status: string;
  readonly lease_active: boolean;
}

export class RelationalBoardWorkerRepository {
  async claimTask(
    client: PoolClient,
    input: ClaimRelationalBoardTaskInput
  ): Promise<ClaimedRelationalBoardTask | undefined> {
    const topics = normalizedTopics(input.topics);
    const leaseDurationMs = positiveDuration(input.leaseDurationMs, "leaseDurationMs");
    if (input.requireReleaseGate) await verifyReleaseGate(client, input);

    const candidates = await client.query<CandidateWorkflowRow>(
      `select candidate.workflow_id
       from (
         select distinct on (task.workflow_id)
                task.workflow_id,task.priority,
                coalesce(task.available_at,attempt.lease_expires_at) ready_at,task.created_at,task.id
         from jina_runtime.board_tasks task
         join jina_runtime.board_workflows workflow on workflow.id=task.workflow_id
         left join jina_runtime.board_attempts attempt on attempt.id=task.current_attempt_id
         where task.topic=any($1::text[])
           and ($2::text is null or task.tenant_id=$2)
           and workflow.status in ('queued','running')
           and (
             (task.status in ('queued','retry_wait') and task.available_at <= clock_timestamp())
             or
             (task.status='leased' and attempt.status='leased'
               and attempt.lease_expires_at <= clock_timestamp())
           )
         order by task.workflow_id,task.priority desc,
                  coalesce(task.available_at,attempt.lease_expires_at),task.created_at,task.id
       ) candidate
       order by candidate.priority desc,candidate.ready_at,candidate.created_at,candidate.id
       limit 32`,
      [topics, input.tenantId ?? null]
    );

    for (const candidate of candidates.rows) {
      const workflow = await lockWorkflow(client, candidate.workflow_id);
      if (!workflow || !["queued", "running"].includes(workflow.status)) continue;
      const selected = await client.query<TaskRow>(
        `select task.*
         from jina_runtime.board_tasks task
         where task.workflow_id=$1
           and task.topic=any($2::text[])
           and ($3::text is null or task.tenant_id=$3)
           and (
             (task.status in ('queued','retry_wait') and task.available_at <= clock_timestamp())
             or
             (task.status='leased' and exists (
               select 1 from jina_runtime.board_attempts attempt
               where attempt.id=task.current_attempt_id
                 and attempt.status='leased'
                 and attempt.lease_expires_at <= clock_timestamp()
             ))
           )
         order by task.priority desc,task.available_at nulls last,task.created_at,task.id
         for update skip locked
         limit 1`,
        [workflow.id, topics, input.tenantId ?? null]
      );
      const task = selected.rows[0];
      if (!task?.topic) continue;

      if (task.status === "leased" && task.current_attempt_id) {
        const expired = await client.query<AttemptLocatorRow>(
          `update jina_runtime.board_attempts
              set status='expired',finished_at=clock_timestamp()
            where id=$1 and status='leased' and lease_expires_at <= clock_timestamp()
            returning id,tenant_id,workflow_id,task_id,attempt_number,claim_number,lease_id,status,
                      false lease_active`,
          [task.current_attempt_id]
        );
        const prior = expired.rows[0];
        if (!prior) continue;
        await appendWorkerEvent(client, {
          workflow,
          taskId: task.id,
          attemptId: prior.id,
          eventType: "attempt.lease_expired",
          actorId: input.workerId,
          payload: {
            schema_version: 1,
            delivery_id: task.delivery_id,
            attempt: prior.attempt_number,
            claim: prior.claim_number
          }
        });
      }

      if (task.attempt_count < 1 || task.attempt_count > task.max_attempts) {
        throw new Error(`Board task ${task.id} has invalid attempt state`);
      }
      const deliveryId = task.delivery_id ?? `outbox_${task.id}_${task.attempt_count}`;
      const deliveryIdempotencyKey = task.delivery_idempotency_key ?? `${task.id}:${task.attempt_count}`;
      const claimNumber = await nextClaimNumber(client, task.id);
      const attemptId = randomUUID();
      const leaseId = randomUUID();
      const fenceToken = randomBytes(32).toString("base64url");
      const spanId = randomBytes(8).toString("hex");
      const inserted = await client.query<{ lease_expires_at: Date }>(
        `insert into jina_runtime.board_attempts
           (id,tenant_id,workflow_id,task_id,delivery_id,delivery_idempotency_key,
            attempt_number,claim_number,worker_id,worker_service,worker_release,worker_revision,
            lease_id,fence_token_hash,lease_expires_at,status,trace_id,span_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 clock_timestamp()+($15::bigint*interval '1 millisecond'),'leased',$16,$17)
         returning lease_expires_at`,
        [
          attemptId,
          workflow.tenant_id,
          workflow.id,
          task.id,
          deliveryId,
          deliveryIdempotencyKey,
          task.attempt_count,
          claimNumber,
          requiredText(input.workerId, "workerId"),
          input.workerService,
          requiredText(input.workerRelease, "workerRelease"),
          requiredText(input.workerRevision, "workerRevision"),
          leaseId,
          fenceHash(fenceToken),
          leaseDurationMs,
          workflow.trace_id,
          spanId
        ]
      );
      const leaseExpiresAt = inserted.rows[0]!.lease_expires_at;
      await client.query(
        `update jina_runtime.board_tasks
            set status='leased',current_attempt_id=$2,available_at=null,
                delivery_id=$3,delivery_idempotency_key=$4,
                started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp()
          where id=$1`,
        [task.id, attemptId, deliveryId, deliveryIdempotencyKey]
      );
      await client.query(
        `update jina_runtime.board_workflows
            set status='running',started_at=coalesce(started_at,clock_timestamp()),
                updated_at=clock_timestamp()
          where id=$1`,
        [workflow.id]
      );
      await appendWorkerEvent(client, {
        workflow,
        taskId: task.id,
        attemptId,
        eventType: "task.claimed",
        actorId: input.workerId,
        spanId,
        payload: {
          schema_version: 1,
          delivery_id: deliveryId,
          topic: task.topic,
          attempt: task.attempt_count,
          claim: claimNumber,
          worker_service: input.workerService,
          worker_release: input.workerRelease,
          worker_revision: input.workerRevision
        }
      });
      await appendWorkerEvent(client, {
        workflow,
        taskId: task.id,
        attemptId,
        eventType: "attempt.started",
        actorId: input.workerId,
        spanId,
        payload: {
          schema_version: 1,
          delivery_id: deliveryId,
          attempt: task.attempt_count,
          claim: claimNumber,
          lease_expires_at: leaseExpiresAt.toISOString()
        }
      });

      const dependencyRows = await client.query<DependencyResultRow>(
        `select prerequisite.id,prerequisite.task_type,prerequisite.status,
                prerequisite.result_artifact,prerequisite.result_digest
         from jina_runtime.board_dependencies dependency
         join jina_runtime.board_tasks prerequisite on prerequisite.id=dependency.depends_on_task_id
         where dependency.task_id=$1
         order by prerequisite.created_at,prerequisite.id`,
        [task.id]
      );

      return {
        tenantId: workflow.tenant_id,
        workflowId: workflow.id,
        workflowType: workflow.workflow_type,
        pipelineVersion: workflow.pipeline_version,
        taskId: task.id,
        taskType: task.task_type,
        topic: task.topic,
        attempt: task.attempt_count,
        maxAttempts: task.max_attempts,
        claim: claimNumber,
        attemptId,
        deliveryId,
        leaseId,
        writeFenceToken: fenceToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        traceId: workflow.trace_id,
        spanId,
        metadata: task.metadata,
        workflowMetadata: workflow.metadata,
        dependencyResults: dependencyRows.rows.map((dependency) => ({
          taskId: dependency.id,
          taskType: dependency.task_type,
          status: dependency.status,
          ...(dependency.result_artifact ? { resultArtifact: dependency.result_artifact } : {}),
          ...(dependency.result_digest ? { resultDigest: dependency.result_digest } : {})
        }))
      };
    }
    return undefined;
  }

  async renewAttempt(client: PoolClient, input: RelationalBoardFenceInput): Promise<RelationalBoardMutationResult> {
    const leaseDurationMs = positiveDuration(input.leaseDurationMs ?? 60_000, "leaseDurationMs");
    const locked = await lockAttemptByFence(client, input);
    if (!locked) return { accepted: false, replayed: false };
    const renewed = await client.query<{ lease_expires_at: Date }>(
      `update jina_runtime.board_attempts
          set lease_expires_at=clock_timestamp()+($2::bigint*interval '1 millisecond'),
              last_renewed_at=clock_timestamp()
        where id=$1 and status='leased' and lease_expires_at > clock_timestamp()
        returning lease_expires_at`,
      [locked.attempt.id, leaseDurationMs]
    );
    const row = renewed.rows[0];
    return row
      ? {
          accepted: true,
          replayed: false,
          workflowId: locked.workflow.id,
          taskId: locked.task.id,
          leaseExpiresAt: row.lease_expires_at.toISOString()
        }
      : { accepted: false, replayed: false };
  }

  async releaseAttempt(client: PoolClient, input: RelationalBoardFenceInput): Promise<RelationalBoardMutationResult> {
    const locked = await lockAttemptByFence(client, input);
    if (!locked) return { accepted: false, replayed: false };
    const released = await client.query(
      `update jina_runtime.board_attempts
          set status='released',finished_at=clock_timestamp()
        where id=$1 and status='leased' and lease_expires_at > clock_timestamp()
        returning id`,
      [locked.attempt.id]
    );
    if (released.rowCount !== 1) return { accepted: false, replayed: false };
    await client.query(
      `update jina_runtime.board_tasks
          set status='queued',current_attempt_id=null,available_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=$1 and current_attempt_id=$2`,
      [locked.task.id, locked.attempt.id]
    );
    await appendWorkerEvent(client, {
      workflow: locked.workflow,
      taskId: locked.task.id,
      attemptId: locked.attempt.id,
      eventType: "attempt.released",
      actorId: locked.attempt.id,
      payload: {
        schema_version: 1,
        delivery_id: input.deliveryId,
        attempt: locked.attempt.attempt_number,
        claim: locked.attempt.claim_number
      }
    });
    return {
      accepted: true,
      replayed: false,
      workflowId: locked.workflow.id,
      taskId: locked.task.id,
      terminal: false
    };
  }

  async completeAttempt(
    client: PoolClient,
    input: CompleteRelationalBoardTaskInput
  ): Promise<RelationalBoardMutationResult> {
    requireSha256(input.resultDigest, "resultDigest");
    requireSha256(input.usageDigest, "usageDigest");
    const located = await locateAttempt(client, input.deliveryId, input.leaseId);
    if (!located) return { accepted: false, replayed: false };
    const locked = await lockLocatedAttempt(client, located, input.writeFenceToken);
    if (!locked) return { accepted: false, replayed: false };
    if (locked.attempt.status === "succeeded" && locked.task.status === "succeeded") {
      const replay = await client.query(
        `select 1 from jina_runtime.board_tasks
         where id=$1 and result_digest=$2 and usage_digest=$3`,
        [locked.task.id, input.resultDigest, input.usageDigest]
      );
      return {
        accepted: replay.rowCount === 1,
        replayed: replay.rowCount === 1,
        workflowId: locked.workflow.id,
        taskId: locked.task.id,
        terminal: true
      };
    }
    if (!activeFence(locked)) return { accepted: false, replayed: false };

    await client.query(
      `update jina_runtime.board_attempts
          set status='succeeded',finished_at=clock_timestamp(),usage=$2::jsonb
        where id=$1`,
      [locked.attempt.id, JSON.stringify(input.usage ?? {})]
    );
    await client.query(
      `update jina_runtime.board_tasks
          set status='succeeded',current_attempt_id=null,available_at=null,
              completed_at=clock_timestamp(),updated_at=clock_timestamp(),
              result_artifact=$2::jsonb,result_digest=$3,usage_digest=$4,
              completion_traceparent=$5
        where id=$1`,
      [
        locked.task.id,
        input.resultArtifact ? JSON.stringify(input.resultArtifact) : null,
        input.resultDigest,
        input.usageDigest,
        input.completionTraceparent ?? null
      ]
    );
    await appendWorkerEvent(client, {
      workflow: locked.workflow,
      taskId: locked.task.id,
      attemptId: locked.attempt.id,
      eventType: "task.completed",
      actorId: locked.attempt.id,
      payload: {
        schema_version: 1,
        delivery_id: input.deliveryId,
        attempt: locked.attempt.attempt_number,
        claim: locked.attempt.claim_number,
        result_digest: input.resultDigest,
        usage_digest: input.usageDigest
      }
    });
    await reduceWorkflow(client, locked.workflow);
    return {
      accepted: true,
      replayed: false,
      workflowId: locked.workflow.id,
      taskId: locked.task.id,
      terminal: true
    };
  }

  async retryAttempt(client: PoolClient, input: RetryRelationalBoardTaskInput): Promise<RelationalBoardMutationResult> {
    const retryDelayMs = nonNegativeDuration(input.retryDelayMs, "retryDelayMs");
    const locked = await lockAttemptByFence(client, input);
    if (!locked || !activeFence(locked)) return { accepted: false, replayed: false };
    const terminal = locked.task.attempt_count >= locked.task.max_attempts;
    await client.query(
      `update jina_runtime.board_attempts
          set status='failed',finished_at=clock_timestamp(),failure_category=$2,diagnostic=$3
        where id=$1`,
      [locked.attempt.id, requiredText(input.failureCategory, "failureCategory"), boundedDiagnostic(input.diagnostic)]
    );
    if (terminal) {
      await client.query(
        `update jina_runtime.board_tasks
            set status='failed',current_attempt_id=null,available_at=null,
                completed_at=clock_timestamp(),updated_at=clock_timestamp()
          where id=$1`,
        [locked.task.id]
      );
      await appendWorkerEvent(client, {
        workflow: locked.workflow,
        taskId: locked.task.id,
        attemptId: locked.attempt.id,
        eventType: "task.retry_exhausted",
        actorId: locked.attempt.id,
        payload: {
          schema_version: 1,
          delivery_id: input.deliveryId,
          attempt: locked.task.attempt_count,
          max_attempts: locked.task.max_attempts,
          failure_category: input.failureCategory
        }
      });
    } else {
      const nextAttempt = locked.task.attempt_count + 1;
      await client.query(
        `update jina_runtime.board_tasks
            set status='retry_wait',current_attempt_id=null,
                attempt_count=$2,delivery_id=$3,delivery_idempotency_key=$4,
                available_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),
                updated_at=clock_timestamp()
          where id=$1`,
        [
          locked.task.id,
          nextAttempt,
          `outbox_${locked.task.id}_${nextAttempt}`,
          `${locked.task.id}:${nextAttempt}`,
          retryDelayMs
        ]
      );
      await appendWorkerEvent(client, {
        workflow: locked.workflow,
        taskId: locked.task.id,
        attemptId: locked.attempt.id,
        eventType: "task.retry_scheduled",
        actorId: locked.attempt.id,
        payload: {
          schema_version: 1,
          delivery_id: input.deliveryId,
          attempt: locked.task.attempt_count,
          next_attempt: nextAttempt,
          max_attempts: locked.task.max_attempts,
          retry_delay_ms: retryDelayMs,
          failure_category: input.failureCategory
        }
      });
    }
    await reduceWorkflow(client, locked.workflow);
    return {
      accepted: true,
      replayed: false,
      workflowId: locked.workflow.id,
      taskId: locked.task.id,
      terminal
    };
  }

  async failAttempt(client: PoolClient, input: FailRelationalBoardTaskInput): Promise<RelationalBoardMutationResult> {
    const locked = await lockAttemptByFence(client, input);
    if (!locked || !activeFence(locked)) return { accepted: false, replayed: false };
    await client.query(
      `update jina_runtime.board_attempts
          set status='failed',finished_at=clock_timestamp(),failure_category=$2,diagnostic=$3
        where id=$1`,
      [locked.attempt.id, requiredText(input.failureCategory, "failureCategory"), boundedDiagnostic(input.diagnostic)]
    );
    await client.query(
      `update jina_runtime.board_tasks
          set status='failed',current_attempt_id=null,available_at=null,
              completed_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=$1`,
      [locked.task.id]
    );
    await appendWorkerEvent(client, {
      workflow: locked.workflow,
      taskId: locked.task.id,
      attemptId: locked.attempt.id,
      eventType: "task.failed",
      actorId: locked.attempt.id,
      payload: {
        schema_version: 1,
        delivery_id: input.deliveryId,
        attempt: locked.attempt.attempt_number,
        claim: locked.attempt.claim_number,
        failure_category: input.failureCategory
      }
    });
    await reduceWorkflow(client, locked.workflow);
    return {
      accepted: true,
      replayed: false,
      workflowId: locked.workflow.id,
      taskId: locked.task.id,
      terminal: true
    };
  }
}

interface LockedAttempt {
  readonly workflow: WorkflowRow;
  readonly task: TaskRow;
  readonly attempt: AttemptLocatorRow;
}

async function locateAttempt(
  client: PoolClient,
  deliveryId: string,
  leaseId: string
): Promise<AttemptLocatorRow | undefined> {
  const located = await client.query<AttemptLocatorRow>(
    `select id,tenant_id,workflow_id,task_id,attempt_number,claim_number,lease_id,status,
            lease_expires_at > clock_timestamp() lease_active
     from jina_runtime.board_attempts
     where delivery_id=$1 and lease_id=$2::uuid
     order by claim_number desc
     limit 1`,
    [requiredText(deliveryId, "deliveryId"), requiredText(leaseId, "leaseId")]
  );
  return located.rows[0];
}

async function lockAttemptByFence(
  client: PoolClient,
  input: RelationalBoardFenceInput
): Promise<LockedAttempt | undefined> {
  const located = await locateAttempt(client, input.deliveryId, input.leaseId);
  return located ? lockLocatedAttempt(client, located, input.writeFenceToken) : undefined;
}

async function lockLocatedAttempt(
  client: PoolClient,
  located: AttemptLocatorRow,
  writeFenceToken: string
): Promise<LockedAttempt | undefined> {
  const workflow = await lockWorkflow(client, located.workflow_id, false);
  if (!workflow) return undefined;
  const task = await client.query<TaskRow>(
    "select * from jina_runtime.board_tasks where id=$1 and workflow_id=$2 for update",
    [located.task_id, workflow.id]
  );
  const attempt = await client.query<AttemptLocatorRow>(
    `select id,tenant_id,workflow_id,task_id,attempt_number,claim_number,lease_id,status,
            lease_expires_at > clock_timestamp() lease_active
     from jina_runtime.board_attempts
     where id=$1 and fence_token_hash=$2
     for update`,
    [located.id, fenceHash(requiredText(writeFenceToken, "writeFenceToken"))]
  );
  const taskRow = task.rows[0];
  const attemptRow = attempt.rows[0];
  return taskRow && attemptRow ? { workflow, task: taskRow, attempt: attemptRow } : undefined;
}

function activeFence(input: LockedAttempt): boolean {
  return (
    input.attempt.status === "leased" &&
    input.attempt.lease_active &&
    input.task.current_attempt_id === input.attempt.id
  );
}

async function lockWorkflow(
  client: PoolClient,
  workflowId: string,
  skipLocked = true
): Promise<WorkflowRow | undefined> {
  const workflow = await client.query<WorkflowRow>(
    `select id,tenant_id,workflow_type,pipeline_version,status,trace_id,metadata
     from jina_runtime.board_workflows
     where id=$1
     for update${skipLocked ? " skip locked" : ""}`,
    [workflowId]
  );
  return workflow.rows[0];
}

async function nextClaimNumber(client: PoolClient, taskId: string): Promise<number> {
  const result = await client.query<{ next_claim: number }>(
    `select coalesce(max(claim_number),0)::integer+1 next_claim
     from jina_runtime.board_attempts where task_id=$1`,
    [taskId]
  );
  return result.rows[0]!.next_claim;
}

async function reduceWorkflow(client: PoolClient, workflow: WorkflowRow): Promise<void> {
  for (;;) {
    const canceled = await client.query<{ id: string }>(
      `update jina_runtime.board_tasks task
          set status='canceled',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        where task.workflow_id=$1 and task.status='blocked'
          and exists (
            select 1
            from jina_runtime.board_dependencies dependency
            join jina_runtime.board_tasks prerequisite on prerequisite.id=dependency.depends_on_task_id
            where dependency.task_id=task.id and dependency.required
              and dependency.condition='success'
              and prerequisite.status in ('failed','canceled','superseded')
          )
        returning task.id`,
      [workflow.id]
    );
    for (const task of canceled.rows) {
      await appendWorkerEvent(client, {
        workflow,
        taskId: task.id,
        eventType: "task.canceled_failed_dependency",
        actorId: "board-reducer",
        payload: { schema_version: 1 }
      });
    }

    const ready = await client.query<{ id: string; attempt_count: number }>(
      `select task.id,task.attempt_count
       from jina_runtime.board_tasks task
       where task.workflow_id=$1 and task.status='blocked'
         and exists (
           select 1 from jina_runtime.board_dependencies dependency
           where dependency.task_id=task.id and dependency.required
         )
         and not exists (
           select 1
           from jina_runtime.board_dependencies dependency
           join jina_runtime.board_tasks prerequisite on prerequisite.id=dependency.depends_on_task_id
           where dependency.task_id=task.id and dependency.required
             and not (
               (dependency.condition='success' and prerequisite.status='succeeded')
               or
               (dependency.condition='terminal'
                 and prerequisite.status in ('succeeded','failed','canceled','superseded'))
             )
         )
       order by task.created_at,task.id
       for update`,
      [workflow.id]
    );
    for (const task of ready.rows) {
      const nextAttempt = task.attempt_count + 1;
      await client.query(
        `update jina_runtime.board_tasks
            set status='queued',attempt_count=$2,available_at=clock_timestamp(),
                delivery_id=$3,delivery_idempotency_key=$4,updated_at=clock_timestamp()
          where id=$1`,
        [task.id, nextAttempt, `outbox_${task.id}_${nextAttempt}`, `${task.id}:${nextAttempt}`]
      );
      await appendWorkerEvent(client, {
        workflow,
        taskId: task.id,
        eventType: "task.queued",
        actorId: "board-reducer",
        payload: { schema_version: 1, attempt: nextAttempt }
      });
    }
    if (canceled.rowCount === 0 && ready.rowCount === 0) break;
  }

  const state = await client.query<{ active: string; failed: string }>(
    `select
       count(*) filter (where status in ('blocked','queued','leased','retry_wait'))::text active,
       count(*) filter (where required and status in ('failed','canceled'))::text failed
     from jina_runtime.board_tasks where workflow_id=$1`,
    [workflow.id]
  );
  const counts = state.rows[0]!;
  if (counts.active !== "0") return;
  const status = counts.failed === "0" ? "succeeded" : "failed";
  const completed = await client.query(
    `update jina_runtime.board_workflows
        set status=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=$1 and status not in ('succeeded','failed','canceled','superseded')
      returning id`,
    [workflow.id, status]
  );
  if (completed.rowCount === 1) {
    await appendWorkerEvent(client, {
      workflow,
      eventType: "workflow.completed",
      actorId: "board-reducer",
      payload: { schema_version: 1, status }
    });
  }
}

async function appendWorkerEvent(
  client: PoolClient,
  input: {
    readonly workflow: WorkflowRow;
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly eventType: string;
    readonly actorId: string;
    readonly spanId?: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }
): Promise<void> {
  await client.query(
    `insert into jina_runtime.board_events
       (tenant_id,workflow_id,task_id,attempt_id,event_type,actor_type,actor_id,trace_id,span_id,payload)
     values ($1,$2,$3,$4,$5,'worker',$6,$7,$8,$9::jsonb)`,
    [
      input.workflow.tenant_id,
      input.workflow.id,
      input.taskId ?? null,
      input.attemptId ?? null,
      input.eventType,
      input.actorId,
      input.workflow.trace_id,
      input.spanId ?? null,
      JSON.stringify(input.payload)
    ]
  );
}

async function verifyReleaseGate(client: PoolClient, input: ClaimRelationalBoardTaskInput): Promise<void> {
  const column =
    input.workerService === "jina-context-worker"
      ? "context_worker_revision"
      : input.workerService === "jina-task-worker"
        ? "task_worker_revision"
        : undefined;
  const accepted = column
    ? await client.query(
        `select 1 from jina_runtime.release_control
         where id=1 and worker_claims_enabled and worker_accepts_claims
           and worker_release_id=$1 and ${column}=$2`,
        [input.workerRelease, input.workerRevision]
      )
    : await client.query(
        `select 1 from jina_runtime.causal_graph_release_control
         where id=1 and worker_claims_enabled and worker_release_id=$1 and worker_revision=$2`,
        [input.workerRelease, input.workerRevision]
      );
  if (accepted.rowCount !== 1) throw new RelationalBoardReleaseRejectedError();
}

export class RelationalBoardReleaseRejectedError extends Error {
  constructor() {
    super("worker release identity is not active for relational Board claims");
    this.name = "RelationalBoardReleaseRejectedError";
  }
}

function normalizedTopics(topics: readonly string[]): string[] {
  const normalized = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error("at least one Board topic is required");
  if (normalized.length > 32) throw new Error("Board claim cannot request more than 32 topics");
  return normalized;
}

function fenceHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) {
    throw new Error(`${label} must be a positive safe integer no greater than 24 hours`);
  }
  return value;
}

function nonNegativeDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60 * 1000) {
    throw new Error(`${label} must be a non-negative safe integer no greater than 24 hours`);
  }
  return value;
}

function requireSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function boundedDiagnostic(value: string): string {
  return value.trim().slice(0, 4096);
}
