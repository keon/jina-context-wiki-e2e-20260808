import { randomUUID } from "node:crypto";
import { stableId } from "./model.js";

export type ContextGraphWorkerTopic =
  "run-context-graph-ingest" | "run-context-graph-assert" | "run-context-graph-project";
export type ContextGraphStageStatus =
  "triage" | "queued" | "in_progress" | "done" | "failed" | "canceled" | "superseded";
export type ContextGraphBuildStatus = "queued" | "in_progress" | "enriching" | "done" | "failed" | "superseded";
export type ContextGraphBuildTrigger = "webhook" | "manual" | "scheduled" | "api";

export const CONTEXT_GRAPH_DEFAULT_HISTORY_LIMIT = 500;
export const CONTEXT_GRAPH_MAX_HISTORY_LIMIT = 10_000;

export interface ContextGraphPipelineBuildRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly snapshotFirst: boolean;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Return the latest build unchanged when its metadata.githubHeadSha matches, instead of superseding it. */
  readonly dedupeHeadSha?: string;
}

export interface ContextGraphBuildRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly status: ContextGraphBuildStatus;
  readonly snapshotFirst: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextGraphStageRecord {
  readonly id: string;
  readonly buildId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly phase: "snapshot" | "history";
  readonly stage: "ingest" | "assert" | "project";
  readonly topic: ContextGraphWorkerTopic;
  readonly status: ContextGraphStageStatus;
  readonly priority: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly leaseId?: string;
  readonly workerId?: string;
  readonly leaseExpiresAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextGraphStageClaim {
  readonly message: {
    readonly id: string;
    readonly topic: ContextGraphWorkerTopic;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
  };
  readonly task: {
    readonly id: string;
    readonly type: `context_graph_${"ingest" | "assert" | "project"}`;
    readonly status: "in_progress";
    readonly metadata: Readonly<Record<string, unknown>>;
  };
}

export interface ContextGraphStageLease {
  readonly stageId: string;
  readonly leaseId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly topic: ContextGraphWorkerTopic;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ContextGraphStageCompletionReceipt extends ContextGraphStageLease {
  readonly outcome: "done" | "failed";
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface ContextGraphTaskBoardEvent {
  readonly id: string;
  readonly taskId: string;
  readonly type: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ContextGraphWorkflow {
  readonly build: ContextGraphBuildRecord;
  readonly stages: readonly ContextGraphStageRecord[];
}

export interface ContextGraphWorkflowCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ContextGraphWorkflowPage {
  readonly workflows: readonly ContextGraphWorkflow[];
  readonly nextCursor?: ContextGraphWorkflowCursor;
}

export interface ContextGraphGlobalWorkflowFilter {
  readonly limit: number;
  readonly cursor?: ContextGraphWorkflowCursor;
  readonly tenantId?: string;
  readonly repository?: string;
  readonly statuses?: readonly ContextGraphBuildStatus[];
  readonly trigger?: ContextGraphBuildTrigger;
  readonly query?: string;
  readonly createdAfter?: string;
  /** Include builds created or updated at or after this instant. */
  readonly activityAfter?: string;
}

export interface ContextGraphPipelineCoordinator {
  createBuild(
    request: ContextGraphPipelineBuildRequest,
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<ContextGraphBuildRecord>;
  cancelBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly now: string;
    readonly reason: string;
  }): Promise<boolean>;
  claim(
    input: {
      readonly tenantId: string;
      readonly tenantIds?: readonly string[];
      readonly repositoryScopes?: readonly {
        readonly tenantId: string;
        readonly repository: string;
      }[];
      /** Stable across transport retries of one claim request. */
      readonly claimId?: string;
      readonly workerId: string;
      readonly topics: readonly ContextGraphWorkerTopic[];
      readonly now: string;
      readonly leaseExpiresAt: string;
    },
    authorityGuard?: (stage: Pick<ContextGraphStageLease, "tenantId" | "repository" | "metadata">) => Promise<void>
  ): Promise<ContextGraphStageClaim | undefined>;
  renew(
    input: {
      readonly tenantId: string;
      readonly stageId: string;
      readonly leaseId: string;
      readonly now: string;
      readonly leaseExpiresAt: string;
    },
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<boolean>;
  release(
    input: {
      readonly tenantId: string;
      readonly stageId: string;
      readonly leaseId: string;
      readonly now: string;
      readonly reason: string;
    },
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<boolean>;
  leasedStage(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly topic?: ContextGraphWorkerTopic;
    readonly now: string;
  }): Promise<ContextGraphStageLease | undefined>;
  completionReceipt(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
  }): Promise<ContextGraphStageCompletionReceipt | undefined>;
  complete(
    input: {
      readonly tenantId: string;
      readonly stageId: string;
      readonly leaseId: string;
      readonly outcome: "done" | "failed";
      readonly now: string;
      readonly result?: Readonly<Record<string, unknown>>;
      readonly nextMetadata?: Readonly<Record<string, unknown>>;
      readonly reason?: string;
    },
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<boolean>;
  checkpoint(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly name: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly now: string;
  }): Promise<boolean>;
  list(
    tenantId: string,
    filter?: { readonly repositories?: readonly string[] }
  ): Promise<readonly ContextGraphWorkflow[]>;
  /** Cross-tenant operational history, ordered newest-first with stable cursor pagination. */
  listGlobal(filter: ContextGraphGlobalWorkflowFilter): Promise<ContextGraphWorkflowPage>;
  countActive(tenantId?: string): Promise<number>;
  listEvents(
    tenantId: string,
    filter?: { readonly taskIds?: readonly string[] }
  ): Promise<readonly ContextGraphTaskBoardEvent[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

interface MutableBuild extends Omit<ContextGraphBuildRecord, "status" | "updatedAt"> {
  status: ContextGraphBuildStatus;
  updatedAt: string;
}

interface MutableStage extends Omit<
  ContextGraphStageRecord,
  "status" | "metadata" | "attempt" | "updatedAt" | "startedAt" | "completedAt" | "durationMs"
> {
  status: ContextGraphStageStatus;
  metadata: Record<string, unknown>;
  attempt: number;
  updatedAt: string;
  leaseId?: string;
  workerId?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/** In-memory implementation used by tests and local development. */
export class MemoryContextGraphPipelineCoordinator implements ContextGraphPipelineCoordinator {
  private readonly builds = new Map<string, MutableBuild>();
  private readonly stages = new Map<string, MutableStage>();
  private readonly checkpoints = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly events: ContextGraphTaskBoardEvent[] = [];

  async createBuild(
    request: ContextGraphPipelineBuildRequest,
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<ContextGraphBuildRecord> {
    await authorityGuard?.(request.repository);
    const id = stableId(
      "context-graph-job",
      `${request.tenantId}:${request.repository}:${request.ref}:${request.requestKey}`
    );
    const existing = this.builds.get(id);
    if (existing) return structuredClone(existing);
    if (request.dedupeHeadSha) {
      const latest = [...this.builds.values()]
        .filter(
          (build) =>
            build.tenantId === request.tenantId && build.repository === request.repository && build.ref === request.ref
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .at(-1);
      if (latest?.metadata.githubHeadSha === request.dedupeHeadSha) return structuredClone(latest);
    }
    if (isParserRepairBuild(request)) {
      const active = [...this.builds.values()]
        .filter(
          (build) =>
            build.tenantId === request.tenantId &&
            build.repository === request.repository &&
            build.ref === request.ref &&
            ["queued", "in_progress", "enriching"].includes(build.status)
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .at(-1);
      if (active) return structuredClone(active);
    }
    for (const build of this.builds.values()) {
      if (
        build.tenantId !== request.tenantId ||
        build.repository !== request.repository ||
        build.ref !== request.ref ||
        build.requestKey === request.requestKey ||
        !["queued", "in_progress", "enriching"].includes(build.status)
      )
        continue;
      build.status = "superseded";
      build.updatedAt = request.createdAt;
      this.recordEvent(build.id, "task.transitioned", request.createdAt, { toStatus: "superseded" });
      for (const stage of this.stages.values()) {
        if (stage.buildId === build.id && !["done", "failed"].includes(stage.status)) {
          stage.status = "superseded";
          stage.updatedAt = request.createdAt;
          clearLease(stage);
          this.recordEvent(stage.id, "task.transitioned", request.createdAt, { toStatus: "superseded" });
        }
      }
    }
    const build: MutableBuild = {
      ...request,
      metadata: structuredClone(request.metadata ?? {}),
      id,
      status: "queued",
      updatedAt: request.createdAt
    };
    this.builds.set(id, build);
    this.recordEvent(id, "task.created", request.createdAt, { type: "context_graph_build" });
    for (const stage of plannedStages(build)) {
      this.stages.set(stage.id, stage);
      this.recordEvent(stage.id, "task.created", request.createdAt, {
        type: `context_graph_${stage.stage}`,
        phase: stage.phase
      });
    }
    return structuredClone(build);
  }

  async cancelBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly now: string;
    readonly reason: string;
  }): Promise<boolean> {
    const build = this.builds.get(input.buildId);
    if (!build || build.tenantId !== input.tenantId || ["done", "failed", "superseded"].includes(build.status)) {
      return false;
    }
    build.status = "failed";
    build.updatedAt = input.now;
    this.recordEvent(build.id, "task.transitioned", input.now, {
      toStatus: "failed",
      reason: input.reason
    });
    for (const stage of this.stages.values()) {
      if (stage.buildId !== build.id || ["done", "failed", "canceled", "superseded"].includes(stage.status)) continue;
      stage.status = "canceled";
      stage.updatedAt = input.now;
      clearLease(stage);
      this.recordEvent(stage.id, "task.transitioned", input.now, {
        toStatus: "canceled",
        reason: input.reason
      });
    }
    return true;
  }

  async claim(
    input: {
      readonly tenantId: string;
      readonly tenantIds?: readonly string[];
      readonly repositoryScopes?: readonly {
        readonly tenantId: string;
        readonly repository: string;
      }[];
      readonly claimId?: string;
      readonly workerId: string;
      readonly topics: readonly ContextGraphWorkerTopic[];
      readonly now: string;
      readonly leaseExpiresAt: string;
    },
    authorityGuard?: (stage: Pick<ContextGraphStageLease, "tenantId" | "repository" | "metadata">) => Promise<void>
  ): Promise<ContextGraphStageClaim | undefined> {
    const tenantIds = new Set(input.tenantIds?.length ? input.tenantIds : [input.tenantId]);
    const repositoryScopes = input.repositoryScopes
      ? new Set(input.repositoryScopes.map((scope) => `${scope.tenantId}:${scope.repository.toLowerCase()}`))
      : undefined;
    const replayed = input.claimId
      ? [...this.stages.values()].find(
          (candidate) =>
            tenantIds.has(candidate.tenantId) &&
            (!repositoryScopes ||
              repositoryScopes.has(`${candidate.tenantId}:${candidate.repository.toLowerCase()}`)) &&
            candidate.status === "in_progress" &&
            candidate.leaseId === input.claimId &&
            candidate.workerId === input.workerId &&
            Boolean(candidate.leaseExpiresAt && candidate.leaseExpiresAt > input.now) &&
            input.topics.includes(candidate.topic)
        )
      : undefined;
    if (replayed) {
      await authorityGuard?.({
        tenantId: replayed.tenantId,
        repository: replayed.repository,
        metadata: structuredClone(replayed.metadata)
      });
      return claimView(replayed);
    }
    for (const stage of this.stages.values()) {
      if (
        tenantIds.has(stage.tenantId) &&
        stage.status === "in_progress" &&
        stage.leaseExpiresAt &&
        stage.leaseExpiresAt <= input.now
      ) {
        // The requeued row must not carry stale timing, so the interrupted
        // attempt's startedAt/duration survive only in this expiry event.
        if (stage.startedAt) {
          this.recordEvent(stage.id, "task.lease_expired", input.now, {
            fromStatus: "in_progress",
            toStatus: "queued",
            attempt: stage.attempt,
            ...(stage.workerId ? { workerId: stage.workerId } : {}),
            startedAt: stage.startedAt,
            endedAt: input.now,
            durationMs: Math.max(0, Date.parse(input.now) - Date.parse(stage.startedAt))
          });
        }
        stage.status = "queued";
        clearLease(stage);
        delete stage.startedAt;
        delete stage.completedAt;
        delete stage.durationMs;
      }
    }
    const stage = [...this.stages.values()]
      .filter(
        (candidate) =>
          tenantIds.has(candidate.tenantId) &&
          (!repositoryScopes || repositoryScopes.has(`${candidate.tenantId}:${candidate.repository.toLowerCase()}`)) &&
          candidate.status === "queued" &&
          input.topics.includes(candidate.topic)
      )
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
      )[0];
    if (!stage) return undefined;
    await authorityGuard?.({
      tenantId: stage.tenantId,
      repository: stage.repository,
      metadata: structuredClone(stage.metadata)
    });
    stage.status = "in_progress";
    stage.attempt += 1;
    stage.leaseId = input.claimId ?? randomUUID();
    stage.workerId = input.workerId;
    stage.leaseExpiresAt = input.leaseExpiresAt;
    stage.startedAt = input.now;
    delete stage.completedAt;
    delete stage.durationMs;
    stage.updatedAt = input.now;
    this.recordEvent(stage.id, "task.transitioned", input.now, {
      fromStatus: "queued",
      toStatus: "in_progress",
      attempt: stage.attempt,
      workerId: input.workerId,
      startedAt: input.now
    });
    const build = this.builds.get(stage.buildId)!;
    build.status = stage.phase === "history" ? "enriching" : "in_progress";
    build.updatedAt = input.now;
    return claimView(stage);
  }

  async renew(
    input: {
      readonly tenantId: string;
      readonly stageId: string;
      readonly leaseId: string;
      readonly now: string;
      readonly leaseExpiresAt: string;
    },
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    await authorityGuard?.(stage!.repository);
    stage!.leaseExpiresAt = input.leaseExpiresAt;
    stage!.updatedAt = input.now;
    return true;
  }

  async release(
    input: {
      readonly tenantId: string;
      readonly stageId: string;
      readonly leaseId: string;
      readonly now: string;
      readonly reason: string;
    },
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    await authorityGuard?.(stage!.repository);
    const startedAt = stage!.startedAt ?? input.now;
    const durationMs = Math.max(0, Date.parse(input.now) - Date.parse(startedAt));
    stage!.status = "queued";
    stage!.updatedAt = input.now;
    clearLease(stage!);
    delete stage!.startedAt;
    // The attempt-end timestamp is endedAt: the stage returns to queued, so
    // nothing completed. Release events written before this rename carry the
    // same value under completedAt; no in-repo consumer keys on either name.
    this.recordEvent(stage!.id, "task.transitioned", input.now, {
      fromStatus: "in_progress",
      toStatus: "queued",
      reason: input.reason,
      attempt: stage!.attempt,
      startedAt,
      endedAt: input.now,
      durationMs
    });
    const build = this.builds.get(stage!.buildId)!;
    build.status = stage!.phase === "history" ? "enriching" : "in_progress";
    build.updatedAt = input.now;
    return true;
  }

  async leasedStage(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly topic?: ContextGraphWorkerTopic;
    readonly now: string;
  }): Promise<ContextGraphStageLease | undefined> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now) || (input.topic && stage!.topic !== input.topic))
      return undefined;
    return leaseView(stage!);
  }

  async completionReceipt(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
  }): Promise<ContextGraphStageCompletionReceipt | undefined> {
    const stage = this.stages.get(input.stageId);
    if (
      !stage ||
      stage.tenantId !== input.tenantId ||
      (stage.status !== "done" && stage.status !== "failed") ||
      stage.metadata.completionLeaseId !== input.leaseId
    ) {
      return undefined;
    }
    const result = recordMetadata(stage.metadata.result);
    return {
      stageId: stage.id,
      leaseId: input.leaseId,
      tenantId: stage.tenantId,
      repository: stage.repository,
      ref: stage.ref,
      topic: stage.topic,
      metadata: structuredClone(stage.metadata),
      outcome: stage.status,
      ...(result ? { result: structuredClone(result) } : {})
    };
  }

  async complete(
    input: {
      readonly tenantId: string;
      readonly stageId: string;
      readonly leaseId: string;
      readonly outcome: "done" | "failed";
      readonly now: string;
      readonly result?: Readonly<Record<string, unknown>>;
      readonly nextMetadata?: Readonly<Record<string, unknown>>;
      readonly reason?: string;
    },
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    await authorityGuard?.(stage!.repository);
    stage!.status = input.outcome;
    stage!.metadata = {
      ...stage!.metadata,
      ...(input.result ? { result: structuredClone(input.result) } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      completionLeaseId: input.leaseId,
      completionOutcome: input.outcome
    };
    stage!.updatedAt = input.now;
    stage!.completedAt = input.now;
    stage!.durationMs = Math.max(0, Date.parse(input.now) - Date.parse(stage!.startedAt ?? input.now));
    // Here completedAt is accurate — the attempt end IS the stage completion —
    // and matches the stage record's completedAt field.
    this.recordEvent(stage!.id, "task.transitioned", input.now, {
      fromStatus: "in_progress",
      toStatus: input.outcome,
      attempt: stage!.attempt,
      startedAt: stage!.startedAt ?? input.now,
      completedAt: input.now,
      durationMs: stage!.durationMs,
      ...(input.reason ? { reason: input.reason } : {})
    });
    clearLease(stage!);
    const build = this.builds.get(stage!.buildId)!;
    if (input.outcome === "failed") {
      if (contextGraphStageRequired(stage!)) {
        build.status = "failed";
        for (const candidate of this.stages.values()) {
          if (
            candidate.buildId === build.id &&
            candidate.id !== stage!.id &&
            !["done", "failed", "canceled", "superseded"].includes(candidate.status)
          ) {
            candidate.status = "canceled";
            candidate.updatedAt = input.now;
            clearLease(candidate);
            this.recordEvent(candidate.id, "task.transitioned", input.now, { toStatus: "canceled" });
          }
        }
      } else {
        this.queueReadyStages(build, stage!, input.nextMetadata ?? {}, input.now);
        build.status = this.buildStatus(build);
      }
    } else {
      this.queueReadyStages(build, stage!, input.nextMetadata ?? {}, input.now);
      build.status = this.buildStatus(build);
    }
    build.updatedAt = input.now;
    return true;
  }

  async checkpoint(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly name: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly now: string;
  }): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    this.checkpoints.set(`${input.stageId}:${input.name}`, structuredClone(input.value));
    return true;
  }

  async list(
    tenantId: string,
    filter?: { readonly repositories?: readonly string[] }
  ): Promise<readonly ContextGraphWorkflow[]> {
    const repositories = filter?.repositories ? new Set(filter.repositories) : undefined;
    return [...this.builds.values()]
      .filter((build) => build.tenantId === tenantId && (!repositories || repositories.has(build.repository)))
      .map((build) => ({
        build: structuredClone(build),
        stages: [...this.stages.values()]
          .filter((stage) => stage.buildId === build.id)
          .sort((a, b) => stageOrder(a) - stageOrder(b))
          .map((stage) => structuredClone(stage))
      }));
  }

  async listGlobal(filter: ContextGraphGlobalWorkflowFilter): Promise<ContextGraphWorkflowPage> {
    const limit = normalizedGlobalLimit(filter.limit);
    const workflows = [...this.builds.values()]
      .filter((build) => globalWorkflowMatches(build, filter))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit + 1);
    const page = workflows.slice(0, limit);
    const last = page.at(-1);
    return {
      workflows: page.map((build) => ({
        build: structuredClone(build),
        stages: [...this.stages.values()]
          .filter((stage) => stage.buildId === build.id)
          .sort((left, right) => stageOrder(left) - stageOrder(right))
          .map((stage) => structuredClone(stage))
      })),
      ...(workflows.length > limit && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {})
    };
  }

  async countActive(tenantId?: string): Promise<number> {
    return [...this.builds.values()].filter(
      (build) =>
        (!tenantId || build.tenantId === tenantId) && ["queued", "in_progress", "enriching"].includes(build.status)
    ).length;
  }

  async listEvents(
    tenantId: string,
    filter?: { readonly taskIds?: readonly string[] }
  ): Promise<readonly ContextGraphTaskBoardEvent[]> {
    const requested = filter?.taskIds ? new Set(filter.taskIds) : undefined;
    const taskIds = new Set([
      ...[...this.builds.values()].filter((build) => build.tenantId === tenantId).map((build) => build.id),
      ...[...this.stages.values()].filter((stage) => stage.tenantId === tenantId).map((stage) => stage.id)
    ]);
    return this.events
      .filter((event) => taskIds.has(event.taskId) && (!requested || requested.has(event.taskId)))
      .map((event) => structuredClone(event));
  }

  async ping(): Promise<void> {
    // The in-memory coordinator is always reachable.
  }
  async close(): Promise<void> {
    // The in-memory coordinator owns no external resources.
  }

  private recordEvent(taskId: string, type: string, at: string, payload: Readonly<Record<string, unknown>>): void {
    this.events.push({
      id: `task-board-event-${this.events.length + 1}`,
      taskId,
      type,
      at,
      payload: structuredClone(payload)
    });
  }

  private queueReadyStages(
    build: MutableBuild,
    completed: MutableStage,
    nextMetadata: Readonly<Record<string, unknown>>,
    now: string
  ): void {
    const stages = [...this.stages.values()].filter((candidate) => candidate.buildId === build.id);
    for (const candidate of stages
      .filter((item) => item.status === "triage")
      .sort((a, b) => stageOrder(a) - stageOrder(b))) {
      const ready = contextGraphStagePrerequisites(candidate, build.snapshotFirst).every((prerequisite) =>
        stages.some(
          (item) => item.phase === prerequisite.phase && item.stage === prerequisite.stage && item.status === "done"
        )
      );
      if (!ready) continue;
      candidate.status = "queued";
      if (candidate.phase === completed.phase) {
        candidate.metadata = { ...candidate.metadata, ...structuredClone(nextMetadata) };
      }
      candidate.updatedAt = now;
      this.recordEvent(candidate.id, "task.transitioned", now, { fromStatus: "triage", toStatus: "queued" });
    }
  }

  private buildStatus(build: MutableBuild): ContextGraphBuildStatus {
    const stages = [...this.stages.values()].filter((candidate) => candidate.buildId === build.id);
    if (stages.some((stage) => contextGraphStageRequired(stage) && stage.status === "failed")) return "failed";
    if (stages.every((stage) => ["done", "failed", "canceled", "superseded"].includes(stage.status))) return "done";
    if (
      build.snapshotFirst &&
      stages.some((stage) => stage.phase === "snapshot" && stage.stage === "project" && stage.status === "done")
    ) {
      return "enriching";
    }
    return "in_progress";
  }
}

function normalizedGlobalLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("global workflow limit must be an integer from 1 to 500");
  }
  return limit;
}

function globalWorkflowMatches(build: ContextGraphBuildRecord, filter: ContextGraphGlobalWorkflowFilter): boolean {
  if (
    filter.cursor &&
    (build.createdAt > filter.cursor.createdAt ||
      (build.createdAt === filter.cursor.createdAt && build.id >= filter.cursor.id))
  )
    return false;
  if (filter.tenantId && build.tenantId !== filter.tenantId) return false;
  if (filter.repository && build.repository !== filter.repository) return false;
  if (filter.statuses && !filter.statuses.includes(build.status)) return false;
  if (filter.trigger && contextGraphBuildTrigger(build) !== filter.trigger) return false;
  if (filter.query) {
    const query = filter.query.toLowerCase();
    if (
      ![build.repository, build.tenantId, build.ref, build.id, build.requestKey].some((value) =>
        value.toLowerCase().includes(query)
      )
    )
      return false;
  }
  if (filter.createdAfter && build.createdAt < filter.createdAfter) return false;
  if (filter.activityAfter && build.createdAt < filter.activityAfter && build.updatedAt < filter.activityAfter)
    return false;
  return true;
}

function contextGraphBuildTrigger(build: ContextGraphBuildRecord): ContextGraphBuildTrigger {
  const source = [
    build.metadata.githubEventName,
    build.metadata.eventName,
    build.metadata.trigger,
    build.metadata.source
  ]
    .find((value): value is string => typeof value === "string")
    ?.toLowerCase();
  if (source?.includes("schedule")) return "scheduled";
  if (source?.includes("webhook") || source?.includes("push") || source?.includes("github")) return "webhook";
  if (source?.includes("manual") || build.requestKey.startsWith("admin-")) return "manual";
  return "api";
}

function plannedStages(build: MutableBuild): MutableStage[] {
  return contextGraphPlannedStageSpecs(build.snapshotFirst, isParserRepairBuild(build)).map(
    ({ phase, priority, stage, ordinal }) => {
      const id = stableId("context-graph-stage", `${build.id}:${phase}:${stage}`);
      return {
        id,
        buildId: build.id,
        tenantId: build.tenantId,
        repository: build.repository,
        ref: build.ref,
        requestKey: build.requestKey,
        phase,
        stage,
        topic: `run-context-graph-${stage}` as ContextGraphWorkerTopic,
        status: ordinal === 0 ? ("queued" as const) : ("triage" as const),
        priority,
        metadata: {
          ...structuredClone(build.metadata),
          tenantId: build.tenantId,
          repository: build.repository,
          ref: build.ref,
          requestKey: build.requestKey,
          pipelinePhase: phase
        },
        attempt: 0,
        createdAt: build.createdAt,
        updatedAt: build.createdAt
      };
    }
  );
}

/**
 * Snapshot-first builds publish a fast structural projection while history is
 * still loading. Semantic assertions belong to the history phase because they
 * require the complete work-item and causal evidence scope.
 */
export function contextGraphPlannedStageSpecs(
  snapshotFirst: boolean,
  repairOnly = false
): readonly {
  readonly phase: "snapshot" | "history";
  readonly stage: "ingest" | "assert" | "project";
  readonly priority: number;
  readonly ordinal: number;
}[] {
  if (repairOnly) return [{ phase: "snapshot", stage: "ingest", priority: 100, ordinal: 0 }];
  const phases = snapshotFirst
    ? [
        { phase: "snapshot" as const, priority: 100, stages: ["ingest", "project"] as const },
        { phase: "history" as const, priority: 10, stages: ["ingest", "assert", "project"] as const }
      ]
    : [{ phase: "history" as const, priority: 50, stages: ["ingest", "assert", "project"] as const }];
  let ordinal = 0;
  return phases.flatMap(({ phase, priority, stages }) =>
    stages.map((stage) => ({ phase, stage, priority, ordinal: ordinal++ }))
  );
}

function isParserRepairBuild(value: { readonly metadata?: Readonly<Record<string, unknown>> }): boolean {
  return value.metadata?.repairOnly === true;
}

export function contextGraphStagePrerequisites(
  stage: Pick<ContextGraphStageRecord, "phase" | "stage">,
  snapshotFirst: boolean
): readonly Pick<ContextGraphStageRecord, "phase" | "stage">[] {
  if (stage.stage !== "ingest") return [{ phase: stage.phase, stage: "ingest" }];
  return snapshotFirst && stage.phase === "history" ? [{ phase: "snapshot", stage: "ingest" }] : [];
}

export function contextGraphStageRequired(stage: Pick<ContextGraphStageRecord, "stage">): boolean {
  return stage.stage !== "assert";
}

function validLease(stage: MutableStage | undefined, tenantId: string, leaseId: string, now: string): boolean {
  return Boolean(
    stage &&
    stage.tenantId === tenantId &&
    stage.status === "in_progress" &&
    stage.leaseId === leaseId &&
    stage.leaseExpiresAt &&
    stage.leaseExpiresAt > now
  );
}

function clearLease(stage: MutableStage): void {
  delete stage.leaseId;
  delete stage.workerId;
  delete stage.leaseExpiresAt;
}

function stageOrder(stage: Pick<ContextGraphStageRecord, "phase" | "stage">): number {
  return (stage.phase === "snapshot" ? 0 : 3) + (stage.stage === "ingest" ? 0 : stage.stage === "assert" ? 1 : 2);
}

function leaseView(stage: MutableStage): ContextGraphStageLease {
  return {
    stageId: stage.id,
    leaseId: stage.leaseId!,
    tenantId: stage.tenantId,
    repository: stage.repository,
    ref: stage.ref,
    topic: stage.topic,
    metadata: structuredClone(stage.metadata)
  };
}

function claimView(stage: MutableStage): ContextGraphStageClaim {
  return {
    message: { id: stage.id, topic: stage.topic, leaseId: stage.leaseId!, leaseExpiresAt: stage.leaseExpiresAt! },
    task: {
      id: stage.id,
      type: `context_graph_${stage.stage}`,
      status: "in_progress",
      metadata: structuredClone(stage.metadata)
    }
  };
}

function recordMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
