export interface ContextRequestDraft {
  readonly targetTaskId: string;
  readonly question: string;
  readonly requestedSources: readonly string[];
}

export function createContextRequest(targetTaskId: string, question: string, requestedSources: readonly string[]): ContextRequestDraft {
  return { targetTaskId, question, requestedSources };
}

