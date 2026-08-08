import { batch, logger, tags, task } from "@trigger.dev/sdk";

import { ContextWikiApiClient } from "../shared/api.js";
import {
  type AuditWikiPayloadV1,
  type WikiStageTaskPayload,
  assertSameCanonical,
  canonicalSha256,
  parseAuditCompletedOutput,
  parseAuditFollowup,
  parseAuditWikiPayload,
  parseWikiStageResult
} from "../shared/contracts.js";
import { readContextTriggerEnv } from "../shared/env.js";
import { runContextWikiStage } from "../workflow/stage.js";
import { notifyTerminalAuditFailure } from "../workflow/reconciliation.js";

type ChildRunResult = { ok: boolean; output?: unknown; error?: unknown; taskIdentifier?: string };

export const wikiAuditStage = task({
  id: "wiki-audit-stage",
  queue: { concurrencyLimit: 10 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, randomize: true },
  machine: { preset: "small-1x" },
  maxDuration: 1_800,
  run: async (payload: WikiStageTaskPayload) => runContextWikiStage("audit", payload)
});

export const auditWiki = task({
  id: "audit-wiki",
  queue: { concurrencyLimit: 10 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, randomize: true },
  machine: { preset: "small-1x" },
  maxDuration: 3_600,
  onFailure: async ({
    payload: untrustedPayload,
    ctx
  }: {
    payload: AuditWikiPayloadV1;
    ctx: { run: { id: string } };
  }) => {
    try {
      const payload = parseAuditWikiPayload(untrustedPayload);
      const receipt = await notifyTerminalAuditFailure({
        payload,
        triggerParentRunId: ctx.run.id,
        failedAt: new Date().toISOString(),
        api: new ContextWikiApiClient()
      });
      logger.info("audit_wiki_terminal_failure_recorded", {
        trigger_parent_run_id: ctx.run.id,
        audit_hash: shortHash(payload.request.auditId),
        audit_input_digest: payload.request.auditInputDigest,
        outcome: receipt.outcome,
        replay: receipt.replay
      });
    } catch {
      logger.error("audit_wiki_terminal_failure_callback_deferred", {
        trigger_parent_run_id: ctx.run.id
      });
    }
  },
  run: async (untrustedPayload: AuditWikiPayloadV1, { ctx }) => {
    const payload = parseAuditWikiPayload(untrustedPayload);
    const env = readContextTriggerEnv();
    if (
      payload.request.auditPolicyVersion !== env.auditPolicyVersion ||
      payload.request.auditorConfigDigest !== env.auditorConfigDigest
    ) {
      throw new Error("audit request policy does not match the deployed auditor configuration");
    }

    const api = new ContextWikiApiClient({ env });
    // Like generate-wiki, claim is the first external effect.
    const claim = await api.claimAudit({ payload, triggerParentRunId: ctx.run.id });
    assertSameCanonical(claim.request, payload.request, "claimed audit request");

    const auditTags = hashedAuditTags(payload);
    await tags.add(auditTags).catch(() => undefined);
    logger.info("audit_wiki_claimed", {
      trigger_parent_run_id: ctx.run.id,
      audit_hash: shortHash(payload.request.auditId),
      repository_hash: shortHash(payload.request.repository),
      release_hash: shortHash(payload.request.releaseId),
      audit_input_digest: payload.request.auditInputDigest
    });

    const stageOperationId = `wiki-audit:${payload.request.auditInputDigest}:evaluate`;
    const child = await batch.triggerAndWait<typeof wikiAuditStage>([
      {
        id: "wiki-audit-stage",
        payload: {
          schemaVersion: 1,
          authorityId: payload.request.auditId,
          requestDigest: payload.request.auditInputDigest,
          executionGrant: claim.executionGrant,
          operationId: stageOperationId,
          input: {
            releaseId: payload.request.releaseId,
            publicSnapshotDigest: payload.request.publicSnapshotDigest,
            auditPolicyVersion: payload.request.auditPolicyVersion,
            auditorConfigDigest: payload.request.auditorConfigDigest,
            auditWindow: payload.request.auditWindow
          }
        },
        options: { idempotencyKey: stageOperationId, tags: auditTags, ttl: "2h" }
      }
    ]);
    const run = child.runs[0] as ChildRunResult | undefined;
    if (!run?.ok) throw new Error(`wiki-audit-stage failed${run?.taskIdentifier ? ` (${run.taskIdentifier})` : ""}`);
    const stage = parseWikiStageResult(run.output);
    if (stage.operationId !== stageOperationId) throw new Error("wiki-audit-stage returned the wrong operationId");
    const result = parseAuditCompletedOutput(stage.output);
    assertAuditIdentity(result, payload);

    await api.completeAudit({
      auditId: payload.request.auditId,
      executionGrant: claim.executionGrant,
      operationId: `wiki-audit:${payload.request.auditInputDigest}:complete`,
      result
    });

    const followup =
      result.outcome === "needs_improvement"
        ? parseAuditFollowup(
            await api.admitAuditFix({
              auditId: payload.request.auditId,
              executionGrant: claim.executionGrant,
              operationId: `wiki-audit:${payload.request.auditInputDigest}:admit-fix`
            })
          )
        : undefined;
    const completed = { ...result, ...(followup ? { followup } : {}) };
    logger.info("audit_wiki_completed", {
      trigger_parent_run_id: ctx.run.id,
      audit_hash: shortHash(payload.request.auditId),
      release_hash: shortHash(payload.request.releaseId),
      audit_input_digest: payload.request.auditInputDigest,
      outcome: completed.outcome,
      admission_outcome: followup?.admissionOutcome
    });
    return completed;
  }
});

function assertAuditIdentity(result: ReturnType<typeof parseAuditCompletedOutput>, payload: AuditWikiPayloadV1): void {
  if (
    result.auditId !== payload.request.auditId ||
    result.releaseId !== payload.request.releaseId ||
    result.auditInputDigest !== payload.request.auditInputDigest
  ) {
    throw new Error("audit result does not match the authorized audit identity");
  }
}

export function hashedAuditTags(payload: AuditWikiPayloadV1): string[] {
  return [
    "kind:context-wiki-audit",
    `audit:${shortHash(payload.request.auditId)}`,
    `tenant:${shortHash(payload.request.tenantId)}`,
    `repo:${shortHash(payload.request.repository)}`,
    `release:${shortHash(payload.request.releaseId)}`
  ];
}

function shortHash(value: string): string {
  return canonicalSha256(value).slice(0, 16);
}
