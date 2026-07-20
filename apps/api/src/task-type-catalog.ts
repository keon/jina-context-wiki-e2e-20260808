import type { TaskTypeDefinition } from "@jina/board";

export interface TaskTypeDependencyRule {
  readonly workflow: string;
  readonly taskType: string;
  readonly dependsOnTaskType: string;
  readonly relationship: string;
  readonly required: boolean;
  readonly condition?: string;
}

export interface TaskTypeTriggerRule {
  readonly workflow: string;
  readonly taskType: string;
  readonly source: string;
  readonly description: string;
  readonly condition?: string;
}

export interface TaskTypeDependencySummary {
  readonly taskType: string;
  readonly relationships: readonly string[];
  readonly workflows: readonly string[];
  readonly required: boolean;
  readonly conditions: readonly string[];
}

export interface TaskTypeTriggerSummary {
  readonly source: string;
  readonly description: string;
  readonly workflows: readonly string[];
  readonly conditions: readonly string[];
}

export interface TaskTypeCatalogEntry extends TaskTypeDefinition {
  readonly triggeredBy: readonly TaskTypeTriggerSummary[];
  readonly dependsOn: readonly TaskTypeDependencySummary[];
  readonly requiredBy: readonly TaskTypeDependencySummary[];
}

export function buildTaskTypeCatalog(
  definitions: readonly TaskTypeDefinition[],
  rules: readonly TaskTypeDependencyRule[],
  triggers: readonly TaskTypeTriggerRule[] = []
): readonly TaskTypeCatalogEntry[] {
  const registeredTypes = new Set(definitions.map((definition) => definition.type));
  for (const rule of rules) {
    if (!registeredTypes.has(rule.taskType) || !registeredTypes.has(rule.dependsOnTaskType)) {
      throw new Error(`task-type dependency references an unregistered type: ${rule.taskType} -> ${rule.dependsOnTaskType}`);
    }
  }
  for (const trigger of triggers) {
    if (!registeredTypes.has(trigger.taskType)) {
      throw new Error(`task-type trigger references an unregistered type: ${trigger.source} -> ${trigger.taskType}`);
    }
  }

  return definitions.map((definition) => ({
    ...definition,
    triggeredBy: triggers.filter((trigger) => trigger.taskType === definition.type).map((trigger) => ({
      source: trigger.source,
      description: trigger.description,
      workflows: [trigger.workflow],
      conditions: trigger.condition ? [trigger.condition] : []
    })),
    dependsOn: summarizeRules(
      rules.filter((rule) => rule.taskType === definition.type),
      (rule) => rule.dependsOnTaskType
    ),
    requiredBy: summarizeRules(
      rules.filter((rule) => rule.dependsOnTaskType === definition.type),
      (rule) => rule.taskType
    )
  }));
}

function summarizeRules(
  rules: readonly TaskTypeDependencyRule[],
  relatedTaskType: (rule: TaskTypeDependencyRule) => string
): readonly TaskTypeDependencySummary[] {
  const summaries = new Map<string, {
    relationships: Set<string>;
    workflows: Set<string>;
    required: boolean;
    conditions: Set<string>;
  }>();

  for (const rule of rules) {
    const taskType = relatedTaskType(rule);
    const summary = summaries.get(taskType) ?? {
      relationships: new Set<string>(),
      workflows: new Set<string>(),
      required: true,
      conditions: new Set<string>()
    };
    summary.relationships.add(rule.relationship);
    summary.workflows.add(rule.workflow);
    summary.required = summary.required && rule.required;
    if (rule.condition) summary.conditions.add(rule.condition);
    summaries.set(taskType, summary);
  }

  return [...summaries].map(([taskType, summary]) => ({
    taskType,
    relationships: [...summary.relationships],
    workflows: [...summary.workflows],
    required: summary.required,
    conditions: [...summary.conditions]
  }));
}
