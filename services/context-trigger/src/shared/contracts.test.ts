import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PAGE_JOBS,
  canonicalSha256,
  parseAuditCompletedOutput,
  parseAuditWikiRequest,
  parseGenerateWikiPayload,
  parsePageJobs,
  parseWikiCompletedOutput,
  type WikiTriggerRequestV1
} from "./contracts.js";

const request: WikiTriggerRequestV1 = {
  schemaVersion: 1,
  taskIdentifier: "generate-wiki",
  boardBuildId: "task_build-1",
  tenantId: "tenant-1",
  repository: "openai/example",
  source: {
    commitSha: "a".repeat(40),
    ref: "refs/heads/main",
    scopeKind: "branch",
    scopeKey: "main",
    refSequence: 1
  },
  requestKey: "wiki:openai/example:main:1",
  generationReason: "initial",
  releaseFamilyId: "family-1",
  requestedLocale: "en",
  pipelineVersion: "context_wiki.trigger.v1",
  generatorPolicyVersion: "generator.v1",
  options: {
    idempotencyKey: "wiki:build-1",
    concurrencyKey: "repo:openai/example:main",
    queue: "context-wiki",
    tags: ["kind:wiki"]
  }
};

test("parseGenerateWikiPayload validates canonical digest and attempt", () => {
  const requestDigest = canonicalSha256(request);
  assert.equal(requestDigest, "695b1eddab5347fab78ced2766abb59bfff3ea8c61c078769c36995f17926e3f");
  assert.deepEqual(
    parseGenerateWikiPayload({
      schemaVersion: 1,
      requestDigest,
      dispatchNonce: "n".repeat(32),
      attempt: 1,
      request
    }),
    {
      schemaVersion: 1,
      requestDigest,
      dispatchNonce: "n".repeat(32),
      attempt: 1,
      request
    }
  );
  assert.throws(
    () =>
      parseGenerateWikiPayload({
        schemaVersion: 1,
        requestDigest: "b".repeat(64),
        dispatchNonce: "n".repeat(32),
        attempt: 1,
        request
      }),
    /does not match/
  );
  assert.throws(
    () =>
      parseGenerateWikiPayload({
        schemaVersion: 1,
        requestDigest,
        dispatchNonce: "n".repeat(32),
        attempt: 0,
        request
      }),
    /positive integer/
  );
});

test("wiki request parser rejects unknown fields and invalid ref sequencing", () => {
  const requestDigest = canonicalSha256({ ...request, unexpected: true });
  assert.throws(
    () =>
      parseGenerateWikiPayload({
        schemaVersion: 1,
        requestDigest,
        dispatchNonce: "n".repeat(32),
        attempt: 1,
        request: { ...request, unexpected: true }
      }),
    /unknown key/
  );

  const commitRequest = {
    ...request,
    source: {
      ...request.source,
      scopeKind: "commit",
      ref: `refs/commits/${request.source.commitSha}`
    }
  };
  assert.throws(
    () =>
      parseGenerateWikiPayload({
        schemaVersion: 1,
        requestDigest: canonicalSha256(commitRequest),
        dispatchNonce: "n".repeat(32),
        attempt: 1,
        request: commitRequest
      }),
    /refSequence/
  );

  const pullRequest = {
    ...request,
    source: {
      ...request.source,
      ref: "refs/pull/42/head",
      scopeKind: "pull_request",
      scopeKey: "42"
    }
  };
  assert.throws(
    () =>
      parseGenerateWikiPayload({
        schemaVersion: 1,
        requestDigest: canonicalSha256(pullRequest),
        dispatchNonce: "n".repeat(32),
        attempt: 1,
        request: pullRequest
      }),
    /baseCommitSha/
  );
});

test("wiki and audit contracts canonicalize en-US as en-us", () => {
  const canonicalRequest = { ...request, requestedLocale: "en-us" };
  const parsed = parseGenerateWikiPayload({
    schemaVersion: 1,
    requestDigest: canonicalSha256(canonicalRequest),
    dispatchNonce: "n".repeat(32),
    attempt: 1,
    request: { ...request, requestedLocale: "en-US" }
  });
  assert.equal(parsed.request.requestedLocale, "en-us");

  const audit = parseAuditWikiRequest({
    schemaVersion: 1,
    taskIdentifier: "audit-wiki",
    auditId: "audit-1",
    tenantId: "tenant-1",
    repository: "openai/example",
    releaseId: "release-1",
    locale: "en-US",
    publicSnapshotDigest: "b".repeat(64),
    auditPolicyVersion: "audit.v1",
    auditorConfigDigest: "c".repeat(64),
    auditWindow: "2026-08-08",
    auditInputDigest: "d".repeat(64)
  });
  assert.equal(audit.locale, "en-us");
});

test("audit-fix contracts accept only the canonical production artifact scope", () => {
  const auditId = "wa_contract";
  const key = `context/tenants/tenant-1/repositories/openai/example/audits/${auditId}/wiki-audit-report/report.json`;
  const improvementRequest: WikiTriggerRequestV1 = {
    ...request,
    requestKey: `wiki-audit-fix:${auditId}`,
    generationReason: "daily_audit_fix",
    parentReleaseId: "release-1",
    improvement: {
      auditId,
      auditedReleaseId: "release-1",
      auditInputDigest: "b".repeat(64),
      findingsArtifact: {
        uri: `gs://wiki-artifacts/${key}`,
        key,
        contentType: "application/json",
        bytes: 128,
        sha256: "c".repeat(64),
        objectGeneration: "1"
      },
      findingsDigest: "d".repeat(64)
    }
  };
  assert.equal(
    parseGenerateWikiPayload({
      schemaVersion: 1,
      requestDigest: canonicalSha256(improvementRequest),
      dispatchNonce: "n".repeat(32),
      attempt: 1,
      request: improvementRequest
    }).request.improvement?.findingsArtifact.key,
    key
  );
  const wrongScope = {
    ...improvementRequest,
    improvement: {
      ...improvementRequest.improvement!,
      findingsArtifact: {
        ...improvementRequest.improvement!.findingsArtifact,
        key: key.replace("/repositories/openai/example/", "/repositories/openai/other/")
      }
    }
  };
  assert.throws(
    () =>
      parseGenerateWikiPayload({
        schemaVersion: 1,
        requestDigest: canonicalSha256(wrongScope),
        dispatchNonce: "n".repeat(32),
        attempt: 1,
        request: wrongScope
      }),
    /outside the audit repository scope/
  );

  assert.equal(
    parseAuditCompletedOutput({
      schemaVersion: 1,
      status: "completed",
      auditId,
      releaseId: "release-1",
      auditInputDigest: "b".repeat(64),
      outcome: "needs_improvement",
      reportArtifact: {
        version: 1,
        tenantId: "tenant-1",
        repository: "openai/example",
        auditId,
        releaseId: "release-1",
        auditInputDigest: "b".repeat(64),
        uri: `gs://wiki-artifacts/${key}`,
        key,
        contentType: "application/json",
        bytes: 128,
        sha256: "c".repeat(64),
        objectGeneration: "1"
      },
      findingsDigest: "d".repeat(64),
      completedAt: "2026-08-08T03:01:00.000Z"
    }).reportArtifact.key,
    key
  );
});

test("page planning is bounded", () => {
  assert.deepEqual(parsePageJobs({ pageJobs: [{ path: "quickstart.md" }] }), [{ path: "quickstart.md" }]);
  assert.throws(() => parsePageJobs({ pageJobs: [] }), /must contain/);
  assert.throws(
    () => parsePageJobs({ pageJobs: Array.from({ length: MAX_PAGE_JOBS + 1 }, () => null) }),
    /must contain/
  );
});

test("completed output is strict, bounded, and generation-compatible", () => {
  const output = {
    schemaVersion: 1,
    status: "completed",
    boardBuildId: request.boardBuildId,
    triggerParentRunId: "run-1",
    requestDigest: canonicalSha256(request),
    tenantId: request.tenantId,
    repository: request.repository,
    commitSha: request.source.commitSha,
    locale: request.requestedLocale,
    releaseFamilyId: request.releaseFamilyId,
    releaseId: "release-1",
    generationId: "release-1",
    releaseArtifactSha256: "b".repeat(64),
    contentBundleArtifactSha256: "c".repeat(64),
    publicSnapshotDigest: "d".repeat(64),
    pageindexAttachmentId: "attachment-1",
    activationOperationDigest: "e".repeat(64),
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
    completedAt: "2026-08-08T12:00:00.000Z"
  };
  assert.equal(parseWikiCompletedOutput(output).releaseId, "release-1");
  assert.throws(() => parseWikiCompletedOutput({ ...output, generationId: "generation-2" }), /must equal/);
  assert.throws(() => parseWikiCompletedOutput({ ...output, secret: "unexpected" }), /unknown key/);
});
