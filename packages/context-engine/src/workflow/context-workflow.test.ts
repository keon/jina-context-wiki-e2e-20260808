import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand, createEmptyBoardState, findTask, reduceBoard, type BoardState, type TaskId } from "@jina/board";
import type { ContextArtifactRef } from "../ports/artifact-store.js";
import {
  CONTEXT_WORKFLOW_CONTRACT,
  CONTEXT_WORKFLOW_SCHEMA_REVISION,
  addContextWorkflowPagePlanner,
  addContextWorkflowPublicationWork,
  bindContextWorkflowBoardBuildCommit,
  contextWorkflowBoardArtifactKind,
  contextWorkflowBoardArtifactKindForTopic,
  contextWorkflowBoardTaskTypeDefinitions,
  contextWorkflowBoardTaskTypes,
  contextWorkflowBoardTopics,
  createContextWorkflowBoardBuild,
  parseContextWorkflowBoardTaskResult,
  type ContextWorkflowBuildScope,
  type ContextWorkflowPagePlanEntry
} from "./context-workflow.js";

const NOW = "2026-08-04T16:00:00.000Z";
const COMMIT = "9".repeat(40);

test("Context owns only the reduced task and topic catalog", () => {
  assert.deepEqual(
    contextWorkflowBoardTaskTypeDefinitions.map((definition) => definition.type),
    [
      "build-context",
      "context-build-graph",
      "snapshot-context-input",
      "plan-context-pages",
      "build-context-page",
      "publish-context-release"
    ]
  );
  assert.equal(contextWorkflowBoardArtifactKind(contextWorkflowBoardTaskTypes.planner), "publication-plan");
  assert.equal(contextWorkflowBoardArtifactKindForTopic(contextWorkflowBoardTopics.page), "context-page");
  assert.throws(
    () => contextWorkflowBoardArtifactKind(contextWorkflowBoardTaskTypes.graph),
    /does not produce an artifact/
  );
});

test("Context starts with only the graph hold and immutable snapshot", () => {
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), scope());
  assert.equal(created.state.tasks.length, 3);
  assert.equal(findTask(created.state, created.buildTaskId)?.metadata.contextWorkflowContract, "page-oriented");
  assert.equal(findTask(created.state, created.buildTaskId)?.metadata.contextWorkflowSchemaRevision, 1);
  assert.equal(findTask(created.state, created.graphTaskId)?.status, "triage");
  assert.equal(findTask(created.state, created.snapshotTaskId)?.status, "queued");
  assert.deepEqual(
    requiredDependencies(created.state, created.buildTaskId).sort(),
    [created.graphTaskId, created.snapshotTaskId].sort()
  );

  assert.throws(
    () =>
      createContextWorkflowBoardBuild(created.state, {
        ...scope(),
        validatorVersion: "validator-different"
      }),
    /different scope/
  );
});

test("Context snapshot binds the commit and schedules exactly one page planner", () => {
  const { commitSha: _admittedCommit, ...unboundScope } = scope();
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), unboundScope);
  const parsed = parseContextWorkflowBoardTaskResult(created.state, created.snapshotTaskId, {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    outputArtifact: artifact("snapshot", created.buildTaskId),
    commitSha: COMMIT
  });
  assert.equal(parsed.taskType, contextWorkflowBoardTaskTypes.snapshot);
  const bound = bindContextWorkflowBoardBuildCommit(created.state, {
    buildTaskId: created.buildTaskId,
    commitSha: parsed.commitSha,
    now: NOW
  });
  const replay = createContextWorkflowBoardBuild(bound, unboundScope);
  assert.equal(replay.buildTaskId, created.buildTaskId, "commit binding does not break request idempotency");
  const planned = addContextWorkflowPagePlanner(bound, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: parsed.outputArtifact,
    now: NOW
  });
  assert.equal(findTask(planned.state, created.buildTaskId)?.metadata.commitSha, COMMIT);
  assert.equal(findTask(planned.state, planned.plannerTaskId)?.type, contextWorkflowBoardTaskTypes.planner);
  assert.equal(findTask(planned.state, planned.plannerTaskId)?.status, "triage");
  assert.deepEqual(requiredDependencies(planned.state, planned.plannerTaskId), [created.snapshotTaskId]);

  assert.throws(
    () =>
      parseContextWorkflowBoardTaskResult(created.state, created.snapshotTaskId, {
        outputArtifact: artifact("snapshot", created.buildTaskId),
        commitSha: COMMIT
      }),
    /contract is missing or mismatched/
  );
});

test("Context planner creates page jobs only for add and revise and publishes after every page", () => {
  const graph = plannerGraph();
  const pages: readonly ContextWorkflowPagePlanEntry[] = [
    page("architecture", "architecture/overview.md", "Architecture", "revise", graph.buildTaskId),
    page("operations", "operations/runtime.md", "Runtime operations", "add", graph.buildTaskId),
    { subjectId: "api", path: "reference/api.md", title: "API", operation: "retain" },
    {
      subjectId: "old-flow",
      path: "workflows/old.md",
      title: "Old workflow",
      operation: "retire",
      reason: "Replaced by the runtime operations page",
      replacementPath: "operations/runtime.md"
    }
  ];
  const expanded = addContextWorkflowPublicationWork(graph.state, {
    buildTaskId: graph.buildTaskId,
    graphTaskId: graph.graphTaskId,
    plannerTaskId: graph.plannerTaskId,
    plan: graph.plan,
    pages,
    now: NOW
  });
  assert.equal(expanded.pageTaskIds.length, 2);
  assert.equal(findTask(expanded.state, graph.graphTaskId)?.status, "done");
  assert.deepEqual(
    expanded.pageTaskIds.map((id) => findTask(expanded.state, id)?.metadata.pageOperation),
    ["revise", "add"]
  );
  assert.deepEqual(
    requiredDependencies(expanded.state, expanded.publicationTaskId).sort(),
    [graph.plannerTaskId, ...expanded.pageTaskIds].sort()
  );
  assert.equal(
    expanded.state.tasks.filter((task) => task.type === contextWorkflowBoardTaskTypes.page).length,
    2,
    "retain and retire are planner dispositions, not model jobs"
  );
  assert.equal(
    expanded.state.tasks.some((task) =>
      [
        "challenge-context-sources",
        "evaluate-context-tasks",
        "repair-context-gaps",
        "certify-context-release",
        "index-context-release"
      ].includes(task.type)
    ),
    false
  );
});

test("Context result parser enforces exact contracts, scoped artifacts, dispositions, and phase receipts", () => {
  const graph = publicationGraph();
  const pageTaskId = graph.pageTaskIds[0]!;
  const accepted = parseContextWorkflowBoardTaskResult(graph.state, pageTaskId, {
    contract: CONTEXT_WORKFLOW_CONTRACT,
    schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    outputArtifact: artifact("page-result", graph.buildTaskId),
    disposition: {
      status: "accepted",
      pageArtifact: artifact("page", graph.buildTaskId),
      evidenceFingerprint: "b".repeat(64),
      generationFingerprint: "c".repeat(64)
    },
    phaseReceiptIds: ["phase-evidence-1", "phase-author-1", "phase-critic-1"]
  });
  assert.equal(accepted.taskType, contextWorkflowBoardTaskTypes.page);
  if (accepted.taskType !== contextWorkflowBoardTaskTypes.page) assert.fail("page result expected");
  assert.equal(accepted.disposition.status, "accepted");

  assert.throws(
    () =>
      parseContextWorkflowBoardTaskResult(graph.state, pageTaskId, {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: artifact("page-result", graph.buildTaskId),
        disposition: { status: "omitted", reasonCode: "internal_stack_trace" },
        phaseReceiptIds: [],
        legacyVerdict: "pass"
      }),
    /unknown properties/
  );
  assert.throws(
    () =>
      parseContextWorkflowBoardTaskResult(graph.state, pageTaskId, {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: artifact("page-result", graph.buildTaskId),
        disposition: {
          status: "retained_stale",
          pageArtifact: artifact("prior", "task_other"),
          reasonCode: "model_timeout"
        },
        phaseReceiptIds: []
      }),
    /does not belong/
  );
  assert.throws(
    () =>
      parseContextWorkflowBoardTaskResult(graph.state, pageTaskId, {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: artifact("page-result", graph.buildTaskId),
        disposition: { status: "omitted", reasonCode: "internal_stack_trace" },
        phaseReceiptIds: []
      }),
    /reasonCode is invalid/
  );

  const mismatchedProfile: BoardState = {
    ...graph.state,
    tasks: graph.state.tasks.map((task) =>
      task.id === pageTaskId
        ? { ...task, metadata: { ...task.metadata, executionProfileDigest: "d".repeat(64) } }
        : task
    )
  };
  assert.throws(
    () =>
      parseContextWorkflowBoardTaskResult(mismatchedProfile, pageTaskId, {
        contract: CONTEXT_WORKFLOW_CONTRACT,
        schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
        outputArtifact: artifact("page-result", graph.buildTaskId),
        disposition: { status: "omitted", reasonCode: "model_timeout" },
        phaseReceiptIds: []
      }),
    /identity does not match/
  );
});

test("a hard Context page failure cancels publication through required Board dependencies", () => {
  const graph = publicationGraph();
  let state = move(graph.state, graph.plannerTaskId, "in_progress", "run");
  state = move(state, graph.plannerTaskId, "done", "run");
  const pageTaskId = graph.pageTaskIds[0]!;
  state = move(state, pageTaskId, "in_progress", "run");
  state = move(state, pageTaskId, "failed", "run");
  state = reduceBoard(state, NOW);
  assert.equal(findTask(state, graph.publicationTaskId)?.status, "canceled");
  assert.equal(findTask(state, graph.buildTaskId)?.status, "failed");
});

function plannerGraph(): {
  readonly state: BoardState;
  readonly buildTaskId: TaskId;
  readonly graphTaskId: TaskId;
  readonly plannerTaskId: TaskId;
  readonly plan: ContextArtifactRef;
} {
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), scope());
  const planned = addContextWorkflowPagePlanner(created.state, {
    buildTaskId: created.buildTaskId,
    snapshotTaskId: created.snapshotTaskId,
    snapshot: artifact("snapshot", created.buildTaskId),
    now: NOW
  });
  let state = move(planned.state, created.snapshotTaskId, "in_progress", "run");
  state = move(state, created.snapshotTaskId, "done", "run");
  return {
    state,
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    plannerTaskId: planned.plannerTaskId,
    plan: artifact("plan", created.buildTaskId)
  };
}

function publicationGraph() {
  const graph = plannerGraph();
  const expanded = addContextWorkflowPublicationWork(graph.state, {
    buildTaskId: graph.buildTaskId,
    graphTaskId: graph.graphTaskId,
    plannerTaskId: graph.plannerTaskId,
    plan: graph.plan,
    pages: [page("architecture", "architecture/overview.md", "Architecture", "revise", graph.buildTaskId)],
    now: NOW
  });
  return { ...graph, ...expanded };
}

function scope(
  overrides: Partial<ContextWorkflowBuildScope> = {}
): ContextWorkflowBuildScope & { readonly now: string } {
  return {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-prompts-1",
    validatorVersion: "context-validator-1",
    pageIndexVersion: "pageindex-1",
    executionProfileDigest: "e".repeat(64),
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "push:context-foundation",
    commitSha: COMMIT,
    trigger: "push",
    ...overrides,
    now: NOW
  };
}

function page(
  subjectId: string,
  path: string,
  title: string,
  operation: "add" | "revise",
  buildTaskId: TaskId
): ContextWorkflowPagePlanEntry {
  return { subjectId, path, title, operation, briefArtifact: artifact(`brief-${subjectId}`, buildTaskId) };
}

function artifact(name: string, buildTaskId: string): ContextArtifactRef {
  const key = `context/tenants/tenant-1/repositories/omxyz/jina/builds/${buildTaskId}/test-artifact/${name}.json`;
  return {
    uri: `gs://context-test/${key}`,
    key,
    contentType: "application/json",
    bytes: name.length,
    sha256: "a".repeat(64)
  };
}

function requiredDependencies(state: BoardState, taskId: TaskId): TaskId[] {
  return state.dependencies
    .filter((dependency) => dependency.taskId === taskId && dependency.required)
    .map((dependency) => dependency.dependsOnTaskId);
}

function move(
  state: BoardState,
  taskId: TaskId,
  toStatus: "in_progress" | "done" | "failed",
  actor: "run" | "system" = "system"
): BoardState {
  const result = applyCommand(
    state,
    { command: "TransitionTask", taskId, toStatus },
    { actor: { type: actor, id: `test-${actor}` }, now: NOW }
  );
  assert.equal(result.accepted, true, result.rejection?.detail ?? "transition rejected");
  return reduceBoard(result.state, NOW);
}
