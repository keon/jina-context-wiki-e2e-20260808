import { randomUUID } from "node:crypto";
import { stableId } from "./model.js";

export type OntologyWorkerTopic = "run-ontology-ingest" | "run-ontology-assert" | "run-ontology-project";
export type OntologyStageStatus = "triage" | "queued" | "in_progress" | "done" | "failed" | "canceled" | "superseded";
export type OntologyBuildStatus = "queued" | "in_progress" | "enriching" | "done" | "failed" | "superseded";

export interface OntologyPipelineBuildRequest {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly snapshotFirst: boolean;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OntologyBuildRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly status: OntologyBuildStatus;
  readonly snapshotFirst: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OntologyStageRecord {
  readonly id: string;
  readonly buildId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly phase: "snapshot" | "history";
  readonly stage: "ingest" | "assert" | "project";
  readonly topic: OntologyWorkerTopic;
  readonly status: OntologyStageStatus;
  readonly priority: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly leaseId?: string;
  readonly workerId?: string;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OntologyStageClaim {
  readonly message: {
    readonly id: string;
    readonly topic: OntologyWorkerTopic;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
  };
  readonly task: {
    readonly id: string;
    readonly type: `ontology_${"ingest" | "assert" | "project"}`;
    readonly status: "in_progress";
    readonly metadata: Readonly<Record<string, unknown>>;
  };
}

export interface OntologyStageLease {
  readonly stageId: string;
  readonly leaseId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly topic: OntologyWorkerTopic;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OntologyTaskBoardEvent {
  readonly id: string;
  readonly taskId: string;
  readonly type: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OntologyPipelineCoordinator {
  createBuild(request: OntologyPipelineBuildRequest): Promise<OntologyBuildRecord>;
  claim(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly topics: readonly OntologyWorkerTopic[];
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<OntologyStageClaim | undefined>;
  renew(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean>;
  release(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly now: string;
    readonly reason: string;
  }): Promise<boolean>;
  leasedStage(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly topic?: OntologyWorkerTopic;
    readonly now: string;
  }): Promise<OntologyStageLease | undefined>;
  complete(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly outcome: "done" | "failed";
    readonly now: string;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly nextMetadata?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
  }): Promise<boolean>;
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
  ): Promise<readonly { readonly build: OntologyBuildRecord; readonly stages: readonly OntologyStageRecord[] }[]>;
  listEvents(tenantId: string, filter?: { readonly taskIds?: readonly string[] }): Promise<readonly OntologyTaskBoardEvent[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

interface MutableBuild extends Omit<OntologyBuildRecord, "status" | "updatedAt"> {
  status: OntologyBuildStatus;
  updatedAt: string;
}

interface MutableStage extends Omit<OntologyStageRecord, "status" | "metadata" | "attempt" | "updatedAt"> {
  status: OntologyStageStatus;
  metadata: Record<string, unknown>;
  attempt: number;
  updatedAt: string;
  leaseId?: string;
  workerId?: string;
  leaseExpiresAt?: string;
}

/** In-memory implementation used by tests and local development. */
export class MemoryOntologyPipelineCoordinator implements OntologyPipelineCoordinator {
  private readonly builds = new Map<string, MutableBuild>();
  private readonly stages = new Map<string, MutableStage>();
  private readonly checkpoints = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly events: OntologyTaskBoardEvent[] = [];

  async createBuild(request: OntologyPipelineBuildRequest): Promise<OntologyBuildRecord> {
    for (const build of this.builds.values()) {
      if (build.tenantId !== request.tenantId || build.repository !== request.repository || build.ref !== request.ref ||
          build.requestKey === request.requestKey || !["queued", "in_progress", "enriching"].includes(build.status)) continue;
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
    const id = stableId("ontology-job", `${request.tenantId}:${request.repository}:${request.ref}:${request.requestKey}`);
    const existing = this.builds.get(id);
    if (existing) return structuredClone(existing);
    const build: MutableBuild = {
      ...request,
      metadata: structuredClone(request.metadata ?? {}),
      id,
      status: "queued",
      updatedAt: request.createdAt
    };
    this.builds.set(id, build);
    this.recordEvent(id, "task.created", request.createdAt, { type: "ontology_build" });
    for (const stage of plannedStages(build)) {
      this.stages.set(stage.id, stage);
      this.recordEvent(stage.id, "task.created", request.createdAt, { type: `ontology_${stage.stage}`, phase: stage.phase });
    }
    return structuredClone(build);
  }

  async claim(input: {
    readonly tenantId: string; readonly workerId: string; readonly topics: readonly OntologyWorkerTopic[];
    readonly now: string; readonly leaseExpiresAt: string;
  }): Promise<OntologyStageClaim | undefined> {
    for (const stage of this.stages.values()) {
      if (stage.status === "in_progress" && stage.leaseExpiresAt && stage.leaseExpiresAt <= input.now) {
        stage.status = "queued";
        clearLease(stage);
      }
    }
    const stage = [...this.stages.values()]
      .filter((candidate) => candidate.tenantId === input.tenantId && candidate.status === "queued" && input.topics.includes(candidate.topic))
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    if (!stage) return undefined;
    stage.status = "in_progress";
    stage.attempt += 1;
    stage.leaseId = randomUUID();
    stage.workerId = input.workerId;
    stage.leaseExpiresAt = input.leaseExpiresAt;
    stage.updatedAt = input.now;
    this.recordEvent(stage.id, "task.transitioned", input.now, {
      fromStatus: "queued", toStatus: "in_progress", attempt: stage.attempt, workerId: input.workerId
    });
    const build = this.builds.get(stage.buildId)!;
    build.status = stage.phase === "history" ? "enriching" : "in_progress";
    build.updatedAt = input.now;
    return claimView(stage);
  }

  async renew(input: {
    readonly tenantId: string; readonly stageId: string; readonly leaseId: string;
    readonly now: string; readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    stage!.leaseExpiresAt = input.leaseExpiresAt;
    stage!.updatedAt = input.now;
    return true;
  }

  async release(input: {
    readonly tenantId: string; readonly stageId: string; readonly leaseId: string;
    readonly now: string; readonly reason: string;
  }): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    stage!.status = "queued";
    stage!.updatedAt = input.now;
    clearLease(stage!);
    this.recordEvent(stage!.id, "task.transitioned", input.now, {
      fromStatus: "in_progress", toStatus: "queued", reason: input.reason
    });
    const build = this.builds.get(stage!.buildId)!;
    build.status = stage!.phase === "history" ? "enriching" : "in_progress";
    build.updatedAt = input.now;
    return true;
  }

  async leasedStage(input: {
    readonly tenantId: string; readonly stageId: string; readonly leaseId: string;
    readonly topic?: OntologyWorkerTopic; readonly now: string;
  }): Promise<OntologyStageLease | undefined> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now) || (input.topic && stage!.topic !== input.topic)) return undefined;
    return leaseView(stage!);
  }

  async complete(input: {
    readonly tenantId: string; readonly stageId: string; readonly leaseId: string; readonly outcome: "done" | "failed";
    readonly now: string; readonly result?: Readonly<Record<string, unknown>>; readonly nextMetadata?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
  }): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    stage!.status = input.outcome;
    stage!.metadata = { ...stage!.metadata, ...(input.result ? { result: structuredClone(input.result) } : {}), ...(input.reason ? { reason: input.reason } : {}) };
    stage!.updatedAt = input.now;
    this.recordEvent(stage!.id, "task.transitioned", input.now, {
      fromStatus: "in_progress", toStatus: input.outcome, ...(input.reason ? { reason: input.reason } : {})
    });
    clearLease(stage!);
    const build = this.builds.get(stage!.buildId)!;
    if (input.outcome === "failed") {
      if (ontologyStageRequired(stage!)) {
        build.status = "failed";
        for (const candidate of this.stages.values()) {
          if (candidate.buildId === build.id && candidate.status === "triage") candidate.status = "canceled";
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
    readonly tenantId: string; readonly stageId: string; readonly leaseId: string; readonly name: string;
    readonly value: Readonly<Record<string, unknown>>; readonly now: string;
  }): Promise<boolean> {
    const stage = this.stages.get(input.stageId);
    if (!validLease(stage, input.tenantId, input.leaseId, input.now)) return false;
    this.checkpoints.set(`${input.stageId}:${input.name}`, structuredClone(input.value));
    return true;
  }

  async list(
    tenantId: string,
    filter?: { readonly repositories?: readonly string[] }
  ): Promise<readonly { readonly build: OntologyBuildRecord; readonly stages: readonly OntologyStageRecord[] }[]> {
    const repositories = filter?.repositories ? new Set(filter.repositories) : undefined;
    return [...this.builds.values()]
      .filter((build) => build.tenantId === tenantId && (!repositories || repositories.has(build.repository)))
      .map((build) => ({
      build: structuredClone(build),
      stages: [...this.stages.values()].filter((stage) => stage.buildId === build.id).sort((a, b) => stageOrder(a) - stageOrder(b)).map((stage) => structuredClone(stage))
    }));
  }

  async listEvents(tenantId: string, filter?: { readonly taskIds?: readonly string[] }): Promise<readonly OntologyTaskBoardEvent[]> {
    const requested = filter?.taskIds ? new Set(filter.taskIds) : undefined;
    const taskIds = new Set([
      ...[...this.builds.values()].filter((build) => build.tenantId === tenantId).map((build) => build.id),
      ...[...this.stages.values()].filter((stage) => stage.tenantId === tenantId).map((stage) => stage.id)
    ]);
    return this.events
      .filter((event) => taskIds.has(event.taskId) && (!requested || requested.has(event.taskId)))
      .map((event) => structuredClone(event));
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  private recordEvent(taskId: string, type: string, at: string, payload: Readonly<Record<string, unknown>>): void {
    this.events.push({ id: `task-board-event-${this.events.length + 1}`, taskId, type, at, payload: structuredClone(payload) });
  }

  private queueReadyStages(
    build: MutableBuild,
    completed: MutableStage,
    nextMetadata: Readonly<Record<string, unknown>>,
    now: string
  ): void {
    const stages = [...this.stages.values()].filter((candidate) => candidate.buildId === build.id);
    for (const candidate of stages.filter((item) => item.status === "triage").sort((a, b) => stageOrder(a) - stageOrder(b))) {
      const ready = ontologyStagePrerequisites(candidate, build.snapshotFirst).every((prerequisite) =>
        stages.some((item) => item.phase === prerequisite.phase && item.stage === prerequisite.stage && item.status === "done")
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

  private buildStatus(build: MutableBuild): OntologyBuildStatus {
    const stages = [...this.stages.values()].filter((candidate) => candidate.buildId === build.id);
    if (stages.some((stage) => ontologyStageRequired(stage) && stage.status === "failed")) return "failed";
    if (stages.every((stage) => ["done", "failed", "canceled", "superseded"].includes(stage.status))) return "done";
    if (build.snapshotFirst && stages.some((stage) => stage.phase === "snapshot" && stage.stage === "project" && stage.status === "done")) {
      return "enriching";
    }
    return "in_progress";
  }
}

function plannedStages(build: MutableBuild): MutableStage[] {
  const phases: Array<{ readonly phase: "snapshot" | "history"; readonly priority: number }> = build.snapshotFirst
    ? [{ phase: "snapshot", priority: 100 }, { phase: "history", priority: 10 }]
    : [{ phase: "history", priority: 50 }];
  return phases.flatMap(({ phase, priority }, phaseIndex) => (["ingest", "assert", "project"] as const).map((stage, stageIndex) => {
    const id = stableId("ontology-stage", `${build.id}:${phase}:${stage}`);
    return {
      id,
      buildId: build.id,
      tenantId: build.tenantId,
      repository: build.repository,
      ref: build.ref,
      requestKey: build.requestKey,
      phase,
      stage,
      topic: `run-ontology-${stage}` as OntologyWorkerTopic,
      status: phaseIndex === 0 && stageIndex === 0 ? "queued" as const : "triage" as const,
      priority,
      metadata: {
        ...structuredClone(build.metadata),
        tenantId: build.tenantId,
        repository: build.repository,
        ref: build.ref,
        requestKey: build.requestKey,
        pipelinePhase: phase,
      },
      attempt: 0,
      createdAt: build.createdAt,
      updatedAt: build.createdAt
    };
  }));
}

export function ontologyStagePrerequisites(
  stage: Pick<OntologyStageRecord, "phase" | "stage">,
  snapshotFirst: boolean
): readonly Pick<OntologyStageRecord, "phase" | "stage">[] {
  if (stage.stage !== "ingest") return [{ phase: stage.phase, stage: "ingest" }];
  return snapshotFirst && stage.phase === "history" ? [{ phase: "snapshot", stage: "ingest" }] : [];
}

export function ontologyStageRequired(stage: Pick<OntologyStageRecord, "stage">): boolean {
  return stage.stage !== "assert";
}

function validLease(stage: MutableStage | undefined, tenantId: string, leaseId: string, now: string): boolean {
  return Boolean(stage && stage.tenantId === tenantId && stage.status === "in_progress" && stage.leaseId === leaseId &&
    stage.leaseExpiresAt && stage.leaseExpiresAt > now);
}

function clearLease(stage: MutableStage): void {
  delete stage.leaseId;
  delete stage.workerId;
  delete stage.leaseExpiresAt;
}

function stageOrder(stage: Pick<OntologyStageRecord, "phase" | "stage">): number {
  return (stage.phase === "snapshot" ? 0 : 3) + (stage.stage === "ingest" ? 0 : stage.stage === "assert" ? 1 : 2);
}

function leaseView(stage: MutableStage): OntologyStageLease {
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

function claimView(stage: MutableStage): OntologyStageClaim {
  return {
    message: { id: stage.id, topic: stage.topic, leaseId: stage.leaseId!, leaseExpiresAt: stage.leaseExpiresAt! },
    task: {
      id: stage.id,
      type: `ontology_${stage.stage}`,
      status: "in_progress",
      metadata: structuredClone(stage.metadata)
    }
  };
}
