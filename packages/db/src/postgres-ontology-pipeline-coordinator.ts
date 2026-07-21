import {
  stableId,
  ontologyStagePrerequisites,
  ontologyStageRequired,
  type OntologyBuildRecord,
  type OntologyPipelineBuildRequest,
  type OntologyPipelineCoordinator,
  type OntologyStageClaim,
  type OntologyStageLease,
  type OntologyStageRecord,
  type OntologyTaskBoardEvent,
  type OntologyWorkerTopic
} from "@jina/ontology";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export interface PostgresOntologyPipelineCoordinatorConfig extends PoolConfig {
  readonly manageSchema?: boolean;
}

interface BuildRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  request_key: string;
  status: OntologyBuildRecord["status"];
  snapshot_first: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface StageRow {
  id: string;
  build_id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  request_key: string;
  phase: OntologyStageRecord["phase"];
  stage: OntologyStageRecord["stage"];
  topic: OntologyWorkerTopic;
  status: OntologyStageRecord["status"];
  priority: number;
  ordinal: number;
  metadata: Record<string, unknown>;
  attempt: number;
  lease_id: string | null;
  worker_id: string | null;
  lease_expires_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  /** pg returns int8 as a string; stageRecord() normalizes with Number(...). */
  duration_ms: string | number | null;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  id: string;
  task_id: string;
  type: string;
  at: Date;
  payload: Record<string, unknown>;
}

/** Durable, repository-scoped ontology pipeline control plane. */
export class PostgresOntologyPipelineCoordinator implements OntologyPipelineCoordinator {
  private readonly pool: Pool;
  private readonly manageSchema: boolean;
  private initialized?: Promise<void>;
  private claimsSinceRetentionSweep = 0;

  constructor(config: PostgresOntologyPipelineCoordinatorConfig) {
    const { manageSchema = true, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.pool = new Pool({ ...poolConfig, application_name: "jina-ontology-pipeline", max: poolConfig.max ?? 5 });
  }

  async createBuild(request: OntologyPipelineBuildRequest): Promise<OntologyBuildRecord> {
    await this.initialize();
    const client = await this.pool.connect();
    const id = stableId("ontology-job", `${request.tenantId}:${request.repository}:${request.ref}:${request.requestKey}`);
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${request.tenantId}:${request.repository}:${request.ref}`
      ]);
      const existing = await client.query<BuildRow>("select * from jina_board.workflows where id=$1", [id]);
      if (existing.rows[0]) {
        await client.query("commit");
        return buildRecord(existing.rows[0]);
      }
      if (request.dedupeHeadSha) {
        const latest = await client.query<BuildRow>(
          `select * from jina_board.workflows where tenant_id=$1 and repository=$2 and ref_name=$3
           order by created_at desc limit 1`,
          [request.tenantId, request.repository, request.ref]
        );
        if (latest.rows[0] && (latest.rows[0].metadata as Record<string, unknown>).githubHeadSha === request.dedupeHeadSha) {
          await client.query("commit");
          return buildRecord(latest.rows[0]);
        }
      }
      const supersededBuilds = await client.query<{ id: string }>(
        `update jina_board.workflows
         set status='superseded',updated_at=$4
         where tenant_id=$1 and repository=$2 and ref_name=$3
           and status in ('queued','in_progress','enriching')
         returning id`,
        [request.tenantId, request.repository, request.ref, request.createdAt]
      );
      for (const build of supersededBuilds.rows) {
        await insertBoardEvent(client, request.tenantId, build.id, "task.transitioned", request.createdAt, {
          toStatus: "superseded"
        });
      }
      const superseded = await client.query<{ id: string }>(
        `update jina_board.tasks stage
         set status='superseded',lease_id=null,worker_id=null,lease_expires_at=null,updated_at=$4
         from jina_board.workflows build
         where stage.build_id=build.id and build.tenant_id=$1 and build.repository=$2 and build.ref_name=$3
           and build.status='superseded' and stage.status not in ('done','failed','canceled','superseded')
         returning stage.id`,
        [request.tenantId, request.repository, request.ref, request.createdAt]
      );
      for (const stage of superseded.rows) {
        await insertBoardEvent(client, request.tenantId, stage.id, "task.transitioned", request.createdAt, {
          toStatus: "superseded"
        });
      }
      const inserted = await client.query<BuildRow>(
        `insert into jina_board.workflows
          (id,tenant_id,repository,ref_name,request_key,status,snapshot_first,metadata,created_at,updated_at)
         values ($1,$2,$3,$4,$5,'queued',$6,$7::jsonb,$8,$8) returning *`,
        [id, request.tenantId, request.repository, request.ref, request.requestKey, request.snapshotFirst,
          JSON.stringify(request.metadata ?? {}), request.createdAt]
      );
      await insertBoardEvent(client, request.tenantId, id, "task.created", request.createdAt, { type: "ontology_build" });
      const stages = plannedStages(id, request);
      for (const stage of stages) {
        await client.query(
          `insert into jina_board.tasks
            (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,attempt,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,0,$14,$14)`,
          [stage.id, id, request.tenantId, request.repository, request.ref, request.requestKey, stage.phase, stage.stage,
            stage.topic, stage.status, stage.priority, stage.ordinal, JSON.stringify(stage.metadata), request.createdAt]
        );
        await insertBoardEvent(client, request.tenantId, stage.id, "task.created", request.createdAt, {
          type: `ontology_${stage.stage}`,
          phase: stage.phase
        });
      }
      for (const stage of stages) {
        const required = ontologyStageRequired(stage);
        if (required) {
          await client.query(
            `insert into jina_board.dependencies
              (workflow_id,task_id,depends_on_task_id,relationship,required,blocks_parent_completion,created_at)
             values ($1,$1,$2,'blocks',true,true,$3) on conflict do nothing`,
            [id, stage.id, request.createdAt]
          );
        }
        for (const prerequisite of ontologyStagePrerequisites(stage, request.snapshotFirst)) {
          const dependency = stages.find((candidate) =>
            candidate.phase === prerequisite.phase && candidate.stage === prerequisite.stage
          );
          if (!dependency) throw new Error(`missing ontology stage prerequisite ${prerequisite.phase}:${prerequisite.stage}`);
          await client.query(
            `insert into jina_board.dependencies
              (workflow_id,task_id,depends_on_task_id,relationship,required,blocks_parent_completion,created_at)
             values ($1,$2,$3,'blocks',true,$4,$5) on conflict do nothing`,
            [id, stage.id, dependency.id, required, request.createdAt]
          );
        }
      }
      await client.query("commit");
      return buildRecord(inserted.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly topics: readonly OntologyWorkerTopic[];
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<OntologyStageClaim | undefined> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update jina_board.tasks
         set status='queued',lease_id=null,worker_id=null,lease_expires_at=null,started_at=null,completed_at=null,duration_ms=null,updated_at=$1
         where tenant_id=$2 and status='in_progress' and lease_expires_at <= $1`,
        [input.now, input.tenantId]
      );
      // Cheap probabilistic retention: roughly one in fifty claims prunes
      // month-old board events and terminal workflows. Deleting a workflow
      // cascades to tasks/dependencies/checkpoints via FKs; events carry no FK
      // and are deleted explicitly. The newest build per (repository, ref) is
      // always kept so head-SHA dedup keeps working regardless of age.
      if (this.claimsSinceRetentionSweep++ % 50 === 0) {
        const retentionCutoff = new Date(Date.parse(input.now) - 30 * 24 * 60 * 60 * 1000).toISOString();
        await client.query(
          `with keepers as (
             select distinct on (repository,ref_name) id
             from jina_board.workflows where tenant_id=$1
             order by repository,ref_name,created_at desc,id
           ),
           expired_workflows as (
             select build.id from jina_board.workflows build
             where build.tenant_id=$1
               and build.status in ('done','failed','canceled','superseded')
               and build.updated_at < $2
               and not exists (select 1 from keepers where keepers.id=build.id)
           ),
           expired_stages as (
             select stage.id from jina_board.tasks stage
             join expired_workflows on expired_workflows.id=stage.build_id
           ),
           pruned_events as (
             delete from jina_board.events
             where tenant_id=$1
               and (task_id in (select id from expired_workflows)
                 or task_id in (select id from expired_stages)
                 or (at < $2 and not exists (
                   select 1 from jina_board.workflows live where live.tenant_id=$1 and live.id=jina_board.events.task_id
                 ) and not exists (
                   select 1 from jina_board.tasks stage where stage.tenant_id=$1 and stage.id=jina_board.events.task_id
                 )))
           )
           delete from jina_board.workflows
           where id in (select id from expired_workflows)`,
          [input.tenantId, retentionCutoff]
        );
      }
      const selected = await client.query<StageRow>(
        `select stage.* from jina_board.tasks stage
         join jina_board.workflows build on build.id=stage.build_id
         where stage.tenant_id=$1 and stage.status='queued' and stage.topic=any($2::text[])
           and build.status in ('queued','in_progress','enriching')
         order by stage.priority desc,stage.created_at,stage.id
         for update of stage skip locked limit 1`,
        [input.tenantId, input.topics]
      );
      const stage = selected.rows[0];
      if (!stage) {
        await client.query("commit");
        return undefined;
      }
      const leased = await client.query<StageRow>(
        `update jina_board.tasks
         set status='in_progress',attempt=attempt+1,lease_id=$2,worker_id=$3,
             lease_expires_at=$4,started_at=$5,completed_at=null,duration_ms=null,updated_at=$5
         where id=$1 returning *`,
        [stage.id, randomUUID(), input.workerId, input.leaseExpiresAt, input.now]
      );
      const row = leased.rows[0]!;
      await insertBoardEvent(client, row.tenant_id, row.id, "task.transitioned", input.now, {
        fromStatus: "queued", toStatus: "in_progress", attempt: row.attempt, workerId: input.workerId,
        startedAt: input.now
      });
      await client.query(
        `update jina_board.workflows set status=$2,updated_at=$3 where id=$1`,
        [row.build_id, row.phase === "history" ? "enriching" : "in_progress", input.now]
      );
      await insertBoardEvent(client, row.tenant_id, row.build_id, "task.updated", input.now, {
        workflowStatus: row.phase === "history" ? "enriching" : "in_progress"
      });
      await client.query("commit");
      return claimRecord(row);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      `update jina_board.tasks set lease_expires_at=$5,updated_at=$4
       where id=$1 and tenant_id=$2 and lease_id=$3 and status='in_progress' and lease_expires_at>$4`,
      [input.stageId, input.tenantId, input.leaseId, input.now, input.leaseExpiresAt]
    );
    return result.rowCount === 1;
  }

  async release(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly now: string;
    readonly reason: string;
  }): Promise<boolean> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const released = await client.query<StageRow>(
        `update jina_board.tasks
         set status='queued',lease_id=null,worker_id=null,lease_expires_at=null,updated_at=$4
         where id=$1 and tenant_id=$2 and lease_id=$3 and status='in_progress' and lease_expires_at>$4
         returning *`,
        [input.stageId, input.tenantId, input.leaseId, input.now]
      );
      const stage = released.rows[0];
      if (!stage) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `update jina_board.workflows set status=$2,updated_at=$3 where id=$1`,
        [stage.build_id, stage.phase === "history" ? "enriching" : "in_progress", input.now]
      );
      await insertBoardEvent(client, stage.tenant_id, stage.id, "task.transitioned", input.now, {
        fromStatus: "in_progress", toStatus: "queued", reason: input.reason,
        attempt: stage.attempt,
        startedAt: stage.started_at?.toISOString() ?? input.now,
        completedAt: input.now,
        durationMs: Math.max(0, Date.parse(input.now) - (stage.started_at?.getTime() ?? Date.parse(input.now)))
      });
      await client.query("update jina_board.tasks set started_at=null where id=$1", [stage.id]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async leasedStage(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly topic?: OntologyWorkerTopic;
    readonly now: string;
  }): Promise<OntologyStageLease | undefined> {
    await this.initialize();
    const result = await this.pool.query<StageRow>(
      `select * from jina_board.tasks
       where id=$1 and tenant_id=$2 and lease_id=$3 and status='in_progress' and lease_expires_at>$4
         and ($5::text is null or topic=$5)`,
      [input.stageId, input.tenantId, input.leaseId, input.now, input.topic ?? null]
    );
    return result.rows[0] ? leaseRecord(result.rows[0]) : undefined;
  }

  async complete(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly outcome: "done" | "failed";
    readonly now: string;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly nextMetadata?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
  }): Promise<boolean> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<StageRow>(
        `select * from jina_board.tasks
         where id=$1 and tenant_id=$2 and lease_id=$3 and status='in_progress' and lease_expires_at>$4
         for update`,
        [input.stageId, input.tenantId, input.leaseId, input.now]
      );
      const stage = selected.rows[0];
      if (!stage) {
        await client.query("rollback");
        return false;
      }
      const metadata = {
        ...stage.metadata,
        ...(input.result ? { result: input.result } : {}),
        ...(input.reason ? { reason: input.reason } : {})
      };
      await client.query(
        `update jina_board.tasks
         set status=$2,metadata=$3::jsonb,lease_id=null,worker_id=null,lease_expires_at=null,
             completed_at=$4,duration_ms=greatest(0,round(extract(epoch from ($4::timestamptz-coalesce(started_at,$4::timestamptz)))*1000))::bigint,
             updated_at=$4
         where id=$1`,
        [stage.id, input.outcome, JSON.stringify(metadata), input.now]
      );
      await insertBoardEvent(client, stage.tenant_id, stage.id, "task.transitioned", input.now, {
        fromStatus: "in_progress", toStatus: input.outcome, attempt: stage.attempt,
        startedAt: stage.started_at?.toISOString() ?? input.now,
        completedAt: input.now,
        durationMs: Math.max(0, Date.parse(input.now) - (stage.started_at?.getTime() ?? Date.parse(input.now))),
        ...(input.reason ? { reason: input.reason } : {})
      });
      if (input.outcome === "failed" && ontologyStageRequired(stage)) {
        await client.query(
          `update jina_board.tasks set status='canceled',updated_at=$2
           where build_id=$1 and status='triage'`,
          [stage.build_id, input.now]
        );
        await client.query("update jina_board.workflows set status='failed',updated_at=$2 where id=$1", [stage.build_id, input.now]);
        await insertBoardEvent(client, stage.tenant_id, stage.build_id, "task.transitioned", input.now, { toStatus: "failed" });
      } else {
        const ready = await client.query<StageRow>(
          `with ready as (
             select candidate.id
             from jina_board.tasks candidate
             where candidate.build_id=$1 and candidate.status='triage'
               and not exists (
                 select 1
                 from jina_board.dependencies dependency
                 join jina_board.tasks prerequisite on prerequisite.id=dependency.depends_on_task_id
                 where dependency.workflow_id=$1 and dependency.task_id=candidate.id
                   and prerequisite.status<>'done'
               )
             order by candidate.ordinal
             for update of candidate skip locked
           )
           update jina_board.tasks candidate
           set status='queued',
               metadata=case when candidate.phase=$2 then candidate.metadata || $3::jsonb else candidate.metadata end,
               updated_at=$4
           from ready where candidate.id=ready.id returning candidate.*`,
          [stage.build_id, stage.phase, JSON.stringify(input.nextMetadata ?? {}), input.now]
        );
        for (const candidate of ready.rows) {
          await insertBoardEvent(client, candidate.tenant_id, candidate.id, "task.transitioned", input.now, {
            fromStatus: "triage", toStatus: "queued"
          });
        }
        const state = await client.query<{
          snapshot_first: boolean;
          required_failed: boolean;
          all_terminal: boolean;
          snapshot_published: boolean;
        }>(
          `select build.snapshot_first,
                  bool_or(stage.stage<>'assert' and stage.status='failed') as required_failed,
                  bool_and(stage.status in ('done','failed','canceled','superseded')) as all_terminal,
                  bool_or(stage.phase='snapshot' and stage.stage='project' and stage.status='done') as snapshot_published
           from jina_board.workflows build
           join jina_board.tasks stage on stage.build_id=build.id
           where build.id=$1 group by build.snapshot_first`,
          [stage.build_id]
        );
        const current = state.rows[0]!;
        const workflowStatus: OntologyBuildRecord["status"] = current.required_failed
          ? "failed"
          : current.all_terminal
            ? "done"
            : current.snapshot_first && current.snapshot_published
              ? "enriching"
              : "in_progress";
        await client.query(
          "update jina_board.workflows set status=$2,updated_at=$3 where id=$1",
          [stage.build_id, workflowStatus, input.now]
        );
        await insertBoardEvent(client, stage.tenant_id, stage.build_id, "task.updated", input.now, {
          workflowStatus,
          queuedStageIds: ready.rows.map((candidate) => candidate.id)
        });
      }
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async checkpoint(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
    readonly name: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly now: string;
  }): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      `insert into jina_board.task_checkpoints (stage_id,name,value,updated_at)
       select id,$4,$5::jsonb,$6 from jina_board.tasks
       where id=$1 and tenant_id=$2 and lease_id=$3 and status='in_progress' and lease_expires_at>$6
       on conflict (stage_id,name) do update set value=excluded.value,updated_at=excluded.updated_at
       returning stage_id`,
      [input.stageId, input.tenantId, input.leaseId, input.name, JSON.stringify(input.value), input.now]
    );
    return result.rowCount === 1;
  }

  async list(
    tenantId: string,
    filter?: { readonly repositories?: readonly string[] }
  ): Promise<readonly { readonly build: OntologyBuildRecord; readonly stages: readonly OntologyStageRecord[] }[]> {
    await this.initialize();
    // The row cap applies after any repository filter so a busy tenant cannot
    // push an authorized repository's history out of the window.
    const builds = filter?.repositories
      ? await this.pool.query<BuildRow>(
        "select * from jina_board.workflows where tenant_id=$1 and repository=any($2::text[]) order by created_at desc,id limit 200",
        [tenantId, [...filter.repositories]]
      )
      : await this.pool.query<BuildRow>(
        "select * from jina_board.workflows where tenant_id=$1 order by created_at desc,id limit 200",
        [tenantId]
      );
    const stages = await this.pool.query<StageRow>(
      "select * from jina_board.tasks where tenant_id=$1 and build_id=any($2::text[]) order by build_id,ordinal",
      [tenantId, builds.rows.map((build) => build.id)]
    );
    return builds.rows.map((build) => ({
      build: buildRecord(build),
      stages: stages.rows.filter((stage) => stage.build_id === build.id).map(stageRecord)
    }));
  }

  async listEvents(
    tenantId: string,
    filter?: { readonly taskIds?: readonly string[] }
  ): Promise<readonly OntologyTaskBoardEvent[]> {
    await this.initialize();
    // Cap the read to the latest 1000 events after any task filter, then
    // restore ascending insertion order: the /events handler assigns seq
    // positionally and acceptance tooling reads the tail as the most recent
    // failures.
    const events = filter?.taskIds
      ? await this.pool.query<EventRow>(
        "select id::text,task_id,type,at,payload from jina_board.events where tenant_id=$1 and task_id=any($2::text[]) order by id desc limit 1000",
        [tenantId, [...filter.taskIds]]
      )
      : await this.pool.query<EventRow>(
        "select id::text,task_id,type,at,payload from jina_board.events where tenant_id=$1 order by id desc limit 1000",
        [tenantId]
      );
    return events.rows.reverse().map((event) => ({
      id: `task-board-event-${event.id}`,
      taskId: event.task_id,
      type: event.type,
      at: event.at.toISOString(),
      payload: event.payload
    }));
  }

  async ping(): Promise<void> {
    await this.initialize();
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.manageSchema ? this.createSchema() : Promise.resolve();
    return this.initialized;
  }

  // Applying PIPELINE_SCHEMA_SQL as one multi-statement transaction takes
  // strong relation locks even when every statement is a no-op ("create index
  // if not exists" holds SHARE on the table, "alter table" ACCESS EXCLUSIVE),
  // so a coordinator initializing lazily could deadlock against another
  // instance's in-flight claim transaction (CI hit exactly that: 40P01).
  // Two guards prevent DDL from ever interleaving with other sessions:
  // a transaction-scoped advisory lock serializes concurrent schema applies,
  // and a catalog probe skips the DDL entirely (taking only catalog reads,
  // no table locks) once the schema is current — first-time DDL then only
  // runs while the tables it locks cannot be in use yet.
  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_board.schema'))");
      const probe = await client.query<{ ready: boolean }>(
        `select to_regclass('jina_board.task_checkpoints') is not null
           and (select count(*) from pg_attribute
                where attrelid=to_regclass('jina_board.tasks')
                  and attname in ('started_at','completed_at','duration_ms') and not attisdropped) = 3
           and exists (select 1 from pg_constraint
                       where conrelid=to_regclass('jina_board.tasks') and contype='c'
                         and pg_get_constraintdef(oid) like '%duration_ms%') as ready`
      );
      if (!probe.rows[0]?.ready) await client.query(PIPELINE_SCHEMA_SQL);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function plannedStages(buildId: string, request: OntologyPipelineBuildRequest): Array<{
  readonly id: string;
  readonly phase: "snapshot" | "history";
  readonly stage: "ingest" | "assert" | "project";
  readonly topic: OntologyWorkerTopic;
  readonly status: "queued" | "triage";
  readonly priority: number;
  readonly ordinal: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}> {
  const phases = request.snapshotFirst
    ? [{ phase: "snapshot" as const, priority: 100 }, { phase: "history" as const, priority: 10 }]
    : [{ phase: "history" as const, priority: 50 }];
  return phases.flatMap(({ phase, priority }, phaseIndex) =>
    (["ingest", "assert", "project"] as const).map((stage, stageIndex) => ({
      id: stableId("ontology-stage", `${buildId}:${phase}:${stage}`),
      phase,
      stage,
      topic: `run-ontology-${stage}` as OntologyWorkerTopic,
      status: phaseIndex === 0 && stageIndex === 0 ? "queued" as const : "triage" as const,
      priority,
      ordinal: phaseIndex * 3 + stageIndex,
      metadata: {
        ...request.metadata,
        tenantId: request.tenantId,
        repository: request.repository,
        ref: request.ref,
        requestKey: request.requestKey,
        pipelinePhase: phase,
      }
    }))
  );
}

function buildRecord(row: BuildRow): OntologyBuildRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    requestKey: row.request_key,
    status: row.status,
    snapshotFirst: row.snapshot_first,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function stageRecord(row: StageRow): OntologyStageRecord {
  return {
    id: row.id,
    buildId: row.build_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    requestKey: row.request_key,
    phase: row.phase,
    stage: row.stage,
    topic: row.topic,
    status: row.status,
    priority: row.priority,
    metadata: row.metadata,
    attempt: row.attempt,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.toISOString() } : {}),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function leaseRecord(row: StageRow): OntologyStageLease {
  return {
    stageId: row.id,
    leaseId: row.lease_id!,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    topic: row.topic,
    metadata: row.metadata
  };
}

function claimRecord(row: StageRow): OntologyStageClaim {
  return {
    message: { id: row.id, topic: row.topic, leaseId: row.lease_id!, leaseExpiresAt: row.lease_expires_at!.toISOString() },
    task: { id: row.id, type: `ontology_${row.stage}`, status: "in_progress", metadata: row.metadata }
  };
}

async function insertBoardEvent(
  client: PoolClient,
  tenantId: string,
  taskId: string,
  type: string,
  at: string,
  payload: Readonly<Record<string, unknown>>
): Promise<void> {
  await client.query(
    `insert into jina_board.events (tenant_id,task_id,type,at,payload)
     values ($1,$2,$3,$4,$5::jsonb)`,
    [tenantId, taskId, type, at, JSON.stringify(payload)]
  );
}

const PIPELINE_SCHEMA_SQL = `
  create schema if not exists jina_board;
  create table if not exists jina_board.workflows (
    id text primary key,
    tenant_id text not null,
    repository text not null,
    ref_name text not null,
    request_key text not null,
    status text not null check (status in ('queued','in_progress','enriching','done','failed','superseded')),
    snapshot_first boolean not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (tenant_id,repository,ref_name,request_key)
  );
  create index if not exists task_board_workflows_repository_idx
    on jina_board.workflows (tenant_id,repository,ref_name,created_at desc);

  create table if not exists jina_board.tasks (
    id text primary key,
    build_id text not null references jina_board.workflows(id) on delete cascade,
    tenant_id text not null,
    repository text not null,
    ref_name text not null,
    request_key text not null,
    phase text not null check (phase in ('snapshot','history')),
    stage text not null check (stage in ('ingest','assert','project')),
    topic text not null check (topic in ('run-ontology-ingest','run-ontology-assert','run-ontology-project')),
    status text not null check (status in ('triage','queued','in_progress','done','failed','canceled','superseded')),
    priority integer not null,
    ordinal integer not null,
    metadata jsonb not null default '{}'::jsonb,
    attempt integer not null default 0,
    lease_id text,
    worker_id text,
    lease_expires_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    duration_ms bigint check (duration_ms is null or duration_ms>=0),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (build_id,phase,stage)
  );
  alter table jina_board.tasks add column if not exists started_at timestamptz;
  alter table jina_board.tasks add column if not exists completed_at timestamptz;
  alter table jina_board.tasks add column if not exists duration_ms bigint;
  do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conrelid='jina_board.tasks'::regclass and contype='c'
        and pg_get_constraintdef(oid) like '%duration_ms%'
    ) then
      alter table jina_board.tasks
        add constraint task_board_tasks_duration_ms_check check (duration_ms is null or duration_ms>=0);
    end if;
  end $$;
  create index if not exists task_board_tasks_claim_idx
    on jina_board.tasks (tenant_id,status,topic,priority desc,created_at);
  create index if not exists task_board_tasks_lease_idx
    on jina_board.tasks (tenant_id,id,lease_id,lease_expires_at) where status='in_progress';

  create table if not exists jina_board.dependencies (
    workflow_id text not null references jina_board.workflows(id) on delete cascade,
    task_id text not null,
    depends_on_task_id text not null,
    relationship text not null,
    required boolean not null,
    blocks_parent_completion boolean not null,
    created_at timestamptz not null,
    primary key (workflow_id,task_id,depends_on_task_id,relationship)
  );

  create table if not exists jina_board.events (
    id bigint generated always as identity primary key,
    tenant_id text not null,
    task_id text not null,
    type text not null,
    at timestamptz not null,
    payload jsonb not null default '{}'::jsonb
  );
  create index if not exists task_board_events_task_idx
    on jina_board.events (tenant_id,task_id,id);

  create table if not exists jina_board.task_checkpoints (
    stage_id text not null references jina_board.tasks(id) on delete cascade,
    name text not null,
    value jsonb not null,
    updated_at timestamptz not null,
    primary key (stage_id,name)
  );
`;
