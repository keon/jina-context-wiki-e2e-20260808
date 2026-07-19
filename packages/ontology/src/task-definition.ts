export const ontologyTaskTypeDefinitions = [
  {
    type: "ontology_build",
    kind: "aggregate",
    defaultAssigneeRole: "system",
    description: "Coordinates raw-data aggregation, semantic assertion derivation, and graph projection."
  },
  {
    type: "ontology_ingest",
    kind: "dispatchable",
    defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-ingest",
    description: "Aggregates an immutable repository snapshot and reuses versioned, content-addressed structural facts."
  },
  {
    type: "ontology_assert",
    kind: "dispatchable",
    defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-assert",
    description: "Records cited model output and applies registry-validated semantic assertions with provenance."
  },
  {
    type: "ontology_project",
    kind: "dispatchable",
    defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-project",
    description: "Builds a disposable dashboard graph from canonical code facts and active assertions."
  }
] as const;
