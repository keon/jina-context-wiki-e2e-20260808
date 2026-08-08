import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  wikiAuditArtifactKey,
  type WikiAuditArtifactStorePort,
  type WikiAuditReportArtifactRef,
  type WikiContentStorePort
} from "@jina/context-engine";
import type { PostgresWikiAuditRepository, WikiAuditRunClaim, WikiReleaseAuditRecord } from "@jina/db";
import { ContextWikiAuditCoordinator } from "./context-wiki-audit.js";
import { createApiServer } from "./server.js";

const tenantId = "tenant-audit-route";
const repository = "acme/widgets";
const releaseId = "cr_historical_release";
const serviceToken = "context-trigger-audit-route-token";
const grantSecret = "g".repeat(64);
const dispatchSecret = "d".repeat(64);
const auditorConfigDigest = "a".repeat(64);
const publicSnapshotDigest = "b".repeat(64);

test("authenticated manual dispatch targets an explicit historical release and terminal failure is run-bound", async () => {
  let claim: WikiAuditRunClaim | undefined;
  let terminal: WikiReleaseAuditRecord | undefined;
  const artifacts = memoryAuditArtifacts();
  const audits = {
    async claimRun(input: WikiAuditRunClaim) {
      if (
        claim &&
        JSON.stringify({ ...claim, claimedAt: undefined }) !== JSON.stringify({ ...input, claimedAt: undefined })
      ) {
        throw new Error("claim changed");
      }
      const created = claim === undefined;
      claim ??= input;
      return { record: claim, created };
    },
    async getRunClaim() {
      return claim;
    },
    async listUnsettledRuns() {
      return claim && !terminal ? [claim] : [];
    },
    async get() {
      return terminal;
    },
    async insertTerminal(input: WikiReleaseAuditRecord) {
      const created = terminal === undefined;
      terminal ??= input;
      return { record: terminal, created };
    }
  };
  const coordinator = new ContextWikiAuditCoordinator(
    audits as unknown as PostgresWikiAuditRepository,
    {
      async getPublishedReleaseInputs(input) {
        if (input.tenantId !== tenantId || input.repository !== repository || input.releaseId !== releaseId) {
          return undefined;
        }
        return {
          tenantId,
          repository,
          releaseId,
          ref: "refs/heads/release-1",
          refSequence: 9,
          scopeKind: "branch" as const,
          scopeKey: "release-1",
          commitSha: "c".repeat(40),
          locale: "en",
          releaseFamilyId: "family-historical",
          publicSnapshotDigest
        } as never;
      }
    },
    {} as WikiContentStorePort,
    artifacts,
    dispatchSecret
  );
  const server = createApiServer({
    tenantId,
    contextWikiTriggerServiceToken: serviceToken,
    contextWikiExecutionGrantSecret: grantSecret,
    contextWikiDispatchSecret: dispatchSecret,
    contextWikiAuditCoordinator: coordinator
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dispatchBody = {
    tenantId,
    repository,
    releaseId,
    locale: "en",
    auditPolicyVersion: "manual-v1",
    auditorConfigDigest,
    timestamp: "2026-08-12T04:00:00.000Z"
  };
  try {
    assert.equal(
      (await post(baseUrl, "/internal/context/wiki/audits/dispatch", "wrong", dispatchBody)).response.status,
      401
    );
    assert.equal(
      (
        await post(baseUrl, "/internal/context/wiki/audits/dispatch", serviceToken, {
          ...dispatchBody,
          unknown: true
        })
      ).response.status,
      400
    );
    assert.equal(
      (
        await post(baseUrl, "/internal/context/wiki/audits/dispatch", serviceToken, {
          ...dispatchBody,
          auditorConfigDigest: "not-a-digest"
        })
      ).response.status,
      400
    );
    assert.equal(
      (
        await post(baseUrl, "/internal/context/wiki/audits/dispatch", serviceToken, {
          ...dispatchBody,
          timestamp: "not-a-timestamp"
        })
      ).response.status,
      400
    );
    assert.equal(
      (
        await post(baseUrl, "/internal/context/wiki/audits/dispatch", serviceToken, {
          ...dispatchBody,
          locale: "not a locale"
        })
      ).response.status,
      400
    );
    assert.equal(
      (
        await post(baseUrl, "/internal/context/wiki/audits/dispatch", serviceToken, {
          ...dispatchBody,
          locale: "fr"
        })
      ).response.status,
      404
    );
    const dispatched = await post(baseUrl, "/internal/context/wiki/audits/dispatch", serviceToken, dispatchBody);
    assert.equal(dispatched.response.status, 200, JSON.stringify(dispatched.body));
    const payload = dispatched.body as {
      dispatchNonce: string;
      request: { auditId: string; releaseId: string; auditInputDigest: string };
    };
    assert.equal(payload.request.releaseId, releaseId);

    const claimed = await post(baseUrl, "/internal/context/wiki/executions/claim", serviceToken, {
      kind: "audit",
      auditId: payload.request.auditId,
      releaseId,
      auditInputDigest: payload.request.auditInputDigest,
      triggerParentRunId: "run_manualaudit",
      dispatchNonce: payload.dispatchNonce,
      request: payload.request
    });
    assert.equal(claimed.response.status, 200, JSON.stringify(claimed.body));
    const executionGrant = (claimed.body as { executionGrant: string }).executionGrant;

    const due = await get(
      baseUrl,
      "/internal/context/wiki/audits/reconciliation/due?limit=100&timestamp=2026-08-12T04%3A05%3A00.000Z&scheduleId=schedule-1",
      serviceToken
    );
    assert.equal(due.response.status, 200, JSON.stringify(due.body));
    assert.equal((due.body as { audits: unknown[] }).audits.length, 1);

    const wrongRun = await post(
      baseUrl,
      `/internal/context/wiki/audits/${payload.request.auditId}/fail`,
      executionGrant,
      {
        failure: terminalFailure(payload.request, "run_wrong")
      }
    );
    assert.equal(wrongRun.response.status, 403);
    const failed = await post(
      baseUrl,
      `/internal/context/wiki/audits/${payload.request.auditId}/fail`,
      executionGrant,
      {
        failure: terminalFailure(payload.request, "run_manualaudit")
      }
    );
    assert.equal(failed.response.status, 200, JSON.stringify(failed.body));
    assert.deepEqual(failed.body, { accepted: true, replay: false, outcome: "error" });
    const replay = await post(
      baseUrl,
      `/internal/context/wiki/audits/${payload.request.auditId}/fail`,
      executionGrant,
      {
        failure: terminalFailure(payload.request, "run_manualaudit")
      }
    );
    assert.deepEqual(replay.body, { accepted: true, replay: true, outcome: "error" });
    assert.equal(terminal?.triggerRunId, "run_manualaudit");
    assert.equal(terminal?.outcome, "error");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("scheduled improvement recovery closes the terminal-audit crash gap idempotently", async () => {
  let claim: WikiAuditRunClaim | undefined;
  const terminalState: { value?: WikiReleaseAuditRecord } = {};
  let followup:
    | {
        auditId: string;
        tenantId: string;
        repository: string;
        requestKey: string;
        currentReleaseIdAtDecision?: string;
        admissionOutcome: "policy_denied";
        decidedAt: string;
      }
    | undefined;
  let followupWrites = 0;
  const audits = {
    async claimRun(input: WikiAuditRunClaim) {
      claim ??= input;
      return { record: claim, created: claim === input };
    },
    async getRunClaim() {
      return claim;
    },
    async listPendingImprovementRuns() {
      return claim && terminalState.value?.outcome === "needs_improvement" && !followup ? [claim] : [];
    },
    async get() {
      return terminalState.value;
    },
    async getFollowup() {
      return followup;
    },
    async recordFollowup(input: NonNullable<typeof followup>) {
      followupWrites += 1;
      followup ??= input;
      return { record: followup, created: followup === input };
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
          ref: "refs/heads/release-1",
          refSequence: 9,
          scopeKind: "branch" as const,
          scopeKey: "release-1",
          commitSha: "c".repeat(40),
          locale: "en",
          releaseFamilyId: "family-historical",
          publicSnapshotDigest
        } as never;
      }
    },
    {} as WikiContentStorePort,
    memoryAuditArtifacts(),
    dispatchSecret
  );
  const payload = await coordinator.dispatch({
    tenantId,
    repository,
    releaseId,
    locale: "en",
    auditPolicyVersion: "manual-v1",
    auditorConfigDigest,
    timestamp: "2026-08-12T04:00:00.000Z"
  });
  await coordinator.claim(payload, {
    triggerParentRunId: "run_improvement",
    claimedAt: "2026-08-12T04:00:30.000Z"
  });
  const reportArtifact: WikiAuditReportArtifactRef = {
    version: 1,
    tenantId,
    repository,
    auditId: payload.request.auditId,
    releaseId,
    auditInputDigest: payload.request.auditInputDigest,
    uri: `memory://${payload.request.auditId}`,
    key: wikiAuditArtifactKey({ tenantId, repository, auditId: payload.request.auditId }),
    contentType: "application/json",
    bytes: 1,
    sha256: "e".repeat(64),
    objectGeneration: "1"
  };
  terminalState.value = {
    ...payload.request,
    triggerRunId: "run_improvement",
    outcome: "needs_improvement",
    summary: { findingsDigest: "f".repeat(64) },
    reportArtifact,
    completedAt: "2026-08-12T04:01:00.000Z"
  };
  const server = createApiServer({
    tenantId,
    contextWikiTriggerServiceToken: serviceToken,
    contextWikiExecutionGrantSecret: grantSecret,
    contextWikiDispatchSecret: dispatchSecret,
    contextWikiAuditCoordinator: coordinator
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const duePath =
    "/internal/context/wiki/audits/improvements/due?limit=100&timestamp=2026-08-12T04%3A05%3A00.000Z&scheduleId=schedule-1";
  try {
    const due = await get(baseUrl, duePath, serviceToken);
    assert.equal(due.response.status, 200, JSON.stringify(due.body));
    const candidate = (due.body as { audits: { auditId: string; executionGrant: string }[] }).audits[0]!;
    assert.equal(candidate.auditId, payload.request.auditId);
    assert.equal(
      (
        await post(baseUrl, `/internal/context/wiki/audits/${candidate.auditId}/admit-fix`, candidate.executionGrant, {
          operationId: "wrong-operation"
        })
      ).response.status,
      409
    );
    const first = await post(
      baseUrl,
      `/internal/context/wiki/audits/${candidate.auditId}/admit-fix`,
      candidate.executionGrant,
      { operationId: `wiki-audit:${payload.request.auditInputDigest}:admit-fix` }
    );
    assert.deepEqual(first.body, { admissionOutcome: "policy_denied" });
    const replay = await post(
      baseUrl,
      `/internal/context/wiki/audits/${candidate.auditId}/admit-fix`,
      candidate.executionGrant,
      { operationId: `wiki-audit:${payload.request.auditInputDigest}:admit-fix` }
    );
    assert.deepEqual(replay.body, { admissionOutcome: "policy_denied" });
    assert.equal(followupWrites, 1);
    assert.deepEqual((await get(baseUrl, duePath, serviceToken)).body, { audits: [] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

function terminalFailure(request: { auditId: string; auditInputDigest: string }, triggerParentRunId: string) {
  return {
    schemaVersion: 1,
    auditId: request.auditId,
    triggerParentRunId,
    auditInputDigest: request.auditInputDigest,
    code: "trigger_crashed",
    source: "reconciler",
    failedAt: "2026-08-12T04:05:00.000Z"
  };
}

function memoryAuditArtifacts(): WikiAuditArtifactStorePort {
  let stored: { ref: WikiAuditReportArtifactRef; bytes: Uint8Array } | undefined;
  return {
    async putIfAbsent(input) {
      const bytes = Buffer.from(input.content);
      const key = wikiAuditArtifactKey(input);
      const ref: WikiAuditReportArtifactRef = {
        version: 1,
        tenantId: input.tenantId,
        repository: input.repository,
        auditId: input.auditId,
        releaseId: input.releaseId,
        auditInputDigest: input.auditInputDigest,
        uri: `memory://${key}`,
        key,
        contentType: "application/json",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        objectGeneration: "1"
      };
      if (stored && stored.ref.sha256 !== ref.sha256) throw new Error("audit report collision");
      stored ??= { ref, bytes };
      return stored.ref;
    },
    async find(input) {
      return stored?.ref.auditId === input.auditId ? stored.ref : undefined;
    },
    async get(ref) {
      if (!stored || stored.ref.sha256 !== ref.sha256) throw new Error("audit report not found");
      return stored.bytes;
    }
  };
}

async function post(baseUrl: string, path: string, token: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, body: (await response.json()) as unknown };
}

async function get(baseUrl: string, path: string, token: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  return { response, body: (await response.json()) as unknown };
}
