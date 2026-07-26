import { contextQueueTopics } from "./topics.js";

export const contextTaskTypes = {
  build: "build-context",
  ingestEvidence: "ingest-evidence",
  deriveKnowledge: "derive-knowledge",
  indexContext: "index-context"
} as const;

export type ContextTaskType = (typeof contextTaskTypes)[keyof typeof contextTaskTypes];

export const contextTaskTypeDefinitions = [
  {
    type: contextTaskTypes.build,
    kind: "aggregate",
    defaultAssigneeRole: "system",
    description: "Coordinates required evidence ingestion, knowledge derivation, and context indexing."
  },
  {
    type: contextTaskTypes.ingestEvidence,
    kind: "dispatchable",
    defaultAssigneeRole: "context_worker",
    dispatchTopic: contextQueueTopics.ingestEvidence,
    description: "Ingests immutable repository and provider evidence."
  },
  {
    type: contextTaskTypes.deriveKnowledge,
    kind: "dispatchable",
    defaultAssigneeRole: "context_worker",
    dispatchTopic: contextQueueTopics.deriveKnowledge,
    description: "Derives immutable, source-cited knowledge document revisions."
  },
  {
    type: contextTaskTypes.indexContext,
    kind: "dispatchable",
    defaultAssigneeRole: "context_worker",
    dispatchTopic: contextQueueTopics.indexContext,
    description: "Publishes exact, lexical, structural, knowledge, and hierarchy context indexes."
  }
] as const;

export const contextTaskTypeDependencies = [
  {
    workflow: contextTaskTypes.build,
    taskType: contextTaskTypes.deriveKnowledge,
    dependsOnTaskType: contextTaskTypes.ingestEvidence,
    relationship: "blocks",
    required: true
  },
  {
    workflow: contextTaskTypes.build,
    taskType: contextTaskTypes.indexContext,
    dependsOnTaskType: contextTaskTypes.ingestEvidence,
    relationship: "blocks",
    required: true
  },
  {
    workflow: contextTaskTypes.build,
    taskType: contextTaskTypes.build,
    dependsOnTaskType: contextTaskTypes.ingestEvidence,
    relationship: "blocks",
    required: true
  },
  {
    workflow: contextTaskTypes.build,
    taskType: contextTaskTypes.build,
    dependsOnTaskType: contextTaskTypes.indexContext,
    relationship: "blocks",
    required: true
  },
  {
    workflow: contextTaskTypes.build,
    taskType: contextTaskTypes.build,
    dependsOnTaskType: contextTaskTypes.deriveKnowledge,
    relationship: "blocks",
    required: true
  }
] as const;

export const contextTaskTypeTriggers = [
  {
    workflow: contextTaskTypes.build,
    source: "POST /context/build",
    taskTypes: Object.values(contextTaskTypes)
  },
  {
    workflow: contextTaskTypes.build,
    source: "repository push",
    taskTypes: Object.values(contextTaskTypes)
  }
] as const;

export function isContextTaskType(value: string): value is ContextTaskType {
  return Object.values(contextTaskTypes).some((type) => type === value);
}
