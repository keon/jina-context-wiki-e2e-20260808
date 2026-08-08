import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONTEXT_WORKFLOW_CONTRACT,
  CONTEXT_WORKFLOW_SCHEMA_REVISION,
  FileContextArtifactStore,
  MemoryContextEngineStore,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  contextArtifactKey,
  contextWorkflowBoardTaskTypes,
  contextWorkflowBoardTopics,
  contextPublicSnapshotDigest,
  createContextWorkflowBoardBuild,
  serializeCertifiedContextReleaseArtifact,
  type CertifiedContextReleaseArtifactV1,
  type ContextArtifactRef,
  type ContextWorkflowBuildScope,
  type ContextWorkflowPriorReleaseSeed
} from "@jina/context-engine";
import {
  applyCommand,
  appendEvent,
  createEmptyBoardState,
  findTask,
  leaseNextOutboxMessage,
  markOutboxDispatched,
  reduceBoard,
  transitionBoardTask,
  type BoardState,
  type TaskId
} from "@jina/board";
import { entityId } from "@jina/shared-kernel";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import { applyContextWorkflowBoardTaskResult } from "./context-workflow-runtime.js";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const NOW = "2026-07-29T21:00:00.000Z";

test("collapsed Context planner checkpoints each allowed intermediate artifact kind", async () => {
  const tenantId = "tenant-collapsed-planner-checkpoint";
  const repository = "omxyz/collapsed-planner-checkpoint";
  const internalApiToken = "collapsed-planner-checkpoint-token";
  const commitSha = "8".repeat(40);
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-prompts-1",
    validatorVersion: "context-validator-1",
    pageIndexVersion: "pageindex-1",
    executionProfileDigest: "f".repeat(64),
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "manual:collapsed-planner-checkpoint",
    commitSha,
    trigger: "manual",
    now: NOW
  });
  const snapshotContent = Buffer.from('{"snapshot":true}', "utf8");
  const snapshotKey = contextArtifactKey({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "evidence-snapshot",
    name: `${created.snapshotTaskId}-attempt-1-snapshot.json`,
    contentType: "application/json",
    content: snapshotContent
  });
  const snapshotArtifact: ContextArtifactRef = {
    uri: `gs://context-test/${snapshotKey}`,
    key: snapshotKey,
    contentType: "application/json",
    bytes: snapshotContent.byteLength,
    sha256: createHash("sha256").update(snapshotContent).digest("hex")
  };
  const expanded = applyContextWorkflowBoardTaskResult(
    created.state,
    created.snapshotTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: snapshotArtifact,
      commitSha
    },
    NOW
  );
  const store = mutableStateStore({
    intakeState: {
      board: reduceBoard(setTaskStatus(expanded.state, created.snapshotTaskId, "done"), NOW)
    },
    devDeliverySequence: 0
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-collapsed-planner-checkpoints-"));
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: created.buildTaskId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken,
    contextArtifactStore: new FileContextArtifactStore(artifactRoot),
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const claimResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "collapsed-planner-test", topics: [contextWorkflowBoardTopics.planner] })
    });
    const claimText = await claimResponse.text();
    assert.equal(claimResponse.status, 200, claimText);
    const claim = JSON.parse(claimText) as {
      message: { id: string; leaseId: string; attempt: number; writeFenceToken: string };
      task: { id: string };
    };
    const lease = {
      messageId: claim.message.id,
      taskId: claim.task.id,
      leaseId: claim.message.leaseId,
      attempt: claim.message.attempt,
      writeFenceToken: claim.message.writeFenceToken
    };
    for (const [kind, phase, checkpointDigit] of [
      ["research-plan", "research-plan.candidate", "c"],
      ["research-report", "research.result", "d"],
      ["publication-plan", "publication-plan.candidate", "e"]
    ] as const) {
      const candidateResponse = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
        method: "POST",
        headers: internalHeaders(internalApiToken),
        body: JSON.stringify({
          ...lease,
          kind,
          name: `${phase}.json`,
          contentType: "application/json",
          contentBase64: Buffer.from('{"candidate":true}').toString("base64")
        })
      });
      const candidateText = await candidateResponse.text();
      assert.equal(candidateResponse.status, 201, candidateText);
      const candidate = (JSON.parse(candidateText) as { artifact: ContextArtifactRef }).artifact;
      const checkpointResponse = await fetch(`${baseUrl}/internal/context/board/phase-checkpoints`, {
        method: "POST",
        headers: internalHeaders(internalApiToken),
        body: JSON.stringify({
          ...lease,
          phase,
          checkpointKey: checkpointDigit.repeat(64),
          artifact: candidate
        })
      });
      assert.equal(checkpointResponse.status, 201, await checkpointResponse.text());
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Context publication completion accepts its authoritative release artifact", async () => {
  const tenantId = "tenant-publication-completion";
  const repository = "omxyz/publication-completion";
  const commitSha = "7".repeat(40);
  const internalApiToken = "publication-completion-token";
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-prompts-1",
    validatorVersion: "context-validator-1",
    pageIndexVersion: "pageindex-1",
    executionProfileDigest: "f".repeat(64),
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "manual:publication-completion",
    commitSha,
    trigger: "manual",
    now: NOW
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-publication-completion-"));
  const artifactStore = new FileContextArtifactStore(artifactRoot);
  const snapshotArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "evidence-snapshot",
    name: `${created.snapshotTaskId}-attempt-1-snapshot.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  let applied = applyContextWorkflowBoardTaskResult(
    created.state,
    created.snapshotTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: snapshotArtifact,
      commitSha
    },
    NOW
  );
  let board = reduceBoard(setTaskStatus(applied.state, created.snapshotTaskId, "done"), NOW);
  const planner = board.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.planner);
  assert.ok(planner);
  const planArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "publication-plan",
    name: `${planner.id}-attempt-1-plan.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  const briefArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "research-report",
    name: `${planner.id}-attempt-1-architecture-brief.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  applied = applyContextWorkflowBoardTaskResult(
    board,
    planner.id,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: planArtifact,
      pages: [
        {
          subjectId: "architecture",
          path: "architecture.md",
          title: "Architecture",
          operation: "add",
          briefArtifact
        }
      ]
    },
    NOW
  );
  board = reduceBoard(setTaskStatus(applied.state, planner.id, "done"), NOW);
  const page = board.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.page);
  assert.ok(page);
  const pageArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "context-page",
    name: `${page.id}-attempt-1-architecture.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  applied = applyContextWorkflowBoardTaskResult(
    board,
    page.id,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: pageArtifact,
      disposition: {
        status: "accepted",
        pageArtifact,
        evidenceFingerprint: "a".repeat(64),
        generationFingerprint: "b".repeat(64)
      },
      phaseReceiptIds: []
    },
    NOW
  );
  board = reduceBoard(setTaskStatus(applied.state, page.id, "done"), NOW);
  const publication = board.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.publication);
  assert.ok(publication);
  assert.equal(publication.status, "queued");

  const releaseId = `cr_${"c".repeat(32)}`;
  const releaseArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "context-release",
    name: `${releaseId}.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  const stateStore = mutableStateStore({ intakeState: { board }, devDeliverySequence: 0 });
  const server = createApiServer({
    tenantId,
    stateStore,
    internalApiToken,
    contextArtifactStore: artifactStore
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const claim = await claimContextTask(baseUrl, internalApiToken, contextWorkflowBoardTopics.publication);
    assert.equal(claim.task.id, publication.id);
    const mismatchedCompletion = await workerComplete(baseUrl, internalApiToken, {
      ...leaseFromClaim(claim),
      outcome: "done",
      result: {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: releaseArtifact,
        releaseId: `cr_${"d".repeat(32)}`
      }
    });
    assert.equal(mismatchedCompletion.status, 400, await mismatchedCompletion.text());
    const completion = await workerComplete(baseUrl, internalApiToken, {
      ...leaseFromClaim(claim),
      outcome: "done",
      result: {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: releaseArtifact,
        releaseId
      }
    });
    assert.equal(completion.status, 200, await completion.text());
    assert.equal(findTask(stateStore.current().intakeState.board, publication.id)?.status, "done");
    assert.equal(findTask(stateStore.current().intakeState.board, created.buildTaskId)?.status, "done");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("omitted Context page completion accepts its current citation audit", async () => {
  const tenantId = "tenant-omitted-page-completion";
  const repository = "omxyz/omitted-page-completion";
  const commitSha = "6".repeat(40);
  const internalApiToken = "omitted-page-completion-token";
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-prompts-1",
    validatorVersion: "context-validator-1",
    pageIndexVersion: "pageindex-1",
    executionProfileDigest: "f".repeat(64),
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "manual:omitted-page-completion",
    commitSha,
    trigger: "manual",
    now: NOW
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-omitted-page-completion-"));
  const artifactStore = new FileContextArtifactStore(artifactRoot);
  const snapshotArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "evidence-snapshot",
    name: `${created.snapshotTaskId}-attempt-1-snapshot.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  let applied = applyContextWorkflowBoardTaskResult(
    created.state,
    created.snapshotTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: snapshotArtifact,
      commitSha
    },
    NOW
  );
  let board = reduceBoard(setTaskStatus(applied.state, created.snapshotTaskId, "done"), NOW);
  const planner = board.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.planner);
  assert.ok(planner);
  const planArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "publication-plan",
    name: `${planner.id}-attempt-1-plan.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  const briefArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "research-report",
    name: `${planner.id}-attempt-1-architecture-brief.json`,
    contentType: "application/json",
    content: '{"version":1}'
  });
  applied = applyContextWorkflowBoardTaskResult(
    board,
    planner.id,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: planArtifact,
      pages: [
        {
          subjectId: "architecture",
          path: "architecture.md",
          title: "Architecture",
          operation: "add",
          briefArtifact
        }
      ]
    },
    NOW
  );
  board = reduceBoard(setTaskStatus(applied.state, planner.id, "done"), NOW);
  const page = board.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.page);
  assert.ok(page);
  const stateStore = mutableStateStore({ intakeState: { board }, devDeliverySequence: 0 });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: created.buildTaskId });
  const server = createApiServer({
    tenantId,
    stateStore,
    internalApiToken,
    contextArtifactStore: artifactStore,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const claim = await claimContextTask(baseUrl, internalApiToken, contextWorkflowBoardTopics.page);
    assert.equal(claim.task.id, page.id);
    const auditArtifact = await uploadWorkerArtifact(
      baseUrl,
      internalApiToken,
      claim,
      "citation-audit",
      "final-audit.json"
    );
    const pageArtifact = await artifactStore.put({
      tenantId,
      repository,
      buildId: created.buildTaskId,
      kind: "context-page",
      name: `${page.id}-attempt-1-page.json`,
      contentType: "application/json",
      content: '{"version":1}'
    });
    const mismatchedCompletion = await workerComplete(baseUrl, internalApiToken, {
      ...leaseFromClaim(claim),
      outcome: "done",
      modelUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
      result: {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: auditArtifact,
        disposition: {
          status: "accepted",
          pageArtifact,
          evidenceFingerprint: "a".repeat(64),
          generationFingerprint: "b".repeat(64)
        },
        phaseReceiptIds: []
      }
    });
    assert.equal(mismatchedCompletion.status, 400, await mismatchedCompletion.text());

    const completion = await workerComplete(baseUrl, internalApiToken, {
      ...leaseFromClaim(claim),
      outcome: "done",
      modelUsage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
      result: {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: auditArtifact,
        disposition: { status: "omitted", reasonCode: "unsupported_core_claims" },
        phaseReceiptIds: []
      }
    });
    assert.equal(completion.status, 200, await completion.text());
    assert.equal(findTask(stateStore.current().intakeState.board, page.id)?.status, "done");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("collapsed Context planner can be operator-retried after a terminal failure", async () => {
  const tenantId = "tenant-collapsed-planner-retry";
  const repository = "omxyz/collapsed-planner-retry";
  const principalId = "svc:operator";
  const commitSha = "9".repeat(40);
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-prompts-1",
    validatorVersion: "context-validator-1",
    pageIndexVersion: "pageindex-1",
    executionProfileDigest: "f".repeat(64),
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "manual:collapsed-planner-retry",
    commitSha,
    trigger: "manual",
    now: NOW
  });
  const snapshotContent = Buffer.from('{"snapshot":true}', "utf8");
  const snapshotKey = contextArtifactKey({
    tenantId,
    repository,
    buildId: created.buildTaskId,
    kind: "evidence-snapshot",
    name: `${created.snapshotTaskId}-attempt-1-snapshot.json`,
    contentType: "application/json",
    content: snapshotContent
  });
  const expanded = applyContextWorkflowBoardTaskResult(
    created.state,
    created.snapshotTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: {
        uri: `gs://context-test/${snapshotKey}`,
        key: snapshotKey,
        contentType: "application/json",
        bytes: snapshotContent.byteLength,
        sha256: createHash("sha256").update(snapshotContent).digest("hex")
      },
      commitSha
    },
    NOW
  );
  let board = reduceBoard(setTaskStatus(expanded.state, created.snapshotTaskId, "done"), NOW);
  const planner = board.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.planner);
  assert.ok(planner);
  const claim = leaseNextOutboxMessage(board, {
    topics: [contextWorkflowBoardTopics.planner],
    taskIds: [planner.id],
    leaseId: "collapsed-planner-retry-lease",
    writeFenceToken: "collapsed-planner-retry-fence",
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(claim);
  board = transitionBoardTask(claim.state, planner.id, "in_progress", NOW);
  board = markOutboxDispatched(board, claim.message.id, NOW);
  board = transitionBoardTask(board, planner.id, "failed", NOW);
  board = reduceBoard(board, NOW);

  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const stateStore = mutableStateStore({
    intakeState: { board },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: created.buildTaskId });
  await quotaService.completeBuild({ tenantId, buildId: created.buildTaskId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/wiki/builds/${created.buildTaskId}/tasks/${planner.id}/retry`, {
      method: "POST",
      headers: devHeaders(tenantId, principalId),
      body: JSON.stringify({
        requestKey: "operator:collapsed-planner-retry",
        reason: "resume after a compatibility deployment"
      })
    });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.taskId, planner.id);
    assert.equal(body.attempt, 2);
    assert.equal(findTask(stateStore.current().intakeState.board, planner.id)?.status, "queued");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("Context execution budgets ignore queue time and merge parallel lease windows", async () => {
  const tenantId = "tenant-active-time-budget";
  const repository = "omxyz/active-time-budget";
  const principalId = "user:active-time@example.com";
  const internalApiToken = "context-active-time-test-token";
  const createdAtMs = Date.now() - 600_000;
  const createdAt = new Date(createdAtMs).toISOString();
  const created = createCurrentContextBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "budget:active-time",
    derivationBudgetSeconds: 300,
    derivationTokenBudget: 12_000_000,
    now: createdAt
  });
  const base = Date.now();
  const firstMessage = created.state.outbox.find((message) => message.taskId === created.snapshotTaskId);
  assert.ok(firstMessage);
  const executionEvent = (
    state: BoardState,
    phase: "started" | "ended",
    messageId: string,
    leaseId: string,
    at: number,
    expiresAt: number
  ) =>
    appendEvent(state, `context.build_execution_lease_${phase}`, new Date(at).toISOString(), created.buildTaskId, {
      messageId,
      taskId: created.snapshotTaskId,
      attempt: 1,
      leaseId,
      leaseExpiresAt: new Date(expiresAt).toISOString()
    });
  let board = executionEvent(
    created.state,
    "started",
    firstMessage.id,
    "execution-one",
    base - 240_000,
    base - 210_000
  );
  board = executionEvent(board, "ended", firstMessage.id, "execution-one", base - 180_000, base - 150_000);
  board = executionEvent(
    board,
    "started",
    `${firstMessage.id}-parallel`,
    "execution-two",
    base - 190_000,
    base - 90_000
  );
  board = executionEvent(board, "ended", `${firstMessage.id}-parallel`, "execution-two", base - 120_000, base - 90_000);
  const stateStore = mutableStateStore({
    intakeState: { board },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/wiki/builds/${created.buildTaskId}/progress`, {
      headers: devHeaders(tenantId, principalId)
    });
    assert.equal(response.status, 200);
    const progress = (await response.json()) as Record<string, unknown>;
    assert.equal(progress.status, "active");
    assert.equal(progress.consumedExecutionSeconds, 120);
    assert.equal(progress.remainingExecutionSeconds, 180);
    const deadlineMs = Date.parse(String(progress.derivationDeadlineAt));
    assert.ok(deadlineMs >= Date.now() + 179_000 && deadlineMs <= Date.now() + 181_000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tenant administrators can extend and resume only the task canceled by a build deadline", async () => {
  const tenantId = "tenant-deadline-recovery";
  const repository = "omxyz/deadline-recovery";
  const principalId = "user:deadline-admin@example.com";
  const internalApiToken = "context-deadline-recovery-token";
  const created = createCurrentContextBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "deadline:expired",
    derivationBudgetSeconds: 300,
    derivationTokenBudget: 12_000_000,
    now: new Date(Date.now() - 301_000).toISOString()
  });
  const snapshotMessage = created.state.outbox.find((message) => message.taskId === created.snapshotTaskId);
  assert.ok(snapshotMessage);
  const board = appendEvent(
    created.state,
    "context.build_execution_lease_started",
    new Date(Date.now() - 301_000).toISOString(),
    created.buildTaskId,
    {
      messageId: snapshotMessage.id,
      taskId: created.snapshotTaskId,
      attempt: snapshotMessage.payload.attempt,
      leaseId: "deadline-expired-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  );
  const stateStore = mutableStateStore({
    intakeState: { board },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: created.buildTaskId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    internalApiToken,
    contextQuotaService: quotaService,
    tenantAdminPrincipalIds: [principalId]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const expiredClaim = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "deadline-recovery-test", topics: [contextWorkflowBoardTopics.snapshot] })
    });
    assert.equal(expiredClaim.status, 204);
    const expired = await fetch(`${baseUrl}/wiki/builds/${created.buildTaskId}/progress`, {
      headers: devHeaders(tenantId, principalId)
    });
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).failureCode, "build_time_budget_exceeded");

    const retryUrl = `${baseUrl}/wiki/builds/${created.buildTaskId}/tasks/${created.snapshotTaskId}/retry`;
    const retryBody = {
      requestKey: "operator:deadline-recovery",
      reason: "the provider outage consumed the original build envelope",
      extendDeadlineBySeconds: 3_600
    };
    for (const [expectedStatus, duplicate] of [
      [202, false],
      [200, true]
    ] as const) {
      const retried = await fetch(retryUrl, {
        method: "POST",
        headers: devHeaders(tenantId, principalId),
        body: JSON.stringify(retryBody)
      });
      const body = (await retried.json()) as Record<string, unknown>;
      assert.equal(retried.status, expectedStatus, JSON.stringify(body));
      assert.equal(body.duplicate, duplicate);
      assert.equal(body.taskId, created.snapshotTaskId);
      assert.equal(typeof body.extendedDeadlineAt, "string");
    }

    const recovered = stateStore.current().intakeState.board;
    const recoveredBuild = findTask(recovered, created.buildTaskId);
    assert.equal(recoveredBuild?.metadata.derivationBudgetSeconds, 3_900);
    assert.equal(findTask(recovered, created.snapshotTaskId)?.status, "queued");
    assert.equal(recovered.events.filter((event) => event.type === "context.build_time_budget_extended").length, 1);
    assert.equal(
      recovered.events.filter((event) => event.type === "context.deadline_interrupted_task_reclassified").length,
      1
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("new build admission reconciles terminal and orphaned quota reservations against the Board", async () => {
  const tenantId = "tenant-terminal-quota-repair";
  const repository = "omxyz/quota-repair";
  const principalId = "user:quota-repair@example.com";
  const internalApiToken = "terminal-quota-repair-token";
  const stale = createCurrentContextBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "stale-terminal-build",
    now: NOW
  });
  const stateStore = mutableStateStore({
    intakeState: {
      board: setTaskStatus(stale.state, stale.buildTaskId, "failed")
    },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const quotaService = new ContextQuotaService({
    store: new InMemoryContextQuotaStore(),
    defaults: { maxActiveBuilds: 1, buildRequestsPerWindow: 10 }
  });
  await quotaService.admitBuild({ tenantId, buildId: stale.buildTaskId });
  await quotaService.completeBuild({ tenantId, buildId: stale.buildTaskId });
  await quotaService.admitBuild({ tenantId, buildId: "orphaned-build-reservation" });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore,
    contextStore,
    contextQuotaService: quotaService,
    internalApiToken,
    tenantAdminPrincipalIds: [principalId]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/wiki/build`, {
      method: "POST",
      headers: {
        ...devHeaders(tenantId, principalId),
        authorization: `Bearer ${internalApiToken}`
      },
      body: JSON.stringify({
        repository,
        ref: "main",
        commitSha: "d".repeat(40),
        requestKey: "replacement-build"
      })
    });
    const body = await response.text();
    assert.equal(response.status, 202, body);
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);
    assert.equal(
      stateStore.current().intakeState.board.tasks.find((task) => task.id === stale.buildTaskId)?.status,
      "failed"
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a newer PR delivery queues behind leased work without settling or canceling its predecessor", async () => {
  const tenantId = "tenant-supersession-settlement-retry";
  const repository = "omxyz/supersession-settlement-retry";
  const webhookSecret = "supersession-settlement-retry-secret";
  const firstHead = "1".repeat(40);
  const secondHead = "2".repeat(40);
  const old = createContextWorkflowBoardBuild(createEmptyBoardState(), {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-page-workflow-1",
    validatorVersion: "context-page-validator-1",
    pageIndexVersion: "pageindex-local-1",
    executionProfileDigest: "f".repeat(64),
    tenantId,
    repository,
    ref: "pull/88/head",
    refSequence: 1,
    requestKey: "github:pull:omxyz/supersession-settlement-retry:88:first",
    commitSha: firstHead,
    trigger: "pull_request",
    now: NOW
  });
  const oldBuild = findTask(old.state, old.buildTaskId);
  assert.ok(oldBuild);
  const modelTaskId = entityId<"task">("supersession-settlement-model-task");
  let board = addContextTask(old.state, {
    id: modelTaskId,
    type: contextWorkflowBoardTaskTypes.planner,
    kind: "dispatchable",
    title: "Leased model work from the superseded build",
    assigneeRole: "context-agent",
    dedupeKey: "supersession-settlement:model-task",
    dispatchTopic: contextWorkflowBoardTopics.planner,
    parentTaskId: old.buildTaskId,
    metadata: { ...oldBuild.metadata, contextBuildId: old.buildTaskId }
  });
  board = reduceBoard(board, NOW);
  const leased = leaseNextOutboxMessage(board, {
    topics: [contextWorkflowBoardTopics.planner],
    taskIds: [modelTaskId],
    leaseId: "supersession-settlement-lease",
    writeFenceToken: "supersession-settlement-fence",
    now: NOW,
    expiresAt: "2026-07-29T22:00:00.000Z"
  });
  assert.ok(leased);
  board = transitionBoardTask(leased.state, modelTaskId, "in_progress", NOW);
  const quotaTaskId = `${modelTaskId}:attempt:${leased.message.payload.attempt}`;
  const quotaService = new FailOnceModelSettlementQuotaService(quotaTaskId);
  await quotaService.admitBuild({ tenantId, buildId: old.buildTaskId });
  await quotaService.startModelTask({ tenantId, taskId: quotaTaskId });
  const stateStore = deliveryTrackingStateStore({
    intakeState: { board },
    devDeliverySequence: 0
  });
  const server = createApiServer({
    tenantId,
    stateStore,
    githubWebhookSecret: webhookSecret,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deliveryId = "supersession-settlement-retry-delivery";
  const rawBody = JSON.stringify({
    action: "synchronize",
    repository: { full_name: repository, default_branch: "main" },
    pull_request: { number: 88, head: { sha: secondHead }, base: { sha: firstHead } }
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const deliver = () =>
    fetch(`${baseUrl}/wiki/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature
      },
      body: rawBody
    });

  try {
    const first = await deliver();
    assert.equal(first.status, 202, await first.text());
    const committed = stateStore.current().intakeState.board;
    assert.notEqual(committed.tasks.find((task) => task.id === old.buildTaskId)?.status, "canceled");
    assert.equal(
      committed.tasks.some(
        (task) => task.type === contextWorkflowBoardTaskTypes.build && task.metadata.commitSha === secondHead
      ),
      false
    );
    assert.ok(
      committed.events.some(
        (event) =>
          event.type === "context.build_followup_requested" &&
          (event.payload?.followup as { commitSha?: string } | undefined)?.commitSha === secondHead
      )
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    assert.equal(quotaService.failedSettlementAttempts, 0);

    const duplicate = await deliver();
    const duplicateBody = (await duplicate.json()) as { duplicate?: boolean };
    assert.equal(duplicate.status, 200);
    assert.equal(duplicateBody.duplicate, true);
    assert.equal((await quotaService.snapshot(tenantId)).active.modelTasks, 1);
    assert.equal(quotaService.successfulSettlementAttempts, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("durable follow-up promotion does not reschedule itself while restoring the mutation snapshot", async () => {
  const tenantId = "tenant-followup-self-reschedule";
  const repository = "omxyz/followup-self-reschedule";
  const initial = createContextWorkflowBoardBuild(createEmptyBoardState(), {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-page-workflow-1",
    validatorVersion: "context-page-validator-1",
    pageIndexVersion: "pageindex-local-1",
    executionProfileDigest: "f".repeat(64),
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    requestKey: "initial-followup-self-reschedule",
    commitSha: "1".repeat(40),
    trigger: "push",
    now: NOW
  });
  let board = transitionBoardTask(initial.state, initial.buildTaskId, "in_progress", NOW);
  board = transitionBoardTask(board, initial.buildTaskId, "done", NOW);
  const queued = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: initial.buildTaskId,
      eventType: "context.build_followup_requested",
      payload: {
        followup: {
          tenantId,
          repository,
          ref: "main",
          requestKey: "followup-self-reschedule",
          commitSha: "2".repeat(40),
          trigger: "push"
        }
      }
    },
    { actor: { type: "system", id: "followup-self-reschedule-test" }, now: NOW }
  );
  assert.equal(queued.accepted, true);
  const stateStore = mutableStateStore({
    intakeState: { board: queued.state },
    devDeliverySequence: 0
  });
  const server = createApiServer({ tenantId, stateStore });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    const deadline = Date.now() + 3_000;
    while (
      Date.now() < deadline &&
      !stateStore
        .current()
        .intakeState.board.tasks.some((task) => task.metadata.requestKey === "followup-self-reschedule")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      stateStore
        .current()
        .intakeState.board.tasks.some((task) => task.metadata.requestKey === "followup-self-reschedule"),
      "the durable follow-up should be promoted"
    );
    const settledUpdateCount = stateStore.updateCount();
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(stateStore.updateCount(), settledUpdateCount, "a successful promotion must not schedule itself again");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a context worker can prefer release-acceptance repository work without excluding normal work", async () => {
  const tenantId = "tenant-preferred-repository";
  const ordinaryTaskId = entityId<"task">("ordinary-repository-task");
  const acceptanceTaskId = entityId<"task">("acceptance-repository-task");
  const initialBoard = quotaClaimBoard([
    {
      tenantId,
      taskId: ordinaryTaskId,
      type: contextWorkflowBoardTaskTypes.snapshot,
      topic: contextWorkflowBoardTopics.snapshot,
      repository: "acme/ordinary"
    },
    {
      tenantId,
      taskId: acceptanceTaskId,
      type: contextWorkflowBoardTaskTypes.snapshot,
      topic: contextWorkflowBoardTopics.snapshot,
      repository: "acme/release-fixture"
    }
  ]);
  const store = mutableStateStore({
    intakeState: { board: initialBoard },
    devDeliverySequence: 0
  });
  const internalApiToken = "preferred-repository-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const preferred = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "preferred-repository-worker",
        topics: [contextWorkflowBoardTopics.snapshot],
        preferredRepository: "acme/release-fixture"
      })
    });
    assert.equal(preferred.status, 200);
    assert.equal(((await preferred.json()) as TestClaim).task.id, acceptanceTaskId);

    const fallback = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({
        workerId: "preferred-repository-worker",
        topics: [contextWorkflowBoardTopics.snapshot],
        preferredRepository: "acme/release-fixture"
      })
    });
    assert.equal(fallback.status, 200);
    assert.equal(((await fallback.json()) as TestClaim).task.id, ordinaryTaskId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("snapshot claims serialize checkout work per repository without blocking other repositories", async () => {
  const tenantId = "tenant-snapshot-repository-fairness";
  const firstRepositoryTaskId = entityId<"task">("snapshot-fairness-first");
  const queuedSameRepositoryTaskId = entityId<"task">("snapshot-fairness-same-repository");
  const otherRepositoryTaskId = entityId<"task">("snapshot-fairness-other-repository");
  const initialBoard = quotaClaimBoard([
    {
      tenantId,
      taskId: firstRepositoryTaskId,
      type: contextWorkflowBoardTaskTypes.snapshot,
      topic: contextWorkflowBoardTopics.snapshot,
      repository: "acme/large-repository"
    },
    {
      tenantId,
      taskId: queuedSameRepositoryTaskId,
      type: contextWorkflowBoardTaskTypes.snapshot,
      topic: contextWorkflowBoardTopics.snapshot,
      repository: "acme/large-repository"
    },
    {
      tenantId,
      taskId: otherRepositoryTaskId,
      type: contextWorkflowBoardTaskTypes.snapshot,
      topic: contextWorkflowBoardTopics.snapshot,
      repository: "acme/other-repository"
    }
  ]);
  const store = mutableStateStore({
    intakeState: { board: initialBoard },
    devDeliverySequence: 0
  });
  const internalApiToken = "snapshot-fairness-token";
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    internalApiToken
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const claim = async (workerId: string): Promise<TestClaim> => {
    const response = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId, topics: [contextWorkflowBoardTopics.snapshot] })
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as TestClaim;
  };

  try {
    assert.equal((await claim("snapshot-fairness-worker-1")).task.id, firstRepositoryTaskId);
    assert.equal((await claim("snapshot-fairness-worker-2")).task.id, otherRepositoryTaskId);
    const persisted = store.current().intakeState.board;
    assert.equal(persisted.tasks.find((task) => task.id === queuedSameRepositoryTaskId)?.status, "queued");
    assert.equal(persisted.outbox.find((message) => message.taskId === queuedSameRepositoryTaskId)?.status, "pending");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a leased incremental build can read only its exact admission-bound prior release", async () => {
  const tenantId = "tenant-incremental-read";
  const repository = "omxyz/jina";
  const ref = "main";
  const commitSha = "8".repeat(40);
  const priorBuildId = "task_prior_release";
  const artifactRoot = await mkdtemp(join(tmpdir(), "jina-context-prior-release-"));
  const artifactStore = new FileContextArtifactStore(artifactRoot);
  const certificationArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: priorBuildId,
    kind: "certification",
    name: "certification.json",
    contentType: "application/json",
    content: '{"version":1}'
  });
  const publicationPlanArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: priorBuildId,
    kind: "publication-plan",
    name: "plan.json",
    contentType: "application/json",
    content: '{"version":1}'
  });
  const bodyMarkdown = "# Architecture\n\nThe API routes requests through the runtime.\n";
  const pages = [
    {
      documentPath: "architecture.md",
      title: "Architecture",
      bodyMarkdown,
      bodySha256: createHash("sha256").update(bodyMarkdown).digest("hex"),
      revisionId: "kr_prior_architecture",
      citations: []
    }
  ];
  const priorScope = {
    tenantId,
    repository,
    ref,
    refSequence: 1,
    commitSha,
    buildId: priorBuildId
  };
  const publicSnapshotDigest = contextPublicSnapshotDigest(pages);
  const publicationInputDigest = boardContextPublicationInputDigest({
    scope: priorScope,
    certificationArtifact,
    publicationPlanArtifact,
    checkpointId: "checkpoint-prior",
    publicSnapshotDigest,
    pages: pages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: []
    }))
  });
  const releaseId = boardContextReleaseId(publicationInputDigest);
  const release: CertifiedContextReleaseArtifactV1 = {
    version: 1,
    release: {
      releaseId,
      ...priorScope,
      checkpointId: "checkpoint-prior",
      publishedAt: NOW
    },
    certificationArtifact,
    publicationPlanArtifact,
    publicSnapshotDigest,
    publicationInputDigest,
    pages
  };
  const releaseContent = serializeCertifiedContextReleaseArtifact(release);
  const releaseArtifact = await artifactStore.put({
    tenantId,
    repository,
    buildId: priorBuildId,
    kind: "context-release",
    name: `${releaseId}.json`,
    contentType: "application/json",
    content: releaseContent
  });
  const priorRelease = {
    version: 1 as const,
    tenantId,
    repository,
    ref,
    refSequence: 1,
    commitSha,
    releaseId,
    publicSnapshotDigest,
    releaseArtifact
  };
  const created = createCurrentContextBuild(createEmptyBoardState(), {
    tenantId,
    repository,
    ref,
    refSequence: 2,
    commitSha,
    requestKey: "manual:incremental-read",
    priorRelease,
    now: NOW
  });
  const store = mutableStateStore({
    intakeState: { board: created.state },
    devDeliverySequence: 0
  });
  const internalApiToken = "context-prior-release-token";
  const server = createApiServer({
    tenantId,
    stateStore: store,
    internalApiToken,
    contextArtifactStore: artifactStore
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const claimResponse = await fetch(`${baseUrl}/internal/worker/claim`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ workerId: "prior-reader", topics: [contextWorkflowBoardTopics.snapshot] })
    });
    const claimText = await claimResponse.text();
    assert.equal(claimResponse.status, 200, claimText);
    const claim = JSON.parse(claimText) as {
      message: { id: string; leaseId: string; attempt: number; writeFenceToken: string };
      task: { id: string; metadata: { priorRelease: unknown } };
    };
    assert.deepEqual(claim.task.metadata.priorRelease, {
      ...priorRelease,
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION
    });
    const lease = {
      messageId: claim.message.id,
      taskId: claim.task.id,
      leaseId: claim.message.leaseId,
      attempt: claim.message.attempt,
      writeFenceToken: claim.message.writeFenceToken
    };
    const priorRead = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ ...lease, artifact: releaseArtifact })
    });
    const priorReadText = await priorRead.text();
    assert.equal(priorRead.status, 200, priorReadText);
    const priorBody = JSON.parse(priorReadText) as { contentBase64: string };
    assert.equal(Buffer.from(priorBody.contentBase64, "base64").toString("utf8"), releaseContent);

    const unboundArtifact = await artifactStore.put({
      tenantId,
      repository,
      buildId: priorBuildId,
      kind: "context-release",
      name: "cr_unbound.json",
      contentType: "application/json",
      content: releaseContent
    });
    const unboundRead = await fetch(`${baseUrl}/internal/context/board/artifacts/read`, {
      method: "POST",
      headers: internalHeaders(internalApiToken),
      body: JSON.stringify({ ...lease, artifact: unboundArtifact })
    });
    assert.equal(unboundRead.status, 400, await unboundRead.text());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("worker completion attestations are internal, tenant-scoped, repository-authorized, and narrow", async () => {
  const tenantA = "00000000-0000-4000-8000-000000000001";
  const tenantB = "00000000-0000-4000-8000-000000000002";
  const repositoryA = "omxyz/jina";
  const first = createCurrentContextBuild(createEmptyBoardState(), {
    tenantId: tenantA,
    repository: repositoryA,
    ref: "main",
    refSequence: 1,
    requestKey: "attestation:tenant-a",
    now: NOW
  });
  const second = createCurrentContextBuild(first.state, {
    tenantId: tenantB,
    repository: "omxyz/other",
    ref: "main",
    refSequence: 1,
    requestKey: "attestation:tenant-b",
    now: NOW
  });
  let board = applyCommand(
    second.state,
    {
      command: "CommentTask",
      taskId: first.snapshotTaskId,
      eventType: "task.worker_completion_recorded",
      payload: {
        messageId: "private-message-id",
        attempt: 1,
        outcome: "done",
        workerReleaseId: "release-1",
        workerService: "jina-context-worker",
        workerRevision: "jina-context-worker-release-1",
        resultDigest: "private-result-digest"
      }
    },
    { actor: { type: "run", id: "worker" }, now: NOW }
  ).state;
  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: first.graphTaskId,
      eventType: "task.worker_completion_recorded",
      payload: {
        attempt: 1,
        outcome: "done",
        workerReleaseId: "must-not-leak"
      }
    },
    { actor: { type: "run", id: "worker" }, now: NOW }
  ).state;
  board = applyCommand(
    board,
    {
      command: "CommentTask",
      taskId: first.snapshotTaskId,
      eventType: "context.private_diagnostic",
      payload: { secret: "must-not-leak" }
    },
    { actor: { type: "run", id: "worker" }, now: NOW }
  ).state;

  const store = mutableStateStore({
    intakeState: { board },
    devDeliverySequence: 0
  });
  const contextStore = new MemoryContextEngineStore();
  const internalApiToken = "completion-attestation-internal-token";
  const adminPrincipalId = "user:admin@example.com";
  const server = createApiServer({
    stateStore: store,
    contextStore,
    internalApiToken,
    tenantAdminPrincipalIds: [adminPrincipalId],
    sharedIdentityResolver: {
      async resolveRepository() {
        return undefined;
      },
      async listTenantIds() {
        return [tenantA, tenantB];
      },
      async ping() {},
      async close() {}
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/internal/context/builds/${first.buildTaskId}/worker-completions`;
  const identityHeaders = (tenantId: string, principalId = adminPrincipalId) => ({
    authorization: `Bearer ${internalApiToken}`,
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId
  });

  try {
    const unauthenticated = await fetch(`${baseUrl}${path}`, {
      headers: {
        "x-jina-tenant-id": tenantA,
        "x-jina-principal-id": adminPrincipalId
      }
    });
    assert.equal(unauthenticated.status, 401);

    const repositoryDenied = await fetch(`${baseUrl}${path}`, {
      headers: identityHeaders(tenantA, "user:reader@example.com")
    });
    assert.equal(repositoryDenied.status, 404);

    const crossTenant = await fetch(`${baseUrl}${path}`, {
      headers: identityHeaders(tenantB)
    });
    assert.equal(crossTenant.status, 404);

    const authorized = await fetch(`${baseUrl}${path}`, {
      headers: identityHeaders(tenantA)
    });
    const body = (await authorized.json()) as {
      readonly buildId: string;
      readonly repository: string;
      readonly completions: readonly Record<string, unknown>[];
    };
    assert.equal(authorized.status, 200);
    assert.equal(body.buildId, first.buildTaskId);
    assert.equal(body.repository, repositoryA);
    assert.deepEqual(body.completions, [
      {
        taskId: first.snapshotTaskId,
        taskType: contextWorkflowBoardTaskTypes.snapshot,
        attempt: 1,
        outcome: "done",
        workerReleaseId: "release-1",
        workerService: "jina-context-worker",
        workerRevision: "jina-context-worker-release-1"
      }
    ]);
    assert.equal(JSON.stringify(body).includes("private-message-id"), false);
    assert.equal(JSON.stringify(body).includes("private-result-digest"), false);
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await contextStore.close();
  }
});

type TestContextBuildScope = Omit<
  ContextWorkflowBuildScope,
  | "contextWorkflowContract"
  | "contextWorkflowSchemaRevision"
  | "promptContractVersion"
  | "validatorVersion"
  | "pageIndexVersion"
  | "executionProfileDigest"
  | "priorRelease"
> & {
  readonly priorRelease?: Omit<ContextWorkflowPriorReleaseSeed, "contract" | "schemaRevision">;
};

function createCurrentContextBuild(state: BoardState, input: TestContextBuildScope & { readonly now: string }) {
  const { priorRelease, ...scope } = input;
  return createContextWorkflowBoardBuild(state, {
    ...scope,
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-page-workflow-1",
    validatorVersion: "context-page-validator-1",
    pageIndexVersion: "pageindex-local-1",
    executionProfileDigest: "a".repeat(64),
    ...(priorRelease
      ? {
          priorRelease: {
            ...priorRelease,
            contract: CONTEXT_WORKFLOW_CONTRACT,
            schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION
          }
        }
      : {})
  });
}

function setTaskStatus(
  state: BoardState,
  taskId: TaskId,
  status: "triage" | "queued" | "in_progress" | "done" | "failed" | "canceled"
): BoardState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
  };
}

async function uploadWorkerArtifact(
  baseUrl: string,
  token: string,
  claim: TestClaim,
  kind: "citation-audit" | "gate-evaluation",
  name: string
): Promise<ContextArtifactRef> {
  const response = await fetch(`${baseUrl}/internal/context/board/artifacts`, {
    method: "POST",
    headers: internalHeaders(token),
    body: JSON.stringify({
      ...leaseFromClaim(claim),
      kind,
      name,
      contentType: "application/json",
      contentBase64: Buffer.from('{"version":1}').toString("base64")
    })
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return (JSON.parse(body) as { artifact: ContextArtifactRef }).artifact;
}

function mutableStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot; updateCount(): number } {
  let snapshot = structuredClone(initial);
  let updates = 0;
  return {
    current: () => structuredClone(snapshot),
    updateCount: () => updates,
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
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>
    ) {
      updates += 1;
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}

function deliveryTrackingStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot } {
  let snapshot = structuredClone(initial);
  const deliveries = new Set<string>();
  return {
    current: () => structuredClone(snapshot),
    async load() {
      return structuredClone(snapshot);
    },
    async ping() {},
    async hasDelivery(deliveryId) {
      return deliveries.has(deliveryId);
    },
    async save(next, deliveryId) {
      snapshot = structuredClone(next);
      if (deliveryId) deliveries.add(deliveryId);
      return true;
    },
    async update<T>(
      operation: (current: ApiSnapshot | undefined) => Promise<{ readonly state: ApiSnapshot; readonly result: T }>,
      deliveryId?: string
    ) {
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      if (deliveryId) deliveries.add(deliveryId);
      return { committed: true, result: updated.result };
    },
    async close() {}
  };
}

class FailOnceModelSettlementQuotaService extends ContextQuotaService {
  failedSettlementAttempts = 0;
  successfulSettlementAttempts = 0;

  constructor(private readonly targetTaskId: string) {
    super({ store: new InMemoryContextQuotaStore() });
  }

  override async cancelModelTask(input: Parameters<ContextQuotaService["cancelModelTask"]>[0]) {
    if (input.taskId === this.targetTaskId && this.failedSettlementAttempts === 0) {
      this.failedSettlementAttempts += 1;
      throw new Error("injected model-quota settlement failure");
    }
    const settled = await super.cancelModelTask(input);
    if (input.taskId === this.targetTaskId) this.successfulSettlementAttempts += 1;
    return settled;
  }
}

function addContextTask(
  board: BoardState,
  task: {
    readonly id: TaskId;
    readonly type: string;
    readonly kind: "aggregate" | "dispatchable";
    readonly title: string;
    readonly assigneeRole: string;
    readonly dedupeKey: string;
    readonly metadata: Record<string, unknown>;
    readonly dispatchTopic?: string;
    readonly parentTaskId?: TaskId;
  }
): BoardState {
  return applyCommand(
    board,
    {
      command: "CreateTask",
      ...(task.kind === "aggregate" ? { blocksParentCompletion: false } : {}),
      task
    },
    { actor: { type: "system", id: "retry-http-test" }, now: NOW }
  ).state;
}

function quotaClaimBoard(
  tasks: readonly {
    readonly tenantId: string;
    readonly taskId: TaskId;
    readonly type: typeof contextWorkflowBoardTaskTypes.planner | typeof contextWorkflowBoardTaskTypes.snapshot;
    readonly topic: typeof contextWorkflowBoardTopics.planner | typeof contextWorkflowBoardTopics.snapshot;
    readonly repository?: string;
  }[]
): BoardState {
  let board = createEmptyBoardState();
  for (const [index, task] of tasks.entries()) {
    board = addContextTask(board, {
      id: task.taskId,
      type: task.type,
      kind: "dispatchable",
      title: `Quota claim candidate ${index + 1}`,
      assigneeRole: "context-agent",
      dedupeKey: `quota-claim:${task.tenantId}:${task.taskId}`,
      dispatchTopic: task.topic,
      metadata: contextMetadata(task.tenantId, task.repository ?? "omxyz/jina", `quota-claim-build-${task.tenantId}`)
    });
  }
  return reduceBoard(board, NOW);
}

function contextMetadata(tenantId: string, repository: string, contextBuildId: string): Record<string, unknown> {
  return {
    tenantId,
    repository,
    ref: "main",
    refSequence: 1,
    commitSha: "a".repeat(40),
    contextBuildId
  };
}

interface TestClaim {
  readonly message: {
    readonly id: string;
    readonly leaseId: string;
    readonly attempt: number;
    readonly writeFenceToken: string;
  };
  readonly task: {
    readonly id: string;
    readonly metadata?: {
      readonly dependencyResults?: readonly {
        readonly taskType: string;
        readonly pageTaskId?: string;
        readonly documentPath?: string;
      }[];
    };
  };
}

async function claimContextTask(baseUrl: string, token: string, topic: string): Promise<TestClaim> {
  const response = await fetch(`${baseUrl}/internal/worker/claim`, {
    method: "POST",
    headers: internalHeaders(token),
    body: JSON.stringify({
      workerId: "context-board-retry-test",
      topics: [topic]
    })
  });
  if (response.status !== 200) {
    assert.fail(`claim failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as TestClaim;
}

function leaseFromClaim(claim: TestClaim) {
  return {
    messageId: claim.message.id,
    taskId: claim.task.id,
    leaseId: claim.message.leaseId,
    attempt: claim.message.attempt,
    writeFenceToken: claim.message.writeFenceToken
  };
}

function workerComplete(baseUrl: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/internal/worker/complete`, {
    method: "POST",
    headers: internalHeaders(token),
    body: JSON.stringify(body)
  });
}

function internalHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

function devHeaders(tenantId: string, principalId: string) {
  return {
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId,
    "content-type": "application/json"
  };
}
