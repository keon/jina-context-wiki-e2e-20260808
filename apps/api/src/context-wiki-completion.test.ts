import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { applyCommand, createEmptyBoardState, findTask, leaseNextOutboxMessage } from "@jina/board";
import {
  artifactSha256,
  contextArtifactKey,
  createContextWikiBoardBuild,
  contextWikiBoardTopic,
  MemoryContextPhaseCheckpointStore,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type ContextArtifactWrite
} from "@jina/context-engine";
import {
  wikiTriggerRequestDigest,
  type WikiTriggerCompletedOutputV1,
  type WikiTriggerRequestV1
} from "@jina/shared-kernel";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import { ContextWikiSnapshotError } from "./context-wiki-execution.js";

const TENANT = "tenant-wiki-callback";
const INTERNAL_TOKEN = "internal-wiki-callback-token";
const SERVICE_TOKEN = "trigger-wiki-callback-token";
const GRANT_SECRET = "g".repeat(64);
const DISPATCH_SECRET = "d".repeat(64);

const request: WikiTriggerRequestV1 = {
  schemaVersion: 1,
  taskIdentifier: "generate-wiki",
  boardBuildId: "task_wiki_callback",
  tenantId: TENANT,
  repository: "acme/docs",
  source: {
    ref: "refs/heads/main",
    scopeKind: "branch",
    scopeKey: "main",
    refSequence: 1,
    commitSha: "a".repeat(40)
  },
  requestKey: "wiki:callback",
  generationReason: "initial",
  releaseFamilyId: "family-callback",
  requestedLocale: "en-us",
  pipelineVersion: "context_wiki.trigger.v1",
  generatorPolicyVersion: "wiki-generator-v1",
  options: {
    idempotencyKey: "wiki:callback",
    concurrencyKey: "wiki:tenant-wiki-callback:acme/docs:main:en-us",
    queue: "context-wiki",
    tags: []
  }
};

test("stale oversized wiki dispatch leases are fenced and reclaimed with the exact dispatch authority", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const testNow = Date.now();
  const leasedAt = new Date(testNow - 5 * 60 * 1000).toISOString();
  const legacyLeaseExpiresAt = new Date(testNow + 145 * 60 * 1000).toISOString();
  const legacy = leaseNextOutboxMessage(created.state, {
    topics: [contextWikiBoardTopic],
    leaseId: "legacy-oversized-wiki-lease",
    writeFenceToken: "legacy-oversized-wiki-fence",
    now: leasedAt,
    expiresAt: legacyLeaseExpiresAt
  });
  assert.ok(legacy);
  const inProgress = applyCommand(
    legacy.state,
    { command: "TransitionTask", taskId: created.buildTaskId, toStatus: "in_progress" },
    { actor: { type: "run", id: "legacy-wiki-worker" }, now: leasedAt }
  ).state;
  const state = memoryStateStore({ intakeState: { board: inProgress }, devDeliverySequence: 0 });
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    contextWikiTriggerServiceToken: SERVICE_TOKEN,
    contextWikiExecutionGrantSecret: GRANT_SECRET,
    contextWikiDispatchSecret: DISPATCH_SECRET,
    contextWorkerLeaseMs: 150 * 60 * 1000
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const legacyFence = {
    messageId: legacy.message.id,
    leaseId: legacy.message.leaseId,
    taskId: created.buildTaskId,
    attempt: legacy.message.payload.attempt,
    writeFenceToken: legacy.message.writeFenceToken
  };
  try {
    const firstAuthority = await post(
      baseUrl,
      "/internal/context/wiki/dispatch/authorize",
      INTERNAL_TOKEN,
      legacyFence
    );
    assert.equal(firstAuthority.response.status, 200, JSON.stringify(firstAuthority.body));

    const claimStartedAt = Date.now();
    const reclaimed = await post(baseUrl, "/internal/worker/claim", INTERNAL_TOKEN, {
      workerId: "reclaimed-wiki-dispatch-worker",
      topics: [contextWikiBoardTopic]
    });
    const claimCompletedAt = Date.now();
    assert.equal(reclaimed.response.status, 200, JSON.stringify(reclaimed.body));
    const reclaimedWork = reclaimed.body as {
      message: {
        id: string;
        leaseId: string;
        leaseExpiresAt: string;
        attempt: number;
        writeFenceToken: string;
      };
      task: { id: string };
    };
    assert.equal(reclaimedWork.task.id, created.buildTaskId);
    assert.equal(reclaimedWork.message.id, legacy.message.id);
    assert.equal(reclaimedWork.message.attempt, legacy.message.payload.attempt);
    assert.notEqual(reclaimedWork.message.leaseId, legacy.message.leaseId);
    assert.ok(Date.parse(reclaimedWork.message.leaseExpiresAt) >= claimStartedAt + 110_000);
    assert.ok(Date.parse(reclaimedWork.message.leaseExpiresAt) <= claimCompletedAt + 125_000);

    const staleAuthority = await post(
      baseUrl,
      "/internal/context/wiki/dispatch/authorize",
      INTERNAL_TOKEN,
      legacyFence
    );
    assert.equal(staleAuthority.response.status, 409);

    const replayedAuthority = await post(baseUrl, "/internal/context/wiki/dispatch/authorize", INTERNAL_TOKEN, {
      messageId: reclaimedWork.message.id,
      leaseId: reclaimedWork.message.leaseId,
      taskId: reclaimedWork.task.id,
      attempt: reclaimedWork.message.attempt,
      writeFenceToken: reclaimedWork.message.writeFenceToken
    });
    assert.equal(replayedAuthority.response.status, 200, JSON.stringify(replayedAuthority.body));
    assert.deepEqual(replayedAuthority.body, firstAuthority.body);

    const snapshot = state.current();
    assert.equal(
      snapshot.intakeState.board.events.filter((event) => event.type === "context.wiki_dispatch_lease_reclaimed")
        .length,
      1
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("an oversized wiki dispatch lease is not reclaimed before its two-minute effective expiry", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const testNow = Date.now();
  const leasedAt = new Date(testNow - 30_000).toISOString();
  const legacy = leaseNextOutboxMessage(created.state, {
    topics: [contextWikiBoardTopic],
    leaseId: "fresh-legacy-wiki-lease",
    writeFenceToken: "fresh-legacy-wiki-fence",
    now: leasedAt,
    expiresAt: new Date(testNow + 149 * 60 * 1000 + 30_000).toISOString()
  });
  assert.ok(legacy);
  const inProgress = applyCommand(
    legacy.state,
    { command: "TransitionTask", taskId: created.buildTaskId, toStatus: "in_progress" },
    { actor: { type: "run", id: "fresh-legacy-wiki-worker" }, now: leasedAt }
  ).state;
  const state = memoryStateStore({ intakeState: { board: inProgress }, devDeliverySequence: 0 });
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    contextWorkerLeaseMs: 150 * 60 * 1000
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ workerId: "competing-wiki-dispatch-worker", topics: [contextWikiBoardTopic] })
    });
    assert.equal(response.status, 204);
    const current = state.current().intakeState.board.outbox[0];
    assert.equal(current?.status, "leased");
    assert.equal(current?.leaseId, legacy.message.leaseId);
    assert.equal(
      state.current().intakeState.board.events.filter((event) => event.type === "context.wiki_dispatch_lease_reclaimed")
        .length,
      0
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("Trigger callback verifies activated storage and atomically completes the one Board task", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const state = memoryStateStore({
    intakeState: { board: created.state },
    devDeliverySequence: 0
  });
  const requestDigest = wikiTriggerRequestDigest(request);
  const completed: WikiTriggerCompletedOutputV1 = {
    schemaVersion: 1,
    status: "completed",
    boardBuildId: request.boardBuildId,
    triggerParentRunId: "run_callback1",
    requestDigest,
    tenantId: TENANT,
    repository: request.repository,
    commitSha: request.source.commitSha,
    locale: request.requestedLocale,
    releaseFamilyId: request.releaseFamilyId,
    releaseId: "release-callback",
    generationId: "release-callback",
    releaseArtifactSha256: "b".repeat(64),
    contentBundleArtifactSha256: "c".repeat(64),
    publicSnapshotDigest: "e".repeat(64),
    pageindexAttachmentId: "pia-callback",
    activationOperationDigest: "f".repeat(64),
    usage: { inputTokens: 10, outputTokens: 20, costMicros: 30 },
    completedAt: "2026-08-08T12:03:00.000Z"
  };
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    contextWikiTriggerServiceToken: SERVICE_TOKEN,
    contextWikiExecutionGrantSecret: GRANT_SECRET,
    contextWikiDispatchSecret: DISPATCH_SECRET,
    contextWikiReleaseQueryStore: {
      async findActivatedWikiBuildReceipt(input) {
        assert.deepEqual(input, {
          tenantId: TENANT,
          repository: request.repository,
          boardBuildId: request.boardBuildId,
          requestDigest
        });
        return completed;
      },
      async findPublishedWikiRelease() {
        return undefined;
      },
      async findCurrentPublishedWikiRelease() {
        return undefined;
      },
      async findNewestPublishedWikiReleaseForCommit() {
        return undefined;
      },
      async listPublishedWikiReleases() {
        return [];
      },
      async latestWikiAuditSummary() {
        return undefined;
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const unauthorized = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/complete`,
      SERVICE_TOKEN,
      { result: completed }
    );
    assert.equal(unauthorized.response.status, 401);

    const work = await post(baseUrl, "/internal/worker/claim", INTERNAL_TOKEN, {
      workerId: "wiki-dispatch-worker",
      topics: ["run-wiki-build"]
    });
    assert.equal(work.response.status, 200);
    const claimedWork = work.body as {
      message: { id: string; leaseId: string; attempt: number; writeFenceToken: string };
      task: { id: string };
    };
    const authority = await post(baseUrl, "/internal/context/wiki/dispatch/authorize", INTERNAL_TOKEN, {
      messageId: claimedWork.message.id,
      leaseId: claimedWork.message.leaseId,
      taskId: claimedWork.task.id,
      attempt: claimedWork.message.attempt,
      writeFenceToken: claimedWork.message.writeFenceToken
    });
    assert.equal(authority.response.status, 200);
    const dispatch = authority.body as { dispatchNonce: string };
    const claim = await post(baseUrl, "/internal/context/wiki/executions/claim", SERVICE_TOKEN, {
      kind: "build",
      boardBuildId: request.boardBuildId,
      requestDigest,
      triggerParentRunId: completed.triggerParentRunId,
      dispatchNonce: dispatch.dispatchNonce,
      attempt: claimedWork.message.attempt
    });
    assert.equal(claim.response.status, 200);
    const executionGrant = (claim.body as { executionGrant: string }).executionGrant;

    const workerEscape = await post(
      baseUrl,
      "/internal/worker/claim",
      executionGrant,
      { workerId: "escaped-wiki-grant", topics: ["run-wiki-build"] },
      { "x-jina-tenant-id": "victim-tenant" }
    );
    assert.equal(workerEscape.response.status, 401);
    const tokenEscape = await post(
      baseUrl,
      "/internal/context/tokens",
      executionGrant,
      {},
      { "x-jina-tenant-id": "victim-tenant" }
    );
    assert.equal(tokenEscape.response.status, 401);

    const first = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/complete`,
      executionGrant,
      { result: completed }
    );
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body, { accepted: true, replay: false });
    const replay = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/complete`,
      executionGrant,
      { result: completed }
    );
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, { accepted: true, replay: true });

    const snapshot = state.current();
    assert.equal(findTask(snapshot.intakeState.board, created.buildTaskId)?.status, "done");
    assert.equal(snapshot.intakeState.board.tasks.length, 1);
    assert.equal(snapshot.intakeState.board.dependencies.length, 0);
    assert.equal(snapshot.intakeState.board.outbox[0]?.status, "dispatched");
    assert.equal(
      snapshot.intakeState.board.events.filter((event) => event.type === "context.wiki_trigger_completion_recorded")
        .length,
      1
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("stage operations replay exact receipts, retry pre-effect failures, and recover a lost page response", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const state = memoryStateStore({ intakeState: { board: created.state }, devDeliverySequence: 0 });
  const artifacts = new MemoryArtifactStore();
  const legacyArtifacts: ContextArtifactStore = {
    async put() {
      throw new Error("wiki receipts must not use the legacy GCS-backed store");
    },
    async get() {
      throw new Error("wiki receipts must not use the legacy GCS-backed store");
    }
  };
  const calls = new Map<string, number>();
  const checkpoints = new MemoryContextPhaseCheckpointStore();
  const recordCheckpoint = checkpoints.record.bind(checkpoints);
  checkpoints.record = async (checkpoint) => {
    assert.match(
      checkpoint.checkpointKey,
      /^[0-9a-f]{64}$/,
      "durable stage receipts must use the PostgreSQL checkpoint-key contract"
    );
    return recordCheckpoint(checkpoint);
  };
  const recoverable = new Map<string, unknown>();
  let signalConcurrentStarted: (() => void) | undefined;
  const concurrentStarted = new Promise<void>((resolve) => {
    signalConcurrentStarted = resolve;
  });
  let releaseConcurrent: (() => void) | undefined;
  const concurrentGate = new Promise<void>((resolve) => {
    releaseConcurrent = resolve;
  });
  const executor = {
    async recover(input: { operationId: string }) {
      return recoverable.get(input.operationId);
    },
    async execute(input: { operationId: string; input: Readonly<Record<string, unknown>> }) {
      const count = (calls.get(input.operationId) ?? 0) + 1;
      calls.set(input.operationId, count);
      if (input.operationId === "classified-snapshot") {
        throw new ContextWikiSnapshotError("source-tree", {
          cause: new Error("ghs_private-token-and-upstream-diagnostic")
        });
      }
      if (input.operationId === "transient" && count === 1) throw new Error("model unavailable before output");
      const output = { operationId: input.operationId, acceptedInput: input.input, modelCall: count };
      if (input.operationId === "page-artifact-crash" && count === 1) {
        recoverable.set(input.operationId, output);
        throw new Error("process ended after immutable page artifact write");
      }
      if (input.operationId === "concurrent") {
        signalConcurrentStarted?.();
        await concurrentGate;
      }
      return output;
    }
  };
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    contextWikiTriggerServiceToken: SERVICE_TOKEN,
    contextWikiExecutionGrantSecret: GRANT_SECRET,
    contextWikiDispatchSecret: DISPATCH_SECRET,
    contextWikiReleaseQueryStore: emptyWikiQueryStore(),
    contextWikiStageExecutor: executor,
    contextPhaseCheckpointStore: checkpoints,
    contextArtifactStore: legacyArtifacts,
    contextWikiArtifactStore: artifacts
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const grant = await claimWikiExecution(baseUrl, "run_stagereplay1");
    const classified = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/steps/snapshot`,
      grant,
      { operationId: "classified-snapshot", input: {} }
    );
    assert.equal(classified.response.status, 500);
    assert.deepEqual(classified.body, {
      accepted: false,
      error: "wiki snapshot source tree failed",
      code: "wiki_snapshot_source_tree_failed"
    });
    assert.doesNotMatch(JSON.stringify(classified.body), /private-token|upstream|diagnostic/i);
    const stage = (operationId: string, input: Record<string, unknown>) =>
      post(baseUrl, `/internal/context/wiki/executions/${request.boardBuildId}/steps/write-page`, grant, {
        operationId,
        input
      });

    const first = await stage("lost-response", { alpha: 1, beta: 2 });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    const replay = await stage("lost-response", { beta: 2, alpha: 1 });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);
    assert.equal(calls.get("lost-response"), 1);

    const changed = await stage("lost-response", { alpha: 1, beta: 3 });
    assert.equal(changed.response.status, 409);
    assert.equal((changed.body as { code: string }).code, "operation_replay_conflict");

    const concurrentFirst = stage("concurrent", { page: "one.md" });
    await concurrentStarted;
    const concurrentSecond = stage("concurrent", { page: "one.md" });
    const concurrentConflict = await stage("concurrent", { page: "changed.md" });
    assert.equal(concurrentConflict.response.status, 409);
    assert.equal((concurrentConflict.body as { code: string }).code, "operation_replay_conflict");
    releaseConcurrent?.();
    const [concurrentLeft, concurrentRight] = await Promise.all([concurrentFirst, concurrentSecond]);
    assert.equal(concurrentLeft.response.status, 200, JSON.stringify(concurrentLeft.body));
    assert.equal(concurrentRight.response.status, 200, JSON.stringify(concurrentRight.body));
    assert.deepEqual(concurrentRight.body, concurrentLeft.body);
    assert.equal(calls.get("concurrent"), 1);

    const transient = await stage("transient", { page: "retry.md" });
    assert.equal(transient.response.status, 500);
    const transientRetry = await stage("transient", { page: "retry.md" });
    assert.equal(transientRetry.response.status, 200, JSON.stringify(transientRetry.body));
    assert.equal(calls.get("transient"), 2);

    const crashed = await stage("page-artifact-crash", { page: "recover.md" });
    assert.equal(crashed.response.status, 500);
    const recovered = await stage("page-artifact-crash", { page: "recover.md" });
    assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
    assert.equal(calls.get("page-artifact-crash"), 1, "recovery must not invoke the model again");

    await state.update(async (snapshot) => {
      const canceled = applyCommand(
        snapshot!.intakeState.board,
        { command: "TransitionTask", taskId: created.buildTaskId, toStatus: "canceled" },
        { actor: { type: "system", id: "stage-replay-test" }, now: "2026-08-08T12:10:00.000Z" }
      );
      assert.equal(canceled.accepted, true);
      return {
        state: { ...snapshot!, intakeState: { ...snapshot!.intakeState, board: canceled.state } },
        result: undefined
      };
    });
    const terminalReplay = await stage("lost-response", { alpha: 1, beta: 2 });
    assert.equal(terminalReplay.response.status, 200, JSON.stringify(terminalReplay.body));
    const terminalMiss = await stage("after-cancel", { page: "forbidden.md" });
    assert.equal(terminalMiss.response.status, 409);
    assert.equal((terminalMiss.body as { code: string }).code, "wiki_execution_revoked");
    assert.equal(calls.has("after-cancel"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("terminal Trigger failure atomically fails Board/outbox/quota and replays exactly", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const state = memoryStateStore({ intakeState: { board: created.state }, devDeliverySequence: 0 });
  const quota = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quota.admitBuild({ tenantId: TENANT, buildId: request.boardBuildId, at: "2026-08-08T12:00:00.000Z" });
  const queryStore = emptyWikiQueryStore();
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    contextWikiTriggerServiceToken: SERVICE_TOKEN,
    contextWikiExecutionGrantSecret: GRANT_SECRET,
    contextWikiDispatchSecret: DISPATCH_SECRET,
    contextWikiReleaseQueryStore: queryStore,
    contextQuotaService: quota
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await claimWikiExecution(baseUrl, "run_failure1");
    const dueResponse = await fetch(
      `${baseUrl}/internal/context/wiki/executions/reconciliation/due?limit=100&timestamp=2026-08-08T12%3A05%3A00.000Z&scheduleId=reconcile-1`,
      { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } }
    );
    assert.equal(dueResponse.status, 200);
    const due = (await dueResponse.json()) as {
      executions: { boardBuildId: string; triggerParentRunId: string; executionGrant: string }[];
    };
    assert.deepEqual(
      due.executions.map(({ boardBuildId, triggerParentRunId }) => ({ boardBuildId, triggerParentRunId })),
      [{ boardBuildId: request.boardBuildId, triggerParentRunId: "run_failure1" }]
    );
    const failure = terminalFailure("run_failure1", "trigger_system_failure", "reconciler");
    const first = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/fail`,
      due.executions[0]!.executionGrant,
      { failure }
    );
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { accepted: true, replay: false, outcome: "failed" });
    const replay = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/fail`,
      due.executions[0]!.executionGrant,
      { failure }
    );
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, { accepted: true, replay: true, outcome: "failed" });

    const snapshot = state.current();
    assert.equal(findTask(snapshot.intakeState.board, created.buildTaskId)?.status, "failed");
    assert.equal(snapshot.intakeState.board.outbox[0]?.status, "dispatched");
    assert.equal(
      snapshot.intakeState.board.events.filter((event) => event.type === "context.wiki_trigger_failure_recorded")
        .length,
      1
    );
    const quotaReplay = await quota.admitBuild({
      tenantId: TENANT,
      buildId: request.boardBuildId,
      at: "2026-08-08T12:06:00.000Z"
    });
    assert.equal(quotaReplay.outcome, "already_completed");
    assert.equal(quotaReplay.snapshot.active.builds, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("activation wins a terminal failure race and reconciles Board as successful", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const state = memoryStateStore({ intakeState: { board: created.state }, devDeliverySequence: 0 });
  const activated = completedOutput("run_activation1");
  const queryStore = emptyWikiQueryStore(activated);
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    contextWikiTriggerServiceToken: SERVICE_TOKEN,
    contextWikiExecutionGrantSecret: GRANT_SECRET,
    contextWikiDispatchSecret: DISPATCH_SECRET,
    contextWikiReleaseQueryStore: queryStore
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const grant = await claimWikiExecution(baseUrl, "run_activation1");
    const result = await post(baseUrl, `/internal/context/wiki/executions/${request.boardBuildId}/fail`, grant, {
      failure: terminalFailure("run_activation1", "trigger_timed_out", "reconciler")
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { accepted: true, replay: false, outcome: "completed" });
    const snapshot = state.current();
    assert.equal(findTask(snapshot.intakeState.board, created.buildTaskId)?.status, "done");
    assert.equal(
      snapshot.intakeState.board.events.filter((event) => event.type === "context.wiki_trigger_failure_recorded")
        .length,
      0
    );
    assert.equal(
      snapshot.intakeState.board.events.filter((event) => event.type === "context.wiki_trigger_completion_recorded")
        .length,
      1
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("an activated release is reconciled before a newer signed webhook admission", async () => {
  const created = createContextWikiBoardBuild(createEmptyBoardState(), {
    request,
    now: "2026-08-08T12:00:00.000Z"
  });
  const state = memoryStateStore({ intakeState: { board: created.state }, devDeliverySequence: 0 });
  const quota = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveBuilds: 1 }
  });
  await quota.admitBuild({ tenantId: TENANT, buildId: request.boardBuildId, at: "2026-08-08T12:00:00.000Z" });
  const activated = completedOutput("run_webhook1");
  const current = {
    releaseId: activated.releaseId,
    releaseFamilyId: activated.releaseFamilyId,
    generationId: activated.generationId,
    repository: request.repository,
    ref: request.source.ref,
    refSequence: 1,
    commitSha: request.source.commitSha,
    publicSnapshotDigest: activated.publicSnapshotDigest,
    locale: request.requestedLocale,
    scopeKind: "branch" as const,
    scopeKey: "main",
    publishedAt: activated.completedAt,
    contentBundleArtifact: {
      version: 1 as const,
      tenantId: TENANT,
      repository: request.repository,
      publicSnapshotDigest: activated.publicSnapshotDigest,
      bundleSha256: activated.contentBundleArtifactSha256,
      uri: "gs://wiki-bucket/activated-content.json",
      key: `context-v2/tenants/${TENANT}/repositories/acme/docs/wiki-content/${activated.contentBundleArtifactSha256}.json`,
      contentType: "application/json" as const,
      bytes: 100,
      sha256: activated.contentBundleArtifactSha256,
      objectGeneration: "1"
    }
  };
  const webhookSecret = "activation-webhook-secret";
  const queryStore = {
    async withCurrentPublishedWikiReleaseLock<T>(
      input: { tenantId: string; repository: string; ref: string; locale: string },
      operation: (release: typeof current | undefined) => Promise<T>
    ) {
      assert.deepEqual(input, {
        tenantId: TENANT,
        repository: request.repository,
        ref: request.source.ref,
        locale: request.requestedLocale
      });
      return operation(current);
    },
    async findActivatedWikiBuildReceipt() {
      return activated;
    },
    async findPublishedWikiRelease() {
      return undefined;
    },
    async findCurrentPublishedWikiRelease() {
      return current;
    },
    async findNewestPublishedWikiReleaseForCommit() {
      return undefined;
    },
    async listPublishedWikiReleases() {
      return [current];
    },
    async latestWikiAuditSummary() {
      return undefined;
    }
  };
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    githubWebhookSecret: webhookSecret,
    internalApiToken: INTERNAL_TOKEN,
    contextWikiTriggerServiceToken: SERVICE_TOKEN,
    contextWikiExecutionGrantSecret: GRANT_SECRET,
    contextWikiDispatchSecret: DISPATCH_SECRET,
    contextWikiPipelineRouting: { mode: "trigger", allowlist: new Set() },
    contextWikiDefaultLocale: request.requestedLocale,
    contextWikiReleaseQueryStore: queryStore,
    contextQuotaService: quota,
    contextBoardReleaseSeedStore: {
      async findCurrentReleaseSeed() {
        return undefined;
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const oldGrant = await claimWikiExecution(baseUrl, activated.triggerParentRunId);
    const nextCommit = "9".repeat(40);
    const rawBody = JSON.stringify({
      ref: "refs/heads/main",
      before: request.source.commitSha,
      after: nextCommit,
      deleted: false,
      repository: { id: 2, full_name: request.repository, default_branch: "main" },
      installation: { id: 123 }
    });
    const webhook = await fetch(`${baseUrl}/wiki/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "activation-before-new-webhook",
        "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`
      },
      body: rawBody
    });
    assert.equal(webhook.status, 202, await webhook.text());

    const snapshot = state.current().intakeState.board;
    const oldTask = findTask(snapshot, created.buildTaskId);
    assert.equal(oldTask?.status, "done");
    const newer = snapshot.tasks.find(
      (task) => task.type === "build-wiki" && task.id !== created.buildTaskId && task.metadata.commitSha === nextCommit
    );
    assert.ok(newer);
    assert.equal(newer.status, "queued");
    assert.equal(newer.metadata.refSequence, 2);
    assert.equal(snapshot.outbox.find((message) => message.taskId === created.buildTaskId)?.status, "dispatched");
    assert.equal(
      snapshot.events.filter(
        (event) => event.taskId === created.buildTaskId && event.type === "context.wiki_trigger_completion_recorded"
      ).length,
      1
    );
    assert.equal((await quota.snapshot(TENANT)).active.builds, 1);
    assert.equal(
      (await quota.admitBuild({ tenantId: TENANT, buildId: request.boardBuildId })).outcome,
      "already_completed"
    );

    const lateCallback = await post(
      baseUrl,
      `/internal/context/wiki/executions/${request.boardBuildId}/complete`,
      oldGrant,
      { result: activated }
    );
    assert.equal(lateCallback.response.status, 200, JSON.stringify(lateCallback.body));
    assert.deepEqual(lateCallback.body, { accepted: true, replay: true });
    const runnable = await post(baseUrl, "/internal/worker/claim", INTERNAL_TOKEN, {
      workerId: "new-webhook-build-worker",
      topics: ["run-wiki-build"]
    });
    assert.equal(runnable.response.status, 200, JSON.stringify(runnable.body));
    assert.equal((runnable.body as { task: { id: string } }).task.id, newer.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("manual translation admission is asynchronous and preserves source release lineage", async () => {
  const state = memoryStateStore({
    intakeState: { board: createEmptyBoardState() },
    devDeliverySequence: 0
  });
  const sourceRelease = {
    releaseId: "release-source-en",
    releaseFamilyId: "family-source",
    generationId: "release-source-en",
    repository: "acme/docs",
    ref: "refs/heads/main",
    refSequence: 4,
    commitSha: "a".repeat(40),
    publicSnapshotDigest: "b".repeat(64),
    locale: "en",
    scopeKind: "branch" as const,
    scopeKey: "main",
    publishedAt: "2026-08-08T12:00:00.000Z",
    contentBundleArtifact: {
      version: 1 as const,
      tenantId: TENANT,
      repository: "acme/docs",
      publicSnapshotDigest: "b".repeat(64),
      bundleSha256: "c".repeat(64),
      uri: "gs://wiki/content.json",
      key: `context-v2/tenants/${TENANT}/repositories/acme/docs/wiki-content/${"c".repeat(64)}.json`,
      contentType: "application/json" as const,
      bytes: 100,
      sha256: "c".repeat(64),
      objectGeneration: "1"
    }
  };
  const queryStore = {
    async findActivatedWikiBuildReceipt() {
      return undefined;
    },
    async findPublishedWikiRelease(input: { releaseId: string }) {
      return input.releaseId === sourceRelease.releaseId ? sourceRelease : undefined;
    },
    async findCurrentPublishedWikiRelease() {
      return undefined;
    },
    async findNewestPublishedWikiReleaseForCommit() {
      return undefined;
    },
    async listPublishedWikiReleases() {
      return [];
    },
    async latestWikiAuditSummary() {
      return undefined;
    }
  };
  const server = createApiServer({
    tenantId: TENANT,
    stateStore: state,
    internalApiToken: INTERNAL_TOKEN,
    tenantAdminPrincipalIds: ["svc:api"],
    contextWikiPipelineRouting: { mode: "trigger", allowlist: new Set() },
    contextWikiReleaseQueryStore: queryStore
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const admitted = await post(
      baseUrl,
      "/wiki/build",
      INTERNAL_TOKEN,
      {
        repository: "acme/docs",
        generationReason: "translation",
        sourceReleaseId: sourceRelease.releaseId,
        sourceLocale: "en",
        locale: "fr",
        requestKey: "translate:source-en:fr"
      },
      { "x-jina-principal-id": "svc:api" }
    );
    assert.equal(admitted.response.status, 202, JSON.stringify(admitted.body));
    const snapshot = state.current();
    assert.equal(snapshot.intakeState.board.tasks.length, 1);
    const triggerRequest = snapshot.intakeState.board.tasks[0]?.metadata.triggerRequest as WikiTriggerRequestV1;
    assert.equal(triggerRequest.generationReason, "translation");
    assert.equal(triggerRequest.releaseFamilyId, sourceRelease.releaseFamilyId);
    assert.equal(triggerRequest.sourceReleaseId, sourceRelease.releaseId);
    assert.equal(triggerRequest.sourceLocale, "en");
    assert.equal(triggerRequest.requestedLocale, "fr");
    assert.equal(triggerRequest.source.commitSha, sourceRelease.commitSha);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

function completedOutput(triggerParentRunId: string): WikiTriggerCompletedOutputV1 {
  return {
    schemaVersion: 1,
    status: "completed",
    boardBuildId: request.boardBuildId,
    triggerParentRunId,
    requestDigest: wikiTriggerRequestDigest(request),
    tenantId: TENANT,
    repository: request.repository,
    commitSha: request.source.commitSha,
    locale: request.requestedLocale,
    releaseFamilyId: request.releaseFamilyId,
    releaseId: "release-callback",
    generationId: "release-callback",
    releaseArtifactSha256: "b".repeat(64),
    contentBundleArtifactSha256: "c".repeat(64),
    publicSnapshotDigest: "e".repeat(64),
    pageindexAttachmentId: "pia-callback",
    activationOperationDigest: "f".repeat(64),
    usage: { inputTokens: 10, outputTokens: 20, costMicros: 30 },
    completedAt: "2026-08-08T12:03:00.000Z"
  };
}

function emptyWikiQueryStore(activated?: WikiTriggerCompletedOutputV1) {
  return {
    async findActivatedWikiBuildReceipt() {
      return activated;
    },
    async findPublishedWikiRelease() {
      return undefined;
    },
    async findCurrentPublishedWikiRelease() {
      return undefined;
    },
    async findNewestPublishedWikiReleaseForCommit() {
      return undefined;
    },
    async listPublishedWikiReleases() {
      return [];
    },
    async latestWikiAuditSummary() {
      return undefined;
    }
  };
}

async function claimWikiExecution(baseUrl: string, triggerParentRunId: string): Promise<string> {
  const work = await post(baseUrl, "/internal/worker/claim", INTERNAL_TOKEN, {
    workerId: "wiki-dispatch-worker",
    topics: ["run-wiki-build"]
  });
  assert.equal(work.response.status, 200, JSON.stringify(work.body));
  const claimedWork = work.body as {
    message: { id: string; leaseId: string; attempt: number; writeFenceToken: string };
    task: { id: string };
  };
  const authority = await post(baseUrl, "/internal/context/wiki/dispatch/authorize", INTERNAL_TOKEN, {
    messageId: claimedWork.message.id,
    leaseId: claimedWork.message.leaseId,
    taskId: claimedWork.task.id,
    attempt: claimedWork.message.attempt,
    writeFenceToken: claimedWork.message.writeFenceToken
  });
  assert.equal(authority.response.status, 200, JSON.stringify(authority.body));
  const claim = await post(baseUrl, "/internal/context/wiki/executions/claim", SERVICE_TOKEN, {
    kind: "build",
    boardBuildId: request.boardBuildId,
    requestDigest: wikiTriggerRequestDigest(request),
    triggerParentRunId,
    dispatchNonce: (authority.body as { dispatchNonce: string }).dispatchNonce,
    attempt: claimedWork.message.attempt
  });
  assert.equal(claim.response.status, 200, JSON.stringify(claim.body));
  return (claim.body as { executionGrant: string }).executionGrant;
}

function terminalFailure(
  triggerParentRunId: string,
  code: "trigger_system_failure" | "trigger_timed_out",
  source: "reconciler"
) {
  return {
    schemaVersion: 1,
    boardBuildId: request.boardBuildId,
    triggerParentRunId,
    requestDigest: wikiTriggerRequestDigest(request),
    code,
    source,
    failedAt: "2026-08-08T12:05:00.000Z"
  };
}

async function post(baseUrl: string, path: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const value = (await response.json()) as unknown;
  return { response, body: value };
}

function memoryStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot } {
  let snapshot = structuredClone(initial);
  return {
    current: () => structuredClone(snapshot),
    async load() {
      return structuredClone(snapshot);
    },
    async ping() {},
    async hasDelivery() {
      return false;
    },
    async save(next) {
      snapshot = structuredClone(next);
      return true;
    },
    async update<T>(operation: (current: ApiSnapshot | undefined) => Promise<{ state: ApiSnapshot; result: T }>) {
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}

class MemoryArtifactStore implements ContextArtifactStore {
  readonly #artifacts = new Map<string, { readonly ref: ContextArtifactRef; readonly content: Uint8Array }>();

  async put(input: ContextArtifactWrite): Promise<ContextArtifactRef> {
    const key = contextArtifactKey(input);
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
    const sha256 = artifactSha256(content);
    const prior = this.#artifacts.get(key);
    if (prior) {
      if (prior.ref.sha256 !== sha256) throw new Error(`artifact collision for ${key}`);
      return prior.ref;
    }
    const ref = {
      uri: `memory://${key}`,
      key,
      contentType: input.contentType,
      bytes: content.byteLength,
      sha256
    };
    this.#artifacts.set(key, { ref, content });
    return ref;
  }

  async get(ref: ContextArtifactRef): Promise<Uint8Array> {
    const artifact = this.#artifacts.get(ref.key);
    if (!artifact || artifact.ref.sha256 !== ref.sha256) throw new Error("artifact not found");
    return artifact.content;
  }
}
