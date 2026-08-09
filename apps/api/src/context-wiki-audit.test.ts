import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import {
  contextPublicSnapshotDigest,
  fingerprint,
  parseWikiReleaseArtifactV2,
  repositoryAclFingerprint,
  stableId,
  wikiPublicationInputDigestV2,
  wikiAuditArtifactKey,
  wikiReleaseIdV2,
  wikiContentBundleSha256,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type EvidenceSnapshot,
  type WikiReleaseArtifactV2,
  type WikiAuditArtifactStorePort,
  type WikiContentArtifactRef,
  type WikiContentBundleV1,
  type WikiContentStorePort
} from "@jina/context-engine";
import type { PostgresWikiAuditRepository, WikiAuditFollowupRecord, WikiReleaseAuditRecord } from "@jina/db";
import {
  ContextWikiAuditCoordinator,
  OpenAiContextWikiSemanticAudit,
  contextWikiSemanticAuditConfigDigest,
  parseAuditWikiRequest,
  type AuditWikiRequestV1,
  type ContextWikiSemanticAudit
} from "./context-wiki-audit.js";

const tenantId = "tenant-test";
const repository = "acme/widgets";
const locale = "en";
const commitSha = "b".repeat(40);
const auditorConfigDigest = "a".repeat(64);
const publicSnapshotDigest = contextPublicSnapshotDigest(
  ["architecture.md", "index.md", "quickstart.md", "reference/project-structure.md"].map((documentPath) => ({
    documentPath,
    title: documentPath,
    bodyMarkdown: pageBody(documentPath)
  }))
);
const bundle: WikiContentBundleV1 = {
  version: 1,
  publicSnapshotDigest,
  pages: ["architecture.md", "index.md", "quickstart.md", "reference/project-structure.md"].map((documentPath) => {
    const bodyMarkdown = pageBody(documentPath);
    return { documentPath, bodyMarkdown, bodySha256: sha(bodyMarkdown) };
  })
};
const bundleSha256 = wikiContentBundleSha256(bundle);
const contentRef: WikiContentArtifactRef = {
  version: 1,
  tenantId,
  repository,
  publicSnapshotDigest,
  bundleSha256,
  uri: `memory://${bundleSha256}`,
  key: `context/tenants/${tenantId}/repositories/acme/widgets/wiki-content/${bundleSha256}.json`,
  contentType: "application/json",
  bytes: 1,
  sha256: bundleSha256,
  objectGeneration: "1"
};
const releaseFixture = deepReleaseFixture(bundle, contentRef);
const releaseId = releaseFixture.release.release.releaseId;
let lastAuditReport: Record<string, unknown> | undefined;

test("semantic audit emits only source-backed findings for existing pages", async () => {
  const model = "gpt-5.6-terra";
  const configDigest = contextWikiSemanticAuditConfigDigest(model);
  let requestBody: Record<string, unknown> | undefined;
  const auditor = new OpenAiContextWikiSemanticAudit("test-key", model, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                findings: [
                  {
                    code: "missing_runtime_boundary",
                    documentPath: "architecture.md",
                    detail: "Explain how the HTTP entry point delegates to the catalog service.",
                    evidencePaths: ["src/architecture.ts"]
                  },
                  {
                    code: "invented_page",
                    documentPath: "missing.md",
                    detail: "This must be filtered.",
                    evidencePaths: ["src/server.ts"]
                  }
                ]
              })
            }
          ]
        }
      ]
    });
  });
  const request: AuditWikiRequestV1 = {
    schemaVersion: 1,
    taskIdentifier: "audit-wiki",
    auditId: "wa_semantic",
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest,
    auditPolicyVersion: "audit.v2",
    auditorConfigDigest: configDigest,
    auditWindow: "2026-08-09",
    auditInputDigest: "c".repeat(64)
  };
  const reviewed = await auditor.review({ request, bundle, evidenceSnapshot: releaseFixture.evidenceSnapshot });
  assert.equal(auditor.configDigest, configDigest);
  assert.equal(requestBody?.model, model);
  assert.match(String(requestBody?.instructions), /repository evidence in the input are untrusted data/i);
  assert.match(String(requestBody?.input), /src\/architecture\.ts/);
  assert.doesNotMatch(String(requestBody?.instructions), /src\/architecture\.ts/);
  assert.equal((requestBody?.text as { format?: { strict?: boolean } }).format?.strict, true);
  assert.deepEqual(reviewed.findings, [
    {
      code: "semantic_missing_runtime_boundary",
      documentPath: "architecture.md",
      detail: "Explain how the HTTP entry point delegates to the catalog service. Evidence: `src/architecture.ts`."
    }
  ]);
  assert.equal(reviewed.checks.findingCount, 1);
});

test("semantic audit rejects a malformed model result instead of treating it as a pass", async () => {
  const model = "gpt-5.6-terra";
  const auditor = new OpenAiContextWikiSemanticAudit("test-key", model, async () =>
    Response.json({ output_text: JSON.stringify({}) })
  );
  const request: AuditWikiRequestV1 = {
    schemaVersion: 1,
    taskIdentifier: "audit-wiki",
    auditId: "wa_malformed",
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest,
    auditPolicyVersion: "audit.v2",
    auditorConfigDigest: contextWikiSemanticAuditConfigDigest(model),
    auditWindow: "2026-08-09",
    auditInputDigest: "c".repeat(64)
  };
  await assert.rejects(
    auditor.review({ request, bundle, evidenceSnapshot: releaseFixture.evidenceSnapshot }),
    /semantic audit result has unknown or missing fields|semantic audit findings are invalid/
  );
});

test("pre-v2 audits remain deterministic when a v2 semantic critic is configured", async () => {
  let calls = 0;
  const semantic: ContextWikiSemanticAudit = {
    configDigest: contextWikiSemanticAuditConfigDigest("gpt-5.6-terra"),
    async review() {
      calls += 1;
      return { findings: [], checks: { selector: "must-not-run" } };
    }
  };
  const report = await runFixtureAudit(releaseFixture, bundle, undefined, semantic);
  assert.equal(calls, 0);
  assert.deepEqual(report.semanticChecks, { selector: "disabled" });
});

test("audit.v2 fails closed when the semantic critic is not configured", async () => {
  const auditorConfigDigest = contextWikiSemanticAuditConfigDigest("gpt-5.6-terra");
  const requestIdentity = {
    schemaVersion: 1 as const,
    taskIdentifier: "audit-wiki" as const,
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest,
    auditPolicyVersion: "audit.v2",
    auditorConfigDigest,
    auditWindow: "2026-08-09"
  };
  const coordinator = new ContextWikiAuditCoordinator(
    {} as PostgresWikiAuditRepository,
    {} as never,
    {} as never,
    {} as never,
    "dispatch-secret-that-is-long-enough-for-tests"
  );
  await assert.rejects(
    coordinator.run({
      request: {
        ...requestIdentity,
        auditId: stableId("wa", {
          releaseId,
          auditPolicyVersion: requestIdentity.auditPolicyVersion,
          auditorConfigDigest,
          auditWindow: requestIdentity.auditWindow
        }),
        auditInputDigest: fingerprint(requestIdentity)
      },
      triggerParentRunId: "run_semantic_required",
      operationId: "audit-semantic-required",
      now: "2026-08-09T00:00:00.000Z"
    }),
    /semantic wiki audit is required by audit\.v2 but is not configured/
  );
});

test("daily audit dispatch is signed, immutable, non-gating, and idempotent", async () => {
  assert.deepEqual(parseWikiReleaseArtifactV2(releaseFixture.release), releaseFixture.release);
  const records: WikiReleaseAuditRecord[] = [];
  const followups: WikiAuditFollowupRecord[] = [];
  const claims: Record<string, unknown>[] = [];
  let queryProbes = 0;
  const audits = {
    async claimRun(input: Record<string, unknown>) {
      const existing = claims[0];
      if (existing) return { record: existing, created: false };
      claims.push(input);
      return { record: input, created: true };
    },
    async getRunClaim() {
      return claims[0];
    },
    async listDue() {
      return [
        {
          tenantId,
          repository,
          ref: "refs/heads/main",
          locale,
          releaseId,
          commitSha,
          publicSnapshotDigest
        }
      ];
    },
    async insertTerminal(input: WikiReleaseAuditRecord) {
      const existing = records.find((record) => record.auditInputDigest === input.auditInputDigest);
      if (existing) return { record: existing, created: false };
      records.push(input);
      return { record: input, created: true };
    },
    async get() {
      return records[0];
    },
    async getFollowup() {
      return followups[0];
    },
    async recordFollowup(input: WikiAuditFollowupRecord) {
      followups.push(input);
      return { record: input, created: true };
    }
  };
  const coordinator = new ContextWikiAuditCoordinator(
    audits as unknown as PostgresWikiAuditRepository,
    {
      async getPublishedReleaseInputs() {
        return {
          tenantId,
          repository,
          releaseId,
          ref: "refs/heads/main",
          refSequence: 3,
          scopeKind: "branch",
          scopeKey: "main",
          commitSha,
          locale,
          generatorPolicyVersion: "wiki-generator-v3",
          releaseFamilyId: "family-test",
          publicSnapshotDigest,
          contentBundleArtifact: contentRef,
          releaseArtifact: releaseFixture.releaseArtifact,
          evidenceSnapshot: releaseFixture.evidenceSnapshot
        };
      }
    },
    {
      async get() {
        return bundle;
      }
    } as unknown as WikiContentStorePort,
    auditArtifacts(),
    "dispatch-secret-that-is-at-least-thirty-two-characters",
    undefined,
    {
      async probe(input) {
        queryProbes += 1;
        assert.equal(input.releaseId, releaseId);
        assert.deepEqual(input.queries, ["quickstart setup", "architecture components", "request workflow"]);
        return {
          releaseId,
          documentPaths: bundle.pages.map((page) => page.documentPath),
          treeNodeCount: bundle.pages.length,
          citationCount: bundle.pages.length,
          searches: input.queries.map((query) => ({ query, resultPaths: ["index.md"] }))
        };
      }
    },
    releaseFixture.artifacts,
    undefined,
    {
      configDigest: auditorConfigDigest,
      async review(input) {
        assert.equal(input.request.auditorConfigDigest, auditorConfigDigest);
        assert.equal(input.bundle.publicSnapshotDigest, publicSnapshotDigest);
        return { findings: [], checks: { selector: "semantic-test", findingCount: 0 } };
      }
    }
  );
  const due = await coordinator.due({
    tenantIds: [tenantId],
    auditPolicyVersion: "audit.v2",
    auditorConfigDigest,
    timestamp: "2026-08-08T03:00:00.000Z",
    limit: 100
  });
  assert.equal(due.audits.length, 1);
  const payload = due.audits[0]!;
  assert.deepEqual(
    await coordinator.claim(payload, { triggerParentRunId: "run_audit", claimedAt: "2026-08-08T03:00:30.000Z" }),
    payload.request
  );
  await assert.rejects(
    coordinator.claim(
      { ...payload, dispatchNonce: `${payload.dispatchNonce}x` },
      { triggerParentRunId: "run_audit", claimedAt: "2026-08-08T03:00:30.000Z" }
    ),
    /dispatch nonce/
  );
  const result = await coordinator.run({
    request: payload.request,
    triggerParentRunId: "run_audit",
    operationId: "audit:evaluate",
    now: "2026-08-08T03:01:00.000Z"
  });
  assert.equal(result.outcome, "passed", JSON.stringify(lastAuditReport?.findings));
  assert.deepEqual(lastAuditReport?.semanticChecks, { selector: "semantic-test", findingCount: 0 });
  assert.equal(queryProbes, 1);
  assert.deepEqual(await coordinator.complete({ request: payload.request, triggerParentRunId: "run_audit", result }), {
    created: true
  });
  assert.deepEqual(await coordinator.complete({ request: payload.request, triggerParentRunId: "run_audit", result }), {
    created: false
  });
  assert.deepEqual(await coordinator.admitFix({ request: payload.request, now: result.completedAt }), {
    admissionOutcome: "policy_denied"
  });
  assert.equal(followups[0]?.admissionOutcome, "policy_denied");
  assert.deepEqual(await coordinator.admitFix({ request: payload.request, now: "2026-08-09T03:01:00.000Z" }), {
    admissionOutcome: "policy_denied"
  });
  assert.equal(followups.length, 1, "a replay must return the immutable decision without writing a new timestamp");
});

test("manual explicit-release dispatch reuses the canonical signed daily identity and rejects locale drift", async () => {
  const coordinator = new ContextWikiAuditCoordinator(
    {
      async listDue() {
        return [];
      }
    } as unknown as PostgresWikiAuditRepository,
    {
      async getPublishedReleaseInputs(input) {
        assert.deepEqual(input, { tenantId, repository, releaseId });
        return publishedInputs(releaseFixture, bundle);
      }
    },
    {} as WikiContentStorePort,
    auditArtifacts(),
    "dispatch-secret-that-is-at-least-thirty-two-characters"
  );
  const dispatched = await coordinator.dispatch({
    tenantId,
    repository: "ACME/WIDGETS",
    releaseId,
    locale: "EN",
    auditPolicyVersion: "daily-v1",
    auditorConfigDigest,
    timestamp: "2026-08-08T17:42:00.000Z"
  });
  assert.equal(
    dispatched.request.auditId,
    stableId("wa", {
      releaseId,
      auditPolicyVersion: "daily-v1",
      auditorConfigDigest,
      auditWindow: "2026-08-08"
    })
  );
  assert.deepEqual(parseAuditWikiRequest(dispatched.request), dispatched.request);
  await assert.rejects(
    coordinator.dispatch({
      tenantId,
      repository,
      releaseId,
      locale: "fr",
      auditPolicyVersion: "daily-v1",
      auditorConfigDigest,
      timestamp: "2026-08-08T17:42:00.000Z"
    }),
    /not published.*scope/
  );
});

test("terminal audit failure is run-bound, deterministic after report-write crash, and idempotent", async () => {
  const records: WikiReleaseAuditRecord[] = [];
  let claim: Record<string, unknown> | undefined;
  let failFirstInsert = true;
  const coordinator = new ContextWikiAuditCoordinator(
    {
      async claimRun(input: Record<string, unknown>) {
        claim = input;
        return { record: input, created: true };
      },
      async getRunClaim() {
        return claim;
      },
      async get() {
        return records[0];
      },
      async insertTerminal(input: WikiReleaseAuditRecord) {
        if (failFirstInsert) {
          failFirstInsert = false;
          throw new Error("simulated terminal insert crash");
        }
        records.push(input);
        return { record: input, created: true };
      }
    } as unknown as PostgresWikiAuditRepository,
    {
      async getPublishedReleaseInputs() {
        return publishedInputs(releaseFixture, bundle);
      }
    },
    {} as WikiContentStorePort,
    auditArtifacts(),
    "dispatch-secret-that-is-at-least-thirty-two-characters"
  );
  const payload = await coordinator.dispatch({
    tenantId,
    repository,
    releaseId,
    locale,
    auditPolicyVersion: "terminal-v1",
    auditorConfigDigest,
    timestamp: "2026-08-10T03:00:00.000Z"
  });
  await coordinator.claim(payload, {
    triggerParentRunId: "run_terminal_audit",
    claimedAt: "2026-08-10T03:00:30.000Z"
  });
  await assert.rejects(
    coordinator.fail({
      request: payload.request,
      failure: {
        schemaVersion: 1,
        auditId: payload.request.auditId,
        triggerParentRunId: "run_terminal_audit",
        auditInputDigest: payload.request.auditInputDigest,
        code: "trigger_crashed",
        source: "reconciler",
        failedAt: "2026-08-10T03:05:00.000Z"
      }
    }),
    /terminal insert crash/
  );
  const replay = await coordinator.fail({
    request: payload.request,
    failure: {
      schemaVersion: 1,
      auditId: payload.request.auditId,
      triggerParentRunId: "run_terminal_audit",
      auditInputDigest: payload.request.auditInputDigest,
      code: "trigger_failed",
      source: "on_failure",
      failedAt: "2026-08-10T03:06:00.000Z"
    }
  });
  assert.equal(replay.result.outcome, "error");
  assert.equal(replay.result.completedAt, "2026-08-10T03:00:30.000Z");
  assert.equal(records.length, 1);
  await assert.rejects(
    coordinator.fail({
      request: payload.request,
      failure: {
        schemaVersion: 1,
        auditId: payload.request.auditId,
        triggerParentRunId: "run_other",
        auditInputDigest: payload.request.auditInputDigest,
        code: "trigger_failed",
        source: "on_failure",
        failedAt: "2026-08-10T03:06:00.000Z"
      }
    }),
    /run claim/
  );
});

test("a completed immutable audit report wins a parent-failure race and is recoverable by exact operation", async () => {
  const records: WikiReleaseAuditRecord[] = [];
  let claim: Record<string, unknown> | undefined;
  const audits = {
    async claimRun(input: Record<string, unknown>) {
      claim = input;
      return { record: input, created: true };
    },
    async getRunClaim() {
      return claim;
    },
    async get() {
      return records[0];
    },
    async insertTerminal(input: WikiReleaseAuditRecord) {
      records.push(input);
      return { record: input, created: true };
    }
  };
  const coordinator = new ContextWikiAuditCoordinator(
    audits as unknown as PostgresWikiAuditRepository,
    {
      async getPublishedReleaseInputs() {
        return publishedInputs(releaseFixture, bundle);
      }
    },
    {
      async get() {
        return bundle;
      }
    } as unknown as WikiContentStorePort,
    auditArtifacts(),
    "dispatch-secret-that-is-at-least-thirty-two-characters",
    undefined,
    undefined,
    releaseFixture.artifacts
  );
  const payload = await coordinator.dispatch({
    tenantId,
    repository,
    releaseId,
    locale,
    auditPolicyVersion: "recovery-v1",
    auditorConfigDigest,
    timestamp: "2026-08-11T03:00:00.000Z"
  });
  const operationId = `wiki-audit:${payload.request.auditInputDigest}:evaluate`;
  await coordinator.claim(payload, {
    triggerParentRunId: "run_report_recovery",
    claimedAt: "2026-08-11T03:00:30.000Z"
  });
  const evaluated = await coordinator.run({
    request: payload.request,
    triggerParentRunId: "run_report_recovery",
    operationId,
    now: "2026-08-11T03:00:30.000Z"
  });
  assert.equal(evaluated.outcome, "passed");
  assert.deepEqual(
    await coordinator.recoverRun({
      request: payload.request,
      triggerParentRunId: "run_report_recovery",
      operationId
    }),
    evaluated
  );
  await assert.rejects(
    coordinator.recoverRun({
      request: payload.request,
      triggerParentRunId: "run_report_recovery",
      operationId: `${operationId}:wrong`
    }),
    /immutable Trigger operation/
  );
  const reconciled = await coordinator.fail({
    request: payload.request,
    failure: {
      schemaVersion: 1,
      auditId: payload.request.auditId,
      triggerParentRunId: "run_report_recovery",
      auditInputDigest: payload.request.auditInputDigest,
      code: "trigger_system_failure",
      source: "reconciler",
      failedAt: "2026-08-11T03:05:00.000Z"
    }
  });
  assert.equal(reconciled.result.outcome, "passed");
  assert.equal(records[0]?.outcome, "passed");
});

test("terminal improvement reconciliation admits one Board build and an existing follow-up replays", async () => {
  const request = {
    schemaVersion: 1 as const,
    taskIdentifier: "audit-wiki" as const,
    auditId: "wa_replay",
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest,
    auditPolicyVersion: "daily-v1",
    auditorConfigDigest,
    auditWindow: "2026-08-08",
    auditInputDigest: "c".repeat(64)
  };
  const followups: WikiAuditFollowupRecord[] = [];
  let admissionCalls = 0;
  const runClaim = {
    ...request,
    triggerRunId: "run-audit",
    claimedAt: "2026-08-08T03:00:00.000Z"
  };
  const audits = {
    async listPendingImprovementRuns() {
      return followups.length === 0 ? [runClaim] : [];
    },
    async get() {
      return {
        ...request,
        triggerRunId: "run-audit",
        outcome: "needs_improvement" as const,
        summary: { findingsDigest: "d".repeat(64) },
        reportArtifact: {
          version: 1 as const,
          tenantId,
          repository,
          auditId: request.auditId,
          releaseId,
          auditInputDigest: request.auditInputDigest,
          uri: `memory://${request.auditId}`,
          key: wikiAuditArtifactKey({ tenantId, repository, auditId: request.auditId }),
          contentType: "application/json" as const,
          bytes: 1,
          sha256: "e".repeat(64),
          objectGeneration: "1"
        },
        completedAt: "2026-08-08T03:01:00.000Z"
      };
    },
    async getFollowup() {
      return followups[0];
    },
    async recordFollowup(input: WikiAuditFollowupRecord) {
      followups.push(input);
      return { record: input, created: true };
    }
  };
  const coordinator = new ContextWikiAuditCoordinator(
    audits as unknown as PostgresWikiAuditRepository,
    {} as never,
    {} as never,
    {} as never,
    "dispatch-secret-that-is-at-least-thirty-two-characters",
    {
      async admit() {
        admissionCalls += 1;
        return { admissionOutcome: "admitted", boardBuildId: "task-wiki-fix" };
      }
    }
  );

  assert.deepEqual(await coordinator.improvementsDue({ tenantIds: [tenantId], limit: 100 }), { runs: [runClaim] });
  assert.deepEqual(await coordinator.admitFix({ request, now: "2026-08-08T03:02:00.000Z" }), {
    admissionOutcome: "admitted",
    boardBuildId: "task-wiki-fix"
  });
  assert.deepEqual(await coordinator.admitFix({ request, now: "2026-08-09T03:02:00.000Z" }), {
    admissionOutcome: "already_admitted",
    boardBuildId: "task-wiki-fix"
  });
  assert.equal(admissionCalls, 1);
  assert.equal(followups.length, 1);
  assert.deepEqual(await coordinator.improvementsDue({ tenantIds: [tenantId], limit: 100 }), { runs: [] });
});

test("audit-fix recovers when the process fails after Board admission but before follow-up persistence", async () => {
  const request = {
    schemaVersion: 1 as const,
    taskIdentifier: "audit-wiki" as const,
    auditId: "wa_crash_recovery",
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest,
    auditPolicyVersion: "daily-v1",
    auditorConfigDigest,
    auditWindow: "2026-08-08",
    auditInputDigest: "f".repeat(64)
  };
  let boardBuildExists = false;
  let failPersistence = true;
  let followup: WikiAuditFollowupRecord | undefined;
  const runClaim = {
    ...request,
    triggerRunId: "run-audit",
    claimedAt: "2026-08-08T03:00:00.000Z"
  };
  const coordinator = new ContextWikiAuditCoordinator(
    {
      async listPendingImprovementRuns() {
        return followup ? [] : [runClaim];
      },
      async get() {
        return {
          ...request,
          triggerRunId: "run-audit",
          outcome: "needs_improvement" as const,
          summary: { findingsDigest: "d".repeat(64) },
          reportArtifact: {
            version: 1 as const,
            tenantId,
            repository,
            auditId: request.auditId,
            releaseId,
            auditInputDigest: request.auditInputDigest,
            uri: `memory://${request.auditId}`,
            key: wikiAuditArtifactKey({ tenantId, repository, auditId: request.auditId }),
            contentType: "application/json" as const,
            bytes: 1,
            sha256: "e".repeat(64),
            objectGeneration: "1"
          },
          completedAt: "2026-08-08T03:01:00.000Z"
        };
      },
      async getFollowup() {
        return followup;
      },
      async recordFollowup(input: WikiAuditFollowupRecord) {
        if (failPersistence) {
          failPersistence = false;
          throw new Error("simulated post-admission persistence failure");
        }
        followup = input;
        return { record: input, created: true };
      }
    } as unknown as PostgresWikiAuditRepository,
    {} as never,
    {} as never,
    {} as never,
    "dispatch-secret-that-is-at-least-thirty-two-characters",
    {
      async admit() {
        if (boardBuildExists) return { admissionOutcome: "already_admitted", boardBuildId: "task-wiki-fix" };
        boardBuildExists = true;
        return { admissionOutcome: "admitted", boardBuildId: "task-wiki-fix" };
      }
    }
  );

  assert.equal((await coordinator.improvementsDue({ tenantIds: [tenantId], limit: 100 })).runs.length, 1);
  await assert.rejects(
    coordinator.admitFix({ request, now: "2026-08-08T03:02:00.000Z" }),
    /post-admission persistence failure/
  );
  assert.deepEqual(await coordinator.admitFix({ request, now: "2026-08-09T03:02:00.000Z" }), {
    admissionOutcome: "already_admitted",
    boardBuildId: "task-wiki-fix"
  });
  assert.equal(followup?.admissionOutcome, "already_admitted");
  assert.equal(followup?.decidedAt, "2026-08-09T03:02:00.000Z");
  assert.deepEqual(await coordinator.improvementsDue({ tenantIds: [tenantId], limit: 100 }), { runs: [] });
});

test("independent audit rejects tampered checkpoint and exact citation evidence bindings", async () => {
  const tampered = {
    ...releaseFixture,
    evidenceSnapshot: {
      ...releaseFixture.evidenceSnapshot,
      checkpoint: { ...releaseFixture.evidenceSnapshot.checkpoint, id: "checkpoint-tampered" },
      records: releaseFixture.evidenceSnapshot.records.map((record, index) =>
        index === 0 ? { ...record, anchor: { ...record.anchor, contentDigest: "f".repeat(64) } } : record
      )
    }
  };

  const report = await runFixtureAudit(tampered, bundle);
  assert.equal(report.outcome, "needs_improvement");
  assert.deepEqual(findingCodes(report), ["broken_citation_binding", "evidence_checkpoint_identity_mismatch"]);
});

test("independent audit diagnoses locale/frontmatter drift and bounded contradictory claims", async () => {
  const localizedPages = bundle.pages.map((page, index) => {
    let bodyMarkdown = page.bodyMarkdown;
    if (index === 0) bodyMarkdown = bodyMarkdown.replace('  locale: "en"', '  locale: "fr"');
    if (index === 1) bodyMarkdown += "\nFeature flag alpha is enabled.\n";
    if (index === 2) bodyMarkdown += "\nFeature flag alpha is disabled.\n";
    return { ...page, bodyMarkdown, bodySha256: sha(bodyMarkdown) };
  });
  const localizedDigest = contextPublicSnapshotDigest(
    localizedPages.map((page) => ({ ...page, title: page.documentPath }))
  );
  const localizedBundle: WikiContentBundleV1 = {
    version: 1,
    publicSnapshotDigest: localizedDigest,
    pages: localizedPages
  };
  const localizedContentRef = wikiContentRef(localizedBundle);
  const fixture = deepReleaseFixture(localizedBundle, localizedContentRef);

  const report = await runFixtureAudit(fixture, localizedBundle);
  assert.equal(report.outcome, "needs_improvement");
  assert.deepEqual(findingCodes(report), ["contradictory_boolean_claim", "frontmatter_locale_mismatch"]);
});

const localChromiumExecutable = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].find(existsSync);

test(
  "independent Mermaid audit renders safe syntax and diagnoses unsafe/invalid diagrams without network access",
  { skip: localChromiumExecutable === undefined },
  async () => {
    let requestCount = 0;
    const listener = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = listener.address();
      assert.ok(address && typeof address !== "string");
      const externalUrl = `http://127.0.0.1:${address.port}/audit.png`;
      const pages = bundle.pages.map((page, index) => {
        const diagrams =
          index === 0
            ? [
                "```mermaid\nsequenceDiagram\n  API->>Worker: Build\n```",
                `> ~~~mermaid\n> flowchart LR\n>   A[image] --> B[${externalUrl}]\n> ~~~`,
                "~~~~mermaid\nflowchart LR\n  A[unterminated --> B"
              ].join("\n\n")
            : "";
        const bodyMarkdown = `${page.bodyMarkdown}\n${diagrams}\n`;
        return { ...page, bodyMarkdown, bodySha256: sha(bodyMarkdown) };
      });
      const digest = contextPublicSnapshotDigest(pages.map((page) => ({ ...page, title: page.documentPath })));
      const diagramBundle: WikiContentBundleV1 = { version: 1, publicSnapshotDigest: digest, pages };
      const fixture = deepReleaseFixture(diagramBundle, wikiContentRef(diagramBundle));
      const report = await runFixtureAudit(fixture, diagramBundle, localChromiumExecutable);

      assert.equal(report.outcome, "needs_improvement");
      assert.deepEqual(findingCodes(report), ["invalid_mermaid", "unsafe_mermaid"]);
      assert.equal(requestCount, 0);
      assert.deepEqual(report.mermaidChecks, {
        selector: "strict-browser-mermaid-audit-v1",
        diagramCount: 3,
        renderedCount: 1,
        blockedNetworkRequests: 0,
        networkPolicy: "abort-all"
      });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }
);

test("audit requests bind their deterministic digest and identifier", () => {
  const base = {
    schemaVersion: 1 as const,
    taskIdentifier: "audit-wiki" as const,
    tenantId,
    repository,
    releaseId,
    locale,
    publicSnapshotDigest,
    auditPolicyVersion: "daily-v1",
    auditorConfigDigest,
    auditWindow: "2026-08-08"
  };
  const request = {
    ...base,
    auditId: stableId("wa", {
      releaseId,
      auditPolicyVersion: base.auditPolicyVersion,
      auditorConfigDigest,
      auditWindow: base.auditWindow
    }),
    auditInputDigest: fingerprint(base)
  };
  assert.deepEqual(parseAuditWikiRequest(request), request);
  assert.throws(() => parseAuditWikiRequest({ ...request, locale: "fr" }), /input digest/);
  assert.throws(() => parseAuditWikiRequest({ ...request, extra: true }), /unknown or missing/);
});

test("audit claim parsing canonicalizes a regional locale before verifying its identity", () => {
  const base = {
    schemaVersion: 1 as const,
    taskIdentifier: "audit-wiki" as const,
    tenantId,
    repository,
    releaseId,
    locale: "en-us",
    publicSnapshotDigest,
    auditPolicyVersion: "daily-v1",
    auditorConfigDigest,
    auditWindow: "2026-08-08"
  };
  const canonical = {
    ...base,
    auditId: stableId("wa", {
      releaseId,
      auditPolicyVersion: base.auditPolicyVersion,
      auditorConfigDigest,
      auditWindow: base.auditWindow
    }),
    auditInputDigest: fingerprint(base)
  };

  assert.deepEqual(parseAuditWikiRequest({ ...canonical, locale: "en-US" }), canonical);
});

async function runFixtureAudit(
  fixture: ReturnType<typeof deepReleaseFixture>,
  content: WikiContentBundleV1,
  chromiumExecutablePath?: string,
  semantic?: ContextWikiSemanticAudit
): Promise<Record<string, unknown>> {
  lastAuditReport = undefined;
  const identity = fixture.release.release;
  const base = {
    schemaVersion: 1 as const,
    taskIdentifier: "audit-wiki" as const,
    tenantId,
    repository,
    releaseId: identity.releaseId,
    locale: identity.locale,
    publicSnapshotDigest: content.publicSnapshotDigest,
    auditPolicyVersion: "daily-v1",
    auditorConfigDigest,
    auditWindow: "2026-08-08"
  };
  const request = {
    ...base,
    auditId: stableId("wa", {
      releaseId: identity.releaseId,
      auditPolicyVersion: base.auditPolicyVersion,
      auditorConfigDigest,
      auditWindow: base.auditWindow
    }),
    auditInputDigest: fingerprint(base)
  };
  const coordinator = new ContextWikiAuditCoordinator(
    {} as PostgresWikiAuditRepository,
    {
      async getPublishedReleaseInputs() {
        return {
          tenantId,
          repository,
          releaseId: identity.releaseId,
          ref: identity.ref,
          refSequence: identity.refSequence!,
          scopeKind: identity.scopeKind,
          scopeKey: identity.scopeKey,
          commitSha: identity.commitSha,
          locale: identity.locale,
          generatorPolicyVersion: "wiki-generator-v3",
          releaseFamilyId: identity.releaseFamilyId,
          publicSnapshotDigest: content.publicSnapshotDigest,
          contentBundleArtifact: fixture.release.contentBundleArtifact,
          releaseArtifact: fixture.releaseArtifact,
          evidenceSnapshot: fixture.evidenceSnapshot
        };
      }
    },
    {
      async get() {
        return content;
      }
    } as unknown as WikiContentStorePort,
    auditArtifacts(),
    "dispatch-secret-that-is-at-least-thirty-two-characters",
    undefined,
    undefined,
    fixture.artifacts,
    chromiumExecutablePath,
    semantic
  );
  await coordinator.run({
    request,
    triggerParentRunId: "run-independent-audit",
    operationId: "audit:evaluate",
    now: "2026-08-08T03:01:00.000Z"
  });
  assert.ok(lastAuditReport);
  return lastAuditReport;
}

function publishedInputs(fixture: ReturnType<typeof deepReleaseFixture>, content: WikiContentBundleV1) {
  const identity = fixture.release.release;
  return {
    tenantId,
    repository,
    releaseId: identity.releaseId,
    ref: identity.ref,
    refSequence: identity.refSequence!,
    scopeKind: identity.scopeKind,
    scopeKey: identity.scopeKey,
    commitSha: identity.commitSha,
    locale: identity.locale,
    generatorPolicyVersion: "wiki-generator-v3",
    releaseFamilyId: identity.releaseFamilyId,
    publicSnapshotDigest: content.publicSnapshotDigest,
    contentBundleArtifact: fixture.release.contentBundleArtifact,
    releaseArtifact: fixture.releaseArtifact,
    evidenceSnapshot: fixture.evidenceSnapshot
  };
}

function findingCodes(report: Record<string, unknown>): string[] {
  assert.ok(Array.isArray(report.findings));
  return report.findings.map((finding) => String((finding as { code: unknown }).code)).sort();
}

function wikiContentRef(content: WikiContentBundleV1): WikiContentArtifactRef {
  const bundleSha256 = wikiContentBundleSha256(content);
  return {
    version: 1,
    tenantId,
    repository,
    publicSnapshotDigest: content.publicSnapshotDigest,
    bundleSha256,
    uri: `memory://context/tenants/${tenantId}/repositories/acme/widgets/wiki-content/${bundleSha256}.json`,
    key: `context/tenants/${tenantId}/repositories/acme/widgets/wiki-content/${bundleSha256}.json`,
    contentType: "application/json",
    bytes: 1,
    sha256: bundleSha256,
    objectGeneration: "1"
  };
}

function auditArtifacts(): WikiAuditArtifactStorePort {
  const objects = new Map<
    string,
    { ref: Awaited<ReturnType<WikiAuditArtifactStorePort["putIfAbsent"]>>; bytes: Uint8Array }
  >();
  return {
    async putIfAbsent(input) {
      const content = typeof input.content === "string" ? Buffer.from(input.content) : Buffer.from(input.content);
      lastAuditReport = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
      const digest = sha(content);
      const ref = {
        version: 1,
        tenantId: input.tenantId,
        repository: input.repository,
        auditId: input.auditId,
        releaseId: input.releaseId,
        auditInputDigest: input.auditInputDigest,
        uri: `memory://${input.auditId}`,
        key: wikiAuditArtifactKey(input),
        contentType: "application/json",
        bytes: content.byteLength,
        sha256: digest,
        objectGeneration: "1"
      } as const;
      const existing = objects.get(input.auditId);
      if (existing) {
        if (sha(existing.bytes) !== digest) throw new Error("immutable audit report collision");
        return existing.ref;
      }
      objects.set(input.auditId, { ref, bytes: content });
      return ref;
    },
    async find(input) {
      const existing = objects.get(input.auditId);
      if (
        !existing ||
        existing.ref.releaseId !== input.releaseId ||
        existing.ref.auditInputDigest !== input.auditInputDigest
      ) {
        return undefined;
      }
      return existing.ref;
    },
    async get(ref) {
      const existing = objects.get(ref.auditId);
      if (!existing || existing.ref.sha256 !== ref.sha256) throw new Error("audit report not found");
      return existing.bytes;
    }
  };
}

function pageBody(path: string): string {
  return [
    "---",
    'type: "Overview"',
    `title: ${JSON.stringify(path)}`,
    'description: "Grounded repository documentation."',
    'tags: ["wiki", "repository"]',
    "jina:",
    '  roles: ["reference"]',
    `  source_paths: [${JSON.stringify(`src/${path.replace(/\.md$/, ".ts")}`)}]`,
    "  test_paths: []",
    `  repository: ${JSON.stringify(repository)}`,
    `  commit: ${JSON.stringify(commitSha)}`,
    `  locale: ${JSON.stringify(locale)}`,
    "---",
    "",
    `# ${path}`,
    "",
    `${"Grounded documentation content. ".repeat(12)}`,
    ""
  ].join("\n");
}

function deepReleaseFixture(
  content: WikiContentBundleV1,
  contentArtifact: WikiContentArtifactRef
): {
  readonly release: WikiReleaseArtifactV2;
  readonly releaseArtifact: ContextArtifactRef;
  readonly evidenceSnapshot: EvidenceSnapshot;
  readonly artifacts: Pick<ContextArtifactStore, "get">;
} {
  const buildId = "build-audit-test";
  const checkpointId = "checkpoint-audit-test";
  const preparedAt = "2026-08-08T02:59:00.000Z";
  const artifact = (kind: string, name: string, bytes: Uint8Array): ContextArtifactRef => {
    const key = `context/tenants/${tenantId}/repositories/acme/widgets/builds/${buildId}/${kind}/${name}`;
    return {
      uri: `memory://${key}`,
      key,
      contentType: "application/json",
      bytes: bytes.byteLength,
      sha256: sha(bytes),
      objectGeneration: "1"
    };
  };
  const evidenceRecords = content.pages.map((page, ordinal) => {
    const path = `src/${page.documentPath.replace(/\.md$/, ".ts")}`;
    const anchor = {
      tenantId,
      repository,
      sourceType: "blob" as const,
      sourceId: `blob-${ordinal}`,
      contentDigest: sha(`source-${ordinal}`),
      commitSha,
      pathOrUrl: path
    };
    return {
      id: `evidence-${ordinal}`,
      anchor,
      ref: "refs/heads/main",
      title: path,
      body: `source-${ordinal}`,
      metadata: {},
      authorityClass: "source_code" as const,
      aclFingerprint: repositoryAclFingerprint(tenantId, repository),
      createdAt: preparedAt
    };
  });
  const projectedPages = content.pages.map((page, ordinal) => ({
    documentPath: page.documentPath,
    title: page.documentPath,
    bodySha256: page.bodySha256,
    revisionId: `revision-${ordinal}`,
    citations: [
      {
        id: `citation-${ordinal}`,
        revisionId: `revision-${ordinal}`,
        ordinal: 0,
        claim: `This page is grounded in ${evidenceRecords[ordinal]!.anchor.pathOrUrl}.`,
        citationId: `cite_${sha(`citation-${ordinal}`).slice(0, 20)}`,
        claimSpan: evidenceRecords[ordinal]!.anchor.pathOrUrl,
        anchor: evidenceRecords[ordinal]!.anchor
      }
    ],
    metadataDigest: sha(`metadata-${ordinal}`)
  }));
  const manifest = {
    version: 1,
    sourceDigest: "1".repeat(64),
    publicSnapshotDigest: content.publicSnapshotDigest,
    projectionInputDigest: "2".repeat(64),
    instructionDigest: "3".repeat(64),
    exclusionPolicyDigest: "4".repeat(64),
    locale,
    pathAccounting: { retain: [], regenerate: [], add: content.pages.map((page) => page.documentPath), retire: [] },
    pages: projectedPages.map((page, ordinal) => ({
      ...page,
      sourcePaths: [evidenceRecords[ordinal]!.anchor.pathOrUrl]
    })),
    diagnostics: []
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const releaseManifestArtifact = artifact("context-draft", "release-manifest.json", manifestBytes);
  const generationPlanArtifact = artifact("research-plan", "generation-plan.json", Buffer.from("{}\n"));
  const finalizationArtifact = artifact("certification", "finalization.json", Buffer.from("{}\n"));
  const releaseIdentity = {
    releaseId: "cr_placeholder",
    tenantId,
    repository,
    ref: "refs/heads/main",
    refSequence: 3,
    scopeKind: "branch" as const,
    scopeKey: "main",
    commitSha,
    checkpointId,
    generationId: "cr_placeholder",
    buildId,
    triggerParentRunId: "run-build",
    requestDigest: "5".repeat(64),
    releaseFamilyId: "family-test",
    generationReason: "initial" as const,
    locale,
    preparedAt
  };
  const withoutDigest = {
    version: 2 as const,
    kind: "generated-wiki" as const,
    release: releaseIdentity,
    generationPlanArtifact,
    finalizationArtifact,
    releaseManifestArtifact,
    contentBundleArtifact: contentArtifact,
    publicSnapshotDigest: content.publicSnapshotDigest,
    pages: projectedPages
  };
  const publicationInputDigest = wikiPublicationInputDigestV2(withoutDigest);
  const computedReleaseId = wikiReleaseIdV2(publicationInputDigest);
  const release: WikiReleaseArtifactV2 = {
    ...withoutDigest,
    release: { ...releaseIdentity, releaseId: computedReleaseId, generationId: computedReleaseId },
    publicationInputDigest
  };
  const releaseBytes = Buffer.from(`${JSON.stringify(release)}\n`);
  const releaseArtifact = artifact("context-release", "release-v2.json", releaseBytes);
  const objects = new Map<string, Uint8Array>([
    [releaseArtifact.key, releaseBytes],
    [releaseManifestArtifact.key, manifestBytes]
  ]);
  return {
    release,
    releaseArtifact,
    evidenceSnapshot: {
      checkpoint: {
        id: checkpointId,
        tenantId,
        repository,
        ref: "refs/heads/main",
        refSequence: 3,
        commitSha,
        parserVersion: "audit-fixture-v1",
        sourceCompleteness: "complete",
        observationFrontier: "fixture",
        evidenceFingerprint: "6".repeat(64),
        manifestFingerprint: "7".repeat(64),
        aclFingerprint: repositoryAclFingerprint(tenantId, repository),
        createdAt: preparedAt
      },
      records: evidenceRecords,
      manifest: [],
      structuralFacts: []
    },
    artifacts: {
      async get(ref) {
        const bytes = objects.get(ref.key);
        if (!bytes || sha(bytes) !== ref.sha256 || bytes.byteLength !== ref.bytes) {
          throw new Error("immutable test artifact mismatch");
        }
        return bytes;
      }
    }
  };
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
