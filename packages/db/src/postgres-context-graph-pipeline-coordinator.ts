import {
  stableId,
  contextGraphPlannedStageSpecs,
  contextGraphStagePrerequisites,
  contextGraphStageRequired,
  type ContextGraphBuildRecord,
  type ContextGraphGlobalWorkflowFilter,
  type ContextGraphPipelineBuildRequest,
  type ContextGraphPipelineCoordinator,
  type ContextGraphStageClaim,
  type ContextGraphStageCompletionReceipt,
  type ContextGraphStageLease,
  type ContextGraphStageRecord,
  type ContextGraphTaskBoardEvent,
  type ContextGraphWorkflowPage,
  type ContextGraphWorkerTopic
} from "@jina/context-graph";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export interface PostgresContextGraphPipelineCoordinatorConfig extends PoolConfig {
  readonly manageSchema?: boolean;
}

interface BuildRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  request_key: string;
  status: ContextGraphBuildRecord["status"];
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
  phase: ContextGraphStageRecord["phase"];
  stage: ContextGraphStageRecord["stage"];
  topic: ContextGraphWorkerTopic;
  status: ContextGraphStageRecord["status"];
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

/** Durable, repository-scoped contextGraph pipeline control plane. */
export class PostgresContextGraphPipelineCoordinator implements ContextGraphPipelineCoordinator {
  private readonly pool: Pool;
  private readonly manageSchema: boolean;
  private initialized?: Promise<void>;
  private claimsSinceRetentionSweep = 0;

  constructor(config: PostgresContextGraphPipelineCoordinatorConfig) {
    const { manageSchema = true, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.pool = new Pool({ ...poolConfig, application_name: "jina-context-graph-pipeline", max: poolConfig.max ?? 5 });
  }

  async createBuild(
    request: ContextGraphPipelineBuildRequest,
    authorityGuard?: (repository: string) => Promise<void>
  ): Promise<ContextGraphBuildRecord> {
    await this.initialize();
    const client = await this.pool.connect();
    const id = stableId(
      "context-graph-job",
      `${request.tenantId}:${request.repository}:${request.ref}:${request.requestKey}`
    );
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
        if (latest.rows[0] && latest.rows[0].metadata.githubHeadSha === request.dedupeHeadSha) {
          await client.query("commit");
          return buildRecord(latest.rows[0]);
        }
      }
      if (isParserRepairBuild(request)) {
        const active = await client.query<BuildRow>(
          `select * from jina_board.workflows
           where tenant_id=$1 and repository=$2 and ref_name=$3
             and status in ('queued','in_progress','enriching')
           order by created_at desc limit 1`,
          [request.tenantId, request.repository, request.ref]
        );
        if (active.rows[0]) {
          await client.query("commit");
          return buildRecord(active.rows[0]);
        }
      }
      await authorityGuard?.(request.repository);
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
        [
          id,
          request.tenantId,
          request.repository,
          request.ref,
          request.requestKey,
          request.snapshotFirst,
          JSON.stringify(request.metadata ?? {}),
          request.createdAt
        ]
      );
      await insertBoardEvent(client, request.tenantId, id, "task.created", request.createdAt, {
        type: "context_graph_build"
      });
      const stages = plannedStages(id, request);
      for (const stage of stages) {
        await client.query(
          `insert into jina_board.tasks
            (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,attempt,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,0,$14,$14)`,
          [
            stage.id,
            id,
            request.tenantId,
            request.repository,
            request.ref,
            request.requestKey,
            stage.phase,
            stage.stage,
            stage.topic,
            stage.status,
            stage.priority,
            stage.ordinal,
            JSON.stringify(stage.metadata),
            request.createdAt
          ]
        );
        await insertBoardEvent(client, request.tenantId, stage.id, "task.created", request.createdAt, {
          type: `context_graph_${stage.stage}`,
          phase: stage.phase
        });
      }
      for (const stage of stages) {
        const required = contextGraphStageRequired(stage);
        if (required) {
          await client.query(
            `insert into jina_board.dependencies
              (workflow_id,task_id,depends_on_task_id,relationship,required,blocks_parent_completion,created_at)
             values ($1,$1,$2,'blocks',true,true,$3) on conflict do nothing`,
            [id, stage.id, request.createdAt]
          );
        }
        for (const prerequisite of contextGraphStagePrerequisites(stage, request.snapshotFirst)) {
          const dependency = stages.find(
            (candidate) => candidate.phase === prerequisite.phase && candidate.stage === prerequisite.stage
          );
          if (!dependency)
            throw new Error(`missing contextGraph stage prerequisite ${prerequisite.phase}:${prerequisite.stage}`);
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

  async cancelBuild(input: {
    readonly tenantId: string;
    readonly buildId: string;
    readonly now: string;
    readonly reason: string;
  }): Promise<boolean> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const failed = await client.query(
        `update jina_board.workflows
         set status='failed',updated_at=$3
         where id=$1 and tenant_id=$2 and status in ('queued','in_progress','enriching')`,
        [input.buildId, input.tenantId, input.now]
      );
      if (failed.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }
      const canceled = await client.query<{ id: string }>(
        `update jina_board.tasks
         set status='canceled',lease_id=null,worker_id=null,lease_expires_at=null,updated_at=$3
         where build_id=$1 and tenant_id=$2 and status not in ('done','failed','canceled','superseded')
         returning id`,
        [input.buildId, input.tenantId, input.now]
      );
      await insertBoardEvent(client, input.tenantId, input.buildId, "task.transitioned", input.now, {
        toStatus: "failed",
        reason: input.reason
      });
      for (const stage of canceled.rows) {
        await insertBoardEvent(client, input.tenantId, stage.id, "task.transitioned", input.now, {
          toStatus: "canceled",
          reason: input.reason
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
    await this.initialize();
    // Claim transactions lock jina_board.tasks then jina_board.workflows and can
    // deadlock against concurrent createBuild supersede sweeps; retry 40P01.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.claimOnce(input, authorityGuard);
      } catch (error) {
        if (attempt >= 3 || (error as { code?: string }).code !== "40P01") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  private async claimOnce(
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
    const tenantIds = [...new Set(input.tenantIds?.length ? input.tenantIds : [input.tenantId])];
    const repositoryScopeTenantIds = input.repositoryScopes?.map((scope) => scope.tenantId) ?? null;
    const repositoryScopeRepositories = input.repositoryScopes?.map((scope) => scope.repository) ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // A required stage can fail while a sibling was already queued or leased.
      // Reconcile those rows before lease expiry/claim processing so terminal
      // workflows cannot retain misleading runnable work.
      const reconciled = await client.query<{ id: string; tenant_id: string; status: "canceled" | "superseded" }>(
        `update jina_board.tasks stage
         set status=case when build.status='superseded' then 'superseded' else 'canceled' end,
             lease_id=null,worker_id=null,lease_expires_at=null,updated_at=$1
         from jina_board.workflows build
         where stage.build_id=build.id and build.tenant_id=any($2::text[])
           and build.status in ('done','failed','superseded')
           and stage.status not in ('done','failed','canceled','superseded')
         returning stage.id,stage.tenant_id,stage.status`,
        [input.now, tenantIds]
      );
      for (const stage of reconciled.rows) {
        await insertBoardEvent(client, stage.tenant_id, stage.id, "task.transitioned", input.now, {
          toStatus: stage.status,
          reason: "reconciled with terminal workflow"
        });
      }
      // Requeue expired leases. The row must not carry stale timing while
      // queued, so the interrupted attempt's startedAt/duration survive only
      // in a board event — the CTE captures the pre-update columns that the
      // update itself clears.
      const expired = await client.query<{
        id: string;
        tenant_id: string;
        attempt: number;
        worker_id: string | null;
        started_at: Date | null;
      }>(
        `with expired as (
           select id,tenant_id,attempt,worker_id,started_at from jina_board.tasks
           where tenant_id=any($2::text[]) and status='in_progress' and lease_expires_at <= $1
           for update
         )
         update jina_board.tasks stage
         set status='queued',lease_id=null,worker_id=null,lease_expires_at=null,started_at=null,completed_at=null,duration_ms=null,updated_at=$1
         from expired where stage.id=expired.id
         returning expired.id,expired.tenant_id,expired.attempt,expired.worker_id,expired.started_at`,
        [input.now, tenantIds]
      );
      for (const stage of expired.rows) {
        if (!stage.started_at) continue;
        await insertBoardEvent(client, stage.tenant_id, stage.id, "task.lease_expired", input.now, {
          fromStatus: "in_progress",
          toStatus: "queued",
          attempt: stage.attempt,
          ...(stage.worker_id ? { workerId: stage.worker_id } : {}),
          startedAt: stage.started_at.toISOString(),
          endedAt: input.now,
          durationMs: Math.max(0, Date.parse(input.now) - stage.started_at.getTime())
        });
      }
      if (input.claimId) {
        const replayed = await client.query<StageRow>(
          `select stage.* from jina_board.tasks stage
           join jina_board.workflows build on build.id=stage.build_id
           where stage.tenant_id=any($1::text[]) and stage.status='in_progress'
             and stage.lease_id=$2 and stage.worker_id=$3 and stage.lease_expires_at>$4
             and stage.topic=any($5::text[]) and build.status in ('queued','in_progress','enriching')
             and (
               $6::text[] is null
               or exists (
                 select 1
                 from unnest($6::text[], $7::text[]) scope(tenant_id, repository)
                 where scope.tenant_id=stage.tenant_id and lower(scope.repository)=lower(build.repository)
               )
             )
           limit 1`,
          [
            tenantIds,
            input.claimId,
            input.workerId,
            input.now,
            input.topics,
            repositoryScopeTenantIds,
            repositoryScopeRepositories
          ]
        );
        if (replayed.rows[0]) {
          const row = replayed.rows[0];
          await authorityGuard?.({
            tenantId: row.tenant_id,
            repository: row.repository,
            metadata: row.metadata
          });
          await client.query("commit");
          return claimRecord(row);
        }
      }
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
         where stage.tenant_id=any($1::text[]) and stage.status='queued' and stage.topic=any($2::text[])
           and build.status in ('queued','in_progress','enriching')
           and (
             $3::text[] is null
             or exists (
               select 1
               from unnest($3::text[], $4::text[]) scope(tenant_id, repository)
               where scope.tenant_id=stage.tenant_id and lower(scope.repository)=lower(build.repository)
             )
           )
         order by stage.priority desc,stage.created_at,stage.id
         for update of stage skip locked limit 1`,
        [tenantIds, input.topics, repositoryScopeTenantIds, repositoryScopeRepositories]
      );
      const stage = selected.rows[0];
      if (!stage) {
        await client.query("commit");
        return undefined;
      }
      await authorityGuard?.({
        tenantId: stage.tenant_id,
        repository: stage.repository,
        metadata: stage.metadata
      });
      const leased = await client.query<StageRow>(
        `update jina_board.tasks
         set status='in_progress',attempt=attempt+1,lease_id=$2,worker_id=$3,
             lease_expires_at=$4,started_at=$5,completed_at=null,duration_ms=null,updated_at=$5
         where id=$1 returning *`,
        [stage.id, input.claimId ?? randomUUID(), input.workerId, input.leaseExpiresAt, input.now]
      );
      const row = leased.rows[0]!;
      await insertBoardEvent(client, row.tenant_id, row.id, "task.transitioned", input.now, {
        fromStatus: "queued",
        toStatus: "in_progress",
        attempt: row.attempt,
        workerId: input.workerId,
        startedAt: input.now
      });
      await client.query(`update jina_board.workflows set status=$2,updated_at=$3 where id=$1`, [
        row.build_id,
        row.phase === "history" ? "enriching" : "in_progress",
        input.now
      ]);
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
      await authorityGuard?.(stage.repository);
      await client.query(`update jina_board.tasks set lease_expires_at=$2,updated_at=$3 where id=$1`, [
        stage.id,
        input.leaseExpiresAt,
        input.now
      ]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
      await authorityGuard?.(stage.repository);
      await client.query(`update jina_board.workflows set status=$2,updated_at=$3 where id=$1`, [
        stage.build_id,
        stage.phase === "history" ? "enriching" : "in_progress",
        input.now
      ]);
      // The attempt-end timestamp is endedAt: the stage returns to queued, so
      // nothing completed. Release events written before this rename carry the
      // same value under completedAt; no in-repo consumer keys on either name.
      await insertBoardEvent(client, stage.tenant_id, stage.id, "task.transitioned", input.now, {
        fromStatus: "in_progress",
        toStatus: "queued",
        reason: input.reason,
        attempt: stage.attempt,
        startedAt: stage.started_at?.toISOString() ?? input.now,
        endedAt: input.now,
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
    readonly topic?: ContextGraphWorkerTopic;
    readonly now: string;
  }): Promise<ContextGraphStageLease | undefined> {
    await this.initialize();
    const result = await this.pool.query<StageRow>(
      `select * from jina_board.tasks
       where id=$1 and tenant_id=$2 and lease_id=$3 and status='in_progress' and lease_expires_at>$4
         and ($5::text is null or topic=$5)`,
      [input.stageId, input.tenantId, input.leaseId, input.now, input.topic ?? null]
    );
    return result.rows[0] ? leaseRecord(result.rows[0]) : undefined;
  }

  async completionReceipt(input: {
    readonly tenantId: string;
    readonly stageId: string;
    readonly leaseId: string;
  }): Promise<ContextGraphStageCompletionReceipt | undefined> {
    await this.initialize();
    const result = await this.pool.query<StageRow>(
      `select * from jina_board.tasks
       where id=$1 and tenant_id=$2 and status in ('done','failed')
         and metadata->>'completionLeaseId'=$3`,
      [input.stageId, input.tenantId, input.leaseId]
    );
    const row = result.rows[0];
    if (!row || (row.status !== "done" && row.status !== "failed")) return undefined;
    const storedResult = recordMetadata(row.metadata.result);
    return {
      stageId: row.id,
      leaseId: input.leaseId,
      tenantId: row.tenant_id,
      repository: row.repository,
      ref: row.ref_name,
      topic: row.topic,
      metadata: row.metadata,
      outcome: row.status,
      ...(storedResult ? { result: storedResult } : {})
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
      await authorityGuard?.(stage.repository);
      const metadata = {
        ...stage.metadata,
        ...(input.result ? { result: input.result } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        completionLeaseId: input.leaseId,
        completionOutcome: input.outcome
      };
      await client.query(
        `update jina_board.tasks
         set status=$2,metadata=$3::jsonb,lease_id=null,worker_id=null,lease_expires_at=null,
             completed_at=$4,duration_ms=greatest(0,round(extract(epoch from ($4::timestamptz-coalesce(started_at,$4::timestamptz)))*1000))::bigint,
             updated_at=$4
         where id=$1`,
        [stage.id, input.outcome, JSON.stringify(metadata), input.now]
      );
      // Here completedAt is accurate — the attempt end IS the stage
      // completion — and matches the row's completed_at column.
      await insertBoardEvent(client, stage.tenant_id, stage.id, "task.transitioned", input.now, {
        fromStatus: "in_progress",
        toStatus: input.outcome,
        attempt: stage.attempt,
        startedAt: stage.started_at?.toISOString() ?? input.now,
        completedAt: input.now,
        durationMs: Math.max(0, Date.parse(input.now) - (stage.started_at?.getTime() ?? Date.parse(input.now))),
        ...(input.reason ? { reason: input.reason } : {})
      });
      if (input.outcome === "failed" && contextGraphStageRequired(stage)) {
        const canceled = await client.query<{ id: string }>(
          `update jina_board.tasks
           set status='canceled',lease_id=null,worker_id=null,lease_expires_at=null,updated_at=$2
           where build_id=$1 and id<>$3
             and status not in ('done','failed','canceled','superseded')
           returning id`,
          [stage.build_id, input.now, stage.id]
        );
        for (const candidate of canceled.rows) {
          await insertBoardEvent(client, stage.tenant_id, candidate.id, "task.transitioned", input.now, {
            toStatus: "canceled"
          });
        }
        await client.query("update jina_board.workflows set status='failed',updated_at=$2 where id=$1", [
          stage.build_id,
          input.now
        ]);
        await insertBoardEvent(client, stage.tenant_id, stage.build_id, "task.transitioned", input.now, {
          toStatus: "failed"
        });
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
            fromStatus: "triage",
            toStatus: "queued"
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
        const workflowStatus: ContextGraphBuildRecord["status"] = current.required_failed
          ? "failed"
          : current.all_terminal
            ? "done"
            : current.snapshot_first && current.snapshot_published
              ? "enriching"
              : "in_progress";
        await client.query("update jina_board.workflows set status=$2,updated_at=$3 where id=$1", [
          stage.build_id,
          workflowStatus,
          input.now
        ]);
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
  ): Promise<
    readonly { readonly build: ContextGraphBuildRecord; readonly stages: readonly ContextGraphStageRecord[] }[]
  > {
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

  async listGlobal(filter: ContextGraphGlobalWorkflowFilter): Promise<ContextGraphWorkflowPage> {
    await this.initialize();
    const { where, values } = globalWorkflowWhere(filter);
    const limit = normalizedGlobalLimit(filter.limit);
    values.push(limit + 1);
    const builds = await this.pool.query<BuildRow>(
      `select * from jina_board.workflows
       ${where}
       order by created_at desc,id desc
       limit $${values.length}`,
      values
    );
    const pageRows = builds.rows.slice(0, limit);
    const stages =
      pageRows.length === 0
        ? { rows: [] as StageRow[] }
        : await this.pool.query<StageRow>(
            "select * from jina_board.tasks where build_id=any($1::text[]) order by build_id,ordinal",
            [pageRows.map((build) => build.id)]
          );
    const last = pageRows.at(-1);
    return {
      workflows: pageRows.map((build) => ({
        build: buildRecord(build),
        stages: stages.rows.filter((stage) => stage.build_id === build.id).map(stageRecord)
      })),
      ...(builds.rows.length > limit && last
        ? { nextCursor: { createdAt: last.created_at.toISOString(), id: last.id } }
        : {})
    };
  }

  async countActive(tenantId?: string): Promise<number> {
    await this.initialize();
    const result = await this.pool.query<{ count: string }>(
      `select count(*) from jina_board.workflows
       where status in ('queued','in_progress','enriching')
         and ($1::text is null or tenant_id=$1::text)`,
      [tenantId ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listEvents(
    tenantId: string,
    filter?: { readonly taskIds?: readonly string[] }
  ): Promise<readonly ContextGraphTaskBoardEvent[]> {
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
                         and pg_get_constraintdef(oid) like '%duration_ms%')
           -- A pre-rename database passes every check above but still
           -- constrains topic to the run-ontology-* vocabulary only; it must
           -- take the DDL path so the topic migration runs. The replacement
           -- constraint deliberately allows both vocabularies, so its
           -- definition also mentions run-ontology-: a check counts as legacy
           -- only when it does NOT mention run-context-graph-.
           and not exists (select 1 from pg_constraint
                           where conrelid=to_regclass('jina_board.tasks') and contype='c'
                             and pg_get_constraintdef(oid) like '%run-ontology-%'
                             and pg_get_constraintdef(oid) not like '%run-context-graph-%') as ready`
      );
      let ready = probe.rows[0]?.ready ?? false;
      if (ready) {
        // A database whose constraint was already migrated (or that raced past
        // the constraint fix) can still hold pre-rename rows the renamed
        // workers never claim; those must send it down the DDL path so the
        // one-time topic row migration runs. This is a plain snapshot read
        // (AccessShare only, no relation DDL locks), but it cannot live inside
        // the catalog probe above: referencing jina_board.tasks directly would
        // fail to parse on a fresh database, so it only runs once the catalog
        // probe has confirmed the table exists.
        const drained = await client.query<{ drained: boolean }>(
          `select not exists (
             select 1 from jina_board.tasks
             where topic like 'run-ontology-%' and status in ('triage','queued','in_progress')
           ) as drained`
        );
        ready = drained.rows[0]?.drained ?? false;
      }
      if (!ready) await client.query(PIPELINE_SCHEMA_SQL);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function normalizedGlobalLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("global workflow limit must be an integer from 1 to 500");
  }
  return limit;
}

function globalWorkflowWhere(filter: ContextGraphGlobalWorkflowFilter): {
  readonly where: string;
  readonly values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const parameter = (value: unknown, cast = ""): string => {
    values.push(value);
    return `$${values.length}${cast}`;
  };
  if (filter.cursor) {
    const createdAt = parameter(filter.cursor.createdAt, "::timestamptz");
    const id = parameter(filter.cursor.id, "::text");
    clauses.push(`(created_at,id)<(${createdAt},${id})`);
  }
  if (filter.tenantId) clauses.push(`tenant_id=${parameter(filter.tenantId, "::text")}`);
  if (filter.repository) clauses.push(`repository=${parameter(filter.repository, "::text")}`);
  if (filter.statuses) clauses.push(`status=any(${parameter([...filter.statuses], "::text[]")})`);
  if (filter.trigger) {
    const source =
      "lower(coalesce(metadata->>'githubEventName',metadata->>'eventName',metadata->>'trigger',metadata->>'source',''))";
    clauses.push(
      `(case
        when ${source} like '%schedule%' then 'scheduled'
        when ${source} like '%webhook%' or ${source} like '%push%' or ${source} like '%github%' then 'webhook'
        when ${source} like '%manual%' or request_key like 'admin-%' then 'manual'
        else 'api'
      end)=${parameter(filter.trigger, "::text")}`
    );
  }
  if (filter.query) {
    const query = parameter(`%${filter.query}%`, "::text");
    clauses.push(
      `(repository ilike ${query} or tenant_id::text ilike ${query} or ref_name ilike ${query}
        or id ilike ${query} or request_key ilike ${query})`
    );
  }
  if (filter.createdAfter) clauses.push(`created_at>=${parameter(filter.createdAfter, "::timestamptz")}`);
  if (filter.activityAfter) {
    const after = parameter(filter.activityAfter, "::timestamptz");
    clauses.push(`(created_at>=${after} or updated_at>=${after})`);
  }
  return {
    where: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
    values
  };
}

function plannedStages(
  buildId: string,
  request: ContextGraphPipelineBuildRequest
): {
  readonly id: string;
  readonly phase: "snapshot" | "history";
  readonly stage: "ingest" | "assert" | "project";
  readonly topic: ContextGraphWorkerTopic;
  readonly status: "queued" | "triage";
  readonly priority: number;
  readonly ordinal: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}[] {
  return contextGraphPlannedStageSpecs(request.snapshotFirst, isParserRepairBuild(request)).map(
    ({ phase, priority, stage, ordinal }) => ({
      id: stableId("context-graph-stage", `${buildId}:${phase}:${stage}`),
      phase,
      stage,
      topic: `run-context-graph-${stage}` as ContextGraphWorkerTopic,
      status: ordinal === 0 ? ("queued" as const) : ("triage" as const),
      priority,
      ordinal,
      metadata: {
        ...request.metadata,
        tenantId: request.tenantId,
        repository: request.repository,
        ref: request.ref,
        requestKey: request.requestKey,
        pipelinePhase: phase
      }
    })
  );
}

function isParserRepairBuild(value: { readonly metadata?: Readonly<Record<string, unknown>> }): boolean {
  return value.metadata?.repairOnly === true;
}

function buildRecord(row: BuildRow): ContextGraphBuildRecord {
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

function stageRecord(row: StageRow): ContextGraphStageRecord {
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

function leaseRecord(row: StageRow): ContextGraphStageLease {
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

function claimRecord(row: StageRow): ContextGraphStageClaim {
  return {
    message: {
      id: row.id,
      topic: row.topic,
      leaseId: row.lease_id!,
      leaseExpiresAt: row.lease_expires_at!.toISOString()
    },
    task: { id: row.id, type: `context_graph_${row.stage}`, status: "in_progress", metadata: row.metadata }
  };
}

function recordMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
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
    topic text not null check (topic in ('run-context-graph-ingest','run-context-graph-assert','run-context-graph-project')),
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
  -- The context-graph rename changed the worker topic vocabulary, but "create
  -- table if not exists" never touches an existing table: a database created
  -- before the rename still constrains topic to the run-ontology-* values and
  -- rejects every new task. Drop every check that pins the legacy-only
  -- vocabulary (whatever name it carries) and install one named replacement
  -- that allows BOTH vocabularies. Both sets are required: legacy queued and
  -- leased rows still exist, Postgres re-evaluates check constraints on ANY
  -- update to a row (superseding or canceling a legacy task would fail under
  -- a new-only check), and adding a new-only constraint would not even
  -- validate against those legacy rows. The legacy-only detection excludes
  -- definitions that already mention run-context-graph- so the replacement
  -- constraint itself never matches and the migration stays idempotent.
  do $$
  declare
    legacy_check record;
    had_legacy boolean := false;
  begin
    for legacy_check in
      select conname from pg_constraint
      where conrelid='jina_board.tasks'::regclass and contype='c'
        and pg_get_constraintdef(oid) like '%run-ontology-%'
        and pg_get_constraintdef(oid) not like '%run-context-graph-%'
    loop
      had_legacy := true;
      execute format('alter table jina_board.tasks drop constraint %I', legacy_check.conname);
    end loop;
    if had_legacy and not exists (
      select 1 from pg_constraint
      where conrelid='jina_board.tasks'::regclass and conname='task_board_tasks_topic_check'
    ) then
      alter table jina_board.tasks add constraint task_board_tasks_topic_check
        check (topic in (
          'run-ontology-ingest','run-ontology-assert','run-ontology-project',
          'run-context-graph-ingest','run-context-graph-assert','run-context-graph-project'
        ));
    end if;
  end $$;
  -- Drain stranded pre-rename work: rows created before the context-graph
  -- rename still carry run-ontology-* topics that the renamed workers never
  -- poll, so non-terminal rows would sit unclaimed forever. Rewrite exactly
  -- the non-terminal statuses to the new vocabulary; terminal rows keep their
  -- historical topics. Idempotent: a second apply matches no rows. A lease on
  -- a rewritten in_progress row belongs to a retired pre-rename worker whose
  -- renew/release/complete key on task id + lease id, never topic; that lease
  -- simply expires and the sweep requeues the row under its claimable topic.
  update jina_board.tasks
  set topic = replace(topic,'run-ontology-','run-context-graph-')
  where topic like 'run-ontology-%' and status in ('triage','queued','in_progress');
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
