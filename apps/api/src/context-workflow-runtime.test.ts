import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBoardState, findTask, type BoardState, type TaskId } from "@jina/board";
import {
  CONTEXT_WORKFLOW_CONTRACT,
  CONTEXT_WORKFLOW_SCHEMA_REVISION,
  contextWorkflowBoardTaskTypes,
  createContextWorkflowBoardBuild,
  type ContextArtifactRef
} from "@jina/context-engine";
import { applyContextWorkflowBoardTaskResult } from "./context-workflow-runtime.js";

const NOW = "2026-08-04T17:00:00.000Z";
const COMMIT = "8".repeat(40);

test("Context runtime expands snapshot directly to the page planner", () => {
  const { commitSha: _commitSha, ...scope } = buildScope();
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), scope);
  const applied = applyContextWorkflowBoardTaskResult(
    created.state,
    created.snapshotTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: artifact("snapshot", created.buildTaskId),
      commitSha: COMMIT
    },
    NOW
  );
  const planner = applied.state.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.planner);
  assert.ok(planner);
  assert.equal(findTask(applied.state, created.buildTaskId)?.metadata.commitSha, COMMIT);
  assert.equal(
    applied.state.tasks.some((task) =>
      ["plan-context-research", "research-context-subject", "plan-context-publication"].includes(task.type)
    ),
    false
  );
});

test("Context runtime expands one planner result to affected pages and one publisher", () => {
  const initial = plannerState();
  const applied = applyContextWorkflowBoardTaskResult(
    initial.state,
    initial.plannerTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: artifact("plan", initial.buildTaskId),
      pages: [
        {
          subjectId: "architecture",
          path: "architecture/overview.md",
          title: "Architecture",
          operation: "revise",
          briefArtifact: artifact("brief-architecture", initial.buildTaskId)
        },
        {
          subjectId: "operations",
          path: "operations/runtime.md",
          title: "Runtime operations",
          operation: "add",
          briefArtifact: artifact("brief-operations", initial.buildTaskId)
        },
        { subjectId: "api", path: "reference/api.md", title: "API", operation: "retain" },
        {
          subjectId: "retired",
          path: "workflows/retired.md",
          title: "Retired workflow",
          operation: "retire",
          reason: "The workflow no longer exists"
        }
      ]
    },
    NOW
  );
  const pageTasks = applied.state.tasks.filter((task) => task.type === contextWorkflowBoardTaskTypes.page);
  const publishers = applied.state.tasks.filter((task) => task.type === contextWorkflowBoardTaskTypes.publication);
  assert.equal(pageTasks.length, 2);
  assert.equal(publishers.length, 1);
  assert.equal(findTask(applied.state, initial.graphTaskId)?.status, "done");
  assert.deepEqual(
    requiredDependencies(applied.state, publishers[0]!.id).sort(),
    [initial.plannerTaskId, ...pageTasks.map((task) => task.id)].sort()
  );
  assert.equal(
    applied.state.tasks.some((task) =>
      [
        "challenge-context-sources",
        "evaluate-context-tasks",
        "repair-context-gaps",
        "certify-context-release"
      ].includes(task.type)
    ),
    false
  );
});

test("Context runtime rejects pre-cutover result envelopes", () => {
  const initial = createContextWorkflowBoardBuild(createEmptyBoardState(), buildScope());
  assert.throws(
    () =>
      applyContextWorkflowBoardTaskResult(
        initial.state,
        initial.snapshotTaskId,
        { outputArtifact: artifact("snapshot", initial.buildTaskId), commitSha: COMMIT },
        NOW
      ),
    /contract is missing or mismatched/
  );
});

function plannerState(): {
  readonly state: BoardState;
  readonly buildTaskId: TaskId;
  readonly graphTaskId: TaskId;
  readonly plannerTaskId: TaskId;
} {
  const { commitSha: _commitSha, ...scope } = buildScope();
  const created = createContextWorkflowBoardBuild(createEmptyBoardState(), scope);
  const applied = applyContextWorkflowBoardTaskResult(
    created.state,
    created.snapshotTaskId,
    {
      contract: CONTEXT_WORKFLOW_CONTRACT,
      schemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
      outputArtifact: artifact("snapshot", created.buildTaskId),
      commitSha: COMMIT
    },
    NOW
  );
  const planner = applied.state.tasks.find((task) => task.type === contextWorkflowBoardTaskTypes.planner);
  assert.ok(planner);
  return {
    state: applied.state,
    buildTaskId: created.buildTaskId,
    graphTaskId: created.graphTaskId,
    plannerTaskId: planner.id
  };
}

function buildScope() {
  return {
    contextWorkflowContract: CONTEXT_WORKFLOW_CONTRACT,
    contextWorkflowSchemaRevision: CONTEXT_WORKFLOW_SCHEMA_REVISION,
    promptContractVersion: "context-prompts-1",
    validatorVersion: "context-validator-1",
    pageIndexVersion: "pageindex-1",
    executionProfileDigest: "f".repeat(64),
    tenantId: "tenant-1",
    repository: "omxyz/jina",
    ref: "main",
    refSequence: 1,
    requestKey: "push:api-runtime",
    commitSha: COMMIT,
    trigger: "push" as const,
    now: NOW
  };
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
