export interface CleanupTaskInput {
  readonly workspaceId: string;
}

export function runCleanupTask(input: CleanupTaskInput): CleanupTaskInput {
  return input;
}
