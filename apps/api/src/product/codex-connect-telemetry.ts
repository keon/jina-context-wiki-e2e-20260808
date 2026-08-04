import { ApiError } from "./errors.js";

const EVENTS = new Set([
  "flow_started",
  "flow_resumed",
  "user_code_received",
  "verification_opened",
  "visibility_changed",
  "authorization_approved",
  "token_exchange_succeeded",
  "credential_save_started",
  "credential_save_succeeded",
  "flow_failed",
  "flow_cancelled",
]);

const STAGES = new Set(["ui", "start", "poll", "exchange", "save"]);
const SAFE_VALUE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FLOW_ID = /^[a-zA-Z0-9_-]{8,80}$/;

export type CodexConnectTelemetry = {
  event: string;
  flow_id: string;
  stage?: string;
  reason?: string;
  http_status?: number;
  elapsed_ms?: number;
  attempt?: number;
  visibility?: "visible" | "hidden";
};

/**
 * Accept only a small, non-secret telemetry vocabulary. In particular, arbitrary messages and
 * OpenAI response bodies are deliberately rejected so codes, device ids, and tokens cannot leak
 * into Cloud Logging through this endpoint.
 */
export function parseCodexConnectTelemetry(raw: unknown): CodexConnectTelemetry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "invalid Codex connection telemetry");
  }
  const body = raw as Record<string, unknown>;
  const event = stringField(body.event, "event");
  const flowId = stringField(body.flow_id, "flow_id");
  if (!EVENTS.has(event) || !FLOW_ID.test(flowId)) {
    throw new ApiError(400, "invalid Codex connection telemetry");
  }

  const result: CodexConnectTelemetry = { event, flow_id: flowId };
  if (body.stage !== undefined) {
    const stage = stringField(body.stage, "stage");
    if (!STAGES.has(stage)) throw new ApiError(400, "invalid Codex connection telemetry stage");
    result.stage = stage;
  }
  if (body.reason !== undefined) {
    const reason = stringField(body.reason, "reason");
    if (!SAFE_VALUE.test(reason)) throw new ApiError(400, "invalid Codex connection telemetry reason");
    result.reason = reason;
  }
  if (body.visibility !== undefined) {
    if (body.visibility !== "visible" && body.visibility !== "hidden") {
      throw new ApiError(400, "invalid Codex connection telemetry visibility");
    }
    result.visibility = body.visibility;
  }
  optionalInteger(body, result, "http_status", 100, 599);
  optionalInteger(body, result, "elapsed_ms", 0, 30 * 60 * 1000);
  optionalInteger(body, result, "attempt", 0, 1_000);
  return result;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, `invalid Codex connection telemetry ${field}`);
  }
  return value;
}

function optionalInteger(
  body: Record<string, unknown>,
  target: CodexConnectTelemetry,
  field: "http_status" | "elapsed_ms" | "attempt",
  minimum: number,
  maximum: number,
): void {
  const value = body[field];
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError(400, `invalid Codex connection telemetry ${field}`);
  }
  target[field] = value as number;
}
