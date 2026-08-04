import { randomUUID } from "node:crypto";

import { RelationalBoardRepository } from "@jina/db";
import { activeTraceparent, parseTraceparent } from "@jina/observability";

import { ApiError } from "./errors.js";
import { withTransaction } from "./db.js";

const BILLING_RETRY_TASK_ID = "billing-retry";
const BILLING_RETRY_PIPELINE_VERSION = "billing_retry.board.v1";
const SCHEDULE_INTERVAL_MS = 15 * 60 * 1_000;

export async function admitScheduledBillingRetry(input: unknown): Promise<{
  id: string;
  replayed: boolean;
}> {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const scheduledAt = parseScheduledAt(value.schedule_time);
  const bucket = Math.floor(scheduledAt.getTime() / SCHEDULE_INTERVAL_MS);
  const workflowId = randomUUID();
  const taskId = randomUUID();
  const traceparent = activeTraceparent();
  const trace = traceparent ? parseTraceparent(traceparent) : undefined;
  const admitted = await withTransaction((client) =>
    new RelationalBoardRepository().admitWorkflow(client, {
      workflowId,
      tenantId: "system:billing",
      workflowType: "billing_retry",
      pipelineVersion: BILLING_RETRY_PIPELINE_VERSION,
      subjectType: "billing_retry_window",
      subjectId: String(bucket),
      dedupeKey: `billing-retry:${bucket}`,
      concurrencyKey: "billing-retry",
      triggerType: "cloud_scheduler",
      ...(trace ? { traceId: trace.traceId } : {}),
      ...(traceparent ? { admissionTraceparent: traceparent } : {}),
      metadata: {
        schema_version: 1,
        schedule_time: scheduledAt.toISOString(),
        schedule_bucket: bucket,
      },
      tasks: [{
        id: taskId,
        taskType: BILLING_RETRY_TASK_ID,
        topic: BILLING_RETRY_TASK_ID,
        status: "queued",
        maxAttempts: 3,
        metadata: { schema_version: 1 },
      }],
      actorType: "scheduler",
      actorId: "cloud-scheduler",
    }),
  );
  return { id: admitted.workflowId, replayed: admitted.replayed };
}

function parseScheduledAt(value: unknown): Date {
  if (value === undefined) return new Date();
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "schedule_time must be an RFC3339 timestamp");
  }
  const scheduledAt = new Date(value);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError(400, "schedule_time must be an RFC3339 timestamp");
  }
  return scheduledAt;
}
