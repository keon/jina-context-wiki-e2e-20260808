export const ontologyTaskTypeDefinitions = [
  {
    type: "ontology_build",
    kind: "aggregate",
    defaultAssigneeRole: "system",
    description: "Coordinates source preparation and generation of a cited repository ontology."
  },
  {
    type: "ontology_prepare",
    kind: "dispatchable",
    defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-prepare",
    description: "Resolves a repository ref to the immutable commit used by an ontology build."
  },
  {
    type: "ontology_generate",
    kind: "dispatchable",
    defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology-generate",
    description: "Generates, validates, and stores one immutable ontology graph."
  }
] as const;
