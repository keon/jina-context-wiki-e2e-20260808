const contextGraphTaskSpecs = [
  {
    type: "context_graph_build",
    kind: "aggregate",
    defaultAssigneeRole: "system",
    description: "Coordinates raw-data aggregation, semantic assertion derivation, and graph projection."
  },
  {
    type: "context_graph_ingest",
    kind: "dispatchable",
    defaultAssigneeRole: "context_graph_worker",
    dispatchTopic: "run-context-graph-ingest",
    description: "Aggregates an immutable repository snapshot and reuses versioned, content-addressed structural facts."
  },
  {
    type: "context_graph_assert",
    kind: "dispatchable",
    defaultAssigneeRole: "context_graph_worker",
    dispatchTopic: "run-context-graph-assert",
    dependsOn: "context_graph_ingest",
    description: "Records cited model output and applies registry-validated semantic assertions with provenance."
  },
  {
    type: "context_graph_project",
    kind: "dispatchable",
    defaultAssigneeRole: "context_graph_worker",
    dispatchTopic: "run-context-graph-project",
    dependsOn: "context_graph_assert",
    description: "Builds a disposable dashboard graph after same-commit semantic assertions complete successfully."
  }
] as const;

export const contextGraphTaskTypeDefinitions = contextGraphTaskSpecs.map(
  ({ type, kind, defaultAssigneeRole, description, ...spec }) => ({
    type,
    kind,
    defaultAssigneeRole,
    description,
    ...("dispatchTopic" in spec ? { dispatchTopic: spec.dispatchTopic } : {})
  })
);

/** Intake events that create workflow tasks; these are not board task-to-task dependencies. */
export const contextGraphTaskTypeTriggers = [
  {
    workflow: "context_graph_build",
    taskType: "context_graph_build",
    source: "POST /context-graph/build",
    description: "Creates the aggregate workflow parent for the requested repository and ref."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_ingest",
    source: "POST /context-graph/build",
    description: "Creates and queues the first executable context graph task."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_assert",
    source: "POST /context-graph/build",
    description: "Creates the assertion task in a waiting state; context_graph_ingest completion unblocks it."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_project",
    source: "POST /context-graph/build",
    description: "Creates the projection task in a waiting state; context_graph_assert completion unblocks it."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_build",
    source: "GitHub push webhook",
    description: "Creates the aggregate workflow parent for a pushed branch head."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_ingest",
    source: "GitHub push webhook",
    description: "Queues repository intake for a pushed branch head."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_assert",
    source: "GitHub push webhook",
    description: "Creates the assertion stage for a pushed branch head."
  },
  {
    workflow: "context_graph_build",
    taskType: "context_graph_project",
    source: "GitHub push webhook",
    description: "Creates the projection stage for a pushed branch head."
  }
] as const;

export const contextGraphTaskTypeDependencies = [
  ...contextGraphTaskSpecs.slice(1).map((spec) => ({
    workflow: "context_graph_build",
    taskType: "context_graph_build",
    dependsOnTaskType: spec.type,
    relationship: "blocks",
    required: true
  })),
  ...contextGraphTaskSpecs.flatMap((spec) =>
    "dependsOn" in spec
      ? [
          {
            workflow: "context_graph_build",
            taskType: spec.type,
            dependsOnTaskType: spec.dependsOn,
            relationship: "blocks",
            required: true
          }
        ]
      : []
  )
];
