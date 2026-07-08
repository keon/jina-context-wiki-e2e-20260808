export interface SourceCitation {
  readonly sourceUri: string;
  readonly label: string;
}

export function formatCitation(citation: SourceCitation): string {
  return `${citation.label}: ${citation.sourceUri}`;
}

