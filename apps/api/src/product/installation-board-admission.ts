import { randomUUID } from "node:crypto";

import { RelationalBoardRepository } from "@jina/db";
import { activeTraceparent, parseTraceparent } from "@jina/observability";

import { ApiError } from "./errors.js";
import { withTransaction } from "./db.js";
import type { DispatchOptions } from "./workflow-dispatcher.js";

export const INSTALLATION_BACKFILL_TASK_ID = "github-installation-backfill";
const INSTALLATION_BACKFILL_PIPELINE_VERSION = "github_installation_backfill.board.v1";

export async function admitInstallationBackfill(
  payload: unknown,
  options: DispatchOptions,
): Promise<{ id: string }> {
  const value = requiredObject(payload, "installation backfill payload");
  const installationId = requiredPositiveInteger(
    value.github_installation_id,
    "github_installation_id",
  );
  const deliveryId = requiredText(value.delivery_id, "delivery_id");
  const dedupeKey =
    options.idempotencyKey ?? `installation-backfill:${installationId}:${deliveryId}`;
  const workflowId = randomUUID();
  const taskId = randomUUID();
  const admissionTraceparent = activeTraceparent();
  const admissionTrace = admissionTraceparent
    ? parseTraceparent(admissionTraceparent)
    : undefined;

  const admitted = await withTransaction((client) =>
    new RelationalBoardRepository().admitWorkflow(client, {
      workflowId,
      tenantId: `system:github-installation:${installationId}`,
      workflowType: "github_installation_backfill",
      pipelineVersion: INSTALLATION_BACKFILL_PIPELINE_VERSION,
      subjectType: "github_installation",
      subjectId: String(installationId),
      dedupeKey,
      concurrencyKey: options.concurrencyKey ?? `installation:${installationId}`,
      triggerType: "github_webhook",
      ...(admissionTrace ? { traceId: admissionTrace.traceId } : {}),
      ...(admissionTraceparent ? { admissionTraceparent } : {}),
      metadata: {
        schema_version: 1,
        installation_id: installationId,
        delivery_id: deliveryId,
        source_event: value.source_event,
        action: value.action,
      },
      tasks: [
        {
          id: taskId,
          taskType: INSTALLATION_BACKFILL_TASK_ID,
          topic: INSTALLATION_BACKFILL_TASK_ID,
          status: "queued",
          maxAttempts: 5,
          metadata: { schema_version: 1, payload: value },
        },
      ],
      actorType: "github",
      actorId: deliveryId,
    }),
  );
  return { id: admitted.workflowId };
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ApiError(400, `${label} must be a non-empty string`);
  return normalized;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, `${label} must be a positive safe integer`);
  }
  return value;
}
