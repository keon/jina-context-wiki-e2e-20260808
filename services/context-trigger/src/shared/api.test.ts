import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_API_CONTROL_TIMEOUT_MS,
  CONTEXT_API_STAGE_TIMEOUT_MS,
  ContextWikiApiClient,
  ContextWikiApiError,
  ContextWikiApiTimeoutError
} from "./api.js";
import {
  canonicalSha256,
  type AuditWikiPayloadV1,
  type GenerateWikiPayloadV1,
  type WikiTriggerCompletedOutputV1,
  type WikiTriggerRequestV1
} from "./contracts.js";
import type { ContextTriggerEnv } from "./env.js";

const env: ContextTriggerEnv = {
  apiBaseUrl: "https://api.example.test",
  internalApiToken: "bootstrap-secret",
  auditPolicyVersion: "audit.v1",
  auditorConfigDigest: "a".repeat(64)
};

const request: WikiTriggerRequestV1 = {
  schemaVersion: 1,
  taskIdentifier: "generate-wiki",
  boardBuildId: "task_build-1",
  tenantId: "tenant-1",
  repository: "openai/example",
  source: {
    commitSha: "b".repeat(40),
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
  attempt: 2,
  request
};

const auditPayload: AuditWikiPayloadV1 = {
  schemaVersion: 1,
  dispatchNonce: "q".repeat(32),
  request: {
    schemaVersion: 1,
    taskIdentifier: "audit-wiki",
    auditId: "wa_manual",
    tenantId: "tenant-1",
    repository: "openai/example",
    releaseId: "cr_historical",
    locale: "en",
    publicSnapshotDigest: "c".repeat(64),
    auditPolicyVersion: env.auditPolicyVersion,
    auditorConfigDigest: env.auditorConfigDigest,
    auditWindow: "2026-08-08",
    auditInputDigest: "d".repeat(64)
  }
};

test("claimBuild uses only the bootstrap credential and exact attempt-scoped contract", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new ContextWikiApiClient({
    env,
    fetch: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({
        executionGrant: "g".repeat(32),
        expiresAt: "2099-01-01T00:00:00.000Z",
        request
      });
    }
  });
  const claimed = await client.claimBuild({ payload, triggerParentRunId: "run-1" });
  assert.equal(claimed.request.boardBuildId, "task_build-1");
  assert.equal(capturedUrl, "https://api.example.test/internal/context/wiki/executions/claim");
  assert.equal((capturedInit?.headers as Record<string, string>).authorization, "Bearer bootstrap-secret");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    kind: "build",
    boardBuildId: "task_build-1",
    requestDigest: payload.requestDigest,
    triggerParentRunId: "run-1",
    dispatchNonce: "n".repeat(32),
    attempt: 2
  });
});

test("runStage uses the scoped grant and central stage route", async () => {
  let capturedUrl = "";
  let authorization = "";
  const client = new ContextWikiApiClient({
    env,
    fetch: async (url, init) => {
      capturedUrl = String(url);
      authorization = (init?.headers as Record<string, string>).authorization;
      return Response.json({ operationId: "operation-1", status: "completed", output: { artifact: "ref" } });
    }
  });
  const result = await client.runStage({
    authorityId: "build/unsafe path",
    stage: "snapshot",
    executionGrant: "scoped-grant",
    operationId: "operation-1",
    stageInput: {}
  });
  assert.equal(
    capturedUrl,
    "https://api.example.test/internal/context/wiki/executions/build%2Funsafe%20path/steps/snapshot"
  );
  assert.equal(authorization, "Bearer scoped-grant");
  assert.equal(result.operationId, "operation-1");
});

test("long stage requests use the task-aware deadline while bootstrap calls stay short", async () => {
  const deadlines: number[] = [];
  const client = new ContextWikiApiClient({
    env,
    timeoutSignal: (timeoutMs) => {
      deadlines.push(timeoutMs);
      return new AbortController().signal;
    },
    fetch: async (url) => {
      if (String(url).endsWith("/executions/claim")) {
        return Response.json({
          executionGrant: "g".repeat(32),
          expiresAt: "2099-01-01T00:00:00.000Z",
          request
        });
      }
      return Response.json({ operationId: "operation-long", status: "completed", output: {} });
    }
  });
  await client.claimBuild({ payload, triggerParentRunId: "run-1" });
  await client.runStage({
    authorityId: request.boardBuildId,
    stage: "write-page",
    executionGrant: "scoped-grant",
    operationId: "operation-long",
    stageInput: {}
  });
  assert.deepEqual(deadlines, [CONTEXT_API_CONTROL_TIMEOUT_MS, CONTEXT_API_STAGE_TIMEOUT_MS]);
  assert.ok(CONTEXT_API_STAGE_TIMEOUT_MS > 30_000);
  assert.ok(CONTEXT_API_STAGE_TIMEOUT_MS < 30 * 60_000);
});

test("request timeout classification is stable and does not expose transport diagnostics", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new ContextWikiApiClient({
    env,
    timeoutSignal: () => controller.signal,
    fetch: async () => {
      throw new Error("socket diagnostic with bearer-secret");
    }
  });
  await assert.rejects(
    () =>
      client.runStage({
        authorityId: request.boardBuildId,
        stage: "finalize",
        executionGrant: "scoped-grant",
        operationId: "operation-timeout",
        stageInput: {}
      }),
    (error: unknown) => {
      assert.ok(error instanceof ContextWikiApiTimeoutError);
      assert.equal(error.code, "api_timeout");
      assert.equal(error.timeoutMs, CONTEXT_API_STAGE_TIMEOUT_MS);
      assert.doesNotMatch(error.message, /bearer-secret|socket diagnostic/);
      return true;
    }
  );
});

test("completeBuild uses the scoped grant and requires an exact callback receipt", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new ContextWikiApiClient({
    env,
    fetch: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ accepted: true, replay: false });
    }
  });
  const result: WikiTriggerCompletedOutputV1 = {
    schemaVersion: 1,
    status: "completed",
    boardBuildId: request.boardBuildId,
    triggerParentRunId: "run-1",
    requestDigest: payload.requestDigest,
    tenantId: request.tenantId,
    repository: request.repository,
    commitSha: request.source.commitSha,
    locale: request.requestedLocale,
    releaseFamilyId: request.releaseFamilyId,
    releaseId: "release-1",
    generationId: "release-1",
    releaseArtifactSha256: "a".repeat(64),
    contentBundleArtifactSha256: "b".repeat(64),
    publicSnapshotDigest: "c".repeat(64),
    pageindexAttachmentId: "pia-1",
    activationOperationDigest: "d".repeat(64),
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
    completedAt: "2026-08-08T12:00:00.000Z"
  };
  assert.deepEqual(
    await client.completeBuild({ boardBuildId: request.boardBuildId, executionGrant: "scoped-grant", result }),
    { accepted: true, replay: false }
  );
  assert.equal(capturedUrl, "https://api.example.test/internal/context/wiki/executions/task_build-1/complete");
  assert.equal((capturedInit?.headers as Record<string, string>).authorization, "Bearer scoped-grant");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { result });

  const invalid = new ContextWikiApiClient({
    env,
    fetch: async () => Response.json({ accepted: true, replay: false, unexpected: true })
  });
  await assert.rejects(
    () => invalid.completeBuild({ boardBuildId: request.boardBuildId, executionGrant: "scoped-grant", result }),
    /invalid wiki completion receipt/
  );
});

test("failure and reconciliation APIs preserve run-bound scoped credentials", async () => {
  const calls: { url: string; authorization: string; body?: unknown }[] = [];
  const client = new ContextWikiApiClient({
    env,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        authorization: (init?.headers as Record<string, string>).authorization,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (String(url).includes("reconciliation/due")) {
        return Response.json({
          executions: [
            {
              schemaVersion: 1,
              boardBuildId: request.boardBuildId,
              triggerParentRunId: "run-1",
              requestDigest: payload.requestDigest,
              executionGrant: "r".repeat(32)
            }
          ]
        });
      }
      return Response.json({ accepted: true, replay: false, outcome: "failed" });
    }
  });
  const failure = {
    schemaVersion: 1 as const,
    boardBuildId: request.boardBuildId,
    triggerParentRunId: "run-1",
    requestDigest: payload.requestDigest,
    code: "trigger_crashed" as const,
    source: "reconciler" as const,
    failedAt: "2026-08-08T12:00:00.000Z"
  };
  assert.deepEqual(
    await client.failBuild({ boardBuildId: request.boardBuildId, executionGrant: "scoped-grant", failure }),
    { accepted: true, replay: false, outcome: "failed" }
  );
  assert.equal(calls[0]?.authorization, "Bearer scoped-grant");
  assert.deepEqual(calls[0]?.body, { failure });

  const due = await client.getDueBuildReconciliations({
    limit: 100,
    timestamp: "2026-08-08T12:05:00.000Z",
    scheduleId: "schedule-1"
  });
  assert.equal(due.executions[0]?.triggerParentRunId, "run-1");
  assert.equal(calls[1]?.authorization, "Bearer bootstrap-secret");
  assert.match(calls[1]?.url ?? "", /\/internal\/context\/wiki\/executions\/reconciliation\/due\?/);
});

test("API failures expose bounded status/code without response secrets", async () => {
  const client = new ContextWikiApiClient({
    env,
    fetch: async () => Response.json({ code: "scope_denied", token: "must-not-leak" }, { status: 403 })
  });
  await assert.rejects(
    () =>
      client.runStage({
        authorityId: "build-1",
        stage: "snapshot",
        executionGrant: "scoped-grant",
        operationId: "operation-1",
        stageInput: {}
      }),
    (error: unknown) => {
      assert.ok(error instanceof ContextWikiApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "scope_denied");
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    }
  );
});

test("API client rejects oversized responses before parsing", async () => {
  const client = new ContextWikiApiClient({
    env,
    fetch: async () => new Response(JSON.stringify({ output: "x".repeat(600_000) }))
  });
  await assert.rejects(
    () =>
      client.runStage({
        authorityId: "build-1",
        stage: "snapshot",
        executionGrant: "scoped-grant",
        operationId: "operation-1",
        stageInput: {}
      }),
    /exceeds/
  );
});

test("due-audit selection sends configured policy without storage credentials", async () => {
  let capturedUrl = "";
  const client = new ContextWikiApiClient({
    env,
    fetch: async (url) => {
      capturedUrl = String(url);
      return Response.json({ audits: [] });
    }
  });
  assert.deepEqual(
    await client.getDueAudits({
      limit: 100,
      timestamp: "2026-08-08T03:00:00.000Z",
      scheduleId: "daily"
    }),
    { audits: [] }
  );
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get("auditPolicyVersion"), "audit.v1");
  assert.equal(url.searchParams.get("auditorConfigDigest"), env.auditorConfigDigest);
  assert.equal(url.searchParams.get("limit"), "100");
});

test("manual dispatch and audit failure/reconciliation APIs preserve canonical policy and run authority", async () => {
  const calls: { url: string; authorization: string; body?: unknown }[] = [];
  const client = new ContextWikiApiClient({
    env,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        authorization: (init?.headers as Record<string, string>).authorization,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (String(url).endsWith("/audits/dispatch")) return Response.json(auditPayload);
      if (String(url).includes("audits/reconciliation/due")) {
        return Response.json({
          audits: [
            {
              schemaVersion: 1,
              auditId: auditPayload.request.auditId,
              triggerParentRunId: "run-audit-1",
              auditInputDigest: auditPayload.request.auditInputDigest,
              request: auditPayload.request,
              executionGrant: "r".repeat(32)
            }
          ]
        });
      }
      if (String(url).includes("audits/improvements/due")) {
        return Response.json({
          audits: [
            {
              schemaVersion: 1,
              auditId: auditPayload.request.auditId,
              triggerParentRunId: "run-audit-1",
              auditInputDigest: auditPayload.request.auditInputDigest,
              request: auditPayload.request,
              executionGrant: "i".repeat(32)
            }
          ]
        });
      }
      return Response.json({ accepted: true, replay: false, outcome: "error" });
    }
  });
  assert.deepEqual(
    await client.createAuditDispatch({
      tenantId: "tenant-1",
      repository: "openai/example",
      releaseId: "cr_historical",
      locale: "en",
      timestamp: "2026-08-08T03:00:00.000Z"
    }),
    auditPayload
  );
  assert.deepEqual(calls[0]?.body, {
    tenantId: "tenant-1",
    repository: "openai/example",
    releaseId: "cr_historical",
    locale: "en",
    timestamp: "2026-08-08T03:00:00.000Z",
    auditPolicyVersion: env.auditPolicyVersion,
    auditorConfigDigest: env.auditorConfigDigest
  });
  const failure = {
    schemaVersion: 1 as const,
    auditId: auditPayload.request.auditId,
    triggerParentRunId: "run-audit-1",
    auditInputDigest: auditPayload.request.auditInputDigest,
    code: "trigger_crashed" as const,
    source: "reconciler" as const,
    failedAt: "2026-08-08T03:05:00.000Z"
  };
  assert.deepEqual(
    await client.failAudit({ auditId: auditPayload.request.auditId, executionGrant: "scoped-audit", failure }),
    { accepted: true, replay: false, outcome: "error" }
  );
  assert.equal(calls[1]?.authorization, "Bearer scoped-audit");
  assert.deepEqual(calls[1]?.body, { failure });
  const due = await client.getDueAuditReconciliations({
    limit: 100,
    timestamp: "2026-08-08T03:05:00.000Z",
    scheduleId: "reconcile"
  });
  assert.equal(due.audits[0]?.triggerParentRunId, "run-audit-1");
  assert.equal(calls[2]?.authorization, "Bearer bootstrap-secret");
  const improvements = await client.getDueAuditImprovements({
    limit: 100,
    timestamp: "2026-08-08T03:05:00.000Z",
    scheduleId: "reconcile"
  });
  assert.equal(improvements.audits[0]?.executionGrant, "i".repeat(32));
  assert.equal(calls[3]?.authorization, "Bearer bootstrap-secret");
});
