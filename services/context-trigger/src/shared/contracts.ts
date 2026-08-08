import { createHash } from "node:crypto";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const MAX_TRIGGER_PAYLOAD_BYTES = 512 * 1024;
export const MAX_STAGE_OUTPUT_BYTES = 512 * 1024;
const MAX_PARENT_OUTPUT_BYTES = 16 * 1024;
const MAX_WIKI_REQUEST_BYTES = 24 * 1024;
export const MAX_PAGE_JOBS = 192;
export const MAX_AUDITS_PER_DUE_PAGE = 100;
export const MAX_RECONCILIATIONS_PER_DUE_PAGE = 100;

export type WikiTriggerRequestV1 = {
  schemaVersion: 1;
  taskIdentifier: "generate-wiki";
  boardBuildId: string;
  tenantId: string;
  repository: string;
  source: {
    commitSha: string;
    ref: string;
    scopeKind: "branch" | "pull_request" | "commit";
    scopeKey: string;
    refSequence?: number;
    baseCommitSha?: string;
    githubInstallationId?: number;
  };
  requestKey: string;
  generationReason: "initial" | "source_update" | "daily_audit_fix" | "manual_refresh" | "translation";
  releaseFamilyId: string;
  parentReleaseId?: string;
  sourceReleaseId?: string;
  sourceLocale?: string;
  improvement?: {
    auditId: string;
    auditedReleaseId: string;
    auditInputDigest: string;
    findingsArtifact: ImmutableArtifactRefV1;
    findingsDigest: string;
  };
  requestedLocale: string;
  pipelineVersion: "context_wiki.trigger.v1";
  generatorPolicyVersion: string;
  options: {
    idempotencyKey: string;
    concurrencyKey: string;
    queue: string;
    tags: string[];
  };
};

type ImmutableArtifactRefV1 = {
  uri: string;
  key: string;
  contentType: string;
  bytes: number;
  sha256: string;
  objectGeneration: string;
};

type WikiAuditReportArtifactRefV1 = ImmutableArtifactRefV1 & {
  version: 1;
  tenantId: string;
  repository: string;
  auditId: string;
  releaseId: string;
  auditInputDigest: string;
};

export type GenerateWikiPayloadV1 = {
  schemaVersion: 1;
  requestDigest: string;
  dispatchNonce: string;
  attempt: number;
  request: WikiTriggerRequestV1;
};

export type AuditWikiRequestV1 = {
  schemaVersion: 1;
  taskIdentifier: "audit-wiki";
  auditId: string;
  tenantId: string;
  repository: string;
  releaseId: string;
  locale: string;
  publicSnapshotDigest: string;
  auditPolicyVersion: string;
  auditorConfigDigest: string;
  auditWindow: string;
  auditInputDigest: string;
};

export type AuditWikiPayloadV1 = {
  schemaVersion: 1;
  dispatchNonce: string;
  request: AuditWikiRequestV1;
};

export type ExecutionClaimResponse<TRequest extends WikiTriggerRequestV1 | AuditWikiRequestV1> = {
  executionGrant: string;
  expiresAt: string;
  request: TRequest;
};

export type WikiStageName = "snapshot" | "plan" | "write-page" | "finalize" | "project" | "pageindex" | "audit";

export type WikiStageTaskPayload = {
  schemaVersion: 1;
  authorityId: string;
  requestDigest: string;
  executionGrant: string;
  operationId: string;
  input: JsonValue;
};

export type WikiStageResult = {
  operationId: string;
  status: "completed";
  output: JsonValue;
};

export type WikiTriggerCompletedOutputV1 = {
  schemaVersion: 1;
  status: "completed";
  boardBuildId: string;
  triggerParentRunId: string;
  requestDigest: string;
  tenantId: string;
  repository: string;
  commitSha: string;
  locale: string;
  releaseFamilyId: string;
  releaseId: string;
  generationId: string;
  releaseArtifactSha256: string;
  contentBundleArtifactSha256: string;
  publicSnapshotDigest: string;
  pageindexAttachmentId: string;
  activationOperationDigest: string;
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  completedAt: string;
};

const wikiTriggerTerminalFailureCodes = [
  "trigger_failed",
  "trigger_crashed",
  "trigger_system_failure",
  "trigger_expired",
  "trigger_timed_out",
  "trigger_canceled"
] as const;

export type WikiTriggerTerminalFailureCode = (typeof wikiTriggerTerminalFailureCodes)[number];

export type WikiTriggerTerminalFailureV1 = {
  schemaVersion: 1;
  boardBuildId: string;
  triggerParentRunId: string;
  requestDigest: string;
  code: WikiTriggerTerminalFailureCode;
  source: "on_failure" | "reconciler";
  failedAt: string;
};

export type WikiTriggerReconciliationCandidateV1 = {
  schemaVersion: 1;
  boardBuildId: string;
  triggerParentRunId: string;
  requestDigest: string;
  executionGrant: string;
};

export type DueWikiReconciliationsPageV1 = {
  executions: WikiTriggerReconciliationCandidateV1[];
  nextCursor?: string;
};

export type AuditWikiTerminalFailureV1 = {
  schemaVersion: 1;
  auditId: string;
  triggerParentRunId: string;
  auditInputDigest: string;
  code: WikiTriggerTerminalFailureCode;
  source: "on_failure" | "reconciler";
  failedAt: string;
};

export type AuditWikiReconciliationCandidateV1 = {
  schemaVersion: 1;
  auditId: string;
  triggerParentRunId: string;
  auditInputDigest: string;
  request: AuditWikiRequestV1;
  executionGrant: string;
};

export type DueAuditReconciliationsPageV1 = {
  audits: AuditWikiReconciliationCandidateV1[];
  nextCursor?: string;
};

export type AuditWikiImprovementCandidateV1 = AuditWikiReconciliationCandidateV1;

export type DueAuditImprovementsPageV1 = {
  audits: AuditWikiImprovementCandidateV1[];
  nextCursor?: string;
};

export type AuditWikiCompletedOutputV1 = {
  schemaVersion: 1;
  status: "completed";
  auditId: string;
  releaseId: string;
  auditInputDigest: string;
  outcome: "passed" | "needs_improvement" | "error";
  reportArtifact: WikiAuditReportArtifactRefV1;
  findingsDigest: string;
  completedAt: string;
  followup?: {
    admissionOutcome: "admitted" | "already_admitted" | "superseded" | "policy_denied";
    boardBuildId?: string;
  };
};

export type DueAuditsPageV1 = {
  audits: AuditWikiPayloadV1[];
  nextCursor?: string;
};

export function parseGenerateWikiPayload(value: unknown): GenerateWikiPayloadV1 {
  assertBoundedJson(value, MAX_TRIGGER_PAYLOAD_BYTES, "generate-wiki payload");
  const object = exactObject(
    value,
    ["schemaVersion", "requestDigest", "dispatchNonce", "attempt", "request"],
    "generate-wiki payload"
  );
  const parsed = {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    requestDigest: digest(object.requestDigest, "requestDigest"),
    dispatchNonce: boundedString(object.dispatchNonce, "dispatchNonce", 32, 512),
    attempt: positiveInteger(object.attempt, "attempt"),
    request: parseWikiTriggerRequest(object.request)
  } satisfies GenerateWikiPayloadV1;
  const computed = canonicalSha256(parsed.request);
  if (computed !== parsed.requestDigest) {
    throw new Error("requestDigest does not match the canonical request");
  }
  return parsed;
}

export function parseWikiTriggerRequest(value: unknown): WikiTriggerRequestV1 {
  assertBoundedJson(value, MAX_WIKI_REQUEST_BYTES, "wiki request");
  const object = exactObject(
    value,
    [
      "schemaVersion",
      "taskIdentifier",
      "boardBuildId",
      "tenantId",
      "repository",
      "source",
      "requestKey",
      "generationReason",
      "releaseFamilyId",
      "parentReleaseId",
      "sourceReleaseId",
      "sourceLocale",
      "improvement",
      "requestedLocale",
      "pipelineVersion",
      "generatorPolicyVersion",
      "options"
    ],
    "wiki request",
    true
  );
  const source = parseSource(object.source);
  const tenantId = pathIdentifier(object.tenantId, "tenantId", 240);
  const repository = repositoryName(object.repository);
  const generationReason = oneOf(
    object.generationReason,
    ["initial", "source_update", "daily_audit_fix", "manual_refresh", "translation"] as const,
    "generationReason"
  );
  const improvement =
    object.improvement === undefined ? undefined : parseImprovement(object.improvement, tenantId, repository);
  if ((generationReason === "daily_audit_fix") !== (improvement !== undefined)) {
    throw new Error("improvement is required exactly for daily_audit_fix");
  }
  const sourceReleaseId = optionalBoundedString(object.sourceReleaseId, "sourceReleaseId", 240);
  const sourceLocale = optionalLocale(object.sourceLocale, "sourceLocale");
  if (generationReason === "translation") {
    if (!sourceReleaseId || !sourceLocale) {
      throw new Error("translation requires sourceReleaseId and sourceLocale");
    }
    if (sourceLocale === locale(object.requestedLocale, "requestedLocale")) {
      throw new Error("translation sourceLocale must differ from requestedLocale");
    }
  } else if (sourceReleaseId || sourceLocale) {
    throw new Error("sourceReleaseId and sourceLocale are only valid for translation");
  }
  if (generationReason === "initial" && object.parentReleaseId !== undefined) {
    throw new Error("initial generation cannot have parentReleaseId");
  }
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    taskIdentifier: literal(object.taskIdentifier, "generate-wiki", "taskIdentifier"),
    boardBuildId: boardTaskId(object.boardBuildId),
    tenantId,
    repository,
    source,
    requestKey: boundedString(object.requestKey, "requestKey", 1, 512),
    generationReason,
    releaseFamilyId: boundedIdentifier(object.releaseFamilyId, "releaseFamilyId", 240),
    ...(object.parentReleaseId === undefined
      ? {}
      : { parentReleaseId: boundedIdentifier(object.parentReleaseId, "parentReleaseId", 240) }),
    ...(sourceReleaseId ? { sourceReleaseId } : {}),
    ...(sourceLocale ? { sourceLocale } : {}),
    ...(improvement ? { improvement } : {}),
    requestedLocale: locale(object.requestedLocale, "requestedLocale"),
    pipelineVersion: literal(object.pipelineVersion, "context_wiki.trigger.v1", "pipelineVersion"),
    generatorPolicyVersion: boundedIdentifier(object.generatorPolicyVersion, "generatorPolicyVersion", 240),
    options: parseOptions(object.options)
  };
}

export function parseAuditWikiPayload(value: unknown): AuditWikiPayloadV1 {
  assertBoundedJson(value, MAX_TRIGGER_PAYLOAD_BYTES, "audit-wiki payload");
  const object = exactObject(value, ["schemaVersion", "dispatchNonce", "request"], "audit-wiki payload");
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    dispatchNonce: boundedString(object.dispatchNonce, "dispatchNonce", 32, 512),
    request: parseAuditWikiRequest(object.request)
  };
}

export function parseAuditWikiRequest(value: unknown): AuditWikiRequestV1 {
  const object = exactObject(
    value,
    [
      "schemaVersion",
      "taskIdentifier",
      "auditId",
      "tenantId",
      "repository",
      "releaseId",
      "locale",
      "publicSnapshotDigest",
      "auditPolicyVersion",
      "auditorConfigDigest",
      "auditWindow",
      "auditInputDigest"
    ],
    "audit request"
  );
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    taskIdentifier: literal(object.taskIdentifier, "audit-wiki", "taskIdentifier"),
    auditId: boundedIdentifier(object.auditId, "auditId", 256),
    tenantId: pathIdentifier(object.tenantId, "tenantId", 240),
    repository: repositoryName(object.repository),
    releaseId: boundedIdentifier(object.releaseId, "releaseId", 256),
    locale: locale(object.locale, "locale"),
    publicSnapshotDigest: digest(object.publicSnapshotDigest, "publicSnapshotDigest"),
    auditPolicyVersion: boundedIdentifier(object.auditPolicyVersion, "auditPolicyVersion", 128),
    auditorConfigDigest: digest(object.auditorConfigDigest, "auditorConfigDigest"),
    auditWindow: boundedIdentifier(object.auditWindow, "auditWindow", 128),
    auditInputDigest: digest(object.auditInputDigest, "auditInputDigest")
  };
}

export function parseExecutionClaimResponse<TRequest extends WikiTriggerRequestV1 | AuditWikiRequestV1>(
  value: unknown,
  parseRequest: (request: unknown) => TRequest
): ExecutionClaimResponse<TRequest> {
  const object = exactObject(value, ["executionGrant", "expiresAt", "request"], "claim response");
  const expiresAt = isoTimestamp(object.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new Error("claim response grant is already expired");
  }
  return {
    executionGrant: boundedString(object.executionGrant, "executionGrant", 32, 16_384),
    expiresAt,
    request: parseRequest(object.request)
  };
}

export function parseWikiStageTaskPayload(value: unknown): WikiStageTaskPayload {
  assertBoundedJson(value, MAX_TRIGGER_PAYLOAD_BYTES, "stage payload");
  const object = exactObject(
    value,
    ["schemaVersion", "authorityId", "requestDigest", "executionGrant", "operationId", "input"],
    "stage payload"
  );
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    authorityId: boundedIdentifier(object.authorityId, "authorityId", 256),
    requestDigest: digest(object.requestDigest, "requestDigest"),
    executionGrant: boundedString(object.executionGrant, "executionGrant", 32, 16_384),
    operationId: boundedString(object.operationId, "operationId", 1, 512),
    input: jsonValue(object.input, "input")
  };
}

export function parseWikiStageResult(value: unknown): WikiStageResult {
  assertBoundedJson(value, MAX_STAGE_OUTPUT_BYTES, "stage result");
  const object = exactObject(value, ["operationId", "status", "output"], "stage result");
  return {
    operationId: boundedString(object.operationId, "operationId", 1, 512),
    status: literal(object.status, "completed", "status"),
    output: jsonValue(object.output, "output")
  };
}

export function parsePageJobs(value: JsonValue): JsonValue[] {
  const object = objectValue(value, "plan output");
  if (!Array.isArray(object.pageJobs) || object.pageJobs.length === 0 || object.pageJobs.length > MAX_PAGE_JOBS) {
    throw new Error(`plan output pageJobs must contain 1-${MAX_PAGE_JOBS} jobs`);
  }
  return object.pageJobs.map((job, index) => jsonValue(job, `pageJobs[${index}]`));
}

export function parseWikiCompletedOutput(value: unknown): WikiTriggerCompletedOutputV1 {
  assertBoundedJson(value, MAX_PARENT_OUTPUT_BYTES, "generate-wiki output");
  const object = exactObject(
    value,
    [
      "schemaVersion",
      "status",
      "boardBuildId",
      "triggerParentRunId",
      "requestDigest",
      "tenantId",
      "repository",
      "commitSha",
      "locale",
      "releaseFamilyId",
      "releaseId",
      "generationId",
      "releaseArtifactSha256",
      "contentBundleArtifactSha256",
      "publicSnapshotDigest",
      "pageindexAttachmentId",
      "activationOperationDigest",
      "usage",
      "completedAt"
    ],
    "generate-wiki output"
  );
  const usageObject = exactObject(object.usage, ["inputTokens", "outputTokens", "costMicros"], "usage");
  const releaseId = boundedIdentifier(object.releaseId, "releaseId", 256);
  const generationId = boundedIdentifier(object.generationId, "generationId", 256);
  if (releaseId !== generationId) {
    throw new Error("generationId must equal releaseId during compatibility");
  }
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    status: literal(object.status, "completed", "status"),
    boardBuildId: boardTaskId(object.boardBuildId),
    triggerParentRunId: boundedIdentifier(object.triggerParentRunId, "triggerParentRunId", 240),
    requestDigest: digest(object.requestDigest, "requestDigest"),
    tenantId: pathIdentifier(object.tenantId, "tenantId", 240),
    repository: repositoryName(object.repository),
    commitSha: commitSha(object.commitSha, "commitSha"),
    locale: locale(object.locale, "locale"),
    releaseFamilyId: boundedIdentifier(object.releaseFamilyId, "releaseFamilyId", 240),
    releaseId,
    generationId,
    releaseArtifactSha256: digest(object.releaseArtifactSha256, "releaseArtifactSha256"),
    contentBundleArtifactSha256: digest(object.contentBundleArtifactSha256, "contentBundleArtifactSha256"),
    publicSnapshotDigest: digest(object.publicSnapshotDigest, "publicSnapshotDigest"),
    pageindexAttachmentId: boundedIdentifier(object.pageindexAttachmentId, "pageindexAttachmentId", 256),
    activationOperationDigest: digest(object.activationOperationDigest, "activationOperationDigest"),
    usage: {
      inputTokens: nonnegativeInteger(usageObject.inputTokens, "inputTokens"),
      outputTokens: nonnegativeInteger(usageObject.outputTokens, "outputTokens"),
      costMicros: nonnegativeInteger(usageObject.costMicros, "costMicros")
    },
    completedAt: isoTimestamp(object.completedAt, "completedAt")
  };
}

export function parseWikiTriggerTerminalFailure(value: unknown): WikiTriggerTerminalFailureV1 {
  assertBoundedJson(value, MAX_PARENT_OUTPUT_BYTES, "generate-wiki terminal failure");
  const object = exactObject(
    value,
    ["schemaVersion", "boardBuildId", "triggerParentRunId", "requestDigest", "code", "source", "failedAt"],
    "generate-wiki terminal failure"
  );
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    boardBuildId: boardTaskId(object.boardBuildId),
    triggerParentRunId: boundedIdentifier(object.triggerParentRunId, "triggerParentRunId", 240),
    requestDigest: digest(object.requestDigest, "requestDigest"),
    code: oneOf(object.code, wikiTriggerTerminalFailureCodes, "code"),
    source: oneOf(object.source, ["on_failure", "reconciler"] as const, "source"),
    failedAt: isoTimestamp(object.failedAt, "failedAt")
  };
}

export function parseDueWikiReconciliationsPage(value: unknown): DueWikiReconciliationsPageV1 {
  const object = exactObject(value, ["executions", "nextCursor"], "due wiki reconciliations response", true);
  if (!Array.isArray(object.executions) || object.executions.length > MAX_RECONCILIATIONS_PER_DUE_PAGE) {
    throw new Error(
      `due wiki reconciliations response must contain at most ${MAX_RECONCILIATIONS_PER_DUE_PAGE} executions`
    );
  }
  return {
    executions: object.executions.map((value, index) => {
      const execution = exactObject(
        value,
        ["schemaVersion", "boardBuildId", "triggerParentRunId", "requestDigest", "executionGrant"],
        `executions[${index}]`
      );
      return {
        schemaVersion: literal(execution.schemaVersion, 1, "schemaVersion"),
        boardBuildId: boardTaskId(execution.boardBuildId),
        triggerParentRunId: boundedIdentifier(execution.triggerParentRunId, "triggerParentRunId", 240),
        requestDigest: digest(execution.requestDigest, "requestDigest"),
        executionGrant: boundedString(execution.executionGrant, "executionGrant", 32, 16_384)
      };
    }),
    ...(object.nextCursor === undefined ? {} : { nextCursor: boundedString(object.nextCursor, "nextCursor", 1, 2_048) })
  };
}

export function parseDueAuditReconciliationsPage(value: unknown): DueAuditReconciliationsPageV1 {
  return parseDueAuditCandidatesPage(value, "due audit reconciliations response");
}

export function parseDueAuditImprovementsPage(value: unknown): DueAuditImprovementsPageV1 {
  return parseDueAuditCandidatesPage(value, "due audit improvements response");
}

function parseDueAuditCandidatesPage(
  value: unknown,
  label: string
): DueAuditReconciliationsPageV1 | DueAuditImprovementsPageV1 {
  const object = exactObject(value, ["audits", "nextCursor"], label, true);
  if (!Array.isArray(object.audits) || object.audits.length > MAX_RECONCILIATIONS_PER_DUE_PAGE) {
    throw new Error(`${label} must contain at most ${MAX_RECONCILIATIONS_PER_DUE_PAGE} audits`);
  }
  return {
    audits: object.audits.map((value, index) => {
      const audit = exactObject(
        value,
        ["schemaVersion", "auditId", "triggerParentRunId", "auditInputDigest", "request", "executionGrant"],
        `audits[${index}]`
      );
      const request = parseAuditWikiRequest(audit.request);
      const auditId = boundedIdentifier(audit.auditId, "auditId", 256);
      const auditInputDigest = digest(audit.auditInputDigest, "auditInputDigest");
      if (request.auditId !== auditId || request.auditInputDigest !== auditInputDigest) {
        throw new Error(`audits[${index}] request identity is invalid`);
      }
      return {
        schemaVersion: literal(audit.schemaVersion, 1, "schemaVersion"),
        auditId,
        triggerParentRunId: boundedIdentifier(audit.triggerParentRunId, "triggerParentRunId", 240),
        auditInputDigest,
        request,
        executionGrant: boundedString(audit.executionGrant, "executionGrant", 32, 16_384)
      };
    }),
    ...(object.nextCursor === undefined ? {} : { nextCursor: boundedString(object.nextCursor, "nextCursor", 1, 2_048) })
  };
}

export function parseAuditWikiTerminalFailure(value: unknown): AuditWikiTerminalFailureV1 {
  const object = exactObject(
    value,
    ["schemaVersion", "auditId", "triggerParentRunId", "auditInputDigest", "code", "source", "failedAt"],
    "audit terminal failure"
  );
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    auditId: boundedIdentifier(object.auditId, "auditId", 256),
    triggerParentRunId: boundedIdentifier(object.triggerParentRunId, "triggerParentRunId", 240),
    auditInputDigest: digest(object.auditInputDigest, "auditInputDigest"),
    code: oneOf(object.code, wikiTriggerTerminalFailureCodes, "code"),
    source: oneOf(object.source, ["on_failure", "reconciler"] as const, "source"),
    failedAt: isoTimestamp(object.failedAt, "failedAt")
  };
}

export function parseAuditCompletedOutput(value: unknown): AuditWikiCompletedOutputV1 {
  assertBoundedJson(value, MAX_PARENT_OUTPUT_BYTES, "audit-wiki output");
  const object = exactObject(
    value,
    [
      "schemaVersion",
      "status",
      "auditId",
      "releaseId",
      "auditInputDigest",
      "outcome",
      "reportArtifact",
      "findingsDigest",
      "completedAt",
      "followup"
    ],
    "audit-wiki output",
    true
  );
  let followup: AuditWikiCompletedOutputV1["followup"];
  if (object.followup !== undefined) {
    const nested = exactObject(object.followup, ["admissionOutcome", "boardBuildId"], "followup", true);
    followup = {
      admissionOutcome: oneOf(
        nested.admissionOutcome,
        ["admitted", "already_admitted", "superseded", "policy_denied"] as const,
        "admissionOutcome"
      ),
      ...(nested.boardBuildId === undefined ? {} : { boardBuildId: boardTaskId(nested.boardBuildId) })
    };
  }
  return {
    schemaVersion: literal(object.schemaVersion, 1, "schemaVersion"),
    status: literal(object.status, "completed", "status"),
    auditId: boundedIdentifier(object.auditId, "auditId", 256),
    releaseId: boundedIdentifier(object.releaseId, "releaseId", 256),
    auditInputDigest: digest(object.auditInputDigest, "auditInputDigest"),
    outcome: oneOf(object.outcome, ["passed", "needs_improvement", "error"] as const, "outcome"),
    reportArtifact: parseAuditReportArtifactRef(object.reportArtifact, {
      auditId: boundedIdentifier(object.auditId, "auditId", 256),
      releaseId: boundedIdentifier(object.releaseId, "releaseId", 256),
      auditInputDigest: digest(object.auditInputDigest, "auditInputDigest")
    }),
    findingsDigest: digest(object.findingsDigest, "findingsDigest"),
    completedAt: isoTimestamp(object.completedAt, "completedAt"),
    ...(followup ? { followup } : {})
  };
}

export function parseAuditFollowup(value: unknown): NonNullable<AuditWikiCompletedOutputV1["followup"]> {
  const object = exactObject(value, ["admissionOutcome", "boardBuildId"], "audit followup", true);
  return {
    admissionOutcome: oneOf(
      object.admissionOutcome,
      ["admitted", "already_admitted", "superseded", "policy_denied"] as const,
      "admissionOutcome"
    ),
    ...(object.boardBuildId === undefined ? {} : { boardBuildId: boardTaskId(object.boardBuildId) })
  };
}

export function parseDueAuditsPage(value: unknown): DueAuditsPageV1 {
  const object = exactObject(value, ["audits", "nextCursor"], "due audits response", true);
  if (!Array.isArray(object.audits) || object.audits.length > MAX_AUDITS_PER_DUE_PAGE) {
    throw new Error(`due audits response must contain at most ${MAX_AUDITS_PER_DUE_PAGE} audits`);
  }
  return {
    audits: object.audits.map(parseAuditWikiPayload),
    ...(object.nextCursor === undefined ? {} : { nextCursor: boundedString(object.nextCursor, "nextCursor", 1, 2_048) })
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertSameCanonical(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} does not match authorized request`);
  }
}

export function assertBoundedJson(value: unknown, maxBytes: number, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON serializable`);
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
}

function parseSource(value: unknown): WikiTriggerRequestV1["source"] {
  const object = exactObject(
    value,
    ["commitSha", "ref", "scopeKind", "scopeKey", "refSequence", "baseCommitSha", "githubInstallationId"],
    "source",
    true
  );
  const scopeKind = oneOf(object.scopeKind, ["branch", "pull_request", "commit"] as const, "scopeKind");
  const refSequence = object.refSequence === undefined ? undefined : positiveInteger(object.refSequence, "refSequence");
  if ((scopeKind === "commit") === (refSequence !== undefined)) {
    throw new Error("refSequence is required for branch/PR and forbidden for commit scope");
  }
  const commit = commitSha(object.commitSha, "commitSha");
  const ref = boundedString(object.ref, "ref", 1, 512);
  const scopeKey = canonicalScopeKey(scopeKind, boundedString(object.scopeKey, "scopeKey", 1, 512));
  const expectedRef =
    scopeKind === "branch"
      ? `refs/heads/${scopeKey}`
      : scopeKind === "pull_request"
        ? `refs/pull/${scopeKey}/head`
        : `refs/commits/${scopeKey}`;
  if (ref !== expectedRef) throw new Error(`${scopeKind} ref must be canonical`);
  if (scopeKind === "commit" && scopeKey !== commit) throw new Error("commit scopeKey must match commitSha");
  if (scopeKind === "pull_request" && object.baseCommitSha === undefined) {
    throw new Error("pull_request source requires baseCommitSha");
  }
  if (object.baseCommitSha !== undefined && scopeKind !== "pull_request") {
    throw new Error("baseCommitSha is only valid for pull_request scope");
  }
  return {
    commitSha: commit,
    ref,
    scopeKind,
    scopeKey,
    ...(refSequence === undefined ? {} : { refSequence }),
    ...(object.baseCommitSha === undefined ? {} : { baseCommitSha: commitSha(object.baseCommitSha, "baseCommitSha") }),
    ...(object.githubInstallationId === undefined
      ? {}
      : { githubInstallationId: positiveInteger(object.githubInstallationId, "githubInstallationId") })
  };
}

function parseOptions(value: unknown): WikiTriggerRequestV1["options"] {
  const object = exactObject(value, ["idempotencyKey", "concurrencyKey", "queue", "tags"], "options");
  if (!Array.isArray(object.tags) || object.tags.length > 16) {
    throw new Error("options.tags must contain at most 16 tags");
  }
  const tags = object.tags.map((tag, index) => boundedIdentifier(tag, `tags[${index}]`, 120));
  if (new Set(tags).size !== tags.length) throw new Error("options.tags must not contain duplicates");
  return {
    idempotencyKey: boundedIdentifier(object.idempotencyKey, "idempotencyKey", 512),
    concurrencyKey: boundedIdentifier(object.concurrencyKey, "concurrencyKey", 512),
    queue: boundedIdentifier(object.queue, "queue", 120),
    tags: tags.sort()
  };
}

function parseImprovement(
  value: unknown,
  tenantId: string,
  repository: string
): NonNullable<WikiTriggerRequestV1["improvement"]> {
  const object = exactObject(
    value,
    ["auditId", "auditedReleaseId", "auditInputDigest", "findingsArtifact", "findingsDigest"],
    "improvement"
  );
  const auditId = boundedIdentifier(object.auditId, "auditId", 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(auditId)) throw new Error("auditId is invalid");
  const findingsArtifact = parseArtifactRef(object.findingsArtifact);
  const expectedKey = auditReportArtifactKey({ tenantId, repository, auditId });
  if (findingsArtifact.key !== expectedKey) throw new Error("findingsArtifact is outside the audit repository scope");
  return {
    auditId,
    auditedReleaseId: boundedIdentifier(object.auditedReleaseId, "auditedReleaseId", 240),
    auditInputDigest: digest(object.auditInputDigest, "auditInputDigest"),
    findingsArtifact,
    findingsDigest: digest(object.findingsDigest, "findingsDigest")
  };
}

function parseArtifactRef(value: unknown): ImmutableArtifactRefV1 {
  const object = exactObject(
    value,
    ["uri", "key", "contentType", "bytes", "sha256", "objectGeneration"],
    "artifact ref"
  );
  const contentType = boundedString(object.contentType, "contentType", 1, 120).toLowerCase();
  if (contentType !== "application/json") throw new Error("contentType must be application/json");
  const objectGeneration = boundedString(object.objectGeneration, "objectGeneration", 1, 40);
  if (!/^[1-9][0-9]*$/.test(objectGeneration)) throw new Error("objectGeneration must be a positive decimal string");
  return {
    uri: boundedString(object.uri, "uri", 1, 2_048),
    key: boundedString(object.key, "key", 1, 2_048),
    contentType,
    bytes: nonnegativeInteger(object.bytes, "bytes"),
    sha256: digest(object.sha256, "sha256"),
    objectGeneration
  };
}

function parseAuditReportArtifactRef(
  value: unknown,
  expected: { readonly auditId: string; readonly releaseId: string; readonly auditInputDigest: string }
): WikiAuditReportArtifactRefV1 {
  const object = exactObject(
    value,
    [
      "version",
      "tenantId",
      "repository",
      "auditId",
      "releaseId",
      "auditInputDigest",
      "uri",
      "key",
      "contentType",
      "bytes",
      "sha256",
      "objectGeneration"
    ],
    "audit report artifact"
  );
  const artifact = parseArtifactRef({
    uri: object.uri,
    key: object.key,
    contentType: object.contentType,
    bytes: object.bytes,
    sha256: object.sha256,
    objectGeneration: object.objectGeneration
  });
  const tenantId = pathIdentifier(object.tenantId, "reportArtifact.tenantId", 240);
  const repository = repositoryName(object.repository);
  const auditId = boundedIdentifier(object.auditId, "reportArtifact.auditId", 240);
  const releaseId = boundedIdentifier(object.releaseId, "reportArtifact.releaseId", 256);
  const auditInputDigest = digest(object.auditInputDigest, "reportArtifact.auditInputDigest");
  if (
    object.version !== 1 ||
    auditId !== expected.auditId ||
    releaseId !== expected.releaseId ||
    auditInputDigest !== expected.auditInputDigest ||
    artifact.key !== auditReportArtifactKey({ tenantId, repository, auditId })
  ) {
    throw new Error("audit report artifact does not match its authorized scope");
  }
  return { version: 1, tenantId, repository, auditId, releaseId, auditInputDigest, ...artifact };
}

function auditReportArtifactKey(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly auditId: string;
}): string {
  const [owner, name] = input.repository.split("/") as [string, string];
  return `context/tenants/${encodeURIComponent(input.tenantId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/audits/${encodeURIComponent(input.auditId)}/wiki-audit-report/report.json`;
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
  optionalKeysAllowed = false
): Record<string, unknown> {
  const object = objectValue(value, label);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown key ${unknown[0]}`);
  if (!optionalKeysAllowed) {
    for (const key of allowedKeys) {
      if (!Object.hasOwn(object, key)) throw new Error(`${label} is missing ${key}`);
    }
  }
  return object;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function jsonValue(value: unknown, label: string): JsonValue {
  assertBoundedJson(value, MAX_STAGE_OUTPUT_BYTES, label);
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new Error(`${label} must be JSON`);
  }
  return value as JsonValue;
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortCanonical(nested)])
    );
  }
  return value;
}

function boundedString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.trim() !== value) {
    throw new Error(`${label} must be a trimmed string with ${min}-${max} characters`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, 1, max);
}

function boundedIdentifier(value: unknown, label: string, max: number): string {
  const parsed = boundedString(value, label, 1, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]*$/.test(parsed)) throw new Error(`${label} contains invalid characters`);
  return parsed;
}

function boardTaskId(value: unknown): string {
  const parsed = boundedIdentifier(value, "boardBuildId", 240);
  if (!/^task_[A-Za-z0-9._:-]+$/.test(parsed)) throw new Error("boardBuildId must be a task identifier");
  return parsed;
}

function pathIdentifier(value: unknown, label: string, max: number): string {
  const parsed = boundedIdentifier(value, label, max);
  if (parsed.includes("/")) throw new Error(`${label} cannot contain a path separator`);
  return parsed;
}

function repositoryName(value: unknown): string {
  const parsed = boundedString(value, "repository", 3, 512).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(parsed)) throw new Error("repository must be normalized owner/name");
  return parsed;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a 40-character Git SHA`);
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be a 40-character Git SHA`);
  return normalized;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function locale(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 2, 120);
  try {
    const canonical = Intl.getCanonicalLocales(parsed);
    if (canonical.length !== 1) throw new Error();
    return canonical[0]!.toLowerCase();
  } catch {
    throw new Error(`${label} must be a canonical BCP-47 locale`);
  }
}

function canonicalScopeKey(scopeKind: "branch" | "pull_request" | "commit", raw: string): string {
  if (scopeKind === "pull_request") {
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || String(Number(raw)) !== raw) {
      throw new Error("pull request scopeKey must be canonical");
    }
    return raw;
  }
  if (scopeKind === "commit") return commitSha(raw, "scopeKey");
  if (
    raw.length > 255 ||
    raw === "@" ||
    raw.startsWith("-") ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.endsWith(".") ||
    raw.includes("..") ||
    raw.includes("//") ||
    raw.includes("@{") ||
    [...raw].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x20 || code === 0x7f || "~^:?*[\\]".includes(character);
    }) ||
    raw.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("branch scopeKey must be canonical");
  }
  return raw;
}

function optionalLocale(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : locale(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function isoTimestamp(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 20, 64);
  const date = new Date(parsed);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== parsed) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return parsed;
}

function literal<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must equal ${String(expected)}`);
  return expected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}
