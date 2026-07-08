export interface AgentRunInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly contextItemIds: readonly string[];
}

export interface AgentRunOutput {
  readonly taskId: string;
  readonly summary: string;
  readonly artifactIds: readonly string[];
}

export interface AgentHarness {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}
