import type { TaskStatus } from "./task-status.js";

export interface RootCompletionInput {
  readonly descendantStatuses: readonly TaskStatus[];
  readonly hasUndispatchedOutbox: boolean;
  readonly requiredGatesPassed: boolean;
}

export function canCompleteRootTask(input: RootCompletionInput): boolean {
  return !input.hasUndispatchedOutbox && input.requiredGatesPassed && input.descendantStatuses.every((status) => status === "done");
}

