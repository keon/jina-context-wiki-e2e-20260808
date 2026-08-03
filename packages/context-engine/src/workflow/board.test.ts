import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCommand,
  appendEvent,
  createEmptyBoardState,
  findTask,
  reduceBoard,
  type BoardState,
  type TaskId,
  type TaskStatus
} from "@jina/board";
import {
  addContextPageRepairCycle,
  addContextGateRepairRound,
  addContextPublicationWork,
  addContextResearchPlan,
  addContextResearchWork,
  assertContextBoardMetadata,
  boardWorkArtifactKind,
  boardWorkArtifactKindForTopic,
  causalGraphBoardTaskTypes,
  contextBoardTaskTypes,
  contextBoardTopics,
  contextGateRepairMustChangeSnapshot,
  createContextBoardBuild,
  createCausalGraphBoardBuild,
  failContextGateRepairExhausted,
  failContextPageRepairExhausted,
  MAX_CONTEXT_GATE_REPAIR_PASS,
  MAX_CONTEXT_OPERATOR_REMEDIATION_PASS,
  MAX_CONTEXT_REPAIR_PASS,
  nextContextBoardRefSequence,
  nextCausalGraphBoardRefSequence,
  parseContextBoardTaskResult,
  resumeContextGateExhaustion,
  resumeContextPageExhaustion
} from "./board.js";
import type { ContextArtifactRef } from "../ports/artifact-store.js";

const NOW = "2026-07-29T18:00:00.000Z";

test("Board work owns one artifact-kind contract shared by tasks and topics", () => {
  assert.equal(boardWorkArtifactKind(contextBoardTaskTypes.gapRepair), "context-draft");
  assert.equal(boardWorkArtifactKindForTopic(contextBoardTopics.gapRepair), "context-draft");
  assert.equal(boardWorkArtifactKind(contextBoardTaskTypes.pageAudit), "citation-audit");
  assert.equal(boardWorkArtifactKindForTopic(contextBoardTopics.pageAudit), "citation-audit");
  assert.throws(() => boardWorkArtifactKind(contextBoardTaskTypes.build), /does not produce an artifact/);
});

test("causal graph is a fixed snapshot, one-run derivation, publication chain", () => {
  const created = createCausalGraphBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "push:issue-sidecar",
    commitSha: "8".repeat(40),
    trigger: "push",
    now: NOW
  });
  const children = created.state.tasks.filter((task) => task.parentTaskId === created.buildTaskId);
  assert.equal(created.state.tasks.length, 4);
  assert.deepEqual(
    children.map((task) => task.type),
    [causalGraphBoardTaskTypes.snapshot, causalGraphBoardTaskTypes.derive, causalGraphBoardTaskTypes.publication]
  );
  assert.equal(findTask(created.state, created.snapshotTaskId)?.status, "queued");
  assert.equal(findTask(created.state, created.deriveTaskId)?.status, "triage");
  assert.equal(findTask(created.state, created.publicationTaskId)?.status, "triage");
  assert.deepEqual(requiredDependencies(created.state, created.deriveTaskId), [created.snapshotTaskId]);
  assert.deepEqual(requiredDependencies(created.state, created.publicationTaskId), [created.deriveTaskId]);
  assert.equal(
    nextCausalGraphBoardRefSequence(created.state, {
      tenantId: "tenant-1",
      repository: "omxyz/jina",
      ref: "main"
    }),
    2
  );
  assert.equal(
    nextContextBoardRefSequence(created.state, { tenantId: "tenant-1", repository: "omxyz/jina", ref: "main" }),
    1,
    "documentation and issue releases own independent ref sequences"
  );
});

test("dynamic context work is scheduled entirely through root-blocking board tasks", () => {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 7,
    requestKey: "push:97ca695",
    commitSha: "9".repeat(40),
    trigger: "push",
    now: NOW
  });
  let state = created.state;

  assert.equal(findTask(state, created.buildTaskId)?.status, "triage");
  assert.equal(findTask(state, created.graphTaskId)?.status, "triage");
  assert.equal(findTask(state, created.snapshotTaskId)?.status, "queued");
  assert.equal(findTask(state, created.snapshotTaskId)?.dispatchTopic, contextBoardTopics.snapshot);

  state = move(state, created.snapshotTaskId, "in_progress");
  state = move(state, created.snapshotTaskId, "done");
  // The graph-open task prevents a reducer pass from completing a build before
  // an agent has materialized its dynamic children.
  state = reduceBoard(state, NOW);
  assert.equal(findTask(state, created.buildTaskId)?.status, "triage");

  const researchPlan = addContextResearchPlan(state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot", created.buildTaskId),
    now: NOW
  });
  state = researchPlan.state;
  assert.equal(findTask(state, researchPlan.taskId)?.status, "queued");
  state = move(state, researchPlan.taskId, "in_progress");
  state = move(state, researchPlan.taskId, "done");

  const research = addContextResearchWork(state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: artifact("research-plan", created.buildTaskId),
    work: [
      {
        key: "api-security",
        title: "Research API security",
        input: artifact("research-api", created.buildTaskId)
      },
      {
        key: "worker-runtime",
        title: "Research worker runtime",
        input: artifact("research-worker", created.buildTaskId)
      }
    ],
    now: NOW
  });
  state = research.state;
  assert.deepEqual(
    research.researchTaskIds.map((id) => findTask(state, id)?.status),
    ["queued", "queued"]
  );
  assert.equal(findTask(state, research.publicationPlanTaskId)?.status, "triage");

  for (const taskId of research.researchTaskIds) {
    state = move(state, taskId, "in_progress");
    state = move(state, taskId, "done");
    state = reduceBoard(state, NOW);
  }
  assert.equal(findTask(state, research.publicationPlanTaskId)?.status, "queued");
  state = move(state, research.publicationPlanTaskId, "in_progress");
  state = move(state, research.publicationPlanTaskId, "done");

  const publication = addContextPublicationWork(state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: artifact("publication-plan", created.buildTaskId),
    pages: [
      {
        key: "architecture",
        path: "architecture.md",
        title: "Architecture",
        input: artifact("page-architecture", created.buildTaskId)
      }
    ],
    now: NOW
  });
  state = publication.state;
  assert.equal(findTask(state, created.graphTaskId)?.status, "done");
  const pageTaskId = publication.pageTaskIds[0]!;
  const firstWrite = state.tasks.find(
    (task) => task.parentTaskId === pageTaskId && task.type === contextBoardTaskTypes.pageWrite
  )!;
  const firstAudit = state.tasks.find(
    (task) => task.parentTaskId === pageTaskId && task.type === contextBoardTaskTypes.pageAudit
  )!;
  assert.equal(firstWrite.status, "queued");
  assert.equal(firstAudit.status, "triage");
  assert.equal(findTask(state, pageTaskId)?.status, "triage");

  state = move(state, firstWrite.id, "in_progress");
  state = reduceBoard(move(state, firstWrite.id, "done"), NOW);
  assert.equal(findTask(state, firstAudit.id)?.status, "queued");
  state = move(state, firstAudit.id, "in_progress");

  // The repair pair is added before the unsupported audit is completed. The
  // page aggregate therefore never observes a false all-dependencies-done gap.
  const repair = addContextPageRepairCycle(state, {
    pageTaskId,
    priorAuditTaskId: firstAudit.id,
    findings: artifact("audit-findings", created.buildTaskId),
    pass: 1,
    now: NOW
  });
  state = reduceBoard(move(repair.state, firstAudit.id, "done"), NOW);
  assert.equal(findTask(state, pageTaskId)?.status, "triage");
  assert.equal(findTask(state, repair.repairTaskId)?.status, "queued");
  assert.equal(findTask(state, repair.auditTaskId)?.status, "triage");

  state = move(state, repair.repairTaskId, "in_progress");
  state = reduceBoard(move(state, repair.repairTaskId, "done"), NOW);
  assert.equal(findTask(state, repair.auditTaskId)?.status, "queued");
  state = move(state, repair.auditTaskId, "in_progress");
  state = reduceBoard(move(state, repair.auditTaskId, "done"), NOW);
  assert.equal(findTask(state, pageTaskId)?.status, "done");
  assert.equal(findTask(state, publication.sourceChallengeTaskId)?.status, "queued");
  assert.equal(findTask(state, publication.taskEvaluationTaskId)?.status, "queued");
  assert.equal(findTask(state, created.buildTaskId)?.status, "triage");

  const rootBlockers = state.dependencies.filter(
    (dependency) => dependency.taskId === created.buildTaskId && dependency.required
  );
  assert.ok(rootBlockers.some((dependency) => dependency.dependsOnTaskId === pageTaskId));
  assert.ok(rootBlockers.some((dependency) => dependency.dependsOnTaskId === publication.pageIndexTaskId));
});

test("context board metadata stores artifact references instead of large payloads", () => {
  assert.doesNotThrow(() =>
    assertContextBoardMetadata({
      tenantId: "tenant-1",
      outputArtifact: artifact("output"),
      inputDigest: "a".repeat(64)
    })
  );
  assert.throws(() => assertContextBoardMetadata({ body: "# embedded page" }), /must reference body as an artifact/);
  assert.throws(
    () => assertContextBoardMetadata({ boundedSummary: "x".repeat(33 * 1024) }),
    /metadata exceeds 32768 bytes/
  );
});

test("an incremental Board graph propagates its immutable prior release and page dispositions", () => {
  const priorRelease = {
    version: 1 as const,
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    commitSha: "9".repeat(40),
    releaseId: "cr_prior",
    publicSnapshotDigest: "8".repeat(64),
    releaseArtifact: {
      uri: "file:///prior-release.json",
      key: "context-v2/tenants/tenant-1/repositories/omxyz/jina/builds/task_prior/context-release/cr_prior.json",
      contentType: "application/json",
      bytes: 1,
      sha256: "7".repeat(64)
    }
  };
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 2,
    requestKey: "issue:provider-only",
    // Provider-only frontier advances intentionally keep the same commit.
    commitSha: priorRelease.commitSha,
    priorRelease,
    now: NOW
  });
  assert.deepEqual(findTask(created.state, created.snapshotTaskId)?.metadata.priorRelease, priorRelease);

  const researchPlan = addContextResearchPlan(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot", created.buildTaskId),
    now: NOW
  });
  const research = addContextResearchWork(researchPlan.state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: artifact("research-plan", created.buildTaskId),
    work: [],
    now: NOW
  });
  const publication = addContextPublicationWork(research.state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: artifact("publication-plan", created.buildTaskId),
    pages: [
      {
        key: "architecture",
        path: "architecture.md",
        title: "Architecture",
        input: artifact("page-architecture", created.buildTaskId),
        change: "retain"
      }
    ],
    now: NOW
  });
  const page = findTask(publication.state, publication.pageTaskIds[0]!)!;
  const writer = publication.state.tasks.find(
    (task) => task.parentTaskId === page.id && task.type === contextBoardTaskTypes.pageWrite
  )!;
  assert.equal(writer.metadata.pageChange, "retain");
  assert.deepEqual(writer.metadata.priorRelease, priorRelease);
});

test("a failed global gate materializes a board-visible repair and successor verification round", () => {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "manual:gate-repair",
    now: NOW
  });
  const researchPlan = addContextResearchPlan(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot", created.buildTaskId),
    now: NOW
  });
  const research = addContextResearchWork(researchPlan.state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: artifact("research-plan", created.buildTaskId),
    work: [],
    now: NOW
  });
  const publication = addContextPublicationWork(research.state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: artifact("publication-plan", created.buildTaskId),
    pages: [
      {
        key: "architecture",
        path: "architecture.md",
        title: "Architecture",
        input: artifact("page-input", created.buildTaskId)
      }
    ],
    now: NOW
  });

  const repaired = addContextGateRepairRound(publication.state, {
    buildTaskId: created.buildTaskId,
    sourceChallengeTaskId: publication.sourceChallengeTaskId,
    taskEvaluationTaskId: publication.taskEvaluationTaskId,
    pass: 1,
    now: NOW
  });
  const repair = findTask(repaired.state, repaired.repairTaskId)!;
  assert.equal(repair.type, contextBoardTaskTypes.gapRepair);
  assert.equal(repair.metadata.pass, 1);
  assert.deepEqual(
    requiredDependencies(repaired.state, repair.id).sort(),
    [publication.sourceChallengeTaskId, publication.taskEvaluationTaskId].sort()
  );
  assert.deepEqual(requiredDependencies(repaired.state, repaired.sourceChallengeTaskId), [repair.id]);
  assert.deepEqual(requiredDependencies(repaired.state, repaired.taskEvaluationTaskId), [repair.id]);
  assert.ok(
    requiredDependencies(repaired.state, publication.certificationTaskId).includes(repaired.sourceChallengeTaskId)
  );
  assert.ok(
    requiredDependencies(repaired.state, publication.certificationTaskId).includes(repaired.taskEvaluationTaskId)
  );

  const replayed = addContextGateRepairRound(repaired.state, {
    buildTaskId: created.buildTaskId,
    sourceChallengeTaskId: publication.sourceChallengeTaskId,
    taskEvaluationTaskId: publication.taskEvaluationTaskId,
    pass: 1,
    now: NOW
  });
  assert.equal(replayed.state.tasks.length, repaired.state.tasks.length);
  assert.equal(replayed.state.dependencies.length, repaired.state.dependencies.length);
});

test("bounded page repair exhaustion fails the page instead of scheduling an unbounded pass", () => {
  const graph = publicationGraph("manual:page-exhaustion");
  let state = graph.state;
  let priorAuditTaskId = graph.firstAuditTaskId;

  for (let pass = 1; pass <= MAX_CONTEXT_REPAIR_PASS; pass += 1) {
    const repair = addContextPageRepairCycle(state, {
      pageTaskId: graph.pageTaskId,
      priorAuditTaskId,
      findings: artifact(`page-findings-${pass}`, graph.buildTaskId),
      pass,
      now: NOW
    });
    state = repair.state;
    priorAuditTaskId = repair.auditTaskId;
  }

  state = failContextPageRepairExhausted(state, {
    pageTaskId: graph.pageTaskId,
    priorAuditTaskId,
    pass: MAX_CONTEXT_REPAIR_PASS,
    now: NOW
  });

  assert.equal(findTask(state, graph.pageTaskId)?.status, "failed");
  assert.equal(
    state.tasks.filter(
      (task) => task.parentTaskId === graph.pageTaskId && task.type === contextBoardTaskTypes.pageRepair
    ).length,
    MAX_CONTEXT_REPAIR_PASS
  );
});

test("operator remediation resumes a bounded page exhaustion from retained checkpoints exactly once", () => {
  const graph = publicationGraph("manual:page-remediation");
  let state = graph.state;
  let priorAuditTaskId = graph.firstAuditTaskId;

  for (let pass = 1; pass <= MAX_CONTEXT_REPAIR_PASS; pass += 1) {
    const repair = addContextPageRepairCycle(state, {
      pageTaskId: graph.pageTaskId,
      priorAuditTaskId,
      findings: artifact(`page-remediation-findings-${pass}`, graph.buildTaskId),
      pass,
      now: NOW
    });
    state = repair.state;
    priorAuditTaskId = repair.auditTaskId;
  }
  state = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === priorAuditTaskId ? { ...task, status: "done" as const, updatedAt: NOW } : task
    )
  };
  state = appendEvent(state, "context.page_audit.completed", NOW, priorAuditTaskId, {
    outputArtifact: artifact("terminal-page-audit", graph.buildTaskId)
  });
  state = failContextPageRepairExhausted(state, {
    pageTaskId: graph.pageTaskId,
    priorAuditTaskId,
    pass: MAX_CONTEXT_REPAIR_PASS,
    now: NOW
  });
  state = reduceBoard(state, NOW);
  assert.equal(findTask(state, graph.buildTaskId)?.status, "failed");
  assert.equal(findTask(state, graph.pageTaskId)?.status, "failed");
  const canceledDispatchableIds = state.tasks
    .filter((task) => task.status === "canceled" && task.kind === "dispatchable")
    .map((task) => task.id);
  assert.ok(canceledDispatchableIds.length > 0);

  const resumed = resumeContextPageExhaustion(state, {
    buildTaskId: graph.buildTaskId,
    pageTaskId: graph.pageTaskId,
    requestKey: "operator:page-remediation:1",
    actorId: "user:operator@example.com",
    reason: "resolve the one remaining rejected citation with a targeted agent pass",
    now: "2026-07-29T18:01:00.000Z"
  });
  assert.equal(resumed.replay, false);
  assert.equal(resumed.pass, MAX_CONTEXT_REPAIR_PASS + 1);
  assert.ok(resumed.pass <= MAX_CONTEXT_OPERATOR_REMEDIATION_PASS);
  assert.equal(findTask(resumed.state, graph.buildTaskId)?.status, "triage");
  assert.equal(findTask(resumed.state, graph.pageTaskId)?.status, "triage");
  assert.equal(findTask(resumed.state, resumed.repairTaskId)?.status, "queued");
  assert.equal(findTask(resumed.state, resumed.auditTaskId)?.status, "triage");
  assert.equal(findTask(resumed.state, resumed.repairTaskId)?.metadata.findingsArtifact !== undefined, true);
  for (const taskId of canceledDispatchableIds) {
    assert.ok(requiredDependencies(resumed.state, taskId).includes(resumed.auditTaskId));
    assert.equal(findTask(resumed.state, taskId)?.status, "triage");
  }

  const replay = resumeContextPageExhaustion(resumed.state, {
    buildTaskId: graph.buildTaskId,
    pageTaskId: graph.pageTaskId,
    requestKey: "operator:page-remediation:1",
    actorId: "user:operator@example.com",
    reason: "resolve the one remaining rejected citation with a targeted agent pass",
    now: "2026-07-29T18:02:00.000Z"
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.repairTaskId, resumed.repairTaskId);
  assert.equal(replay.auditTaskId, resumed.auditTaskId);
  assert.deepEqual(replay.state, resumed.state);
});

test("bounded global repair exhaustion cancels certification and all downstream publication", () => {
  const graph = publicationGraph("manual:gate-exhaustion");
  let state = graph.state;
  let sourceChallengeTaskId = graph.sourceChallengeTaskId;
  let taskEvaluationTaskId = graph.taskEvaluationTaskId;

  for (let pass = 1; pass <= MAX_CONTEXT_GATE_REPAIR_PASS; pass += 1) {
    const repair = addContextGateRepairRound(state, {
      buildTaskId: graph.buildTaskId,
      sourceChallengeTaskId,
      taskEvaluationTaskId,
      pass,
      now: NOW
    });
    state = repair.state;
    sourceChallengeTaskId = repair.sourceChallengeTaskId;
    taskEvaluationTaskId = repair.taskEvaluationTaskId;
  }

  state = failContextGateRepairExhausted(state, {
    buildTaskId: graph.buildTaskId,
    sourceChallengeTaskId,
    taskEvaluationTaskId,
    pass: MAX_CONTEXT_GATE_REPAIR_PASS,
    now: NOW
  });

  assert.equal(findTask(state, graph.certificationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.publicationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.pageIndexTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.buildTaskId)?.status, "failed");
});

test("only automatic gate repair passes require changed public bytes", () => {
  assert.equal(contextGateRepairMustChangeSnapshot(1), true);
  assert.equal(contextGateRepairMustChangeSnapshot(MAX_CONTEXT_GATE_REPAIR_PASS), true);
  assert.equal(contextGateRepairMustChangeSnapshot(MAX_CONTEXT_GATE_REPAIR_PASS + 1), false);
  assert.equal(contextGateRepairMustChangeSnapshot(MAX_CONTEXT_OPERATOR_REMEDIATION_PASS), false);
  assert.throws(() => contextGateRepairMustChangeSnapshot(0), /outside the supported range/);
  assert.throws(
    () => contextGateRepairMustChangeSnapshot(MAX_CONTEXT_OPERATOR_REMEDIATION_PASS + 1),
    /outside the supported range/
  );
});

test("operator remediation resumes gate exhaustion from the retained draft and gates exactly once", () => {
  const graph = publicationGraph("manual:gate-remediation");
  let state = graph.state;
  let sourceChallengeTaskId = graph.sourceChallengeTaskId;
  let taskEvaluationTaskId = graph.taskEvaluationTaskId;

  for (let pass = 1; pass <= MAX_CONTEXT_GATE_REPAIR_PASS; pass += 1) {
    const repair = addContextGateRepairRound(state, {
      buildTaskId: graph.buildTaskId,
      sourceChallengeTaskId,
      taskEvaluationTaskId,
      pass,
      now: NOW
    });
    state = repair.state;
    sourceChallengeTaskId = repair.sourceChallengeTaskId;
    taskEvaluationTaskId = repair.taskEvaluationTaskId;
  }
  const unfinishedTaskIds = new Set([
    graph.buildTaskId,
    graph.certificationTaskId,
    graph.publicationTaskId,
    graph.pageIndexTaskId,
    taskEvaluationTaskId
  ]);
  state = {
    ...state,
    tasks: state.tasks.map((task) =>
      unfinishedTaskIds.has(task.id) ? task : { ...task, status: "done" as const, updatedAt: NOW }
    )
  };
  state = failContextGateRepairExhausted(state, {
    buildTaskId: graph.buildTaskId,
    sourceChallengeTaskId,
    taskEvaluationTaskId,
    pass: MAX_CONTEXT_GATE_REPAIR_PASS,
    now: NOW
  });

  const resumed = resumeContextGateExhaustion(state, {
    buildTaskId: graph.buildTaskId,
    requestKey: "operator:gate-remediation:1",
    actorId: "user:operator@example.com",
    reason: "promote the final independently challenged maintenance task",
    now: "2026-07-29T18:01:00.000Z"
  });
  assert.equal(resumed.replay, false);
  assert.equal(resumed.pass, MAX_CONTEXT_GATE_REPAIR_PASS + 1);
  assert.equal(findTask(resumed.state, graph.buildTaskId)?.status, "triage");
  assert.equal(findTask(resumed.state, graph.certificationTaskId)?.status, "triage");
  assert.equal(findTask(resumed.state, resumed.repairTaskId)?.metadata.pass, resumed.pass);
  assert.ok(requiredDependencies(resumed.state, resumed.repairTaskId).includes(sourceChallengeTaskId));
  assert.ok(requiredDependencies(resumed.state, resumed.repairTaskId).includes(taskEvaluationTaskId));

  const replay = resumeContextGateExhaustion(resumed.state, {
    buildTaskId: graph.buildTaskId,
    requestKey: "operator:gate-remediation:1",
    actorId: "user:operator@example.com",
    reason: "promote the final independently challenged maintenance task",
    now: "2026-07-29T18:02:00.000Z"
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.repairTaskId, resumed.repairTaskId);
  assert.deepEqual(replay.state, resumed.state);
});

test("dynamic context tasks reject cross-build artifact references", () => {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "manual:one",
    now: NOW
  });
  assert.throws(
    () =>
      addContextResearchPlan(created.state, {
        buildTaskId: created.buildTaskId,
        snapshotTaskId: created.snapshotTaskId,
        snapshot: artifact("snapshot", "task_another_build"),
        now: NOW
      }),
    /does not belong to the task's tenant, repository, and build/
  );
});

test("context build request keys are idempotent only for the same scope and ref sequences are board-derived", () => {
  const input = {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "push:one",
    commitSha: "9".repeat(40),
    githubInstallationId: 42,
    derivationDetail: "thorough" as const,
    derivationBudgetSeconds: 1_800,
    trigger: "push" as const,
    now: NOW
  };
  const created = createContextBoardBuild(createEmptyBoardState(), input);
  assert.deepEqual(createContextBoardBuild(created.state, input), created);
  assert.equal(
    nextContextBoardRefSequence(created.state, {
      tenantId: input.tenantId,
      repository: input.repository,
      ref: input.ref
    }),
    2
  );
  assert.throws(
    () => createContextBoardBuild(created.state, { ...input, repository: "omxyz/other" }),
    /request key is already bound/
  );
});

test("worker result envelopes retain only scoped artifact references and bounded graph fan-out", () => {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "manual:result-contract",
    now: NOW
  });
  let state = move(created.state, created.snapshotTaskId, "in_progress");
  const snapshot = parseContextBoardTaskResult(state, created.snapshotTaskId, {
    version: 1,
    outputArtifact: artifact("snapshot", created.buildTaskId),
    commitSha: "9".repeat(40)
  });
  assert.equal(snapshot.taskType, contextBoardTaskTypes.snapshot);
  const generatedSnapshotArtifact = {
    ...artifact("snapshot-generation", created.buildTaskId),
    objectGeneration: "18446744073709551615"
  };
  const generatedSnapshot = parseContextBoardTaskResult(state, created.snapshotTaskId, {
    version: 1,
    outputArtifact: generatedSnapshotArtifact,
    commitSha: "9".repeat(40)
  });
  assert.deepEqual(generatedSnapshot.outputArtifact, generatedSnapshotArtifact);
  assert.throws(
    () =>
      parseContextBoardTaskResult(state, created.snapshotTaskId, {
        version: 1,
        outputArtifact: { ...generatedSnapshotArtifact, objectGeneration: 7 },
        commitSha: "9".repeat(40)
      }),
    /objectGeneration/
  );

  state = reduceBoard(move(state, created.snapshotTaskId, "done"), NOW);
  const planned = addContextResearchPlan(state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot", created.buildTaskId),
    now: NOW
  });
  state = move(planned.state, planned.taskId, "in_progress");
  const result = parseContextBoardTaskResult(state, planned.taskId, {
    version: 1,
    outputArtifact: artifact("research-plan", created.buildTaskId),
    work: [
      {
        key: "runtime",
        title: "Research the runtime",
        inputArtifact: artifact("research-runtime", created.buildTaskId)
      }
    ]
  });
  assert.equal(result.taskType, contextBoardTaskTypes.researchPlan);
  assert.equal("work" in result ? result.work[0]?.key : undefined, "runtime");

  assert.throws(
    () =>
      parseContextBoardTaskResult(state, planned.taskId, {
        version: 1,
        outputArtifact: artifact("research-plan", created.buildTaskId),
        body: "# embedded plan",
        work: []
      }),
    /must reference body as an artifact/
  );
  assert.throws(
    () =>
      parseContextBoardTaskResult(state, planned.taskId, {
        version: 1,
        outputArtifact: artifact("research-plan", "task_another_build"),
        work: []
      }),
    /does not belong/
  );
});

function artifact(name: string, buildTaskId = "task_test"): ContextArtifactRef {
  const key = `context-v2/tenants/tenant-1/repositories/omxyz/jina/builds/${buildTaskId}/test-artifact/${name}.json`;
  return {
    uri: `gs://context-test/${key}`,
    key,
    contentType: "application/json",
    bytes: name.length,
    sha256: "a".repeat(64)
  };
}

function publicationGraph(requestKey: string): {
  readonly state: BoardState;
  readonly buildTaskId: TaskId;
  readonly pageTaskId: TaskId;
  readonly firstAuditTaskId: TaskId;
  readonly sourceChallengeTaskId: TaskId;
  readonly taskEvaluationTaskId: TaskId;
  readonly certificationTaskId: TaskId;
  readonly publicationTaskId: TaskId;
  readonly pageIndexTaskId: TaskId;
} {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey,
    now: NOW
  });
  const researchPlan = addContextResearchPlan(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot", created.buildTaskId),
    now: NOW
  });
  const research = addContextResearchWork(researchPlan.state, {
    buildTaskId: created.buildTaskId,
    researchPlanTaskId: researchPlan.taskId,
    plan: artifact("research-plan", created.buildTaskId),
    work: [],
    now: NOW
  });
  const publication = addContextPublicationWork(research.state, {
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    publicationPlanTaskId: research.publicationPlanTaskId,
    plan: artifact("publication-plan", created.buildTaskId),
    pages: [
      {
        key: "architecture",
        path: "architecture.md",
        title: "Architecture",
        input: artifact("page-input", created.buildTaskId)
      }
    ],
    now: NOW
  });
  const pageTaskId = publication.pageTaskIds[0]!;
  const firstAuditTaskId = publication.state.tasks.find(
    (task) =>
      task.parentTaskId === pageTaskId && task.type === contextBoardTaskTypes.pageAudit && task.metadata.pass === 0
  )?.id;
  if (!firstAuditTaskId) throw new Error("initial page audit task not found");
  return {
    state: publication.state,
    buildTaskId: created.buildTaskId,
    pageTaskId,
    firstAuditTaskId,
    sourceChallengeTaskId: publication.sourceChallengeTaskId,
    taskEvaluationTaskId: publication.taskEvaluationTaskId,
    certificationTaskId: publication.certificationTaskId,
    publicationTaskId: publication.publicationTaskId,
    pageIndexTaskId: publication.pageIndexTaskId
  };
}

function move(state: BoardState, taskId: TaskId, toStatus: TaskStatus): BoardState {
  const result = applyCommand(
    state,
    { command: "TransitionTask", taskId, toStatus },
    { actor: { type: "run", id: "test-worker" }, now: NOW }
  );
  assert.equal(result.accepted, true, result.rejection?.detail ?? result.rejection?.reason ?? "transition rejected");
  return result.state;
}

function requiredDependencies(state: BoardState, taskId: TaskId): TaskId[] {
  return state.dependencies
    .filter((dependency) => dependency.taskId === taskId && dependency.required)
    .map((dependency) => dependency.dependsOnTaskId);
}
