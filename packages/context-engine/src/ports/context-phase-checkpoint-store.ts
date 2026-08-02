import type { ContextArtifactRef } from "./artifact-store.js";

export interface ContextPhaseCheckpoint {
  readonly tenantId: string;
  readonly repository: string;
  readonly buildId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly checkpointKey: string;
  readonly attempt: number;
  readonly artifact: ContextArtifactRef;
  readonly recordedAt: string;
}

export interface ContextPhaseCheckpointStore {
  read(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly checkpointKey: string;
  }): Promise<ContextPhaseCheckpoint | undefined>;
  record(checkpoint: ContextPhaseCheckpoint): Promise<{
    readonly checkpoint: ContextPhaseCheckpoint;
    readonly created: boolean;
  }>;
  listBuilds(input: {
    readonly tenantId: string;
    readonly buildIds: readonly string[];
  }): Promise<readonly ContextPhaseCheckpoint[]>;
}

export class MemoryContextPhaseCheckpointStore implements ContextPhaseCheckpointStore {
  private readonly checkpoints = new Map<string, ContextPhaseCheckpoint>();

  async read(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly checkpointKey: string;
  }): Promise<ContextPhaseCheckpoint | undefined> {
    return this.checkpoints.get(checkpointIdentity(input));
  }

  async record(checkpoint: ContextPhaseCheckpoint): Promise<{
    readonly checkpoint: ContextPhaseCheckpoint;
    readonly created: boolean;
  }> {
    const key = checkpointIdentity(checkpoint);
    const existing = this.checkpoints.get(key);
    if (existing) return { checkpoint: existing, created: false };
    this.checkpoints.set(key, checkpoint);
    return { checkpoint, created: true };
  }

  async listBuilds(input: {
    readonly tenantId: string;
    readonly buildIds: readonly string[];
  }): Promise<readonly ContextPhaseCheckpoint[]> {
    const buildIds = new Set(input.buildIds);
    return [...this.checkpoints.values()]
      .filter((checkpoint) => checkpoint.tenantId === input.tenantId && buildIds.has(checkpoint.buildId))
      .sort(
        (left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) ||
          left.taskId.localeCompare(right.taskId) ||
          left.phase.localeCompare(right.phase)
      );
  }
}

function checkpointIdentity(input: {
  readonly tenantId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly checkpointKey: string;
}): string {
  return `${input.tenantId}\u001f${input.taskId}\u001f${input.phase}\u001f${input.checkpointKey}`;
}
