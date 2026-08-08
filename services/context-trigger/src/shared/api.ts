import {
  MAX_STAGE_OUTPUT_BYTES,
  MAX_TRIGGER_PAYLOAD_BYTES,
  type AuditWikiCompletedOutputV1,
  type AuditWikiPayloadV1,
  type AuditWikiRequestV1,
  type AuditWikiTerminalFailureV1,
  type DueAuditImprovementsPageV1,
  type DueAuditReconciliationsPageV1,
  type DueAuditsPageV1,
  type DueWikiReconciliationsPageV1,
  type ExecutionClaimResponse,
  type GenerateWikiPayloadV1,
  type JsonValue,
  type WikiTriggerCompletedOutputV1,
  type WikiTriggerTerminalFailureV1,
  type WikiStageName,
  type WikiStageResult,
  type WikiTriggerRequestV1,
  assertBoundedJson,
  parseAuditWikiRequest,
  parseAuditWikiPayload,
  parseAuditWikiTerminalFailure,
  parseDueAuditImprovementsPage,
  parseDueAuditReconciliationsPage,
  parseDueAuditsPage,
  parseDueWikiReconciliationsPage,
  parseExecutionClaimResponse,
  parseWikiStageResult,
  parseWikiTriggerTerminalFailure,
  parseWikiTriggerRequest
} from "./contracts.js";
import { readContextTriggerEnv, type ContextTriggerEnv } from "./env.js";

const MAX_API_RESPONSE_BYTES = 1024 * 1024;
export const CONTEXT_API_CONTROL_TIMEOUT_MS = 30_000;
// Trigger stage tasks have a 30-minute maxDuration. Leave one minute for the
// child to validate the receipt, return its output, and run lifecycle cleanup.
export const CONTEXT_API_STAGE_TIMEOUT_MS = 29 * 60_000;

export class ContextWikiApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(path: string, status: number, code?: string) {
    super(`Context API ${path} returned ${status}${code ? ` (${code})` : ""}`);
    this.name = "ContextWikiApiError";
    this.status = status;
    this.code = code;
  }
}

export class ContextWikiApiTimeoutError extends Error {
  readonly code = "api_timeout";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("Context API request exceeded its bounded operation deadline");
    this.name = "ContextWikiApiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface ContextWikiApiClientOptions {
  env?: ContextTriggerEnv;
  fetch?: typeof fetch;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

export class ContextWikiApiClient {
  readonly #env: ContextTriggerEnv;
  readonly #fetch: typeof fetch;
  readonly #timeoutSignal: (timeoutMs: number) => AbortSignal;

  constructor(options: ContextWikiApiClientOptions = {}) {
    this.#env = options.env ?? readContextTriggerEnv();
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutSignal = options.timeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  }

  async claimBuild(input: {
    payload: GenerateWikiPayloadV1;
    triggerParentRunId: string;
  }): Promise<ExecutionClaimResponse<WikiTriggerRequestV1>> {
    return parseExecutionClaimResponse(
      await this.#request({
        method: "POST",
        path: "/internal/context/wiki/executions/claim",
        bearer: this.#env.internalApiToken,
        body: {
          kind: "build",
          boardBuildId: input.payload.request.boardBuildId,
          requestDigest: input.payload.requestDigest,
          triggerParentRunId: input.triggerParentRunId,
          dispatchNonce: input.payload.dispatchNonce,
          attempt: input.payload.attempt
        }
      }),
      parseWikiTriggerRequest
    );
  }

  async claimAudit(input: {
    payload: AuditWikiPayloadV1;
    triggerParentRunId: string;
  }): Promise<ExecutionClaimResponse<AuditWikiRequestV1>> {
    return parseExecutionClaimResponse(
      await this.#request({
        method: "POST",
        path: "/internal/context/wiki/executions/claim",
        bearer: this.#env.internalApiToken,
        body: {
          kind: "audit",
          auditId: input.payload.request.auditId,
          releaseId: input.payload.request.releaseId,
          auditInputDigest: input.payload.request.auditInputDigest,
          triggerParentRunId: input.triggerParentRunId,
          dispatchNonce: input.payload.dispatchNonce,
          request: input.payload.request
        }
      }),
      parseAuditWikiRequest
    );
  }

  async runStage(input: {
    authorityId: string;
    stage: WikiStageName;
    executionGrant: string;
    operationId: string;
    stageInput: JsonValue;
  }): Promise<WikiStageResult> {
    return parseWikiStageResult(
      await this.#request({
        method: "POST",
        path: `/internal/context/wiki/executions/${encodeURIComponent(input.authorityId)}/steps/${input.stage}`,
        bearer: input.executionGrant,
        body: { operationId: input.operationId, input: input.stageInput },
        maxResponseBytes: MAX_STAGE_OUTPUT_BYTES,
        timeoutMs: CONTEXT_API_STAGE_TIMEOUT_MS
      })
    );
  }

  async completeBuild(input: {
    boardBuildId: string;
    executionGrant: string;
    result: WikiTriggerCompletedOutputV1;
  }): Promise<{ readonly accepted: true; readonly replay: boolean }> {
    const value = await this.#request({
      method: "POST",
      path: `/internal/context/wiki/executions/${encodeURIComponent(input.boardBuildId)}/complete`,
      bearer: input.executionGrant,
      body: { result: input.result }
    });
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "accepted" && key !== "replay") ||
      value.accepted !== true ||
      typeof value.replay !== "boolean"
    ) {
      throw new Error("Context API returned an invalid wiki completion receipt");
    }
    return { accepted: true, replay: value.replay };
  }

  async failBuild(input: {
    boardBuildId: string;
    executionGrant: string;
    failure: WikiTriggerTerminalFailureV1;
  }): Promise<{ readonly accepted: true; readonly replay: boolean; readonly outcome: "failed" | "completed" }> {
    const value = await this.#request({
      method: "POST",
      path: `/internal/context/wiki/executions/${encodeURIComponent(input.boardBuildId)}/fail`,
      bearer: input.executionGrant,
      body: { failure: parseWikiTriggerTerminalFailure(input.failure) }
    });
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "accepted" && key !== "replay" && key !== "outcome") ||
      value.accepted !== true ||
      typeof value.replay !== "boolean" ||
      (value.outcome !== "failed" && value.outcome !== "completed")
    ) {
      throw new Error("Context API returned an invalid wiki failure receipt");
    }
    return { accepted: true, replay: value.replay, outcome: value.outcome };
  }

  async getDueBuildReconciliations(input: {
    cursor?: string;
    limit: number;
    timestamp: string;
    scheduleId: string;
  }): Promise<DueWikiReconciliationsPageV1> {
    const query = new URLSearchParams({
      limit: String(input.limit),
      timestamp: input.timestamp,
      scheduleId: input.scheduleId
    });
    if (input.cursor) query.set("cursor", input.cursor);
    return parseDueWikiReconciliationsPage(
      await this.#request({
        method: "GET",
        path: `/internal/context/wiki/executions/reconciliation/due?${query.toString()}`,
        bearer: this.#env.internalApiToken
      })
    );
  }

  async putArtifact(input: { executionGrant: string; operationId: string; artifact: JsonValue }): Promise<JsonValue> {
    return this.#request({
      method: "POST",
      path: "/internal/context/wiki/artifacts/put",
      bearer: input.executionGrant,
      body: { operationId: input.operationId, artifact: input.artifact }
    });
  }

  async getReleaseInputs(input: { releaseId: string; executionGrant: string }): Promise<JsonValue> {
    return this.#request({
      method: "GET",
      path: `/internal/context/wiki/releases/${encodeURIComponent(input.releaseId)}/inputs`,
      bearer: input.executionGrant
    });
  }

  async prepareRelease(input: { executionGrant: string; operationId: string; release: JsonValue }): Promise<JsonValue> {
    return this.#request({
      method: "POST",
      path: "/internal/context/wiki/releases/prepare",
      bearer: input.executionGrant,
      body: { operationId: input.operationId, release: input.release }
    });
  }

  async activateRelease(input: {
    releaseId: string;
    executionGrant: string;
    operationId: string;
    activation: JsonValue;
  }): Promise<JsonValue> {
    return this.#request({
      method: "POST",
      path: `/internal/context/wiki/releases/${encodeURIComponent(input.releaseId)}/activate`,
      bearer: input.executionGrant,
      body: { operationId: input.operationId, activation: input.activation }
    });
  }

  async getDueAudits(input: {
    cursor?: string;
    limit: number;
    timestamp: string;
    scheduleId: string;
  }): Promise<DueAuditsPageV1> {
    const query = new URLSearchParams({
      limit: String(input.limit),
      timestamp: input.timestamp,
      scheduleId: input.scheduleId,
      auditPolicyVersion: this.#env.auditPolicyVersion,
      auditorConfigDigest: this.#env.auditorConfigDigest
    });
    if (input.cursor) query.set("cursor", input.cursor);
    return parseDueAuditsPage(
      await this.#request({
        method: "GET",
        path: `/internal/context/wiki/audits/due?${query.toString()}`,
        bearer: this.#env.internalApiToken
      })
    );
  }

  async createAuditDispatch(input: {
    tenantId: string;
    repository: string;
    releaseId: string;
    locale: string;
    timestamp: string;
  }): Promise<AuditWikiPayloadV1> {
    return parseAuditWikiPayload(
      await this.#request({
        method: "POST",
        path: "/internal/context/wiki/audits/dispatch",
        bearer: this.#env.internalApiToken,
        body: {
          ...input,
          auditPolicyVersion: this.#env.auditPolicyVersion,
          auditorConfigDigest: this.#env.auditorConfigDigest
        }
      })
    );
  }

  async getDueAuditReconciliations(input: {
    cursor?: string;
    limit: number;
    timestamp: string;
    scheduleId: string;
  }): Promise<DueAuditReconciliationsPageV1> {
    const query = new URLSearchParams({
      limit: String(input.limit),
      timestamp: input.timestamp,
      scheduleId: input.scheduleId
    });
    if (input.cursor) query.set("cursor", input.cursor);
    return parseDueAuditReconciliationsPage(
      await this.#request({
        method: "GET",
        path: `/internal/context/wiki/audits/reconciliation/due?${query.toString()}`,
        bearer: this.#env.internalApiToken
      })
    );
  }

  async getDueAuditImprovements(input: {
    cursor?: string;
    limit: number;
    timestamp: string;
    scheduleId: string;
  }): Promise<DueAuditImprovementsPageV1> {
    const query = new URLSearchParams({
      limit: String(input.limit),
      timestamp: input.timestamp,
      scheduleId: input.scheduleId
    });
    if (input.cursor) query.set("cursor", input.cursor);
    return parseDueAuditImprovementsPage(
      await this.#request({
        method: "GET",
        path: `/internal/context/wiki/audits/improvements/due?${query.toString()}`,
        bearer: this.#env.internalApiToken
      })
    );
  }

  async completeAudit(input: {
    auditId: string;
    executionGrant: string;
    operationId: string;
    result: AuditWikiCompletedOutputV1;
  }): Promise<JsonValue> {
    return this.#request({
      method: "POST",
      path: `/internal/context/wiki/audits/${encodeURIComponent(input.auditId)}/complete`,
      bearer: input.executionGrant,
      body: { operationId: input.operationId, result: input.result }
    });
  }

  async failAudit(input: {
    auditId: string;
    executionGrant: string;
    failure: AuditWikiTerminalFailureV1;
  }): Promise<{ accepted: true; replay: boolean; outcome: "passed" | "needs_improvement" | "error" }> {
    const value = await this.#request({
      method: "POST",
      path: `/internal/context/wiki/audits/${encodeURIComponent(input.auditId)}/fail`,
      bearer: input.executionGrant,
      body: { failure: parseAuditWikiTerminalFailure(input.failure) }
    });
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "accepted" && key !== "replay" && key !== "outcome") ||
      value.accepted !== true ||
      typeof value.replay !== "boolean" ||
      (value.outcome !== "passed" && value.outcome !== "needs_improvement" && value.outcome !== "error")
    ) {
      throw new Error("Context API returned an invalid audit failure receipt");
    }
    return { accepted: true, replay: value.replay, outcome: value.outcome };
  }

  async admitAuditFix(input: { auditId: string; executionGrant: string; operationId: string }): Promise<JsonValue> {
    return this.#request({
      method: "POST",
      path: `/internal/context/wiki/audits/${encodeURIComponent(input.auditId)}/admit-fix`,
      bearer: input.executionGrant,
      body: { operationId: input.operationId }
    });
  }

  async #request(input: {
    method: "GET" | "POST";
    path: string;
    bearer: string;
    body?: unknown;
    maxResponseBytes?: number;
    timeoutMs?: number;
  }): Promise<JsonValue> {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (input.body !== undefined) assertBoundedJson(input.body, MAX_TRIGGER_PAYLOAD_BYTES, `API ${input.path} request`);
    const timeoutMs = input.timeoutMs ?? CONTEXT_API_CONTROL_TIMEOUT_MS;
    const signal = this.#timeoutSignal(timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#env.apiBaseUrl}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.bearer}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body }),
        signal
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw new ContextWikiApiTimeoutError(timeoutMs);
      throw error;
    }
    const parsed = await readBoundedJson(response, input.maxResponseBytes ?? MAX_API_RESPONSE_BYTES);
    if (!response.ok) {
      const code =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && typeof parsed.code === "string"
          ? parsed.code.slice(0, 128)
          : undefined;
      throw new ContextWikiApiError(input.path, response.status, code);
    }
    return parsed;
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && (value.name === "AbortError" || value.name === "TimeoutError");
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<JsonValue> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Context API response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new Error("Context API returned invalid JSON");
  }
}
