export const ADVANCED_GRAPH_NODE_KINDS = ["Symbol", "Engineer", "Team", "Package", "Repository"] as const;

const ADVANCED_GRAPH_NODE_KIND_SET = new Set<string>(ADVANCED_GRAPH_NODE_KINDS);

export function isAdvancedGraphNodeKind(kind: string): boolean {
  return ADVANCED_GRAPH_NODE_KIND_SET.has(kind);
}

export function partitionGraphNodeKinds(kinds: readonly string[]): { primary: string[]; advanced: string[] } {
  const primary: string[] = [];
  const advanced: string[] = [];
  for (const kind of kinds) {
    (isAdvancedGraphNodeKind(kind) ? advanced : primary).push(kind);
  }
  return { primary, advanced };
}

export function defaultEnabledGraphNodeKinds(kinds: readonly string[]): Set<string> {
  return new Set(kinds.filter((kind) => !isAdvancedGraphNodeKind(kind)));
}

export function defaultHiddenGraphNodeKinds(kinds: readonly string[]): Set<string> {
  return new Set(kinds.filter(isAdvancedGraphNodeKind));
}
