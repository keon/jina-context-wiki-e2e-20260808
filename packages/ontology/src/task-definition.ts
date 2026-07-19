export const ontologyTaskTypeDefinitions = [
  {
    type: "ontology_build",
    kind: "dispatchable",
    defaultAssigneeRole: "ontology_worker",
    dispatchTopic: "run-ontology",
    description: "Builds a cited repository ontology in a Codex-powered Daytona sandbox."
  }
] as const;
