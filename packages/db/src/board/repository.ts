import { randomBytes, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

export type BoardWorkflowStatus =
  "shadow" | "queued" | "running" | "superseding" | "succeeded" | "failed" | "canceled" | "superseded";

export type BoardTaskStatus =
  | "blocked"
  | "queued"
  | "leased"
  | "retry_wait"
  | "waiting_external"
  | "succeeded"
  | "failed"
  | "canceled"
  | "superseded";

export interface BoardAdmissionTask {
  readonly id?: string;
  readonly parentTaskId?: string;
  readonly taskType: string;
  readonly topic?: string;
  readonly status: Extract<BoardTaskStatus, "blocked" | "queued">;
  readonly priority?: number;
  readonly availableAt?: Date;
  readonly maxAttempts: number;
  readonly deliveryId?: string;
  readonly deliveryIdempotencyKey?: string;
  readonly required?: boolean;
  readonly cleanupTask?: boolean;
  readonly enqueueTraceparent?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface BoardAdmissionDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly condition: "success" | "terminal";
  readonly required?: boolean;
  readonly relationship: string;
}

export interface AdmitBoardWorkflowInput {
  readonly workflowId?: string;
  readonly tenantId: string;
  readonly workflowType: string;
  readonly pipelineVersion: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly dedupeKey: string;
  readonly concurrencyKey: string;
  readonly status?: Extract<BoardWorkflowStatus, "shadow" | "queued">;
  readonly epoch?: number;
  readonly triggerType: string;
  readonly traceId?: string;
  readonly admissionTraceparent?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly tasks: readonly BoardAdmissionTask[];
  readonly dependencies?: readonly BoardAdmissionDependency[];
  readonly actorType?: string;
  readonly actorId?: string;
}

export interface BoardAdmissionResult {
  readonly workflowId: string;
  readonly traceId: string;
  readonly replayed: boolean;
  readonly taskIds: readonly string[];
}

export interface ExistingBoardAdmission extends BoardAdmissionResult {
  readonly workflowType: string;
  readonly pipelineVersion: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly concurrencyKey: string;
}

interface ExistingWorkflowRow {
  readonly id: string;
  readonly workflow_type: string;
  readonly pipeline_version: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly concurrency_key: string;
  readonly trace_id: string;
}

export class RelationalBoardRepository {
  async findAdmissionByDedupe(
    client: PoolClient,
    input: { readonly tenantId: string; readonly dedupeKey: string }
  ): Promise<ExistingBoardAdmission | undefined> {
    const existing = await client.query<ExistingWorkflowRow>(
      `select id,workflow_type,pipeline_version,subject_type,subject_id,concurrency_key,trace_id
       from jina_runtime.board_workflows
       where tenant_id=$1 and dedupe_key=$2
       for update`,
      [input.tenantId, input.dedupeKey]
    );
    const workflow = existing.rows[0];
    if (!workflow) return undefined;
    const tasks = await client.query<{ id: string }>(
      "select id from jina_runtime.board_tasks where workflow_id=$1 order by created_at,id",
      [workflow.id]
    );
    return {
      workflowId: workflow.id,
      workflowType: workflow.workflow_type,
      pipelineVersion: workflow.pipeline_version,
      subjectType: workflow.subject_type,
      subjectId: workflow.subject_id,
      concurrencyKey: workflow.concurrency_key,
      traceId: workflow.trace_id,
      replayed: true,
      taskIds: tasks.rows.map((task) => task.id)
    };
  }

  async admitWorkflow(client: PoolClient, input: AdmitBoardWorkflowInput): Promise<BoardAdmissionResult> {
    const normalized = normalizeAdmission(input);
    const inserted = await client.query<{ id: string; trace_id: string }>(
      `insert into jina_runtime.board_workflows
         (id,tenant_id,workflow_type,pipeline_version,subject_type,subject_id,dedupe_key,
          concurrency_key,status,epoch,trigger_type,trace_id,admission_traceparent,metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
       on conflict (tenant_id,dedupe_key) do nothing
       returning id,trace_id`,
      [
        normalized.workflowId,
        normalized.tenantId,
        normalized.workflowType,
        normalized.pipelineVersion,
        normalized.subjectType,
        normalized.subjectId,
        normalized.dedupeKey,
        normalized.concurrencyKey,
        normalized.status,
        normalized.epoch,
        normalized.triggerType,
        normalized.traceId,
        normalized.admissionTraceparent ?? null,
        JSON.stringify(normalized.metadata)
      ]
    );

    const created = inserted.rows[0];
    if (!created) {
      return this.replayedAdmission(client, normalized);
    }

    for (const task of normalized.tasks) {
      await client.query(
        `insert into jina_runtime.board_tasks
           (id,tenant_id,workflow_id,parent_task_id,task_type,topic,status,priority,available_at,
            attempt_count,max_attempts,delivery_id,delivery_idempotency_key,required,cleanup_task,pipeline_version,
            enqueue_traceparent,metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
        [
          task.id,
          normalized.tenantId,
          normalized.workflowId,
          task.parentTaskId ?? null,
          task.taskType,
          task.topic ?? null,
          task.status,
          task.priority,
          task.availableAt ?? null,
          task.status === "queued" ? 1 : 0,
          task.maxAttempts,
          task.deliveryId ?? null,
          task.deliveryIdempotencyKey ?? null,
          task.required,
          task.cleanupTask,
          normalized.pipelineVersion,
          task.enqueueTraceparent ?? null,
          JSON.stringify(task.metadata)
        ]
      );
      await appendEvent(client, {
        tenantId: normalized.tenantId,
        workflowId: normalized.workflowId,
        taskId: task.id,
        eventType: "task.created",
        actorType: normalized.actorType,
        actorId: normalized.actorId,
        traceId: normalized.traceId,
        payload: {
          schema_version: 1,
          task_type: task.taskType,
          topic: task.topic,
          status: task.status,
          max_attempts: task.maxAttempts,
          delivery_id: task.deliveryId,
          required: task.required,
          cleanup_task: task.cleanupTask
        }
      });
      if (task.status === "queued") {
        await appendEvent(client, {
          tenantId: normalized.tenantId,
          workflowId: normalized.workflowId,
          taskId: task.id,
          eventType: "task.queued",
          actorType: normalized.actorType,
          actorId: normalized.actorId,
          traceId: normalized.traceId,
          payload: { schema_version: 1, available_at: task.availableAt?.toISOString() }
        });
      }
    }

    for (const dependency of normalized.dependencies) {
      await client.query(
        `insert into jina_runtime.board_dependencies
           (tenant_id,workflow_id,task_id,depends_on_task_id,condition,required,relationship)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          normalized.tenantId,
          normalized.workflowId,
          dependency.taskId,
          dependency.dependsOnTaskId,
          dependency.condition,
          dependency.required,
          dependency.relationship
        ]
      );
      await appendEvent(client, {
        tenantId: normalized.tenantId,
        workflowId: normalized.workflowId,
        taskId: dependency.taskId,
        eventType: "task.dependency_added",
        actorType: normalized.actorType,
        actorId: normalized.actorId,
        traceId: normalized.traceId,
        payload: {
          schema_version: 1,
          depends_on_task_id: dependency.dependsOnTaskId,
          condition: dependency.condition,
          required: dependency.required,
          relationship: dependency.relationship
        }
      });
    }

    await appendEvent(client, {
      tenantId: normalized.tenantId,
      workflowId: normalized.workflowId,
      eventType: "workflow.admitted",
      actorType: normalized.actorType,
      actorId: normalized.actorId,
      traceId: normalized.traceId,
      payload: {
        schema_version: 1,
        workflow_type: normalized.workflowType,
        pipeline_version: normalized.pipelineVersion,
        trigger_type: normalized.triggerType,
        status: normalized.status
      }
    });

    return {
      workflowId: created.id,
      traceId: created.trace_id,
      replayed: false,
      taskIds: normalized.tasks.map((task) => task.id)
    };
  }

  private async replayedAdmission(client: PoolClient, input: NormalizedBoardAdmission): Promise<BoardAdmissionResult> {
    const workflow = await this.findAdmissionByDedupe(client, {
      tenantId: input.tenantId,
      dedupeKey: input.dedupeKey
    });
    if (!workflow) {
      throw new Error("Board workflow dedupe conflict disappeared during admission");
    }
    if (
      workflow.workflowType !== input.workflowType ||
      workflow.pipelineVersion !== input.pipelineVersion ||
      workflow.subjectType !== input.subjectType ||
      workflow.subjectId !== input.subjectId ||
      workflow.concurrencyKey !== input.concurrencyKey
    ) {
      throw new BoardAdmissionConflictError(workflow.workflowId);
    }
    return {
      workflowId: workflow.workflowId,
      traceId: workflow.traceId,
      replayed: true,
      taskIds: workflow.taskIds
    };
  }
}

export class BoardAdmissionConflictError extends Error {
  constructor(readonly workflowId: string) {
    super(`Board workflow ${workflowId} conflicts with replayed admission`);
    this.name = "BoardAdmissionConflictError";
  }
}

interface NormalizedBoardAdmission {
  readonly workflowId: string;
  readonly tenantId: string;
  readonly workflowType: string;
  readonly pipelineVersion: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly dedupeKey: string;
  readonly concurrencyKey: string;
  readonly status: Extract<BoardWorkflowStatus, "shadow" | "queued">;
  readonly epoch: number;
  readonly triggerType: string;
  readonly traceId: string;
  readonly admissionTraceparent?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tasks: readonly NormalizedAdmissionTask[];
  readonly dependencies: readonly Required<BoardAdmissionDependency>[];
  readonly actorType: string;
  readonly actorId: string;
}

interface NormalizedAdmissionTask {
  readonly id: string;
  readonly parentTaskId?: string;
  readonly taskType: string;
  readonly topic?: string;
  readonly status: Extract<BoardTaskStatus, "blocked" | "queued">;
  readonly priority: number;
  readonly availableAt?: Date;
  readonly maxAttempts: number;
  readonly deliveryId?: string;
  readonly deliveryIdempotencyKey?: string;
  readonly required: boolean;
  readonly cleanupTask: boolean;
  readonly enqueueTraceparent?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function normalizeAdmission(input: AdmitBoardWorkflowInput): NormalizedBoardAdmission {
  const taskIds = new Set<string>();
  const tasks = input.tasks.map((task) => {
    const id = task.id ?? randomUUID();
    if (taskIds.has(id)) throw new Error(`duplicate Board task id ${id}`);
    taskIds.add(id);
    if (!Number.isSafeInteger(task.maxAttempts) || task.maxAttempts < 1) {
      throw new Error(`Board task ${id} maxAttempts must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(task.priority ?? 0)) {
      throw new Error(`Board task ${id} priority must be a safe integer`);
    }
    const availableAt = task.status === "queued" ? (task.availableAt ?? new Date()) : undefined;
    if (task.status === "blocked" && task.availableAt) {
      throw new Error(`blocked Board task ${id} cannot have availableAt`);
    }
    const deliveryId = task.status === "queued" ? (task.deliveryId ?? `outbox_${id}_1`) : task.deliveryId;
    const deliveryIdempotencyKey = deliveryId === undefined ? undefined : (task.deliveryIdempotencyKey ?? `${id}:1`);
    return {
      id,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      taskType: requiredText(task.taskType, "taskType"),
      ...(task.topic ? { topic: requiredText(task.topic, "topic") } : {}),
      status: task.status,
      priority: task.priority ?? 0,
      ...(availableAt ? { availableAt } : {}),
      maxAttempts: task.maxAttempts,
      ...(deliveryId ? { deliveryId } : {}),
      ...(deliveryIdempotencyKey ? { deliveryIdempotencyKey } : {}),
      required: task.required ?? true,
      cleanupTask: task.cleanupTask ?? false,
      ...(task.enqueueTraceparent ? { enqueueTraceparent: task.enqueueTraceparent } : {}),
      metadata: task.metadata ?? {}
    };
  });
  for (const task of tasks) {
    if (task.parentTaskId && !taskIds.has(task.parentTaskId)) {
      throw new Error(`Board task ${task.id} references unknown parent ${task.parentTaskId}`);
    }
  }

  const dependencies = (input.dependencies ?? []).map((dependency) => {
    if (!taskIds.has(dependency.taskId) || !taskIds.has(dependency.dependsOnTaskId)) {
      throw new Error("Board dependency references a task outside the admission");
    }
    if (dependency.taskId === dependency.dependsOnTaskId) {
      throw new Error(`Board task ${dependency.taskId} cannot depend on itself`);
    }
    return {
      ...dependency,
      required: dependency.required ?? true,
      relationship: requiredText(dependency.relationship, "dependency relationship")
    };
  });

  return {
    workflowId: input.workflowId ?? randomUUID(),
    tenantId: requiredText(input.tenantId, "tenantId"),
    workflowType: requiredText(input.workflowType, "workflowType"),
    pipelineVersion: requiredText(input.pipelineVersion, "pipelineVersion"),
    subjectType: requiredText(input.subjectType, "subjectType"),
    subjectId: requiredText(input.subjectId, "subjectId"),
    dedupeKey: requiredText(input.dedupeKey, "dedupeKey"),
    concurrencyKey: requiredText(input.concurrencyKey, "concurrencyKey"),
    status: input.status ?? "queued",
    epoch: positiveInteger(input.epoch ?? 1, "epoch"),
    triggerType: requiredText(input.triggerType, "triggerType"),
    traceId: input.traceId ?? randomBytes(16).toString("hex"),
    ...(input.admissionTraceparent ? { admissionTraceparent: input.admissionTraceparent } : {}),
    metadata: input.metadata ?? {},
    tasks,
    dependencies,
    actorType: requiredText(input.actorType ?? "system", "actorType"),
    actorId: requiredText(input.actorId ?? "review-admission", "actorId")
  };
}

async function appendEvent(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly workflowId: string;
    readonly taskId?: string;
    readonly eventType: string;
    readonly actorType: string;
    readonly actorId: string;
    readonly traceId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }
): Promise<void> {
  await client.query(
    `insert into jina_runtime.board_events
       (tenant_id,workflow_id,task_id,event_type,actor_type,actor_id,trace_id,payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.tenantId,
      input.workflowId,
      input.taskId ?? null,
      input.eventType,
      input.actorType,
      input.actorId,
      input.traceId,
      JSON.stringify(input.payload)
    ]
  );
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}
