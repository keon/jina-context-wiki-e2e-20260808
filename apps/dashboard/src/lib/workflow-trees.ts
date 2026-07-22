import type { TaskTypeDefinition, TaskTypeDependency } from "./types.ts";

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly relationships: readonly string[];
  readonly required: boolean;
  readonly conditions: readonly string[];
}

export interface WorkflowTreeNode {
  readonly type: string;
  readonly definition: TaskTypeDefinition;
  readonly incoming: readonly WorkflowEdge[];
  readonly collapsedDependencies: readonly WorkflowEdge[];
  readonly cycle: boolean;
  readonly children: readonly { readonly edge: WorkflowEdge; readonly node: WorkflowTreeNode }[];
}

export interface WorkflowTree {
  readonly name: string;
  readonly typeCount: number;
  readonly edgeCount: number;
  readonly roots: readonly WorkflowTreeNode[];
}

/**
 * Groups declared task-type dependencies into per-workflow trees, collapsing
 * transitively implied edges and guarding against cycles — a direct port of
 * the previous dashboard's rendering logic.
 */
export function buildWorkflowTrees(definitions: readonly TaskTypeDefinition[]): readonly WorkflowTree[] {
  const byType = new Map(definitions.map((definition, index) => [definition.type, { definition, index }]));
  const workflowNames = new Set<string>();
  for (const definition of definitions) {
    for (const dependency of definition.dependsOn ?? []) {
      for (const workflow of dependency.workflows ?? []) workflowNames.add(workflow);
    }
  }
  const order = (type: string) => byType.get(type)?.index ?? Number.MAX_SAFE_INTEGER;
  return Array.from(workflowNames)
    .sort((left, right) => order(left) - order(right) || left.localeCompare(right))
    .map((workflow) => {
      const nodeTypes = new Set<string>();
      const edges: WorkflowEdge[] = [];
      for (const definition of definitions) {
        for (const dependency of definition.dependsOn ?? []) {
          if (!(dependency.workflows ?? []).includes(workflow)) continue;
          nodeTypes.add(dependency.taskType);
          nodeTypes.add(definition.type);
          edges.push({
            from: dependency.taskType,
            to: definition.type,
            relationships: dependency.relationships ?? [],
            required: dependency.required !== false,
            conditions: dependency.conditions ?? []
          });
        }
      }
      const reducedEdges: WorkflowEdge[] = [];
      const collapsedEdges: WorkflowEdge[] = [];
      edges.forEach((edge, index) => {
        (hasDependencyPath(edge.from, edge.to, edges, index) ? collapsedEdges : reducedEdges).push(edge);
      });
      const incoming = new Map<string, WorkflowEdge[]>(Array.from(nodeTypes, (type) => [type, []]));
      const outgoing = new Map<string, WorkflowEdge[]>(Array.from(nodeTypes, (type) => [type, []]));
      for (const edge of reducedEdges) {
        incoming.get(edge.to)?.push(edge);
        outgoing.get(edge.from)?.push(edge);
      }
      for (const values of outgoing.values()) {
        values.sort((left, right) => order(left.to) - order(right.to) || left.to.localeCompare(right.to));
      }
      const rootTypes = Array.from(nodeTypes)
        .filter((type) => (incoming.get(type) ?? []).length === 0)
        .sort((left, right) => order(left) - order(right) || left.localeCompare(right));
      return {
        name: workflow,
        typeCount: nodeTypes.size,
        edgeCount: edges.length,
        roots: rootTypes.map((type) => workflowTreeNode(type, byType, incoming, outgoing, collapsedEdges, new Set()))
      };
    });
}

export function hasDependencyPath(
  from: string,
  target: string,
  edges: readonly WorkflowEdge[],
  skippedIndex: number
): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.shift();
    if (current === target) return true;
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    edges.forEach((edge, index) => {
      if (index !== skippedIndex && edge.from === current && !visited.has(edge.to)) pending.push(edge.to);
    });
  }
  return false;
}

function workflowTreeNode(
  type: string,
  byType: ReadonlyMap<string, { readonly definition: TaskTypeDefinition; readonly index: number }>,
  incoming: ReadonlyMap<string, readonly WorkflowEdge[]>,
  outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>,
  collapsedEdges: readonly WorkflowEdge[],
  ancestors: ReadonlySet<string>
): WorkflowTreeNode {
  const nextAncestors = new Set(ancestors);
  const cycle = nextAncestors.has(type);
  nextAncestors.add(type);
  const entry = byType.get(type);
  return {
    type,
    definition: entry?.definition ?? { type, kind: "dispatchable", description: "Unregistered task type" },
    incoming: incoming.get(type) ?? [],
    collapsedDependencies: collapsedEdges.filter((edge) => edge.to === type),
    cycle,
    children: cycle
      ? []
      : (outgoing.get(type) ?? []).map((edge) => ({
          edge,
          node: workflowTreeNode(edge.to, byType, incoming, outgoing, collapsedEdges, nextAncestors)
        }))
  };
}

export function workflowSteps(definition: TaskTypeDefinition): readonly string[] {
  const humanizeType = (dependency: TaskTypeDependency) =>
    dependency.taskType.replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  return [
    ...(definition.dependsOn ?? []).map((dependency) => `Wait for ${humanizeType(dependency)}`),
    definition.description || definition.type,
    ...(definition.requiredBy ?? []).map((dependent) => `Unlock ${humanizeType(dependent)}`)
  ];
}

export function taskTypeIcon(type: string): string {
  if (/review/i.test(type)) return "⑂";
  if (/context-graph|graph/i.test(type)) return "⌘";
  if (/issue|investig/i.test(type)) return "⌕";
  if (/document/i.test(type)) return "▤";
  if (/publish|release/i.test(type)) return "◇";
  return "△";
}
