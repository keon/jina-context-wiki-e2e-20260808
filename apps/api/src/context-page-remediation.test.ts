import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  MAX_CONTEXT_GATE_REPAIR_PASS,
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
  resumeContextGateExhaustion,
  resumeContextPageExhaustion,
  type ContextArtifactRef
} from "@jina/context-engine";
import { appendEvent, createEmptyBoardState, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import { contextGateRemediationTaskId, contextPageRemediationTaskIds } from "./context-board-recovery.js";
import { createApiServer, type ApiSnapshot, type ApiStateStore } from "./server.js";

const NOW = "2026-07-30T12:00:00.000Z";

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

test("historical page exhaustion cannot authorize recovery after the page was reopened", () => {
  const fixture = exhaustedPagesFixture({
    tenantId: "tenant-stale-page-remediation",
    repository: "omxyz/jina",
    suffix: "stale",
    pageCount: 1
  });
  const page = fixture.pages[0]!;
  const stale = appendEvent(fixture.state, "task.operator_reopened", "2026-07-30T12:01:00.000Z", page.pageTaskId, {
    requestKey: "operator:prior-page-reopen"
  });
  const build = stale.tasks.find((task) => task.id === fixture.buildId)!;

  assert.deepEqual(contextPageRemediationTaskIds(stale, build), []);
  assert.throws(
    () =>
      resumeContextPageExhaustion(stale, {
        buildTaskId: fixture.buildId,
        pageTaskId: page.pageTaskId,
        requestKey: "operator:stale-page-recovery",
        actorId: "svc:operator",
        reason: "must not reuse historical exhaustion",
        now: "2026-07-30T12:02:00.000Z"
      }),
    /latest failure was not bounded repair exhaustion/
  );
});

test("historical gate exhaustion cannot authorize recovery after certification was reopened", () => {
  const fixture = exhaustedGateFixture({ tenantId: "tenant-stale-gate-remediation", repository: "omxyz/jina" });
  const stale = appendEvent(
    fixture.state,
    "task.operator_reopened",
    "2026-07-30T12:01:00.000Z",
    fixture.certificationTaskId,
    { requestKey: "operator:prior-gate-reopen" }
  );
  const build = stale.tasks.find((task) => task.id === fixture.buildId)!;

  assert.equal(contextGateRemediationTaskId(stale, build), undefined);
  assert.throws(
    () =>
      resumeContextGateExhaustion(stale, {
        buildTaskId: fixture.buildId,
        requestKey: "operator:stale-gate-recovery",
        actorId: "svc:operator",
        reason: "must not reuse historical exhaustion",
        now: "2026-07-30T12:02:00.000Z"
      }),
    /latest failure was not bounded gate exhaustion/
  );
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
      `context/tenants/${input.tenantId}/repositories/${input.repository}/` +
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
      `context/tenants/${input.tenantId}/repositories/${input.repository}/` +
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

function hashCharacter(value: string): string {
  return "abcdef0123456789"[value.length % 16]!;
}
