import { randomUUID } from "node:crypto";
import type { ContextProjectionConsumer, IndexGeneration, ProjectionCheckpoint } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString } from "./database.js";

export const requiredContextConsumers = [
  "manifest",
  "lexical",
  "structural",
  "identity",
  "acl",
  "retention"
] as const satisfies readonly ContextProjectionConsumer[];

export interface GenerationProjectorClaim {
  readonly generationId: string;
  readonly consumer: ContextProjectionConsumer;
  readonly leaseId: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
  readonly version: string;
}

export class PostgresGenerationCoordinator {
  constructor(private readonly database: ContextDatabase) {}

  async create(generation: Omit<IndexGeneration, "status" | "publishedAt">): Promise<IndexGeneration> {
    await this.database.transactionAs("jina_context_coordinator", async (client) => {
      const checkpoint = await client.query<{ acl_fingerprint: string; created_at: Date }>(
        `select acl_fingerprint,created_at from jina_context.evidence_checkpoints
         where id=$1 and tenant_id=$2 and repository=$3 and ref_name=$4 and commit_sha=$5`,
        [generation.checkpointId, generation.tenantId, generation.repository, generation.ref, generation.commitSha]
      );
      const evidence = checkpoint.rows[0];
      if (!evidence) throw new Error("Generation checkpoint does not match its requested scope");
      await client.query(
        `insert into jina_context.index_generations
          (id,tenant_id,repository,ref_name,commit_sha,checkpoint_id,kind,status,
           barrier_occurred_at,projector_versions,capabilities,required_fingerprint,
           acl_fingerprint,degraded_capabilities,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,'building',$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
         on conflict (id) do nothing`,
        [
          generation.id,
          generation.tenantId,
          generation.repository,
          generation.ref,
          generation.commitSha,
          generation.checkpointId,
          generation.capabilities.derivedKnowledge === "available" ? "enriched" : "baseline",
          evidence.created_at,
          JSON.stringify(generation.projectorVersions),
          JSON.stringify(generation.capabilities),
          generation.fingerprint,
          evidence.acl_fingerprint,
          degradedCapabilities(generation),
          generation.createdAt
        ]
      );
      for (const [consumer, version] of Object.entries(generation.projectorVersions) as [
        ContextProjectionConsumer,
        string
      ][]) {
        await client.query(
          `insert into jina_context.generation_projectors
            (generation_id,consumer,required,version,status)
           values ($1,$2,$3,$4,'pending')
           on conflict (generation_id,consumer) do nothing`,
          [
            generation.id,
            consumer,
            requiredContextConsumers.includes(consumer as (typeof requiredContextConsumers)[number]),
            version
          ]
        );
      }
    });
    return { ...generation, status: "building" };
  }

  async claim(input: {
    readonly generationId: string;
    readonly consumer: ContextProjectionConsumer;
    readonly workerId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<GenerationProjectorClaim | undefined> {
    return this.database.transactionAs("jina_context_coordinator", async (client) => {
      const leaseId = randomUUID();
      const result = await client.query<{
        generation_id: string;
        consumer: ContextProjectionConsumer;
        version: string;
        lease_id: string;
        lease_owner: string;
        lease_expires_at: Date;
      }>(
        `update jina_context.generation_projectors projector
         set status='running',lease_id=$4,lease_owner=$3,lease_expires_at=$6,
             started_at=coalesce(started_at,$5),completed_at=null,failure=null
         from jina_context.index_generations generation
         where projector.generation_id=$1 and projector.consumer=$2
           and generation.id=projector.generation_id and generation.status='building'
           and (
             projector.status in ('pending','failed')
             or (projector.status='running' and projector.lease_expires_at <= $5)
           )
         returning projector.generation_id,projector.consumer,projector.version,
                   projector.lease_id,projector.lease_owner,projector.lease_expires_at`,
        [input.generationId, input.consumer, input.workerId, leaseId, input.now, input.leaseExpiresAt]
      );
      const row = result.rows[0];
      return row
        ? {
            generationId: row.generation_id,
            consumer: row.consumer,
            leaseId: row.lease_id,
            leaseOwner: row.lease_owner,
            leaseExpiresAt: dateString(row.lease_expires_at),
            version: row.version
          }
        : undefined;
    });
  }

  async renew(input: {
    readonly generationId: string;
    readonly consumer: ContextProjectionConsumer;
    readonly leaseId: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_coordinator",
      `update jina_context.generation_projectors
       set lease_expires_at=$5
       where generation_id=$1 and consumer=$2 and lease_id=$3
         and status='running' and lease_expires_at > $4`,
      [input.generationId, input.consumer, input.leaseId, input.now, input.leaseExpiresAt]
    );
    return result.rowCount === 1;
  }

  async complete(input: {
    readonly generationId: string;
    readonly consumer: ContextProjectionConsumer;
    readonly leaseId: string;
    readonly status: "ready" | "disabled" | "skipped" | "failed";
    readonly outputFingerprint?: string;
    readonly processedThrough?: string;
    readonly completedAt: string;
    readonly failure?: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    return this.database.transactionAs("jina_context_coordinator", async (client) => {
      const updated = await client.query(
        `update jina_context.generation_projectors
         set status=$4,output_fingerprint=$5,processed_through=$6,completed_at=$7,
             failure=$8::jsonb,lease_id=null,lease_owner=null,lease_expires_at=null
         where generation_id=$1 and consumer=$2 and lease_id=$3
           and status='running' and lease_expires_at > $7`,
        [
          input.generationId,
          input.consumer,
          input.leaseId,
          input.status,
          input.outputFingerprint ?? null,
          input.processedThrough ?? null,
          input.completedAt,
          input.failure ? JSON.stringify(input.failure) : null
        ]
      );
      if (updated.rowCount !== 1) return false;
      const generation = await client.query<{
        tenant_id: string;
        repository: string;
        ref_name: string;
      }>("select tenant_id,repository,ref_name from jina_context.index_generations where id=$1", [input.generationId]);
      const scope = generation.rows[0]!;
      await client.query(
        `insert into jina_context.projection_checkpoints
          (tenant_id,repository,ref_name,consumer,projector_version,processed_through,
           output_fingerprint,updated_at)
         select $1,$2,$3,consumer,version,$5,$6,$7
         from jina_context.generation_projectors
         where generation_id=$4 and consumer=$8
         on conflict (tenant_id,repository,ref_name,consumer) do update
         set projector_version=excluded.projector_version,
             processed_through=excluded.processed_through,
             output_fingerprint=excluded.output_fingerprint,
             lease_id=null,lease_owner=null,lease_expires_at=null,
             updated_at=excluded.updated_at`,
        [
          scope.tenant_id,
          scope.repository,
          scope.ref_name,
          input.generationId,
          input.processedThrough ?? null,
          input.outputFingerprint ?? null,
          input.completedAt,
          input.consumer
        ]
      );
      return true;
    });
  }

  async publish(generationId: string, publishedAt: string): Promise<IndexGeneration> {
    return this.database.transactionAs("jina_context_coordinator", async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [generationId]);
      const incomplete = await client.query<{ consumer: ContextProjectionConsumer; status: string; required: boolean }>(
        `select consumer,status,required from jina_context.generation_projectors
         where generation_id=$1 and (
           (required and status <> 'ready')
           or status in ('pending','running')
         )`,
        [generationId]
      );
      if (incomplete.rows.length > 0) {
        throw new Error(
          `Generation ${generationId} is not publishable: ${incomplete.rows
            .map((row) => `${row.consumer}=${row.status}`)
            .join(", ")}`
        );
      }
      const target = await client.query<{
        tenant_id: string;
        repository: string;
        ref_name: string;
        commit_sha: string;
      }>(
        `select tenant_id,repository,ref_name,commit_sha
         from jina_context.index_generations where id=$1 and status='building' for update`,
        [generationId]
      );
      const scope = target.rows[0];
      if (!scope) throw new Error(`Generation ${generationId} is not building`);
      await client.query(
        `update jina_context.index_generations
         set status='invalidated',invalidated_at=$4
         where tenant_id=$1 and repository=$2 and ref_name=$3
           and status='published' and id <> $5`,
        [scope.tenant_id, scope.repository, scope.ref_name, publishedAt, generationId]
      );
      await client.query(
        `update jina_context.index_generations
         set status='published',published_at=$2
         where id=$1 and status='building'`,
        [generationId, publishedAt]
      );
      const generation = await loadGeneration(client, generationId);
      if (!generation) throw new Error(`Generation ${generationId} disappeared during publication`);
      return generation;
    });
  }

  async fail(generationId: string, failure: Readonly<Record<string, unknown>>, failedAt: string): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_coordinator",
      `update jina_context.index_generations
       set status='failed',failure=$2::jsonb
       where id=$1 and status='building'`,
      [generationId, JSON.stringify({ ...failure, failedAt })]
    );
    return result.rowCount === 1;
  }

  async checkpoint(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly consumer: ContextProjectionConsumer;
  }): Promise<ProjectionCheckpoint | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<{
      tenant_id: string;
      repository: string;
      consumer: ContextProjectionConsumer;
      projector_version: string;
      processed_through: Date | null;
      lease_id: string | null;
      lease_expires_at: Date | null;
      updated_at: Date;
    }>(
      "jina_context_coordinator",
      `select * from jina_context.projection_checkpoints
       where tenant_id=$1 and repository=$2 and ref_name=$3 and consumer=$4`,
      [input.tenantId, input.repository, input.ref, input.consumer]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      consumer: row.consumer,
      tenantId: row.tenant_id,
      repository: row.repository,
      sequence: row.processed_through ? row.processed_through.getTime() : 0,
      projectorVersion: row.projector_version,
      ...(row.lease_id ? { leaseId: row.lease_id } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: dateString(row.lease_expires_at) } : {}),
      updatedAt: dateString(row.updated_at)
    };
  }
}

function degradedCapabilities(generation: Pick<IndexGeneration, "capabilities">): string[] {
  return Object.entries(generation.capabilities)
    .filter(([, status]) => status !== "available")
    .map(([capability]) => capability);
}

export async function loadGeneration(client: PoolClient, generationId: string): Promise<IndexGeneration | undefined> {
  const generation = await client.query<{
    id: string;
    tenant_id: string;
    repository: string;
    ref_name: string;
    commit_sha: string;
    checkpoint_id: string;
    status: "building" | "published" | "failed" | "invalidated";
    projector_versions: IndexGeneration["projectorVersions"];
    capabilities: IndexGeneration["capabilities"];
    required_fingerprint: string;
    created_at: Date;
    published_at: Date | null;
  }>("select * from jina_context.index_generations where id=$1", [generationId]);
  const row = generation.rows[0];
  if (!row || row.status === "invalidated") return undefined;
  const projectors = await client.query<{
    consumer: ContextProjectionConsumer;
    status: "pending" | "running" | "ready" | "disabled" | "skipped" | "failed";
  }>("select consumer,status from jina_context.generation_projectors where generation_id=$1", [generationId]);
  const statuses = Object.fromEntries(
    projectors.rows.map((projector) => [
      projector.consumer,
      projector.status === "pending" || projector.status === "running" ? "failed" : projector.status
    ])
  ) as IndexGeneration["projectorStatuses"];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    checkpointId: row.checkpoint_id,
    status: row.status,
    projectorVersions: row.projector_versions,
    projectorStatuses: statuses,
    capabilities: row.capabilities,
    fingerprint: row.required_fingerprint,
    createdAt: dateString(row.created_at),
    ...(row.published_at ? { publishedAt: dateString(row.published_at) } : {})
  };
}
