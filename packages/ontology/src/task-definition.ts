const ontologyTaskSpecs = [
  {
    type: "ontology_build", kind: "aggregate", defaultAssigneeRole: "system",
    description: "Coordinates raw-data aggregation, semantic assertion derivation, and graph projection."
  },
  {
    type: "ontology_ingest", kind: "dispatchable", defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-ingest",
    description: "Aggregates an immutable repository snapshot and reuses versioned, content-addressed structural facts."
  },
  {
    type: "ontology_assert", kind: "dispatchable", defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-assert", dependsOn: "ontology_ingest",
    description: "Records cited model output and applies registry-validated semantic assertions with provenance."
  },
  {
    type: "ontology_project", kind: "dispatchable", defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-project", dependsOn: "ontology_ingest",
    description: "Builds a disposable dashboard graph from canonical code facts and available assertions."
  }
] as const;

export const ontologyTaskTypeDefinitions = ontologyTaskSpecs.map(({ type, kind, defaultAssigneeRole, description, ...spec }) => ({
  type, kind, defaultAssigneeRole, description,
  ...("dispatchTopic" in spec ? { dispatchTopic: spec.dispatchTopic } : {})
}));

/** Intake events that create workflow tasks; these are not board task-to-task dependencies. */
export const ontologyTaskTypeTriggers = [
  {
    workflow: "ontology_build",
    taskType: "ontology_build",
    source: "POST /ontology/build",
    description: "Creates the aggregate workflow parent for the requested repository and ref."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_ingest",
    source: "POST /ontology/build",
    description: "Creates and queues the first executable Ontology task."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_assert",
    source: "POST /ontology/build",
    description: "Creates the assertion task in a waiting state; ontology_ingest completion unblocks it."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_project",
    source: "POST /ontology/build",
    description: "Creates the projection task in a waiting state; ontology_ingest completion unblocks it independently of model assertions."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_build",
    source: "GitHub push webhook",
    description: "Creates the aggregate workflow parent for a pushed branch head."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_ingest",
    source: "GitHub push webhook",
    description: "Queues repository intake for a pushed branch head."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_assert",
    source: "GitHub push webhook",
    description: "Creates the assertion stage for a pushed branch head."
  },
  {
    workflow: "ontology_build",
    taskType: "ontology_project",
    source: "GitHub push webhook",
    description: "Creates the projection stage for a pushed branch head."
  }
] as const;

export const ontologyTaskTypeDependencies = [
  ...ontologyTaskSpecs.slice(1).map((spec) => ({
    workflow: "ontology_build",
    taskType: "ontology_build",
    dependsOnTaskType: spec.type,
    relationship: "blocks",
    required: spec.type !== "ontology_assert"
  })),
  ...ontologyTaskSpecs.flatMap((spec) => "dependsOn" in spec ? [{
    workflow: "ontology_build",
    taskType: spec.type,
    dependsOnTaskType: spec.dependsOn,
    relationship: "blocks",
    required: true
  }] : [])
];

