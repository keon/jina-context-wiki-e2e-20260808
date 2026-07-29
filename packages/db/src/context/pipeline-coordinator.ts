import type { DerivationDetail } from "@jina/context-engine";
import { randomUUID } from "node:crypto";
import {
  contextQueueTopics,
  contextTaskTypes,
  isFullCommitSha,
  stableId,
  type ContextBuild,
  type ContextPipelineCoordinator,
  type ContextPipelineStage,
  type ContextQueueTopic,
  type ContextWriteFence
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString, type PostgresContextDatabaseConfig } from "./database.js";

interface BuildRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  ref_sequence: string;
  request_key: string;
  status: ContextBuild["status"];
  created_at: Date;
  completed_at: Date | null;
}

interface StageRow {
  id: string;
  build_id: string;
  type: ContextPipelineStage["type"];
  topic: ContextQueueTopic;
  required: boolean;
  status: ContextPipelineStage["status"];
  attempt: number;
  metadata: Record<string, unknown>;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
  lease_id: string | null;
  lease_expires_at: Date | null;
  fence_token: string | null;
}

export class PostgresContextPipelineCoordinator implements ContextPipelineCoordinator {
  private readonly database: ContextDatabase;

  constructor(config: PostgresContextDatabaseConfig | ContextDatabase) {
    this.database = config instanceof ContextDatabase ? config : new ContextDatabase(config);
  }

  async createBuild(input: {
    tenantId: string;
    repository: string;
    ref: string;
    commitSha?: string;
    githubInstallationId?: number;
    requestKey: string;
    createdAt: string;
    derivationDetail?: DerivationDetail;
    derivationBudgetSeconds?: number;
  }): Promise<ContextBuild> {
    if (input.commitSha !== undefined && !isFullCommitSha(input.commitSha)) {
      throw new Error("commitSha must be a full Git SHA");
    }
    if (
      input.githubInstallationId !== undefined &&
      (!Number.isSafeInteger(input.githubInstallationId) || input.githubInstallationId <= 0)
    ) {
      throw new Error("githubInstallationId must be a positive integer");
    }
    return this.database.transactionAs("jina_context_coordinator", { tenantIds: [input.tenantId] }, async (client) => {
      const id = stableId("cb", { tenantId: input.tenantId, requestKey: input.requestKey });
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `context-generation-ref:${input.tenantId}:${input.repository}:${input.ref}`
      ]);
      await client.query(
        `insert into jina_context.repositories
          (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
         values ($1,$2,'unknown',$2,$3,'{}'::jsonb,$4,$4)
         on conflict (tenant_id,repository) do nothing`,
        [input.tenantId, input.repository, input.ref, input.createdAt]
      );
      const existing = await client.query<BuildRow>(
        "select * from jina_context.pipeline_builds where tenant_id=$1 and request_key=$2",
        [input.tenantId, input.requestKey]
      );
      if (existing.rows[0]) return hydrateBuild(client, existing.rows[0]);
      const nextSequence = await client.query<{ value: string }>(
        `select (coalesce(max(ref_sequence),0)+1)::text value
         from jina_context.pipeline_builds
         where tenant_id=$1 and repository=$2 and ref_name=$3`,
        [input.tenantId, input.repository, input.ref]
      );
      const refSequence = Number(nextSequence.rows[0]!.value);
      if (!Number.isSafeInteger(refSequence) || refSequence <= 0) {
        throw new Error(`Ref sequence exceeds the supported range for ${input.repository}@${input.ref}`);
      }
      await client.query(
        `insert into jina_context.pipeline_builds
          (id,tenant_id,repository,ref_name,ref_sequence,request_key,status,created_at)
         values ($1,$2,$3,$4,$5,$6,'active',$7)`,
        [id, input.tenantId, input.repository, input.ref, refSequence, input.requestKey, input.createdAt]
      );
      const stages = [
        {
          type: contextTaskTypes.ingestEvidence,
          topic: contextQueueTopics.ingestEvidence,
          required: true,
          status: "queued"
        },
        {
          type: contextTaskTypes.deriveKnowledge,
          topic: contextQueueTopics.deriveKnowledge,
          required: true,
          status: "blocked"
        },
        {
          type: contextTaskTypes.indexContext,
          topic: contextQueueTopics.indexContext,
          required: true,
          status: "blocked"
        }
      ] as const;
      for (const stage of stages) {
        const metadata =
          stage.type === contextTaskTypes.ingestEvidence
            ? {
                ...(input.commitSha ? { commitSha: input.commitSha.toLowerCase() } : {}),
                ...(input.githubInstallationId ? { githubInstallationId: input.githubInstallationId } : {}),
                refSequence
              }
            : // The derive stage is claimed long after the build was requested, so
              // how much to write has to travel with it rather than be read from
              // the environment at execution time.
              stage.type === contextTaskTypes.deriveKnowledge &&
                (input.derivationDetail || input.derivationBudgetSeconds)
              ? {
                  ...(input.derivationDetail ? { derivationDetail: input.derivationDetail } : {}),
                  ...(input.derivationBudgetSeconds ? { derivationBudgetSeconds: input.derivationBudgetSeconds } : {})
                }
              : {};
        await client.query(
          `insert into jina_context.pipeline_stages
            (id,build_id,tenant_id,type,topic,required,status,attempt,metadata,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,0,$8::jsonb,$9,$9)`,
          [
            stableId("cs", { buildId: id, type: stage.type }),
            id,
            input.tenantId,
            stage.type,
            stage.topic,
            stage.required,
            stage.status,
            JSON.stringify(metadata),
            input.createdAt
          ]
        );
      }
      return hydrateBuild(client, {
        id,
        tenant_id: input.tenantId,
        repository: input.repository,
        ref_name: input.ref,
        ref_sequence: String(refSequence),
        request_key: input.requestKey,
        status: "active",
        created_at: new Date(input.createdAt),
        completed_at: null
      });
    });
  }

  async claim(input: {
    tenantId?: string;
    tenantIds?: string[];
    workerId: string;
    topics: ContextQueueTopic[];
    now: string;
    leaseExpiresAt: string;
  }): Promise<{ build: ContextBuild; stage: ContextPipelineStage; fence: ContextWriteFence } | undefined> {
    const tenantIds = [...new Set([...(input.tenantId ? [input.tenantId] : []), ...(input.tenantIds ?? [])])];
    if (tenantIds.length === 0) throw new Error("At least one tenant is required to claim work");
    if (input.topics.length === 0) return undefined;
    if (input.leaseExpiresAt <= input.now) throw new Error("Lease expiry must be in the future");
    return this.database.transactionAs("jina_context_coordinator", { tenantIds }, async (client) => {
      const leaseId = `lease_${randomUUID()}`;
      const fenceToken = `fence_${randomUUID()}`;
      const result = await client.query<StageRow & BuildRow>(
        `with claimable as (
           select stage.id
           from jina_context.pipeline_stages stage
           join jina_context.pipeline_builds build on build.id=stage.build_id
           where stage.tenant_id=any($1::text[]) and stage.topic=any($2::text[])
             and build.status='active'
             and (
               stage.status='queued'
               or (stage.status='leased' and stage.lease_expires_at <= $3)
             )
           order by
             case stage.topic
               when 'run-ingest-evidence' then 0
               when 'run-index-context' then 1
               else 2
             end,
             stage.created_at,stage.id
           for update of stage skip locked
           limit 1
         ), leased as (
           update jina_context.pipeline_stages stage
           set status='leased',attempt=stage.attempt+1,lease_id=$4,lease_owner=$5,
               lease_expires_at=$6,fence_token=$7,started_at=coalesce(stage.started_at,$3),
               metadata=stage.metadata || jsonb_build_object('workerId',$5::text),
               completed_at=null,error=null,updated_at=$3
           from claimable
           where stage.id=claimable.id
           returning stage.*
         )
         select build.*,leased.*
         from leased join jina_context.pipeline_builds build on build.id=leased.build_id`,
        [tenantIds, input.topics, input.now, leaseId, input.workerId, input.leaseExpiresAt, fenceToken]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const buildRow = await client.query<BuildRow>("select * from jina_context.pipeline_builds where id=$1", [
        row.build_id
      ]);
      const build = await hydrateBuild(client, buildRow.rows[0]!);
      const stage = build.stages.find((candidate) => candidate.id === row.id)!;
      return { build, stage, fence: stage.fence! };
    });
  }

  async release(input: {
    tenantId: string;
    stageId: string;
    leaseId: string;
    now: string;
    reason: string;
  }): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_coordinator",
      { tenantIds: [input.tenantId] },
      `update jina_context.pipeline_stages
       set status='queued',metadata=metadata || jsonb_build_object('releaseReason',$5::text),
           lease_id=null,lease_owner=null,lease_expires_at=null,fence_token=null,updated_at=$4
       where tenant_id=$1 and id=$2 and lease_id=$3 and status='leased'`,
      [input.tenantId, input.stageId, input.leaseId, input.now, input.reason]
    );
    return result.rowCount === 1;
  }

  async renew(input: {
    tenantId: string;
    stageId: string;
    leaseId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<ContextWriteFence | undefined> {
    if (input.leaseExpiresAt <= input.now) return undefined;
    await this.database.initialize();
    const result = await this.database.queryAs<{
      build_id: string;
      id: string;
      attempt: number;
      lease_id: string;
      lease_expires_at: Date;
      fence_token: string;
    }>(
      "jina_context_coordinator",
      { tenantIds: [input.tenantId] },
      `update jina_context.pipeline_stages
       set lease_expires_at=$5,updated_at=$4
       where tenant_id=$1 and id=$2 and lease_id=$3 and status='leased'
         and lease_expires_at > $4
       returning build_id,id,attempt,lease_id,lease_expires_at,fence_token`,
      [input.tenantId, input.stageId, input.leaseId, input.now, input.leaseExpiresAt]
    );
    const row = result.rows[0];
    return row
      ? {
          buildId: row.build_id,
          stageId: row.id,
          attempt: row.attempt,
          leaseId: row.lease_id,
          leaseExpiresAt: dateString(row.lease_expires_at),
          token: row.fence_token
        }
      : undefined;
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
    return this.database.transactionAs("jina_context_coordinator", { tenantIds: [input.tenantId] }, async (client) => {
      const result = await client.query<{
        build_id: string;
        type: ContextPipelineStage["type"];
        metadata: Record<string, unknown>;
      }>(
        `update jina_context.pipeline_stages
         set status=$8,metadata=metadata || $9::jsonb,completed_at=$7,error=$10,
             lease_id=null,lease_owner=null,lease_expires_at=null,fence_token=null,updated_at=$7
         where tenant_id=$1 and id=$2 and build_id=$3 and attempt=$4
           and lease_id=$5 and fence_token=$6 and status='leased'
           and lease_expires_at > $7
         returning build_id,type,metadata`,
        [
          input.tenantId,
          input.stageId,
          input.fence.buildId,
          input.fence.attempt,
          input.fence.leaseId,
          input.fence.token,
          input.now,
          input.outcome,
          JSON.stringify(input.metadata ?? {}),
          input.error ?? null
        ]
      );
      const stage = result.rows[0];
      if (!stage) return false;
      // ingest -> derive -> index. Indexing exists to make retrieval fast, and
      // what a query retrieves is the derived pages, so it has to run after
      // they exist. Derivation reads the checkpoint manifest, which ingestion
      // writes with the evidence, so nothing it needs comes from indexing.
      if (stage.type === contextTaskTypes.ingestEvidence && input.outcome === "succeeded") {
        await client.query(
          `update jina_context.pipeline_stages
           set status='queued',metadata=metadata || $3::jsonb,updated_at=$2
           where build_id=$1 and type=$4 and status='blocked'`,
          [stage.build_id, input.now, JSON.stringify(stage.metadata), contextTaskTypes.deriveKnowledge]
        );
      }
      if (stage.type === contextTaskTypes.deriveKnowledge && input.outcome === "succeeded") {
        await client.query(
          `update jina_context.pipeline_stages
           set status='queued',metadata=metadata || $3::jsonb,updated_at=$2
           where build_id=$1 and type=$4 and status='blocked'`,
          [stage.build_id, input.now, JSON.stringify(stage.metadata), contextTaskTypes.indexContext]
        );
      }
      await updateBuildStatus(client, stage.build_id, input.now);
      return true;
    });
  }

  async validateWriteFence(input: { tenantId: string; fence: ContextWriteFence; now: string }): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_coordinator",
      { tenantIds: [input.tenantId] },
      `select 1
       from jina_context.pipeline_stages stage
       join jina_context.pipeline_builds build on build.id=stage.build_id
       where build.tenant_id=$1 and build.id=$2 and stage.id=$3
         and stage.status='leased' and stage.attempt=$4 and stage.lease_id=$5
         and stage.fence_token=$6 and stage.lease_expires_at > $7`,
      [
        input.tenantId,
        input.fence.buildId,
        input.fence.stageId,
        input.fence.attempt,
        input.fence.leaseId,
        input.fence.token,
        input.now
      ]
    );
    return result.rowCount === 1;
  }

  async latestRefSequence(tenantId: string, repository: string, ref: string): Promise<number> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ ref_sequence: string }>(
      "jina_context_coordinator",
      { tenantIds: [tenantId] },
      `select coalesce(max(ref_sequence),0)::text ref_sequence
       from jina_context.pipeline_builds
       where tenant_id=$1 and repository=$2 and ref_name=$3`,
      [tenantId, repository, ref]
    );
    const sequence = Number(result.rows[0]!.ref_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error(`Ref sequence exceeds the supported range for ${repository}@${ref}`);
    }
    return sequence;
  }

  async get(buildId: string): Promise<ContextBuild | undefined> {
    return this.database.transactionAs("jina_context_admin", { system: true }, async (client) => {
      const result = await client.query<BuildRow>("select * from jina_context.pipeline_builds where id=$1", [buildId]);
      return result.rows[0] ? hydrateBuild(client, result.rows[0]) : undefined;
    });
  }

  async list(tenantId: string): Promise<ContextBuild[]> {
    return this.database.transactionAs("jina_context_coordinator", { tenantIds: [tenantId] }, async (client) => {
      const result = await client.query<BuildRow>(
        `select * from jina_context.pipeline_builds
         where tenant_id=$1 order by created_at desc,id desc`,
        [tenantId]
      );
      const builds: ContextBuild[] = [];
      for (const row of result.rows) builds.push(await hydrateBuild(client, row));
      return builds;
    });
  }
}

async function hydrateBuild(queryable: { query: PoolClient["query"] }, row: BuildRow): Promise<ContextBuild> {
  const stages = await queryable.query<StageRow>(
    `select * from jina_context.pipeline_stages
     where build_id=$1
     order by case type
       when 'ingest-evidence' then 0
       when 'derive-knowledge' then 1
       else 2 end`,
    [row.id]
  );
  const refSequence = Number(row.ref_sequence);
  if (!Number.isSafeInteger(refSequence) || refSequence <= 0) {
    throw new Error(`Invalid ref sequence on context build ${row.id}`);
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    refSequence,
    requestKey: row.request_key,
    status: row.status,
    stages: stages.rows.map(stageFromRow),
    createdAt: dateString(row.created_at),
    ...(row.completed_at ? { completedAt: dateString(row.completed_at) } : {})
  };
}

function stageFromRow(row: StageRow): ContextPipelineStage {
  const fence =
    row.status === "leased" && row.lease_id && row.lease_expires_at && row.fence_token
      ? {
          buildId: row.build_id,
          stageId: row.id,
          attempt: row.attempt,
          leaseId: row.lease_id,
          leaseExpiresAt: dateString(row.lease_expires_at),
          token: row.fence_token
        }
      : undefined;
  return {
    id: row.id,
    buildId: row.build_id,
    type: row.type,
    topic: row.topic,
    required: row.required,
    status: row.status,
    attempt: row.attempt,
    metadata: row.metadata,
    ...(row.started_at ? { startedAt: dateString(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: dateString(row.completed_at) } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(fence ? { fence } : {})
  };
}

async function updateBuildStatus(client: PoolClient, buildId: string, now: string): Promise<void> {
  const stages = await client.query<{ required: boolean; status: ContextPipelineStage["status"] }>(
    "select required,status from jina_context.pipeline_stages where build_id=$1",
    [buildId]
  );
  const required = stages.rows.filter((stage) => stage.required);
  const optional = stages.rows.filter((stage) => !stage.required);
  let status: ContextBuild["status"] = "active";
  if (required.some((stage) => stage.status === "failed")) status = "failed";
  else if (
    required.every((stage) => stage.status === "succeeded") &&
    optional.every((stage) => stage.status === "succeeded" || stage.status === "failed")
  ) {
    status = optional.some((stage) => stage.status === "failed") ? "degraded" : "succeeded";
  }
  await client.query(
    `update jina_context.pipeline_builds
     set status=$2,completed_at=case when $2='active' then null else $3::timestamptz end
     where id=$1`,
    [buildId, status, now]
  );
}
