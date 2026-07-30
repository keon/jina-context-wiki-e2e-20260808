import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  MAX_CONTEXT_GATE_REPAIR_PASS,
  MAX_CONTEXT_OPERATOR_REMEDIATION_PASS,
  MAX_CONTEXT_REPAIR_PASS,
  addContextGateRepairRound,
  addContextPageRepairCycle,
  addContextPublicationWork,
  addContextResearchPlan,
  addContextResearchWork,
  contextBoardTaskTypes,
  createContextBoardBuild,
  failContextGateRepairExhausted,
  failContextPageRepairExhausted,
  MemoryContextEngineStore,
  type ContextArtifactRef
} from "@jina/context-engine";
import { appendEvent, createEmptyBoardState, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const NOW = "2026-07-30T12:00:00.000Z";

test("tenant-admin batch retry resumes one exhausted page from retained checkpoints exactly once", async () => {
  const tenantId = "tenant-page-remediation";
  const repository = "omxyz/jina";
  const fixture = exhaustedPagesFixture({ tenantId, repository, suffix: "single", pageCount: 1 });
  const store = mutableStateStore({
    intakeState: { board: fixture.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, "user:developer@example.com", [repository]);
  await quotaService.admitBuild({ tenantId, buildId: fixture.buildId });
  await quotaService.completeBuild({ tenantId, buildId: fixture.buildId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    contextStore,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const progressUrl = `${baseUrl}/context/builds/${fixture.buildId}/progress`;
  const retryUrl = `${baseUrl}/context/builds/${fixture.buildId}/retry`;
  const page = fixture.pages[0]!;
  const retryBody = {
    taskIds: [page.pageTaskId],
    requestKey: "operator:page-remediation:single:v1",
    reason: "resume the failed page from its retained page and citation-audit checkpoints"
  };

  try {
    const ordinaryProgress = await fetch(progressUrl, {
      headers: devHeaders(tenantId, "user:developer@example.com")
    });
    const ordinaryProgressText = await ordinaryProgress.text();
    assert.equal(ordinaryProgress.status, 200, ordinaryProgressText);
    assert.equal(
      Object.hasOwn(JSON.parse(ordinaryProgressText) as Record<string, unknown>, "retryEligibility"),
      false,
      "repository readers must not receive tenant-admin remediation eligibility"
    );

    const crossTenantProgress = await fetch(progressUrl, {
      headers: devHeaders("tenant-page-remediation-other", "svc:operator")
    });
    assert.equal(crossTenantProgress.status, 404);

    const adminProgress = await fetch(progressUrl, {
      headers: devHeaders(tenantId, "svc:operator")
    });
    const adminProgressText = await adminProgress.text();
    assert.equal(adminProgress.status, 200, adminProgressText);
    assert.deepEqual(
      (
        JSON.parse(adminProgressText) as {
          retryEligibility: {
            eligible: boolean;
            recoverableTaskIds: readonly string[];
            blockers: readonly unknown[];
            mode: string;
          };
        }
      ).retryEligibility,
      {
        eligible: true,
        recoverableTaskIds: [page.pageTaskId],
        blockers: [],
        mode: "page_remediation"
      }
    );

    const beforeDeniedRequests = store.current().intakeState.board;
    const ordinaryRetry = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "user:developer@example.com"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(ordinaryRetry.status, 403);
    const crossTenantRetry = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders("tenant-page-remediation-other", "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(crossTenantRetry.status, 404);
    assert.deepEqual(store.current().intakeState.board, beforeDeniedRequests);

    const priorAudit = beforeDeniedRequests.tasks.find((task) => task.id === page.priorAuditTaskId);
    assert.ok(priorAudit);
    const accepted = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 202, acceptedText);
    const acceptedBody = JSON.parse(acceptedText) as {
      accepted: boolean;
      duplicate: boolean;
      buildId: string;
      taskIds: readonly string[];
      tasks: readonly { taskId: string; attempt: number; outboxMessageId: string }[];
      reopenedTaskIds: readonly string[];
    };
    assert.equal(acceptedBody.accepted, true);
    assert.equal(acceptedBody.duplicate, false);
    assert.equal(acceptedBody.buildId, fixture.buildId);
    assert.deepEqual(acceptedBody.taskIds, [page.pageTaskId]);
    assert.equal(acceptedBody.tasks.length, 1);
    assert.equal(acceptedBody.tasks[0]?.attempt, 1);
    assert.ok(acceptedBody.reopenedTaskIds.includes(fixture.buildId));
    assert.ok(acceptedBody.reopenedTaskIds.includes(page.pageTaskId));

    let persisted = store.current().intakeState.board;
    const remediationReceipts = persisted.events.filter(
      (event) =>
        event.type === "context.page_operator_remediation_scheduled" &&
        event.payload?.requestKey === retryBody.requestKey
    );
    assert.equal(remediationReceipts.length, 1);
    const receipt = remediationReceipts[0]!;
    assert.equal(receipt.taskId, page.pageTaskId);
    assert.equal(receipt.payload?.buildTaskId, fixture.buildId);
    assert.equal(receipt.payload?.priorAuditTaskId, page.priorAuditTaskId);
    assert.equal(receipt.payload?.pass, MAX_CONTEXT_REPAIR_PASS + 1);
    assert.ok(Number(receipt.payload?.pass) <= MAX_CONTEXT_OPERATOR_REMEDIATION_PASS);
    const repairTaskId = String(receipt.payload?.repairTaskId) as TaskId;
    const auditTaskId = String(receipt.payload?.auditTaskId) as TaskId;
    assert.equal(acceptedBody.tasks[0]?.taskId, repairTaskId);
    const repair = persisted.tasks.find((task) => task.id === repairTaskId);
    const audit = persisted.tasks.find((task) => task.id === auditTaskId);
    assert.equal(repair?.type, contextBoardTaskTypes.pageRepair);
    assert.equal(repair?.status, "queued");
    assert.equal(repair?.metadata.pass, MAX_CONTEXT_REPAIR_PASS + 1);
    assert.deepEqual(repair?.metadata.findingsArtifact, page.findingsArtifact);
    assert.ok(
      persisted.dependencies.some(
        (dependency) =>
          dependency.taskId === repairTaskId &&
          dependency.dependsOnTaskId === page.priorAuditTaskId &&
          dependency.required
      ),
      "the remediation repair must depend on the retained completed audit checkpoint"
    );
    assert.equal(audit?.type, contextBoardTaskTypes.pageAudit);
    assert.equal(audit?.status, "triage");
    assert.equal(audit?.metadata.pass, MAX_CONTEXT_REPAIR_PASS + 1);
    assert.deepEqual(
      persisted.tasks.find((task) => task.id === page.priorAuditTaskId),
      priorAudit,
      "the retained completed audit checkpoint must not be rewritten"
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);

    const beforeReplay = store.current().intakeState.board;
    const duplicate = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    const duplicateText = await duplicate.text();
    assert.equal(duplicate.status, 200, duplicateText);
    const duplicateBody = JSON.parse(duplicateText) as typeof acceptedBody;
    assert.equal(duplicateBody.duplicate, true);
    assert.deepEqual(duplicateBody.tasks, acceptedBody.tasks);
    assert.deepEqual(duplicateBody.reopenedTaskIds, acceptedBody.reopenedTaskIds);
    persisted = store.current().intakeState.board;
    assert.deepEqual(persisted, beforeReplay);
    assert.equal(
      persisted.events.filter(
        (event) =>
          event.type === "context.page_operator_remediation_scheduled" &&
          event.payload?.requestKey === retryBody.requestKey
      ).length,
      1
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("tenant-admin batch retry continues exhausted global gates from the retained draft", async () => {
  const tenantId = "tenant-gate-remediation";
  const repository = "omxyz/jina";
  const fixture = exhaustedGateFixture({ tenantId, repository });
  const store = mutableStateStore({
    intakeState: { board: fixture.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: fixture.buildId });
  await quotaService.completeBuild({ tenantId, buildId: fixture.buildId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const progressUrl = `${baseUrl}/context/builds/${fixture.buildId}/progress`;
  const retryUrl = `${baseUrl}/context/builds/${fixture.buildId}/retry`;
  const retryBody = {
    taskIds: [fixture.certificationTaskId],
    requestKey: "operator:gate-remediation:single:v1",
    reason: "promote the final challenged maintenance task from retained gate and draft checkpoints"
  };

  try {
    const progress = await fetch(progressUrl, {
      headers: devHeaders(tenantId, "svc:operator")
    });
    const progressText = await progress.text();
    assert.equal(progress.status, 200, progressText);
    assert.deepEqual(
      (
        JSON.parse(progressText) as {
          retryEligibility: {
            eligible: boolean;
            recoverableTaskIds: readonly string[];
            blockers: readonly unknown[];
            mode: string;
          };
        }
      ).retryEligibility,
      {
        eligible: true,
        recoverableTaskIds: [fixture.certificationTaskId],
        blockers: [],
        mode: "gate_remediation"
      }
    );

    const accepted = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 202, acceptedText);
    const acceptedBody = JSON.parse(acceptedText) as {
      duplicate: boolean;
      tasks: readonly { taskId: string; attempt: number }[];
      reopenedTaskIds: readonly string[];
    };
    assert.equal(acceptedBody.duplicate, false);
    assert.ok(acceptedBody.reopenedTaskIds.includes(fixture.buildId));
    assert.ok(acceptedBody.reopenedTaskIds.includes(fixture.priorEvaluationTaskId));
    assert.equal(
      acceptedBody.tasks.some((task) => task.taskId === fixture.priorEvaluationTaskId),
      true
    );

    const persisted = store.current().intakeState.board;
    const receipt = persisted.events.find(
      (event) =>
        event.type === "context.gate_operator_remediation_scheduled" &&
        event.payload?.requestKey === retryBody.requestKey
    );
    assert.ok(receipt);
    assert.equal(receipt.payload?.pass, MAX_CONTEXT_GATE_REPAIR_PASS + 1);
    const repairTaskId = String(receipt.payload?.repairTaskId);
    assert.equal(persisted.tasks.find((task) => task.id === repairTaskId)?.type, contextBoardTaskTypes.gapRepair);
    assert.equal(
      persisted.tasks.find((task) => task.id === repairTaskId)?.status,
      "triage",
      "the new repair waits for the canceled sibling gate to be reevaluated"
    );
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 1);

    const beforeReplay = store.current().intakeState.board;
    const replay = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify(retryBody)
    });
    assert.equal(replay.status, 200, await replay.text());
    assert.deepEqual(store.current().intakeState.board, beforeReplay);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("batch page remediation rejects multiple pages and mixed task types atomically", async () => {
  const tenantId = "tenant-page-remediation-rejections";
  const repository = "omxyz/jina";
  const fixture = exhaustedPagesFixture({
    tenantId,
    repository,
    suffix: "multiple",
    pageCount: 2,
    mixedFailure: true
  });
  const store = mutableStateStore({
    intakeState: { board: fixture.state, pullRequests: [] },
    devDeliverySequence: 0
  });
  const quotaService = new ContextQuotaService({ store: new InMemoryContextQuotaStore() });
  await quotaService.admitBuild({ tenantId, buildId: fixture.buildId });
  await quotaService.completeBuild({ tenantId, buildId: fixture.buildId });
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: true,
    stateStore: store,
    contextQuotaService: quotaService
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const retryUrl = `${baseUrl}/context/builds/${fixture.buildId}/retry`;

  try {
    const before = store.current().intakeState.board;
    const multiple = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({
        taskIds: fixture.pages.map((page) => page.pageTaskId),
        requestKey: "operator:page-remediation:multiple",
        reason: "must not reopen more than one exhausted page in one operation"
      })
    });
    const multipleText = await multiple.text();
    assert.equal(multiple.status, 409, multipleText);
    assert.equal((JSON.parse(multipleText) as { code: string }).code, "operator_retry_rejected");
    assert.deepEqual(store.current().intakeState.board, before);
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 0);

    const mixed = await fetch(retryUrl, {
      method: "POST",
      headers: devHeaders(tenantId, "svc:operator"),
      body: JSON.stringify({
        taskIds: [fixture.pages[0]!.pageTaskId, fixture.mixedTaskId],
        requestKey: "operator:page-remediation:mixed",
        reason: "must not combine page remediation with generic dispatchable retry"
      })
    });
    const mixedText = await mixed.text();
    assert.equal(mixed.status, 409, mixedText);
    assert.equal((JSON.parse(mixedText) as { code: string }).code, "operator_retry_rejected");
    assert.deepEqual(store.current().intakeState.board, before);
    assert.equal((await quotaService.snapshot(tenantId)).active.builds, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a production-bound read credential can watch builds but cannot remediate them", async () => {
  const tenantId = "tenant-page-remediation-reader";
  const repository = "omxyz/jina";
  const principalId = "user:context-reader@example.com";
  const contextToken = "context-page-remediation-reader-token";
  const fixture = exhaustedPagesFixture({ tenantId, repository, suffix: "reader", pageCount: 1 });
  const contextStore = new MemoryContextEngineStore();
  await contextStore.replaceRepositoryAccess(tenantId, principalId, [repository]);
  const server = createApiServer({
    tenantId,
    enableDevEndpoints: false,
    stateStore: mutableStateStore({
      intakeState: { board: fixture.state, pullRequests: [] },
      devDeliverySequence: 0
    }),
    contextStore,
    internalApiToken: "context-page-remediation-internal-token",
    contextApiToken: contextToken,
    contextApiTenantId: tenantId,
    contextApiPrincipalId: principalId
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    authorization: `Bearer ${contextToken}`,
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId
  };

  try {
    const builds = await fetch(`${baseUrl}/context/builds`, { headers });
    const buildsText = await builds.text();
    assert.equal(builds.status, 200, buildsText);
    assert.deepEqual(
      (JSON.parse(buildsText) as { builds: readonly { id: string }[] }).builds.map((build) => build.id),
      [fixture.buildId]
    );

    const progress = await fetch(`${baseUrl}/context/builds/${fixture.buildId}/progress`, { headers });
    const progressText = await progress.text();
    assert.equal(progress.status, 200, progressText);
    assert.equal(Object.hasOwn(JSON.parse(progressText) as Record<string, unknown>, "retryEligibility"), false);

    const page = await fetch(
      `${baseUrl}/context/builds/${fixture.buildId}/page?path=${encodeURIComponent("subjects/subject-1")}`,
      { headers }
    );
    assert.equal(page.status, 404, await page.text());

    const retry = await fetch(`${baseUrl}/context/builds/${fixture.buildId}/retry`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        taskIds: [fixture.pages[0]!.pageTaskId],
        requestKey: "reader-must-not-remediate",
        reason: "read credentials cannot mutate the Board"
      })
    });
    assert.equal(retry.status, 401, await retry.text());

    const crossTenant = await fetch(`${baseUrl}/context/builds/${fixture.buildId}/progress`, {
      headers: {
        ...headers,
        "x-jina-tenant-id": "tenant-page-remediation-reader-other"
      }
    });
    assert.equal(crossTenant.status, 401, await crossTenant.text());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

function exhaustedGateFixture(input: { readonly tenantId: string; readonly repository: string }): {
  readonly state: BoardState;
  readonly buildId: TaskId;
  readonly certificationTaskId: TaskId;
  readonly priorEvaluationTaskId: TaskId;
} {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: input.tenantId,
    repository: input.repository,
    ref: "main",
    refSequence: 1,
    requestKey: "gate-remediation:fixture",
    now: NOW
  });
  const artifact = (name: string): ContextArtifactRef => {
    const key =
      `context-v2/tenants/${input.tenantId}/repositories/${input.repository}/` +
      `builds/${created.buildTaskId}/${name}.json`;
    return {
      uri: `gs://context-test/${key}`,
      key,
      contentType: "application/json",
      bytes: name.length,
      sha256: hashCharacter(name).repeat(64)
    };
  };
  const researchPlan = addContextResearchPlan(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot"),
    now: NOW
  });
  const research = addContextResearchWork(researchPlan.state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: artifact("research-plan"),
    work: [],
    now: NOW
  });
  const publication = addContextPublicationWork(research.state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: artifact("publication-plan"),
    pages: [
      {
        key: "architecture",
        path: "architecture.md",
        title: "Architecture",
        input: artifact("page-input")
      }
    ],
    now: NOW
  });
  let state = publication.state;
  let sourceChallengeTaskId = publication.sourceChallengeTaskId;
  let taskEvaluationTaskId = publication.taskEvaluationTaskId;
  for (let pass = 1; pass <= MAX_CONTEXT_GATE_REPAIR_PASS; pass += 1) {
    const repair = addContextGateRepairRound(state, {
      buildTaskId: created.buildTaskId,
      sourceChallengeTaskId,
      taskEvaluationTaskId,
      pass,
      now: NOW
    });
    state = repair.state;
    sourceChallengeTaskId = repair.sourceChallengeTaskId;
    taskEvaluationTaskId = repair.taskEvaluationTaskId;
  }
  state = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === created.buildTaskId ||
      task.id === publication.certificationTaskId ||
      task.id === publication.publicationTaskId ||
      task.id === publication.pageIndexTaskId ||
      task.id === taskEvaluationTaskId
        ? task
        : { ...task, status: "done" as const, updatedAt: NOW }
    )
  };
  state = appendEvent(state, "context.source_challenge.completed", NOW, sourceChallengeTaskId, {
    version: 1,
    outputArtifact: artifact("terminal-source-challenge")
  });
  state = failContextGateRepairExhausted(state, {
    buildTaskId: created.buildTaskId,
    sourceChallengeTaskId,
    taskEvaluationTaskId,
    pass: MAX_CONTEXT_GATE_REPAIR_PASS,
    now: NOW
  });
  assert.equal(state.tasks.find((task) => task.id === created.buildTaskId)?.status, "failed");
  assert.equal(state.tasks.find((task) => task.id === taskEvaluationTaskId)?.status, "canceled");
  return {
    state,
    buildId: created.buildTaskId,
    certificationTaskId: publication.certificationTaskId,
    priorEvaluationTaskId: taskEvaluationTaskId
  };
}

function exhaustedPagesFixture(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly suffix: string;
  readonly pageCount: number;
  readonly mixedFailure?: boolean;
}): {
  readonly state: BoardState;
  readonly buildId: TaskId;
  readonly mixedTaskId: TaskId;
  readonly pages: readonly {
    readonly pageTaskId: TaskId;
    readonly priorAuditTaskId: TaskId;
    readonly findingsArtifact: ContextArtifactRef;
  }[];
} {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: input.tenantId,
    repository: input.repository,
    ref: "main",
    refSequence: 1,
    requestKey: `page-remediation:${input.suffix}`,
    now: NOW
  });
  const artifact = (name: string): ContextArtifactRef => {
    const key =
      `context-v2/tenants/${input.tenantId}/repositories/${input.repository}/` +
      `builds/${created.buildTaskId}/${name}.json`;
    return {
      uri: `gs://context-test/${key}`,
      key,
      contentType: "application/json",
      bytes: name.length,
      sha256: hashCharacter(name).repeat(64)
    };
  };
  const researchPlan = addContextResearchPlan(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot"),
    now: NOW
  });
  const research = addContextResearchWork(researchPlan.state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: artifact("research-plan"),
    work: [],
    now: NOW
  });
  const publication = addContextPublicationWork(research.state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: artifact("publication-plan"),
    pages: Array.from({ length: input.pageCount }, (_, index) => ({
      key: `subject-${index + 1}`,
      path: `subjects/subject-${index + 1}.md`,
      title: `Subject ${index + 1}`,
      input: artifact(`page-input-${index + 1}`)
    })),
    now: NOW
  });
  let state = publication.state;
  const pages: {
    pageTaskId: TaskId;
    priorAuditTaskId: TaskId;
    findingsArtifact: ContextArtifactRef;
  }[] = [];
  for (const [index, pageTaskId] of publication.pageTaskIds.entries()) {
    let priorAuditTaskId = state.tasks.find(
      (task) =>
        task.parentTaskId === pageTaskId && task.type === contextBoardTaskTypes.pageAudit && task.metadata.pass === 0
    )?.id;
    if (!priorAuditTaskId) throw new Error("initial page audit task was not created");
    let latestRepairTaskId: TaskId | undefined;
    for (let pass = 1; pass <= MAX_CONTEXT_REPAIR_PASS; pass += 1) {
      const repair = addContextPageRepairCycle(state, {
        pageTaskId,
        priorAuditTaskId,
        findings: artifact(`page-${index + 1}-findings-${pass}`),
        pass,
        now: NOW
      });
      state = repair.state;
      latestRepairTaskId = repair.repairTaskId;
      priorAuditTaskId = repair.auditTaskId;
    }
    if (!latestRepairTaskId) throw new Error("terminal page repair task was not created");
    state = {
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === latestRepairTaskId || task.id === priorAuditTaskId
          ? { ...task, status: "done" as const, updatedAt: NOW }
          : task
      )
    };
    const findingsArtifact = artifact(`page-${index + 1}-terminal-audit`);
    state = appendEvent(state, "context.page_audit.completed", NOW, priorAuditTaskId, {
      outputArtifact: findingsArtifact
    });
    state = failContextPageRepairExhausted(state, {
      pageTaskId,
      priorAuditTaskId,
      pass: MAX_CONTEXT_REPAIR_PASS,
      now: NOW
    });
    pages.push({ pageTaskId, priorAuditTaskId, findingsArtifact });
  }
  state = reduceBoard(state, NOW);
  if (input.mixedFailure) {
    state = {
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === publication.sourceChallengeTaskId ? { ...task, status: "failed" as const, updatedAt: NOW } : task
      )
    };
  }
  assert.equal(state.tasks.find((task) => task.id === created.buildTaskId)?.status, "failed");
  for (const page of pages) {
    assert.equal(state.tasks.find((task) => task.id === page.pageTaskId)?.status, "failed");
  }
  return {
    state,
    buildId: created.buildTaskId,
    mixedTaskId: publication.sourceChallengeTaskId,
    pages
  };
}

function mutableStateStore(initial: ApiSnapshot): ApiStateStore & { current(): ApiSnapshot } {
  let snapshot = structuredClone(initial);
  return {
    current: () => structuredClone(snapshot),
    async load() {
      return structuredClone(snapshot);
    },
    async ping() {
      return undefined;
    },
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
      const updated = await operation(structuredClone(snapshot));
      snapshot = structuredClone(updated.state);
      return { committed: true, result: updated.result };
    },
    async close() {
      return undefined;
    }
  };
}

function devHeaders(tenantId: string, principalId: string) {
  return {
    "x-jina-tenant-id": tenantId,
    "x-jina-principal-id": principalId,
    "content-type": "application/json"
  };
}

function hashCharacter(value: string): string {
  return "abcdef0123456789"[value.length % 16]!;
}
