import assert from "node:assert/strict";
import { test } from "node:test";
import { contextGraphTaskTypeDefinitions, contextGraphTaskTypeDependencies } from "./task-definition.js";

test("agent-first framework preserves the three context graph stage tasks", () => {
  assert.deepEqual(
    contextGraphTaskTypeDefinitions.map((definition) => definition.type),
    ["context_graph_build", "context_graph_ingest", "context_graph_assert", "context_graph_project"]
  );
  assert.deepEqual(
    contextGraphTaskTypeDefinitions
      .filter((definition) => definition.kind === "dispatchable")
      .map((definition) => definition.type),
    ["context_graph_ingest", "context_graph_assert", "context_graph_project"]
  );
  assert.equal(
    contextGraphTaskTypeDefinitions.some((definition) =>
      /planner|investigator|reducer|reviewer|causal_analysis/.test(definition.type)
    ),
    false
  );
});

test("assertion is required and projection is blocked by assertion completion", () => {
  const stageDependencies = contextGraphTaskTypeDependencies.filter(
    (dependency) => dependency.taskType !== "context_graph_build"
  );
  assert.deepEqual(stageDependencies, [
    {
      workflow: "context_graph_build",
      taskType: "context_graph_assert",
      dependsOnTaskType: "context_graph_ingest",
      relationship: "blocks",
      required: true
    },
    {
      workflow: "context_graph_build",
      taskType: "context_graph_project",
      dependsOnTaskType: "context_graph_assert",
      relationship: "blocks",
      required: true
    }
  ]);

  const aggregateDependencies = contextGraphTaskTypeDependencies.filter(
    (dependency) => dependency.taskType === "context_graph_build"
  );
  assert.deepEqual(
    aggregateDependencies.map(({ dependsOnTaskType, required }) => ({ dependsOnTaskType, required })),
    [
      { dependsOnTaskType: "context_graph_ingest", required: true },
      { dependsOnTaskType: "context_graph_assert", required: true },
      { dependsOnTaskType: "context_graph_project", required: true }
    ]
  );
});
