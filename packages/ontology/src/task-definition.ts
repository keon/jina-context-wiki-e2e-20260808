import { entityId, type EntityId } from "@jina/shared-kernel";

const ontologyTaskSpecs = [
  {
    type: "ontology_build", kind: "aggregate", defaultAssigneeRole: "system", keySuffix: "root",
    description: "Coordinates raw-data aggregation, semantic assertion derivation, and graph projection."
  },
  {
    type: "ontology_ingest", kind: "dispatchable", defaultAssigneeRole: "ontology_worker", keySuffix: "ingest",
    dispatchTopic: "run-ontology-ingest",
    description: "Aggregates an immutable repository snapshot and reuses versioned, content-addressed structural facts."
  },
  {
    type: "ontology_assert", kind: "dispatchable", defaultAssigneeRole: "ontology_worker", keySuffix: "assert",
    dispatchTopic: "run-ontology-assert", dependsOn: "ontology_ingest",
    description: "Records cited model output and applies registry-validated semantic assertions with provenance."
  },
  {
    type: "ontology_project", kind: "dispatchable", defaultAssigneeRole: "ontology_worker", keySuffix: "project",
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

export type PlannedOntologyTaskId = EntityId<"task">;

export interface PlannedOntologyTask {
  readonly id: PlannedOntologyTaskId;
  readonly type: typeof ontologyTaskSpecs[number]["type"];
  readonly kind: "aggregate" | "dispatchable";
  readonly title: string;
  readonly assigneeRole: string;
  readonly dedupeKey: string;
  readonly dispatchTopic?: string;
  readonly parentTaskId?: PlannedOntologyTaskId;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OntologyBuildPlan {
  readonly rootTaskId: PlannedOntologyTaskId;
  readonly tasks: readonly PlannedOntologyTask[];
  readonly dependencies: readonly {
    readonly taskId: PlannedOntologyTaskId;
    readonly dependsOnTaskId: PlannedOntologyTaskId;
    readonly relationship: "blocks";
    readonly required: true;
    readonly blocksParentCompletion: boolean;
  }[];
}

export function planOntologyBuild(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
}): OntologyBuildPlan {
  const prefix = `task_ontology:${input.tenantId}:${input.repository}:${input.ref}:${input.requestKey}`;
  const ids = {
    ontology_build: entityId<"task">(`${prefix}:root`),
    ontology_ingest: entityId<"task">(`${prefix}:ingest`),
    ontology_assert: entityId<"task">(`${prefix}:assert`),
    ontology_project: entityId<"task">(`${prefix}:project`)
  };
  const titles = {
    ontology_build: `Build Ontology for ${input.repository}@${input.ref}`,
    ontology_ingest: `Aggregate raw repository data for ${input.repository}@${input.ref}`,
    ontology_assert: `Derive assertions for ${input.repository}@${input.ref}`,
    ontology_project: `Project Ontology for ${input.repository}@${input.ref}`
  };
  const metadata = { tenantId: input.tenantId, repository: input.repository, ref: input.ref, requestKey: input.requestKey };
  return {
    rootTaskId: ids.ontology_build,
    tasks: ontologyTaskSpecs.map((spec) => ({
      id: ids[spec.type], type: spec.type, kind: spec.kind, title: titles[spec.type],
      assigneeRole: spec.defaultAssigneeRole,
      dedupeKey: `ontology:${input.tenantId}:${input.repository}:${input.ref}:${input.requestKey}:${spec.keySuffix}`,
      ...("dispatchTopic" in spec ? { dispatchTopic: spec.dispatchTopic } : {}),
      ...(spec.type === "ontology_build" ? {} : { parentTaskId: ids.ontology_build }),
      metadata
    })),
    dependencies: ontologyTaskSpecs.flatMap((spec) => "dependsOn" in spec ? [{
      taskId: ids[spec.type], dependsOnTaskId: ids[spec.dependsOn], relationship: "blocks" as const,
      required: true as const, blocksParentCompletion: spec.type !== "ontology_assert"
    }] : [])
  };
}
