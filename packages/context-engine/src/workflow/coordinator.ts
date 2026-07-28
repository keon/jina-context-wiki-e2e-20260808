import type { DerivationDetail } from "../derive/verbosity.js";
import { isFullCommitSha, newId, normalizeIsoTime, normalizeRepository, stableId } from "../domain/fingerprint.js";
import type { ContextQueueTopic } from "./topics.js";
import { contextQueueTopics } from "./topics.js";
import type { ContextTaskType } from "./task-definition.js";
import { contextTaskTypes } from "./task-definition.js";

export interface ContextWriteFence {
  buildId: string;
  stageId: string;
  attempt: number;
  leaseId: string;
  leaseExpiresAt: string;
  token: string;
}

export type ContextStageStatus = "blocked" | "queued" | "leased" | "succeeded" | "failed";

export interface ContextPipelineStage {
  id: string;
  buildId: string;
  type: Exclude<ContextTaskType, "build-context">;
  topic: ContextQueueTopic;
  required: boolean;
  status: ContextStageStatus;
  attempt: number;
  metadata: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  fence?: ContextWriteFence;
}

export interface ContextBuild {
  id: string;
  tenantId: string;
  repository: string;
  ref: string;
  refSequence: number;
  requestKey: string;
  status: "active" | "succeeded" | "degraded" | "failed";
  stages: ContextPipelineStage[];
  createdAt: string;
  completedAt?: string;
}

export interface ContextPipelineCoordinator {
  createBuild(input: {
    tenantId: string;
    repository: string;
    ref: string;
    commitSha?: string;
    githubInstallationId?: number;
    requestKey: string;
    createdAt: string;
    /** How much the deriving agent should write; carried to the derive stage. */
    derivationDetail?: DerivationDetail;
    /** Wall clock the derive stage may use; carried the same way. */
    derivationBudgetSeconds?: number;
  }): Promise<ContextBuild>;
  claim(input: {
    tenantId?: string;
    tenantIds?: string[];
    workerId: string;
    topics: ContextQueueTopic[];
    now: string;
    leaseExpiresAt: string;
  }): Promise<{ build: ContextBuild; stage: ContextPipelineStage; fence: ContextWriteFence } | undefined>;
  release(input: { tenantId: string; stageId: string; leaseId: string; now: string; reason: string }): Promise<boolean>;
  renew(input: {
    tenantId: string;
    stageId: string;
    leaseId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ContextWriteFence | undefined>;
  complete(input: {
    tenantId: string;
    stageId: string;
    fence: ContextWriteFence;
    outcome: "succeeded" | "failed";
    now: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }): Promise<boolean>;
  validateWriteFence(input: { tenantId: string; fence: ContextWriteFence; now: string }): Promise<boolean>;
  latestRefSequence(tenantId: string, repository: string, ref: string): Promise<number>;
  get(buildId: string): Promise<ContextBuild | undefined>;
  list(tenantId: string): Promise<ContextBuild[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function topicFor(type: ContextPipelineStage["type"]): ContextQueueTopic {
  if (type === contextTaskTypes.ingestEvidence) return contextQueueTopics.ingestEvidence;
  if (type === contextTaskTypes.deriveKnowledge) return contextQueueTopics.deriveKnowledge;
  return contextQueueTopics.indexContext;
}

export class MemoryContextPipelineCoordinator implements ContextPipelineCoordinator {
  readonly #builds = new Map<string, ContextBuild>();
  readonly #requests = new Map<string, string>();

  async createBuild(input: {
    tenantId: string;
    repository: string;
    ref: string;
    commitSha?: string;
    derivationDetail?: DerivationDetail;
    derivationBudgetSeconds?: number;
    githubInstallationId?: number;
    requestKey: string;
    createdAt: string;
  }): Promise<ContextBuild> {
    const requestScope = `${input.tenantId}\u0000${input.requestKey}`;
    const existingId = this.#requests.get(requestScope);
    if (existingId !== undefined) return copy(this.#builds.get(existingId)!);
    if (input.commitSha !== undefined && !isFullCommitSha(input.commitSha)) {
      throw new Error("commitSha must be a full Git SHA");
    }
    if (
      input.githubInstallationId !== undefined &&
      (!Number.isSafeInteger(input.githubInstallationId) || input.githubInstallationId <= 0)
    ) {
      throw new Error("githubInstallationId must be a positive integer");
    }
    const createdAt = normalizeIsoTime(input.createdAt);
    const repository = normalizeRepository(input.repository);
    const refSequence =
      Math.max(
        0,
        ...[...this.#builds.values()]
          .filter(
            (build) => build.tenantId === input.tenantId && build.repository === repository && build.ref === input.ref
          )
          .map((build) => build.refSequence)
      ) + 1;
    const id = stableId("cb", { tenantId: input.tenantId, requestKey: input.requestKey });
    const stage = (type: ContextPipelineStage["type"], required: boolean, status: ContextStageStatus) => ({
      id: stableId("cs", { buildId: id, type }),
      buildId: id,
      type,
      topic: topicFor(type),
      required,
      status,
      attempt: 0,
      metadata:
        type === contextTaskTypes.ingestEvidence
          ? {
              ...(input.commitSha ? { commitSha: input.commitSha.toLowerCase() } : {}),
              ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
              refSequence
            }
          : // The derive stage is claimed long after the build was requested, so
            // the choice has to travel with it rather than being read from the
            // environment at execution time.
            type === contextTaskTypes.deriveKnowledge && (input.derivationDetail || input.derivationBudgetSeconds)
            ? {
                ...(input.derivationDetail ? { derivationDetail: input.derivationDetail } : {}),
                ...(input.derivationBudgetSeconds ? { derivationBudgetSeconds: input.derivationBudgetSeconds } : {})
              }
            : {}
    });
    const build: ContextBuild = {
      id,
      tenantId: input.tenantId,
      repository,
      ref: input.ref,
      refSequence,
      requestKey: input.requestKey,
      status: "active",
      stages: [
        stage(contextTaskTypes.ingestEvidence, true, "queued"),
        stage(contextTaskTypes.deriveKnowledge, true, "blocked"),
        stage(contextTaskTypes.indexContext, true, "blocked")
      ],
      createdAt
    };
    this.#builds.set(id, build);
    this.#requests.set(requestScope, id);
    return copy(build);
  }

  async claim(input: {
    tenantId?: string;
    tenantIds?: string[];
    workerId: string;
    topics: ContextQueueTopic[];
    now: string;
    leaseExpiresAt: string;
  }): Promise<{ build: ContextBuild; stage: ContextPipelineStage; fence: ContextWriteFence } | undefined> {
    const now = normalizeIsoTime(input.now);
    const leaseExpiresAt = normalizeIsoTime(input.leaseExpiresAt);
    if (leaseExpiresAt <= now) throw new Error("Lease expiry must be in the future");
    const allowedTenants = new Set([
      ...(input.tenantId === undefined ? [] : [input.tenantId]),
      ...(input.tenantIds ?? [])
    ]);
    if (allowedTenants.size === 0) throw new Error("At least one tenant is required to claim work");
    for (const build of [...this.#builds.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    )) {
      if (!allowedTenants.has(build.tenantId) || build.status !== "active") continue;
      // Publish the evidence-only baseline before model derivation so queries
      // remain available while the required derivation stage is running.
      for (const stage of [...build.stages].sort(
        (left, right) => claimPriority(left.type) - claimPriority(right.type)
      )) {
        const expired = stage.status === "leased" && stage.fence !== undefined && stage.fence.leaseExpiresAt <= now;
        if (!input.topics.includes(stage.topic) || (stage.status !== "queued" && !expired)) continue;
        stage.status = "leased";
        stage.attempt += 1;
        stage.startedAt ??= now;
        const fence: ContextWriteFence = {
          buildId: build.id,
          stageId: stage.id,
          attempt: stage.attempt,
          leaseId: newId("lease"),
          leaseExpiresAt,
          token: newId("fence")
        };
        stage.fence = fence;
        stage.metadata = { ...stage.metadata, workerId: input.workerId };
        return { build: copy(build), stage: copy(stage), fence: copy(fence) };
      }
    }
    return undefined;
  }

  async release(input: {
    tenantId: string;
    stageId: string;
    leaseId: string;
    now: string;
    reason: string;
  }): Promise<boolean> {
    const located = this.#findStage(input.tenantId, input.stageId);
    normalizeIsoTime(input.now);
    if (located === undefined || located.stage.status !== "leased" || located.stage.fence?.leaseId !== input.leaseId) {
      return false;
    }
    located.stage.status = "queued";
    located.stage.metadata = { ...located.stage.metadata, releaseReason: input.reason };
    delete located.stage.fence;
    return true;
  }

  async renew(input: {
    tenantId: string;
    stageId: string;
    leaseId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ContextWriteFence | undefined> {
    const located = this.#findStage(input.tenantId, input.stageId);
    const now = normalizeIsoTime(input.now);
    const expires = normalizeIsoTime(input.leaseExpiresAt);
    if (
      located === undefined ||
      located.stage.status !== "leased" ||
      located.stage.fence?.leaseId !== input.leaseId ||
      located.stage.fence.leaseExpiresAt <= now ||
      expires <= now
    ) {
      return undefined;
    }
    located.stage.fence.leaseExpiresAt = expires;
    return copy(located.stage.fence);
  }

  async complete(input: {
    tenantId: string;
    stageId: string;
    fence: ContextWriteFence;
    outcome: "succeeded" | "failed";
    now: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }): Promise<boolean> {
    const located = this.#findStage(input.tenantId, input.stageId);
    const now = normalizeIsoTime(input.now);
    if (
      located === undefined ||
      !(await this.validateWriteFence({ tenantId: input.tenantId, fence: input.fence, now }))
    ) {
      return false;
    }
    const { build, stage } = located;
    stage.status = input.outcome;
    stage.completedAt = now;
    if (input.error === undefined) delete stage.error;
    else stage.error = input.error;
    stage.metadata = { ...stage.metadata, ...input.metadata };
    delete stage.fence;
    if (stage.type === contextTaskTypes.ingestEvidence && input.outcome === "succeeded") {
      const baseline = build.stages.find((candidate) => candidate.type === contextTaskTypes.indexContext);
      if (baseline?.status === "blocked") {
        baseline.status = "queued";
        baseline.metadata = { ...baseline.metadata, ...stage.metadata };
      }
    }
    if (stage.type === contextTaskTypes.indexContext && input.outcome === "succeeded") {
      const derivation = build.stages.find((candidate) => candidate.type === contextTaskTypes.deriveKnowledge);
      if (derivation?.status === "blocked") {
        derivation.status = "queued";
        derivation.metadata = { ...derivation.metadata, ...stage.metadata };
      }
    }
    this.#updateBuildStatus(build, now);
    return true;
  }

  async validateWriteFence(input: { tenantId: string; fence: ContextWriteFence; now: string }): Promise<boolean> {
    const located = this.#findStage(input.tenantId, input.fence.stageId);
    const active = located?.stage.fence;
    return (
      located !== undefined &&
      located.build.id === input.fence.buildId &&
      located.stage.status === "leased" &&
      active !== undefined &&
      active.leaseId === input.fence.leaseId &&
      active.token === input.fence.token &&
      active.attempt === input.fence.attempt &&
      active.leaseExpiresAt > normalizeIsoTime(input.now)
    );
  }

  async latestRefSequence(tenantId: string, repository: string, ref: string): Promise<number> {
    return Math.max(
      0,
      ...[...this.#builds.values()]
        .filter(
          (build) =>
            build.tenantId === tenantId && build.repository === normalizeRepository(repository) && build.ref === ref
        )
        .map((build) => build.refSequence)
    );
  }

  async get(buildId: string): Promise<ContextBuild | undefined> {
    const value = this.#builds.get(buildId);
    return value === undefined ? undefined : copy(value);
  }

  async list(tenantId: string): Promise<ContextBuild[]> {
    return [...this.#builds.values()]
      .filter((build) => build.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copy);
  }

  #findStage(tenantId: string, stageId: string): { build: ContextBuild; stage: ContextPipelineStage } | undefined {
    for (const build of this.#builds.values()) {
      if (build.tenantId !== tenantId) continue;
      const stage = build.stages.find((candidate) => candidate.id === stageId);
      if (stage !== undefined) return { build, stage };
    }
    return undefined;
  }

  #updateBuildStatus(build: ContextBuild, now: string): void {
    const required = build.stages.filter((stage) => stage.required);
    if (required.some((stage) => stage.status === "failed")) {
      build.status = "failed";
      build.completedAt = now;
      return;
    }
    if (!required.every((stage) => stage.status === "succeeded")) return;
    const optional = build.stages.filter((stage) => !stage.required);
    if (!optional.every((stage) => stage.status === "succeeded" || stage.status === "failed")) return;
    build.status = optional.some((stage) => stage.status === "failed") ? "degraded" : "succeeded";
    build.completedAt = now;
  }
}

function claimPriority(type: ContextPipelineStage["type"]): number {
  if (type === contextTaskTypes.ingestEvidence) return 0;
  if (type === contextTaskTypes.indexContext) return 1;
  return 2;
}
