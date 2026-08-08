import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSha256,
  type AuditWikiPayloadV1,
  type GenerateWikiPayloadV1,
  type WikiTriggerRequestV1
} from "../shared/contracts.js";
import {
  notifyTerminalAuditFailure,
  notifyTerminalWikiFailure,
  reconcileAuditImprovementCandidates,
  reconcileAuditRunCandidates,
  reconcileWikiRunCandidates
} from "./reconciliation.js";

const request: WikiTriggerRequestV1 = {
  schemaVersion: 1,
  taskIdentifier: "generate-wiki",
  boardBuildId: "task_reconcile-1",
  tenantId: "tenant-1",
  repository: "openai/example",
  source: {
    commitSha: "a".repeat(40),
    ref: "refs/heads/main",
    scopeKind: "branch",
    scopeKey: "main",
    refSequence: 1
  },
  requestKey: "request-1",
  generationReason: "initial",
  releaseFamilyId: "family-1",
  requestedLocale: "en",
  pipelineVersion: "context_wiki.trigger.v1",
  generatorPolicyVersion: "generator.v1",
  options: { idempotencyKey: "idem-1", concurrencyKey: "concurrency-1", queue: "wiki", tags: [] }
};

const payload: GenerateWikiPayloadV1 = {
  schemaVersion: 1,
  requestDigest: canonicalSha256(request),
  dispatchNonce: "n".repeat(32),
  attempt: 1,
  request
};

const candidate = {
  schemaVersion: 1 as const,
  boardBuildId: request.boardBuildId,
  triggerParentRunId: "run_parent1",
  requestDigest: payload.requestDigest,
  executionGrant: "g".repeat(32)
};

test("exhausted child/parent failure reclaims the exact run grant and reports no raw error", async () => {
  const calls: unknown[] = [];
  const receipt = await notifyTerminalWikiFailure({
    payload,
    triggerParentRunId: candidate.triggerParentRunId,
    failedAt: "2026-08-08T12:00:00.000Z",
    api: {
      async claimBuild(input) {
        calls.push(input);
        return { executionGrant: candidate.executionGrant };
      },
      async failBuild(input) {
        calls.push(input);
        return { accepted: true, replay: false, outcome: "failed" };
      }
    }
  });
  assert.equal(receipt.outcome, "failed");
  assert.deepEqual(calls, [
    { payload, triggerParentRunId: candidate.triggerParentRunId },
    {
      boardBuildId: request.boardBuildId,
      executionGrant: candidate.executionGrant,
      failure: {
        schemaVersion: 1,
        boardBuildId: request.boardBuildId,
        triggerParentRunId: candidate.triggerParentRunId,
        requestDigest: payload.requestDigest,
        code: "trigger_failed",
        source: "on_failure",
        failedAt: "2026-08-08T12:00:00.000Z"
      }
    }
  ]);
});

test("reconciler maps system failures and treats an activation-won receipt as completed", async () => {
  const failures: unknown[] = [];
  const result = await reconcileWikiRunCandidates({
    candidates: [candidate],
    failedAt: "2026-08-08T12:05:00.000Z",
    retrieve: async () => ({
      id: candidate.triggerParentRunId,
      taskIdentifier: "generate-wiki",
      status: "SYSTEM_FAILURE"
    }),
    api: {
      async completeBuild() {
        throw new Error("not expected");
      },
      async failBuild(input) {
        failures.push(input);
        return { accepted: true, replay: false, outcome: "completed" };
      }
    }
  });
  assert.deepEqual(result, { completed: 1, failed: 0, active: 0, errors: 0 });
  assert.deepEqual(failures, [
    {
      boardBuildId: candidate.boardBuildId,
      executionGrant: candidate.executionGrant,
      failure: {
        schemaVersion: 1,
        boardBuildId: candidate.boardBuildId,
        triggerParentRunId: candidate.triggerParentRunId,
        requestDigest: candidate.requestDigest,
        code: "trigger_system_failure",
        source: "reconciler",
        failedAt: "2026-08-08T12:05:00.000Z"
      }
    }
  ]);
});

test("reconciler covers crashed/timed-out terminals, leaves active runs alone, and isolates identity errors", async () => {
  const candidates = [
    { ...candidate, boardBuildId: "task_crashed", triggerParentRunId: "run_crashed" },
    { ...candidate, boardBuildId: "task_timedout", triggerParentRunId: "run_timedout" },
    { ...candidate, boardBuildId: "task_active", triggerParentRunId: "run_active" },
    { ...candidate, boardBuildId: "task_wrong", triggerParentRunId: "run_wrong_expected" }
  ];
  const codes: string[] = [];
  const result = await reconcileWikiRunCandidates({
    candidates,
    failedAt: "2026-08-08T12:05:00.000Z",
    retrieve: async (runId) => {
      if (runId === "run_crashed") return { id: runId, taskIdentifier: "generate-wiki", status: "CRASHED" };
      if (runId === "run_timedout") return { id: runId, taskIdentifier: "generate-wiki", status: "TIMED_OUT" };
      if (runId === "run_active") return { id: runId, taskIdentifier: "generate-wiki", status: "EXECUTING" };
      return { id: "run_wrong_actual", taskIdentifier: "generate-wiki", status: "CRASHED" };
    },
    api: {
      async completeBuild() {
        throw new Error("not expected");
      },
      async failBuild(input) {
        codes.push(input.failure.code);
        return { accepted: true, replay: false, outcome: "failed" };
      }
    }
  });
  assert.deepEqual(result, { completed: 0, failed: 2, active: 1, errors: 1 });
  assert.deepEqual(codes, ["trigger_crashed", "trigger_timed_out"]);
});

const auditPayload: AuditWikiPayloadV1 = {
  schemaVersion: 1,
  dispatchNonce: "n".repeat(32),
  request: {
    schemaVersion: 1,
    taskIdentifier: "audit-wiki",
    auditId: "wa_reconcile",
    tenantId: "tenant-1",
    repository: "openai/example",
    releaseId: "cr_reconcile",
    locale: "en",
    publicSnapshotDigest: "b".repeat(64),
    auditPolicyVersion: "audit-v1",
    auditorConfigDigest: "c".repeat(64),
    auditWindow: "2026-08-08",
    auditInputDigest: "d".repeat(64)
  }
};

const auditCandidate = {
  schemaVersion: 1 as const,
  auditId: auditPayload.request.auditId,
  triggerParentRunId: "run_audit_parent",
  auditInputDigest: auditPayload.request.auditInputDigest,
  request: auditPayload.request,
  executionGrant: "g".repeat(32)
};

test("exhausted audit failure reclaims the exact audit run and sends only a bounded terminal code", async () => {
  const calls: unknown[] = [];
  const receipt = await notifyTerminalAuditFailure({
    payload: auditPayload,
    triggerParentRunId: auditCandidate.triggerParentRunId,
    failedAt: "2026-08-08T13:00:00.000Z",
    api: {
      async claimAudit(input) {
        calls.push(input);
        return { executionGrant: auditCandidate.executionGrant };
      },
      async failAudit(input) {
        calls.push(input);
        return { accepted: true, replay: false, outcome: "error" };
      }
    }
  });
  assert.equal(receipt.outcome, "error");
  assert.deepEqual(calls, [
    { payload: auditPayload, triggerParentRunId: auditCandidate.triggerParentRunId },
    {
      auditId: auditCandidate.auditId,
      executionGrant: auditCandidate.executionGrant,
      failure: {
        schemaVersion: 1,
        auditId: auditCandidate.auditId,
        triggerParentRunId: auditCandidate.triggerParentRunId,
        auditInputDigest: auditCandidate.auditInputDigest,
        code: "trigger_failed",
        source: "on_failure",
        failedAt: "2026-08-08T13:00:00.000Z"
      }
    }
  ]);
});

test("audit reconciler completes recovered reports, maps hard crashes, and rejects the wrong Trigger task", async () => {
  const candidates = [
    auditCandidate,
    { ...auditCandidate, auditId: "wa_crashed", triggerParentRunId: "run_audit_crashed" },
    { ...auditCandidate, auditId: "wa_wrong", triggerParentRunId: "run_audit_wrong" }
  ];
  const completions: unknown[] = [];
  const failures: unknown[] = [];
  const result = await reconcileAuditRunCandidates({
    candidates,
    failedAt: "2026-08-08T13:05:00.000Z",
    retrieve: async (runId) => {
      if (runId === auditCandidate.triggerParentRunId) {
        return {
          id: runId,
          taskIdentifier: "audit-wiki",
          status: "COMPLETED",
          output: auditCompletedOutput(auditCandidate.auditId, auditCandidate.auditInputDigest)
        };
      }
      if (runId === "run_audit_crashed") {
        return { id: runId, taskIdentifier: "audit-wiki", status: "SYSTEM_FAILURE" };
      }
      return { id: runId, taskIdentifier: "generate-wiki", status: "CRASHED" };
    },
    api: {
      async completeAudit(input) {
        completions.push(input);
      },
      async failAudit(input) {
        failures.push(input);
        return { accepted: true, replay: false, outcome: "error" };
      }
    }
  });
  assert.deepEqual(result, { completed: 1, failed: 1, active: 0, errors: 1 });
  assert.equal(completions.length, 1);
  assert.deepEqual(failures, [
    {
      auditId: "wa_crashed",
      executionGrant: auditCandidate.executionGrant,
      failure: {
        schemaVersion: 1,
        auditId: "wa_crashed",
        triggerParentRunId: "run_audit_crashed",
        auditInputDigest: auditCandidate.auditInputDigest,
        code: "trigger_system_failure",
        source: "reconciler",
        failedAt: "2026-08-08T13:05:00.000Z"
      }
    }
  ]);
});

test("audit improvement reconciliation retries the exact idempotent fix admission", async () => {
  const calls: unknown[] = [];
  let admitted = false;
  const api = {
    async admitAuditFix(input: unknown) {
      calls.push(input);
      if (admitted) return { admissionOutcome: "already_admitted", boardBuildId: "task_wiki-fix" };
      admitted = true;
      return { admissionOutcome: "admitted", boardBuildId: "task_wiki-fix" };
    }
  };

  assert.deepEqual(await reconcileAuditImprovementCandidates({ candidates: [auditCandidate], api }), {
    admitted: 1,
    replayed: 0,
    closed: 0,
    errors: 0
  });
  assert.deepEqual(await reconcileAuditImprovementCandidates({ candidates: [auditCandidate], api }), {
    admitted: 0,
    replayed: 1,
    closed: 0,
    errors: 0
  });
  assert.deepEqual(calls, [
    {
      auditId: auditCandidate.auditId,
      executionGrant: auditCandidate.executionGrant,
      operationId: `wiki-audit:${auditCandidate.auditInputDigest}:admit-fix`
    },
    {
      auditId: auditCandidate.auditId,
      executionGrant: auditCandidate.executionGrant,
      operationId: `wiki-audit:${auditCandidate.auditInputDigest}:admit-fix`
    }
  ]);
});

function auditCompletedOutput(auditId: string, auditInputDigest: string) {
  const releaseId = auditPayload.request.releaseId;
  return {
    schemaVersion: 1,
    status: "completed",
    auditId,
    releaseId,
    auditInputDigest,
    outcome: "passed",
    reportArtifact: {
      version: 1,
      tenantId: auditPayload.request.tenantId,
      repository: auditPayload.request.repository,
      auditId,
      releaseId,
      auditInputDigest,
      uri: `gs://wiki/context/tenants/tenant-1/repositories/openai/example/audits/${auditId}/wiki-audit-report/report.json`,
      key: `context/tenants/tenant-1/repositories/openai/example/audits/${auditId}/wiki-audit-report/report.json`,
      contentType: "application/json",
      bytes: 128,
      sha256: "e".repeat(64),
      objectGeneration: "1"
    },
    findingsDigest: "f".repeat(64),
    completedAt: "2026-08-08T13:00:00.000Z"
  };
}
