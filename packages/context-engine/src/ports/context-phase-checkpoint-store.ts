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

export interface ContextPhaseOperationLease {
  readonly tenantId: string;
  readonly repository: string;
  readonly buildId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly operationKey: string;
  readonly inputDigest: string;
  readonly ownerToken: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
}

export interface ContextPhaseOperationClaimInput {
  readonly tenantId: string;
  readonly repository: string;
  readonly buildId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly operationKey: string;
  readonly inputDigest: string;
  readonly ownerToken: string;
  readonly now: string;
  readonly leaseDurationMs: number;
}

export type ContextPhaseOperationClaim =
  | { readonly outcome: "acquired"; readonly lease: ContextPhaseOperationLease }
  | { readonly outcome: "held"; readonly lease: ContextPhaseOperationLease }
  | { readonly outcome: "conflict"; readonly lease: ContextPhaseOperationLease };

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
  claimOperation(input: ContextPhaseOperationClaimInput): Promise<ContextPhaseOperationClaim>;
  renewOperation(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly operationKey: string;
    readonly ownerToken: string;
    readonly now: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean>;
  releaseOperation(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly operationKey: string;
    readonly ownerToken: string;
  }): Promise<boolean>;
  listBuilds(input: {
    readonly tenantId: string;
    readonly buildIds: readonly string[];
  }): Promise<readonly ContextPhaseCheckpoint[]>;
}

export class MemoryContextPhaseCheckpointStore implements ContextPhaseCheckpointStore {
  private readonly checkpoints = new Map<string, ContextPhaseCheckpoint>();
  private readonly operationLeases = new Map<string, ContextPhaseOperationLease>();

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

  async claimOperation(input: ContextPhaseOperationClaimInput): Promise<ContextPhaseOperationClaim> {
    const key = operationIdentity(input);
    const existing = this.operationLeases.get(key);
    if (existing && existing.inputDigest !== input.inputDigest) {
      return { outcome: "conflict", lease: existing };
    }
    if (existing && !existing.releasedAt && Date.parse(existing.expiresAt) > Date.parse(input.now)) {
      return {
        outcome: "held",
        lease: existing
      };
    }
    const lease: ContextPhaseOperationLease = {
      tenantId: input.tenantId,
      repository: input.repository,
      buildId: input.buildId,
      taskId: input.taskId,
      phase: input.phase,
      operationKey: input.operationKey,
      inputDigest: input.inputDigest,
      ownerToken: input.ownerToken,
      claimedAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString()
    };
    this.operationLeases.set(key, lease);
    return { outcome: "acquired", lease };
  }

  async renewOperation(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly operationKey: string;
    readonly ownerToken: string;
    readonly now: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean> {
    const key = operationIdentity(input);
    const existing = this.operationLeases.get(key);
    if (!existing || existing.ownerToken !== input.ownerToken) return false;
    if (existing.releasedAt) return false;
    this.operationLeases.set(key, {
      ...existing,
      expiresAt: new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString()
    });
    return true;
  }

  async releaseOperation(input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly phase: string;
    readonly operationKey: string;
    readonly ownerToken: string;
  }): Promise<boolean> {
    const key = operationIdentity(input);
    const existing = this.operationLeases.get(key);
    if (!existing || existing.ownerToken !== input.ownerToken) return false;
    this.operationLeases.set(key, { ...existing, releasedAt: new Date().toISOString() });
    return true;
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

function operationIdentity(input: {
  readonly tenantId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly operationKey: string;
}): string {
  return `${input.tenantId}\u001f${input.taskId}\u001f${input.phase}\u001f${input.operationKey}`;
}
