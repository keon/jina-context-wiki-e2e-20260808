import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand, createEmptyBoardState, findTask, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import {
  addContextGateRepairRound,
  addContextPageRepairCycle,
  addContextPublicationWork,
  addContextResearchPlan,
  addContextResearchWork,
  contextBoardTaskTypes,
  createContextBoardBuild,
  MAX_CONTEXT_GATE_REPAIR_PASS,
  MAX_CONTEXT_REPAIR_PASS,
  type ContextArtifactRef
} from "@jina/context-engine";
import { applyContextBoardTaskResult, finalizeContextBoardTaskResult } from "./context-board-runtime.js";

const NOW = "2026-07-29T20:00:00.000Z";

test("board completions expand the research, publication, and page repair graph before transition", () => {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 3,
    requestKey: "manual:runtime",
    now: NOW
  });
  let state = move(created.state, created.snapshotTaskId, "in_progress");
  state = applyContextBoardTaskResult(
    state,
    created.snapshotTaskId,
    {
      version: 1,
      outputArtifact: artifact("snapshot", created.buildTaskId),
      commitSha: "9".repeat(40)
    },
    NOW
  ).state;
  state = reduceBoard(move(state, created.snapshotTaskId, "done"), NOW);
  assert.equal(findTask(state, created.buildTaskId)?.metadata.commitSha, "9".repeat(40));
  const researchPlan = state.tasks.find((task) => task.type === contextBoardTaskTypes.researchPlan)!;
  assert.equal(researchPlan.status, "queued");

  state = move(state, researchPlan.id, "in_progress");
  state = applyContextBoardTaskResult(
    state,
    researchPlan.id,
    {
      version: 1,
      outputArtifact: artifact("research-plan", created.buildTaskId),
      work: [
        {
          key: "runtime",
          title: "Research runtime",
          inputArtifact: artifact("research-input", created.buildTaskId)
        }
      ]
    },
    NOW
  ).state;
  state = reduceBoard(move(state, researchPlan.id, "done"), NOW);
  const research = state.tasks.find((task) => task.type === contextBoardTaskTypes.research)!;
  state = reduceBoard(move(move(state, research.id, "in_progress"), research.id, "done"), NOW);
  const publicationPlan = state.tasks.find((task) => task.type === contextBoardTaskTypes.publicationPlan)!;
  assert.equal(publicationPlan.status, "queued");

  state = move(state, publicationPlan.id, "in_progress");
  state = applyContextBoardTaskResult(
    state,
    publicationPlan.id,
    {
      version: 1,
      outputArtifact: artifact("publication-plan", created.buildTaskId),
      pages: [
        {
          key: "architecture",
          path: "architecture.md",
          title: "Architecture",
          inputArtifact: artifact("page-input", created.buildTaskId)
        }
      ]
    },
    NOW
  ).state;
  state = reduceBoard(move(state, publicationPlan.id, "done"), NOW);
  const page = state.tasks.find((task) => task.type === contextBoardTaskTypes.page)!;
  const write = state.tasks.find(
    (task) => task.parentTaskId === page.id && task.type === contextBoardTaskTypes.pageWrite
  )!;
  state = reduceBoard(move(move(state, write.id, "in_progress"), write.id, "done"), NOW);
  const audit = state.tasks.find(
    (task) => task.parentTaskId === page.id && task.type === contextBoardTaskTypes.pageAudit
  )!;
  state = move(state, audit.id, "in_progress");
  state = applyContextBoardTaskResult(
    state,
    audit.id,
    {
      version: 1,
      outputArtifact: artifact("audit-findings", created.buildTaskId),
      verdict: "unsupported",
      publicSnapshotDigest: "b".repeat(64),
      unsupportedCitationCount: 2
    },
    NOW
  ).state;
  state = reduceBoard(move(state, audit.id, "done"), NOW);

  assert.equal(findTask(state, page.id)?.status, "triage");
  assert.equal(
    state.tasks.find((task) => task.parentTaskId === page.id && task.type === contextBoardTaskTypes.pageRepair)?.status,
    "queued"
  );
});

test("a repair-required global gate adds a board repair and fresh challenge pair before completion", () => {
  const created = createContextBoardBuild(createEmptyBoardState(), {
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 4,
    requestKey: "manual:gate-runtime",
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
  const expanded = applyContextBoardTaskResult(
    publication.state,
    publication.sourceChallengeTaskId,
    {
      version: 1,
      outputArtifact: artifact("challenge-findings", created.buildTaskId),
      verdict: "repair_required",
      publicSnapshotDigest: "b".repeat(64),
      blockingGapCount: 2
    },
    NOW
  ).state;

  const repair = expanded.tasks.find((task) => task.type === contextBoardTaskTypes.gapRepair)!;
  assert.equal(repair.metadata.pass, 1);
  const successorChallenge = expanded.tasks.find(
    (task) => task.type === contextBoardTaskTypes.sourceChallenge && task.metadata.pass === 1
  )!;
  const successorEvaluation = expanded.tasks.find(
    (task) => task.type === contextBoardTaskTypes.taskEvaluation && task.metadata.pass === 1
  )!;
  const certificationDependencies = expanded.dependencies
    .filter((dependency) => dependency.taskId === publication.certificationTaskId && dependency.required)
    .map((dependency) => dependency.dependsOnTaskId);
  assert.ok(certificationDependencies.includes(successorChallenge.id));
  assert.ok(certificationDependencies.includes(successorEvaluation.id));
});

test("terminal page audit finalization preserves the completed audit while failing its build", () => {
  const graph = publicationGraph("manual:page-runtime-exhaustion");
  let state = graph.state;
  let auditTaskId = graph.firstAuditTaskId;

  for (let pass = 1; pass <= MAX_CONTEXT_REPAIR_PASS; pass += 1) {
    const repair = addContextPageRepairCycle(state, {
      pageTaskId: graph.pageTaskId,
      priorAuditTaskId: auditTaskId,
      findings: artifact(`page-findings-${pass}`, graph.buildTaskId),
      pass,
      now: NOW
    });
    state = repair.state;
    auditTaskId = repair.auditTaskId;
  }
  state = setStatus(state, auditTaskId, "in_progress");

  const applied = applyContextBoardTaskResult(
    state,
    auditTaskId,
    {
      version: 1,
      outputArtifact: artifact("terminal-page-findings", graph.buildTaskId),
      verdict: "unsupported",
      publicSnapshotDigest: "b".repeat(64),
      unsupportedCitationCount: 1
    },
    NOW
  );
  assert.equal(findTask(applied.state, graph.pageTaskId)?.status, "triage");
  assert.equal(findTask(applied.state, auditTaskId)?.status, "in_progress");
  assert.throws(
    () => finalizeContextBoardTaskResult(applied.state, applied.postCompletion!, NOW),
    /completing task to be done/
  );

  state = move(applied.state, auditTaskId, "done");
  state = reduceBoard(finalizeContextBoardTaskResult(state, applied.postCompletion!, NOW), NOW);

  assert.equal(findTask(state, auditTaskId)?.status, "done");
  assert.equal(findTask(state, graph.pageTaskId)?.status, "failed");
  assert.equal(findTask(state, graph.buildTaskId)?.status, "failed");
  assert.equal(findTask(state, graph.certificationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.publicationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.pageIndexTaskId)?.status, "canceled");
});

test("terminal global gate finalization preserves the completing gate and cancels remaining descendants", () => {
  const graph = publicationGraph("manual:gate-runtime-exhaustion");
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
  state = setStatus(state, sourceChallengeTaskId, "in_progress");

  const applied = applyContextBoardTaskResult(
    state,
    sourceChallengeTaskId,
    {
      version: 1,
      outputArtifact: artifact("terminal-gate-findings", graph.buildTaskId),
      verdict: "repair_required",
      publicSnapshotDigest: "c".repeat(64),
      blockingGapCount: 1
    },
    NOW
  );
  assert.equal(findTask(applied.state, graph.buildTaskId)?.status, "triage");
  assert.equal(findTask(applied.state, sourceChallengeTaskId)?.status, "in_progress");

  state = move(applied.state, sourceChallengeTaskId, "done");
  state = reduceBoard(finalizeContextBoardTaskResult(state, applied.postCompletion!, NOW), NOW);

  assert.equal(findTask(state, sourceChallengeTaskId)?.status, "done");
  assert.equal(findTask(state, taskEvaluationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.certificationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.publicationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.pageIndexTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.buildTaskId)?.status, "failed");
});

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
    refSequence: 5,
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

function artifact(name: string, buildTaskId: TaskId): ContextArtifactRef {
  const key = `context/tenants/tenant-1/repositories/omxyz/jina/builds/${buildTaskId}/${name}.json`;
  return {
    uri: `gs://context-test/${key}`,
    key,
    contentType: "application/json",
    bytes: name.length,
    sha256: "a".repeat(64)
  };
}

function move(state: BoardState, taskId: TaskId, toStatus: "in_progress" | "done"): BoardState {
  const moved = applyCommand(
    state,
    { command: "TransitionTask", taskId, toStatus },
    { actor: { type: "run", id: "test" }, now: NOW }
  );
  assert.equal(moved.accepted, true, moved.rejection?.reason ?? "transition rejected");
  return moved.state;
}

function setStatus(
  state: BoardState,
  taskId: TaskId,
  status: "triage" | "queued" | "in_progress" | "done" | "failed" | "canceled"
): BoardState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
  };
}
