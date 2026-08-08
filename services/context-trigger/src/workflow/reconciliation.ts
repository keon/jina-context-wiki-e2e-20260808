import {
  parseAuditFollowup,
  parseAuditCompletedOutput,
  parseWikiCompletedOutput,
  type AuditWikiPayloadV1,
  type AuditWikiImprovementCandidateV1,
  type AuditWikiReconciliationCandidateV1,
  type AuditWikiTerminalFailureV1,
  type DueAuditReconciliationsPageV1,
  type DueWikiReconciliationsPageV1,
  type GenerateWikiPayloadV1,
  type WikiTriggerCompletedOutputV1,
  type WikiTriggerReconciliationCandidateV1,
  type WikiTriggerTerminalFailureCode,
  type WikiTriggerTerminalFailureV1
} from "../shared/contracts.js";

const terminalTriggerFailureStatuses = [
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
  "CANCELED"
] as const;

type TerminalTriggerFailureStatus = (typeof terminalTriggerFailureStatuses)[number];

export type RetrievedWikiRun = {
  readonly id: string;
  readonly taskIdentifier: string;
  readonly status: string;
  readonly output?: unknown;
};

export interface WikiFailureApi {
  claimBuild(input: {
    payload: GenerateWikiPayloadV1;
    triggerParentRunId: string;
  }): Promise<{ executionGrant: string }>;
  failBuild(input: {
    boardBuildId: string;
    executionGrant: string;
    failure: WikiTriggerTerminalFailureV1;
  }): Promise<{ accepted: true; replay: boolean; outcome: "failed" | "completed" }>;
}

export interface WikiReconciliationApi {
  completeBuild(input: {
    boardBuildId: string;
    executionGrant: string;
    result: WikiTriggerCompletedOutputV1;
  }): Promise<{ accepted: true; replay: boolean }>;
  failBuild(input: {
    boardBuildId: string;
    executionGrant: string;
    failure: WikiTriggerTerminalFailureV1;
  }): Promise<{ accepted: true; replay: boolean; outcome: "failed" | "completed" }>;
}

export interface AuditFailureApi {
  claimAudit(input: { payload: AuditWikiPayloadV1; triggerParentRunId: string }): Promise<{ executionGrant: string }>;
  failAudit(input: {
    auditId: string;
    executionGrant: string;
    failure: AuditWikiTerminalFailureV1;
  }): Promise<{ accepted: true; replay: boolean; outcome: "passed" | "needs_improvement" | "error" }>;
}

export interface AuditReconciliationApi {
  completeAudit(input: {
    auditId: string;
    executionGrant: string;
    operationId: string;
    result: ReturnType<typeof parseAuditCompletedOutput>;
  }): Promise<unknown>;
  failAudit(input: {
    auditId: string;
    executionGrant: string;
    failure: AuditWikiTerminalFailureV1;
  }): Promise<{ accepted: true; replay: boolean; outcome: "passed" | "needs_improvement" | "error" }>;
}

export interface AuditImprovementApi {
  admitAuditFix(input: { auditId: string; executionGrant: string; operationId: string }): Promise<unknown>;
}

function terminalFailureCode(status: TerminalTriggerFailureStatus): WikiTriggerTerminalFailureCode {
  switch (status) {
    case "FAILED":
      return "trigger_failed";
    case "CRASHED":
      return "trigger_crashed";
    case "SYSTEM_FAILURE":
      return "trigger_system_failure";
    case "EXPIRED":
      return "trigger_expired";
    case "TIMED_OUT":
      return "trigger_timed_out";
    case "CANCELED":
      return "trigger_canceled";
  }
}

function isTerminalTriggerFailureStatus(value: string): value is TerminalTriggerFailureStatus {
  return terminalTriggerFailureStatuses.some((status) => status === value);
}

/**
 * The normal exhausted-retry path. The bootstrap claim revalidates the exact
 * Board dispatch nonce and parent run before a scoped grant can report failure.
 */
export async function notifyTerminalWikiFailure(input: {
  payload: GenerateWikiPayloadV1;
  triggerParentRunId: string;
  failedAt: string;
  api: WikiFailureApi;
}): Promise<{ accepted: true; replay: boolean; outcome: "failed" | "completed" }> {
  const claim = await input.api.claimBuild({
    payload: input.payload,
    triggerParentRunId: input.triggerParentRunId
  });
  return input.api.failBuild({
    boardBuildId: input.payload.request.boardBuildId,
    executionGrant: claim.executionGrant,
    failure: {
      schemaVersion: 1,
      boardBuildId: input.payload.request.boardBuildId,
      triggerParentRunId: input.triggerParentRunId,
      requestDigest: input.payload.requestDigest,
      code: "trigger_failed",
      source: "on_failure",
      failedAt: input.failedAt
    }
  });
}

export async function notifyTerminalAuditFailure(input: {
  payload: AuditWikiPayloadV1;
  triggerParentRunId: string;
  failedAt: string;
  api: AuditFailureApi;
}): Promise<{ accepted: true; replay: boolean; outcome: "passed" | "needs_improvement" | "error" }> {
  const claim = await input.api.claimAudit({
    payload: input.payload,
    triggerParentRunId: input.triggerParentRunId
  });
  return input.api.failAudit({
    auditId: input.payload.request.auditId,
    executionGrant: claim.executionGrant,
    failure: {
      schemaVersion: 1,
      auditId: input.payload.request.auditId,
      triggerParentRunId: input.triggerParentRunId,
      auditInputDigest: input.payload.request.auditInputDigest,
      code: "trigger_failed",
      source: "on_failure",
      failedAt: input.failedAt
    }
  });
}

/**
 * Bounded backstop for terminal states where Trigger does not invoke
 * `onFailure` (crash, system failure, expiry, timeout, or cancellation).
 */
export async function reconcileWikiRunCandidates(input: {
  candidates: DueWikiReconciliationsPageV1["executions"];
  failedAt: string;
  retrieve: (runId: string) => Promise<RetrievedWikiRun>;
  api: WikiReconciliationApi;
}): Promise<{ completed: number; failed: number; active: number; errors: number }> {
  let completed = 0;
  let failed = 0;
  let active = 0;
  let errors = 0;
  for (const candidate of input.candidates) {
    try {
      const run = await input.retrieve(candidate.triggerParentRunId);
      assertRetrievedRunIdentity(run, candidate);
      if (run.status === "COMPLETED") {
        const result = parseWikiCompletedOutput(run.output);
        await input.api.completeBuild({
          boardBuildId: candidate.boardBuildId,
          executionGrant: candidate.executionGrant,
          result
        });
        completed += 1;
      } else if (isTerminalTriggerFailureStatus(run.status)) {
        const receipt = await input.api.failBuild({
          boardBuildId: candidate.boardBuildId,
          executionGrant: candidate.executionGrant,
          failure: failureForCandidate(candidate, terminalFailureCode(run.status), input.failedAt)
        });
        if (receipt.outcome === "completed") completed += 1;
        else failed += 1;
      } else {
        active += 1;
      }
    } catch {
      errors += 1;
    }
  }
  return { completed, failed, active, errors };
}

export async function reconcileAuditRunCandidates(input: {
  candidates: DueAuditReconciliationsPageV1["audits"];
  failedAt: string;
  retrieve: (runId: string) => Promise<RetrievedWikiRun>;
  api: AuditReconciliationApi;
}): Promise<{ completed: number; failed: number; active: number; errors: number }> {
  let completed = 0;
  let failed = 0;
  let active = 0;
  let errors = 0;
  for (const candidate of input.candidates) {
    try {
      const run = await input.retrieve(candidate.triggerParentRunId);
      assertRetrievedAuditRunIdentity(run, candidate);
      if (run.status === "COMPLETED") {
        const parsed = parseAuditCompletedOutput(run.output);
        const { followup: _followup, ...result } = parsed;
        await input.api.completeAudit({
          auditId: candidate.auditId,
          executionGrant: candidate.executionGrant,
          operationId: `wiki-audit:${candidate.auditInputDigest}:reconcile-complete`,
          result
        });
        completed += 1;
      } else if (isTerminalTriggerFailureStatus(run.status)) {
        const receipt = await input.api.failAudit({
          auditId: candidate.auditId,
          executionGrant: candidate.executionGrant,
          failure: auditFailureForCandidate(candidate, terminalFailureCode(run.status), input.failedAt)
        });
        if (receipt.outcome === "error") failed += 1;
        else completed += 1;
      } else {
        active += 1;
      }
    } catch {
      errors += 1;
    }
  }
  return { completed, failed, active, errors };
}

export async function reconcileAuditImprovementCandidates(input: {
  candidates: readonly AuditWikiImprovementCandidateV1[];
  api: AuditImprovementApi;
}): Promise<{ admitted: number; replayed: number; closed: number; errors: number }> {
  let admitted = 0;
  let replayed = 0;
  let closed = 0;
  let errors = 0;
  for (const candidate of input.candidates) {
    try {
      const followup = parseAuditFollowup(
        await input.api.admitAuditFix({
          auditId: candidate.auditId,
          executionGrant: candidate.executionGrant,
          operationId: `wiki-audit:${candidate.auditInputDigest}:admit-fix`
        })
      );
      if (followup.admissionOutcome === "admitted") admitted += 1;
      else if (followup.admissionOutcome === "already_admitted") replayed += 1;
      else closed += 1;
    } catch {
      errors += 1;
    }
  }
  return { admitted, replayed, closed, errors };
}

function failureForCandidate(
  candidate: WikiTriggerReconciliationCandidateV1,
  code: WikiTriggerTerminalFailureCode,
  failedAt: string
): WikiTriggerTerminalFailureV1 {
  return {
    schemaVersion: 1,
    boardBuildId: candidate.boardBuildId,
    triggerParentRunId: candidate.triggerParentRunId,
    requestDigest: candidate.requestDigest,
    code,
    source: "reconciler",
    failedAt
  };
}

function auditFailureForCandidate(
  candidate: AuditWikiReconciliationCandidateV1,
  code: WikiTriggerTerminalFailureCode,
  failedAt: string
): AuditWikiTerminalFailureV1 {
  return {
    schemaVersion: 1,
    auditId: candidate.auditId,
    triggerParentRunId: candidate.triggerParentRunId,
    auditInputDigest: candidate.auditInputDigest,
    code,
    source: "reconciler",
    failedAt
  };
}

function assertRetrievedRunIdentity(run: RetrievedWikiRun, candidate: WikiTriggerReconciliationCandidateV1): void {
  if (run.id !== candidate.triggerParentRunId || run.taskIdentifier !== "generate-wiki") {
    throw new Error("retrieved Trigger run does not match the reconciled wiki execution");
  }
}

function assertRetrievedAuditRunIdentity(run: RetrievedWikiRun, candidate: AuditWikiReconciliationCandidateV1): void {
  if (run.id !== candidate.triggerParentRunId || run.taskIdentifier !== "audit-wiki") {
    throw new Error("retrieved Trigger run does not match the reconciled audit execution");
  }
}
