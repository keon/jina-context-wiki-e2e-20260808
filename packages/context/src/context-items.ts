export interface ContextItemDraft {
  readonly sourceUri?: string;
  readonly summary: string;
  readonly citations: readonly string[];
}

export function hasCitations(item: ContextItemDraft): boolean {
  return item.citations.length > 0;
}

