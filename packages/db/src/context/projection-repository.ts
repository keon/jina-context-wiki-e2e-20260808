import { randomUUID } from "node:crypto";
import type {
  ContextDocument,
  ContextFragment,
  ContextProjectionConsumer,
  CurrentKnowledgeRevision,
  ExactIndexEntry,
  GenerationProjection,
  HierarchyNode,
  IndexGeneration,
  ProjectorStatus,
  ProjectionStore,
  RefManifestEntry,
  StructuralRelation
} from "@jina/context-engine";
import type { ContextWriteFence } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, contextDigest, dateString } from "./database.js";
import { requiredContextConsumers } from "./generation-coordinator.js";
import { enqueueContextEvent } from "./outbox-repository.js";
import { assertContextWriteFence } from "./write-fence.js";

interface GenerationRow {
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
}

export class PostgresProjectionRepository implements ProjectionStore {
  constructor(private readonly database: ContextDatabase) {}

  async publish(projection: GenerationProjection, fence?: ContextWriteFence): Promise<IndexGeneration> {
    const generation = projection.generation;
    if (generation.status !== "published" || !generation.publishedAt) {
      throw new Error("Only a fully published generation may be persisted");
    }
    const publishedAt = generation.publishedAt;
    for (const consumer of requiredContextConsumers) {
      if (generation.projectorStatuses[consumer] !== "ready") {
        throw new Error(`Required projector ${consumer} is not ready`);
      }
    }
    return this.database.transactionAs("jina_context_admin", async (client) => {
      await assertContextWriteFence(client, generation.tenantId, ["run-index-context", "run-derive-knowledge"], fence);
      const existing = await loadGenerationRow(client, generation.id);
      if (existing) {
        if (existing.required_fingerprint !== generation.fingerprint) {
          throw new Error(`Generation identity collision for ${generation.id}`);
        }
        if (existing.status === "published") {
          for (const consumer of contextProjectionConsumersFor(generation)) {
            await acknowledgeScopedDeliveries(client, {
              generationId: generation.id,
              checkpointId: generation.checkpointId,
              consumer,
              tenantId: generation.tenantId,
              repository: generation.repository,
              ref: generation.ref,
              commitSha: generation.commitSha,
              processedAt: publishedAt
            });
          }
          await assertContextWriteFence(
            client,
            generation.tenantId,
            ["run-index-context", "run-derive-knowledge"],
            fence
          );
          return generationFromRow(existing, await projectorStatuses(client, generation.id));
        }
        throw new Error(`Generation ${generation.id} exists in ${existing.status} state`);
      }
      const checkpoint = await client.query<{ acl_fingerprint: string; created_at: Date }>(
        `select acl_fingerprint,created_at
         from jina_context.evidence_checkpoints
         where id=$1 and tenant_id=$2 and repository=$3 and ref_name=$4 and commit_sha=$5`,
        [generation.checkpointId, generation.tenantId, generation.repository, generation.ref, generation.commitSha]
      );
      const evidence = checkpoint.rows[0];
      if (!evidence) throw new Error("Projection scope does not match its evidence checkpoint");
      await client.query(
        `insert into jina_context.index_generations
          (id,tenant_id,repository,ref_name,commit_sha,checkpoint_id,kind,status,
           barrier_occurred_at,projector_versions,capabilities,required_fingerprint,
           acl_fingerprint,degraded_capabilities,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,'building',$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)`,
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
            (generation_id,consumer,required,version,status,output_fingerprint,
             processed_through,started_at,completed_at)
           values ($1,$2,$3,$4,'pending',null,null,null,null)`,
          [
            generation.id,
            consumer,
            requiredContextConsumers.includes(consumer as (typeof requiredContextConsumers)[number]),
            version
          ]
        );
      }
      await insertManifest(client, projection.manifest, generation.id);
      await insertCurrentKnowledge(client, projection.currentKnowledge);
      await insertDocuments(client, projection.documents);
      await insertFragments(client, projection.fragments, projection.documents);
      await insertExactIndex(client, projection.exactIndex);
      await insertHierarchy(client, projection.hierarchyNodes, projection.documents);
      await insertRelations(client, projection.structuralRelations, generation.projectorVersions.structural);
      await projectIdentities(client, generation);
      await projectAcl(client, generation);

      for (const consumer of Object.keys(generation.projectorVersions) as ContextProjectionConsumer[]) {
        await completeScopedProjector(client, {
          generation,
          consumer,
          status: generation.projectorStatuses[consumer],
          processedThrough: evidence.created_at,
          completedAt: publishedAt
        });
      }
      const incomplete = await client.query<{ consumer: ContextProjectionConsumer; status: ProjectorStatus }>(
        `select consumer,status
         from jina_context.generation_projectors
         where generation_id=$1 and (
           (required and status <> 'ready')
           or status in ('pending','running')
         )
         order by consumer`,
        [generation.id]
      );
      if (incomplete.rows.length > 0) {
        throw new Error(
          `Generation ${generation.id} did not pass its projector barrier: ${incomplete.rows
            .map((row) => `${row.consumer}=${row.status}`)
            .join(", ")}`
        );
      }
      await client.query(
        `update jina_context.index_generations
         set status='invalidated',invalidated_at=$4
         where tenant_id=$1 and repository=$2 and ref_name=$3
           and status='published' and id <> $5`,
        [generation.tenantId, generation.repository, generation.ref, publishedAt, generation.id]
      );
      await client.query(
        `update jina_context.index_generations
         set status='published',published_at=$2 where id=$1 and status='building'`,
        [generation.id, publishedAt]
      );
      const generationEventId = `event_generation_${contextDigest({
        id: generation.id,
        fingerprint: generation.fingerprint
      }).slice(0, 24)}`;
      await enqueueContextEvent(client, {
        id: generationEventId,
        sequence: 1,
        tenantId: generation.tenantId,
        repository: generation.repository,
        aggregateType: "retention",
        aggregateId: generation.id,
        eventType: "generation.published",
        payload: { generationId: generation.id, ref: generation.ref, commitSha: generation.commitSha },
        consumers: ["retention"],
        occurredAt: publishedAt
      });
      await acknowledgeScopedDeliveries(client, {
        generationId: generation.id,
        checkpointId: generation.checkpointId,
        consumer: "retention",
        tenantId: generation.tenantId,
        repository: generation.repository,
        ref: generation.ref,
        commitSha: generation.commitSha,
        processedAt: publishedAt,
        eventId: generationEventId
      });
      await assertContextWriteFence(client, generation.tenantId, ["run-index-context", "run-derive-knowledge"], fence);
      return generation;
    });
  }

  async getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const generation = (
      await this.database.queryAs<GenerationRow>(
        "jina_context_admin",
        "select * from jina_context.index_generations where id=$1",
        [generationId]
      )
    ).rows[0];
    if (!generation || generation.status !== "published") return undefined;
    return this.hydrate(generation);
  }

  async getAuthorizedGeneration(
    generationId: string,
    allowedAclFingerprints: ReadonlySet<string>
  ): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const generation = (
      await this.database.queryAs<GenerationRow>(
        "jina_context_admin",
        "select * from jina_context.index_generations where id=$1",
        [generationId]
      )
    ).rows[0];
    if (!generation || generation.status !== "published") return undefined;
    return this.hydrate(generation, [...allowedAclFingerprints]);
  }

  async latestPublished(tenantId: string, repository: string, ref: string): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<GenerationRow>(
      "jina_context_admin",
      `select * from jina_context.index_generations
       where tenant_id=$1 and repository=$2 and ref_name=$3 and status='published'
       order by published_at desc,id desc limit 1`,
      [tenantId, repository, ref]
    );
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  async listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<GenerationRow>(
      "jina_context_admin",
      `select * from jina_context.index_generations
       where tenant_id=$1 and repository=$2 and status <> 'invalidated'
       order by created_at desc,id desc`,
      [tenantId, repository]
    );
    const generations: IndexGeneration[] = [];
    for (const row of result.rows) {
      generations.push(generationFromRow(row, await this.projectorStatuses(row.id)));
    }
    return generations;
  }

  private async hydrate(row: GenerationRow, allowedAclFingerprints?: readonly string[]): Promise<GenerationProjection> {
    const acl = allowedAclFingerprints === undefined ? null : [...allowedAclFingerprints];
    const [statuses, manifest, currentKnowledge, documents, fragments, exactIndex, hierarchyNodes, relations] =
      await Promise.all([
        this.projectorStatuses(row.id),
        this.database.queryAs<ManifestDbRow>(
          "jina_context_admin",
          `select distinct manifest.*
           from jina_context.ref_manifest manifest
           join jina_context.context_documents document
             on document.generation_id=manifest.generation_id
            and document.metadata->>'path'=manifest.path
           where manifest.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by manifest.path`,
          [row.id, acl]
        ),
        this.database.queryAs<CurrentKnowledgeDbRow>(
          "jina_context_admin",
          `select distinct current.*
           from jina_context.current_knowledge_revisions current
           join jina_context.context_documents document
             on document.generation_id=current.generation_id
            and document.source_revision_id=current.revision_id
           where current.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by current.logical_id`,
          [row.id, acl]
        ),
        this.database.queryAs<DocumentDbRow>(
          "jina_context_admin",
          `select document.*
           from jina_context.context_documents document
           where document.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by document.id`,
          [row.id, acl]
        ),
        this.database.queryAs<FragmentDbRow>(
          "jina_context_admin",
          `select fragment.*
           from jina_context.context_fragments fragment
           join jina_context.context_documents document on document.id=fragment.document_id
           where fragment.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by fragment.document_id,fragment.ordinal`,
          [row.id, acl]
        ),
        this.database.queryAs<ExactIndexDbRow>(
          "jina_context_admin",
          `select exact.*
           from jina_context.exact_index exact
           join jina_context.context_documents document on document.id=exact.document_id
           where exact.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by exact.term,exact.document_id,exact.field`,
          [row.id, acl]
        ),
        this.database.queryAs<HierarchyDbRow>(
          "jina_context_admin",
          `select hierarchy.*
           from jina_context.hierarchy_nodes hierarchy
           join jina_context.context_documents document on document.id=hierarchy.document_id
           where hierarchy.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by hierarchy.document_id,hierarchy.preorder_start`,
          [row.id, acl]
        ),
        this.database.queryAs<RelationDbRow>(
          "jina_context_admin",
          "select * from jina_context.structural_relations where generation_id=$1 order by id",
          [row.id]
        )
      ]);
    const hydratedDocuments = documents.rows.map(documentFromRow);
    const allowedAnchors = new Set(
      hydratedDocuments.flatMap((document) =>
        document.anchors.map((anchor) => `${anchor.sourceType}\u0000${anchor.sourceId}\u0000${anchor.contentDigest}`)
      )
    );
    const hydratedRelations = relations.rows
      .map(relationFromRow)
      .filter(
        (relation) =>
          allowedAclFingerprints === undefined ||
          relation.anchors.every((anchor) =>
            allowedAnchors.has(`${anchor.sourceType}\u0000${anchor.sourceId}\u0000${anchor.contentDigest}`)
          )
      );
    return {
      generation: generationFromRow(row, statuses),
      manifest: manifest.rows.map(manifestFromRow),
      currentKnowledge: currentKnowledge.rows.map(currentKnowledgeFromRow),
      documents: hydratedDocuments,
      fragments: fragments.rows.map(fragmentFromRow),
      exactIndex: exactIndex.rows.map(exactIndexFromRow),
      hierarchyNodes: hierarchyNodes.rows.map(hierarchyFromRow),
      structuralRelations: hydratedRelations
    };
  }

  private async projectorStatuses(generationId: string): Promise<IndexGeneration["projectorStatuses"]> {
    const result = await this.database.queryAs<{ consumer: ContextProjectionConsumer; status: ProjectorStatus }>(
      "jina_context_admin",
      "select consumer,status from jina_context.generation_projectors where generation_id=$1",
      [generationId]
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.consumer, row.status])
    ) as IndexGeneration["projectorStatuses"];
  }
}

function contextProjectionConsumersFor(generation: IndexGeneration): ContextProjectionConsumer[] {
  return (Object.keys(generation.projectorStatuses) as ContextProjectionConsumer[]).filter(
    (consumer) => generation.projectorStatuses[consumer] !== "failed"
  );
}

async function completeScopedProjector(
  client: PoolClient,
  input: {
    generation: IndexGeneration;
    consumer: ContextProjectionConsumer;
    status: ProjectorStatus;
    processedThrough: Date;
    completedAt: string;
  }
): Promise<void> {
  const leaseId = randomUUID();
  const leaseOwner = `projector:${input.generation.id}:${input.consumer}`;
  const claimed = await client.query(
    `update jina_context.generation_projectors
     set status='running',lease_id=$3,lease_owner=$4,
         lease_expires_at=$5::timestamptz + interval '5 minutes',
         started_at=coalesce(started_at,$5),completed_at=null,failure=null
     where generation_id=$1 and consumer=$2 and status='pending'`,
    [input.generation.id, input.consumer, leaseId, leaseOwner, input.completedAt]
  );
  if (claimed.rowCount !== 1) {
    throw new Error(`Projector ${input.consumer} could not claim generation ${input.generation.id}`);
  }
  if (input.status !== "failed") {
    await acknowledgeScopedDeliveries(client, {
      generationId: input.generation.id,
      checkpointId: input.generation.checkpointId,
      consumer: input.consumer,
      tenantId: input.generation.tenantId,
      repository: input.generation.repository,
      ref: input.generation.ref,
      commitSha: input.generation.commitSha,
      processedAt: input.completedAt
    });
  }
  const completed = await client.query(
    `update jina_context.generation_projectors
     set status=$4,output_fingerprint=$5,processed_through=$6,completed_at=$7,
         failure=$8::jsonb,lease_id=null,lease_owner=null,lease_expires_at=null
     where generation_id=$1 and consumer=$2 and lease_id=$3
       and status='running' and lease_expires_at > $7`,
    [
      input.generation.id,
      input.consumer,
      leaseId,
      input.status,
      input.status === "ready" ? input.generation.fingerprint : null,
      input.processedThrough,
      input.completedAt,
      input.status === "failed" ? JSON.stringify({ reason: "projector reported failed" }) : null
    ]
  );
  if (completed.rowCount !== 1) {
    throw new Error(`Projector ${input.consumer} lost its generation lease for ${input.generation.id}`);
  }
  await client.query(
    `insert into jina_context.projection_checkpoints
      (tenant_id,repository,ref_name,consumer,projector_version,processed_through,
       output_fingerprint,updated_at)
     select $1,$2,$3,consumer,version,$5,$6,$7
     from jina_context.generation_projectors
     where generation_id=$4 and consumer=$8 and status <> 'failed'
     on conflict (tenant_id,repository,ref_name,consumer) do update
     set projector_version=excluded.projector_version,
         processed_through=excluded.processed_through,
         output_fingerprint=excluded.output_fingerprint,
         lease_id=null,lease_owner=null,lease_expires_at=null,
         updated_at=excluded.updated_at`,
    [
      input.generation.tenantId,
      input.generation.repository,
      input.generation.ref,
      input.generation.id,
      input.processedThrough,
      input.status === "ready" ? input.generation.fingerprint : null,
      input.completedAt,
      input.consumer
    ]
  );
}

async function acknowledgeScopedDeliveries(
  client: PoolClient,
  input: {
    generationId: string;
    checkpointId: string;
    consumer: ContextProjectionConsumer;
    tenantId: string;
    repository: string;
    ref: string;
    commitSha: string;
    processedAt: string;
    eventId?: string;
  }
): Promise<void> {
  const leaseId = randomUUID();
  const leaseOwner = `generation:${input.generationId}:${input.consumer}`;
  const claimed = await client.query<{ delivery_id: string }>(
    `update jina_context.outbox delivery
     set lease_id=$1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '5 minutes',
         attempt=delivery.attempt+1,last_error=null
     where delivery.consumer=$4 and delivery.tenant_id=$5 and delivery.repository=$6
       and delivery.processed_at is null and delivery.available_at <= $3
       and (delivery.lease_expires_at is null or delivery.lease_expires_at <= $3)
       and ($10::text is null or delivery.event_id=$10)
       and (
         $4='retention'
         or
         delivery.aggregate_id=$7
         or (
           delivery.aggregate_type='evidence'
           and delivery.payload->>'ref'=$8
           and delivery.payload->>'commitSha'=$9
         )
         or (
           delivery.aggregate_type='knowledge'
           and exists (
             select 1
             from jina_context.knowledge_document_revisions revision
             where revision.tenant_id=delivery.tenant_id
               and revision.repository=delivery.repository
               and revision.id=delivery.aggregate_id
               and revision.ref_name=$8
               and revision.commit_sha=$9
           )
         )
         or delivery.aggregate_type in ('access','retention')
       )
     returning delivery.delivery_id`,
    [
      leaseId,
      leaseOwner,
      input.processedAt,
      input.consumer,
      input.tenantId,
      input.repository,
      input.checkpointId,
      input.ref,
      input.commitSha,
      input.eventId ?? null
    ]
  );
  for (const row of claimed.rows) {
    const acknowledged = await client.query(
      `update jina_context.outbox
       set processed_at=$3,lease_id=null,lease_owner=null,lease_expires_at=null,last_error=null
       where delivery_id=$1 and lease_id=$2 and processed_at is null and lease_expires_at > $3`,
      [row.delivery_id, leaseId, input.processedAt]
    );
    if (acknowledged.rowCount !== 1) {
      throw new Error(`Lost ${input.consumer} outbox lease for ${row.delivery_id}`);
    }
  }
}

function authorizedDocumentSql(alias: string): string {
  return `not exists (
    select 1
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(${alias}.metadata->'requiredAclFingerprints')='array'
          then ${alias}.metadata->'requiredAclFingerprints'
        else jsonb_build_array(${alias}.effective_acl_fingerprint)
      end
    ) required(value)
    where not (required.value = any($2::text[]))
  )`;
}

async function insertManifest(
  client: PoolClient,
  entries: readonly RefManifestEntry[],
  generationId: string
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `insert into jina_context.ref_manifest
        (generation_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,mode,source_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        generationId,
        entry.tenantId,
        entry.repository,
        entry.ref,
        entry.commitSha,
        entry.path,
        entry.blobSha,
        entry.executable ? "100755" : "100644",
        entry.contentDigest
      ]
    );
  }
}

async function insertCurrentKnowledge(client: PoolClient, entries: readonly CurrentKnowledgeRevision[]): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `insert into jina_context.current_knowledge_revisions
        (generation_id,tenant_id,repository,logical_id,revision_id,selection_reason,selection_fingerprint)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        entry.generationId,
        entry.tenantId,
        entry.repository,
        entry.logicalId,
        entry.revisionId,
        JSON.stringify({ reason: entry.selectionReason }),
        contextDigest(entry)
      ]
    );
  }
}

async function insertDocuments(client: PoolClient, documents: readonly ContextDocument[]): Promise<void> {
  for (const document of documents) {
    await client.query(
      `insert into jina_context.context_documents
        (id,generation_id,tenant_id,repository,ref_name,commit_sha,source_kind,source_id,
         source_revision_id,title,body,contextual_text,metadata,authority_class,
         effective_acl_fingerprint,source_fingerprint,source_anchors,projector_name,
         projector_version,projected_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18,$19,$20)`,
      [
        document.id,
        document.generationId,
        document.tenantId,
        document.repository,
        document.ref,
        document.commitSha,
        document.sourceKind,
        document.sourceId,
        document.sourceRevisionId ?? null,
        document.title,
        document.body,
        document.contextualText,
        JSON.stringify({
          ...document.metadata,
          ...(document.knowledgeKind ? { knowledgeKind: document.knowledgeKind } : {})
        }),
        document.authorityClass,
        document.effectiveAclFingerprint,
        document.sourceFingerprint,
        JSON.stringify(document.anchors),
        document.projectorName,
        document.projectorVersion,
        document.projectedAt
      ]
    );
  }
}

async function insertFragments(
  client: PoolClient,
  fragments: readonly ContextFragment[],
  documents: readonly ContextDocument[]
): Promise<void> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  for (const fragment of fragments) {
    const document = byId.get(fragment.documentId);
    if (!document) throw new Error(`Fragment ${fragment.id} references missing document ${fragment.documentId}`);
    await client.query(
      `insert into jina_context.context_fragments
        (id,generation_id,document_id,tenant_id,repository,ordinal,source_text,contextual_text,
         source_anchors,source_start,source_end,content_fingerprint,effective_acl_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
      [
        fragment.id,
        fragment.generationId,
        fragment.documentId,
        document.tenantId,
        document.repository,
        fragment.ordinal,
        fragment.sourceText,
        fragment.contextualText,
        JSON.stringify(fragment.anchors),
        fragment.startOffset,
        fragment.endOffset,
        fragment.tokenFingerprint,
        document.effectiveAclFingerprint
      ]
    );
  }
}

async function insertExactIndex(client: PoolClient, entries: readonly ExactIndexEntry[]): Promise<void> {
  const batchSize = 10_000;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    await client.query(
      `insert into jina_context.exact_index (generation_id,term,document_id,field)
       select * from unnest($1::text[],$2::text[],$3::text[],$4::text[])`,
      [
        batch.map((entry) => entry.generationId),
        batch.map((entry) => entry.term),
        batch.map((entry) => entry.documentId),
        batch.map((entry) => entry.field)
      ]
    );
  }
}

async function insertHierarchy(
  client: PoolClient,
  nodes: readonly HierarchyNode[],
  documents: readonly ContextDocument[]
): Promise<void> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  await client.query("set constraints all deferred");
  for (const [ordinal, node] of nodes.entries()) {
    const document = byId.get(node.documentId);
    if (!document) throw new Error(`Hierarchy node ${node.id} references missing document ${node.documentId}`);
    await client.query(
      `insert into jina_context.hierarchy_nodes
        (id,generation_id,document_id,tenant_id,repository,parent_id,ordinal,depth,
         preorder_start,preorder_end,title,summary,source_anchors,source_start,source_end,
         adapter_name,adapter_version,node_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)`,
      [
        node.id,
        node.generationId,
        node.documentId,
        document.tenantId,
        document.repository,
        node.parentId ?? null,
        ordinal,
        node.depth,
        node.preorderStart,
        node.preorderEnd,
        node.title,
        node.summary,
        JSON.stringify(node.anchors),
        0,
        document.body.length,
        node.adapterName,
        node.adapterVersion,
        contextDigest(node)
      ]
    );
  }
}

async function insertRelations(
  client: PoolClient,
  relations: readonly StructuralRelation[],
  projectorVersion: string
): Promise<void> {
  for (const relation of relations) {
    await client.query(
      `insert into jina_context.structural_relations
        (id,generation_id,tenant_id,repository,relation_kind,ref_name,commit_sha,
         source_kind,source_id,target_kind,target_id,source_anchors,metadata,
         relation_fingerprint,projector_version)
       values ($1,$2,$3,$4,$5,$6,$7,'resource',$8,'resource',$9,$10::jsonb,$11::jsonb,$12,$13)`,
      [
        relation.id,
        relation.generationId,
        relation.tenantId,
        relation.repository,
        relation.kind,
        relation.ref,
        relation.commitSha,
        relation.from,
        relation.to,
        JSON.stringify(relation.anchors),
        JSON.stringify(relation.metadata),
        contextDigest(relation),
        projectorVersion
      ]
    );
  }
}

async function projectIdentities(client: PoolClient, generation: IndexGeneration): Promise<void> {
  await client.query(
    `insert into jina_context.identity_projection
      (generation_id,tenant_id,repository,provider,external_id,canonical_entity_id,projection_fingerprint)
     select $1,identity.tenant_id,identity.repository,identity.provider,identity.external_id,
            identity.entity_id,encode(sha256(convert_to(
              identity.provider || ':' || identity.external_id || ':' || identity.entity_id,'UTF8'
            )),'hex')
     from jina_context.identities identity
     where identity.tenant_id=$2 and identity.repository=$3`,
    [generation.id, generation.tenantId, generation.repository]
  );
}

async function projectAcl(client: PoolClient, generation: IndexGeneration): Promise<void> {
  await client.query(
    `insert into jina_context.repository_acl_projection
      (generation_id,tenant_id,repository,principal_id,permission,acl_fingerprint,source_observation_id)
     select distinct on (acl.principal_id)
       $1,acl.tenant_id,acl.repository,acl.principal_id,acl.permission,
       acl.acl_fingerprint,acl.source_observation_id
     from jina_context.repository_acl_observations acl
     where acl.tenant_id=$2 and acl.repository=$3
     order by acl.principal_id,acl.observed_at desc,acl.id desc`,
    [generation.id, generation.tenantId, generation.repository]
  );
}

async function loadGenerationRow(
  queryable: { query: PoolClient["query"] },
  generationId: string
): Promise<GenerationRow | undefined> {
  const result = await queryable.query<GenerationRow>("select * from jina_context.index_generations where id=$1", [
    generationId
  ]);
  return result.rows[0];
}

async function projectorStatuses(
  queryable: { query: PoolClient["query"] },
  generationId: string
): Promise<IndexGeneration["projectorStatuses"]> {
  const result = await queryable.query<{
    consumer: ContextProjectionConsumer;
    status: IndexGeneration["projectorStatuses"][ContextProjectionConsumer];
  }>("select consumer,status from jina_context.generation_projectors where generation_id=$1", [generationId]);
  return Object.fromEntries(
    result.rows.map((row) => [row.consumer, row.status])
  ) as IndexGeneration["projectorStatuses"];
}

function generationFromRow(row: GenerationRow, statuses: IndexGeneration["projectorStatuses"]): IndexGeneration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    checkpointId: row.checkpoint_id,
    status: row.status === "invalidated" ? "failed" : row.status,
    projectorVersions: row.projector_versions,
    projectorStatuses: statuses,
    capabilities: row.capabilities,
    fingerprint: row.required_fingerprint,
    createdAt: dateString(row.created_at),
    ...(row.published_at ? { publishedAt: dateString(row.published_at) } : {})
  };
}

function degradedCapabilities(generation: IndexGeneration): string[] {
  return Object.entries(generation.capabilities)
    .filter(([, value]) => value !== "available")
    .map(([name]) => name);
}

interface ManifestDbRow {
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  path: string;
  blob_sha: string;
  mode: string;
  source_fingerprint: string;
}
function manifestFromRow(row: ManifestDbRow): RefManifestEntry {
  return {
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    path: row.path,
    blobSha: row.blob_sha,
    contentDigest: row.source_fingerprint,
    executable: row.mode === "100755"
  };
}

interface CurrentKnowledgeDbRow {
  generation_id: string;
  tenant_id: string;
  repository: string;
  logical_id: string;
  revision_id: string;
  selection_reason: { reason?: string };
}
function currentKnowledgeFromRow(row: CurrentKnowledgeDbRow): CurrentKnowledgeRevision {
  return {
    generationId: row.generation_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    logicalId: row.logical_id,
    revisionId: row.revision_id,
    selectionReason: row.selection_reason.reason ?? ""
  };
}

interface DocumentDbRow {
  id: string;
  generation_id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  source_kind: ContextDocument["sourceKind"];
  source_id: string;
  source_revision_id: string | null;
  title: string;
  body: string;
  contextual_text: string;
  metadata: Record<string, unknown> & { knowledgeKind?: ContextDocument["knowledgeKind"] };
  authority_class: string;
  effective_acl_fingerprint: string;
  source_fingerprint: string;
  source_anchors: ContextDocument["anchors"];
  projector_name: string;
  projector_version: string;
  projected_at: Date;
}
function documentFromRow(row: DocumentDbRow): ContextDocument {
  const { knowledgeKind, ...metadata } = row.metadata;
  return {
    id: row.id,
    generationId: row.generation_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    ...(row.source_revision_id ? { sourceRevisionId: row.source_revision_id } : {}),
    ...(knowledgeKind ? { knowledgeKind } : {}),
    title: row.title,
    body: row.body,
    contextualText: row.contextual_text,
    metadata,
    authorityClass: row.authority_class,
    effectiveAclFingerprint: row.effective_acl_fingerprint,
    sourceFingerprint: row.source_fingerprint,
    anchors: row.source_anchors,
    projectorName: row.projector_name,
    projectorVersion: row.projector_version,
    projectedAt: dateString(row.projected_at)
  };
}

interface FragmentDbRow {
  id: string;
  generation_id: string;
  document_id: string;
  ordinal: number;
  source_text: string;
  contextual_text: string;
  source_anchors: ContextFragment["anchors"];
  source_start: number;
  source_end: number;
  content_fingerprint: string;
}
function fragmentFromRow(row: FragmentDbRow): ContextFragment {
  return {
    id: row.id,
    generationId: row.generation_id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    sourceText: row.source_text,
    contextualText: row.contextual_text,
    startOffset: row.source_start,
    endOffset: row.source_end,
    anchors: row.source_anchors,
    tokenFingerprint: row.content_fingerprint
  };
}

interface ExactIndexDbRow {
  generation_id: string;
  term: string;
  document_id: string;
  field: ExactIndexEntry["field"];
}
function exactIndexFromRow(row: ExactIndexDbRow): ExactIndexEntry {
  return {
    generationId: row.generation_id,
    term: row.term,
    documentId: row.document_id,
    field: row.field
  };
}

interface HierarchyDbRow {
  id: string;
  generation_id: string;
  document_id: string;
  parent_id: string | null;
  title: string;
  summary: string;
  depth: number;
  preorder_start: number;
  preorder_end: number;
  source_anchors: HierarchyNode["anchors"];
  adapter_name: string;
  adapter_version: string;
}
function hierarchyFromRow(row: HierarchyDbRow): HierarchyNode {
  return {
    id: row.id,
    generationId: row.generation_id,
    documentId: row.document_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    title: row.title,
    summary: row.summary,
    depth: row.depth,
    preorderStart: row.preorder_start,
    preorderEnd: row.preorder_end,
    anchors: row.source_anchors,
    adapterName: row.adapter_name,
    adapterVersion: row.adapter_version
  };
}

interface RelationDbRow {
  id: string;
  generation_id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  relation_kind: StructuralRelation["kind"];
  source_id: string;
  target_id: string;
  source_anchors: StructuralRelation["anchors"];
  metadata: Record<string, unknown>;
}
function relationFromRow(row: RelationDbRow): StructuralRelation {
  return {
    id: row.id,
    generationId: row.generation_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    kind: row.relation_kind,
    from: row.source_id,
    to: row.target_id,
    anchors: row.source_anchors,
    metadata: row.metadata
  };
}
