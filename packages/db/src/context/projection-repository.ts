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
import { contextProjectionConsumers, EXACT_TERM_MAX_CHARACTERS } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { assertRepositoryAccessFingerprint, lockRepositoryAccess } from "./access.js";
import { ContextDatabase, contextDigest, dateString } from "./database.js";
import type { ContextDatabaseRole } from "./roles.js";
import { PostgresGenerationCoordinator, requiredContextConsumers } from "./generation-coordinator.js";
import { enqueueContextEvent } from "./outbox-repository.js";

// Body-bearing rows are intentionally smaller; metadata-only relations can amortize more round trips.
// The byte target also bounds atypically large metadata/anchor payloads (except an indivisible single row).
const PROJECTION_WRITE_CHUNK_SIZE = 500;
const PROJECTION_BODY_WRITE_CHUNK_SIZE = 100;
const PROJECTION_RELATION_WRITE_CHUNK_SIZE = 2_000;
const PROJECTION_WRITE_CHUNK_BYTE_TARGET = 4 * 1024 * 1024;

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
  acl_fingerprint: string;
  projection_input_fingerprint: string;
  created_at: Date;
  published_at: Date | null;
}

interface GenerationListingRow extends GenerationRow {
  projector_statuses: Partial<Record<ContextProjectionConsumer, ProjectorStatus>>;
}

export class PostgresProjectionRepository implements ProjectionStore {
  constructor(private readonly database: ContextDatabase) {}

  async publish(projection: GenerationProjection): Promise<IndexGeneration> {
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
    const coordinator = new PostgresGenerationCoordinator(this.database);
    await coordinator.assertCurrentCheckpoint(
      generation.tenantId,
      generation.repository,
      generation.ref,
      generation.checkpointId
    );
    const existing = (
      await this.database.queryAs<GenerationRow>(
        "jina_context_coordinator",
        { tenantIds: [generation.tenantId] },
        "select * from jina_context.index_generations where id=$1",
        [generation.id]
      )
    ).rows[0];
    if (existing?.required_fingerprint !== undefined && existing.required_fingerprint !== generation.fingerprint) {
      throw new Error(`Generation identity collision for ${generation.id}`);
    }
    if (existing?.status === "published") {
      const existingPublishedAt = existing.published_at ? dateString(existing.published_at) : publishedAt;
      const generationEventId = generationPublishedEventId(generation);
      await enqueueGenerationPublishedEvent(this.database, generation, existingPublishedAt, generationEventId);
      await acknowledgePostPublicationDeliveries(this.database, generation, existingPublishedAt, generationEventId);
      return generationFromRow(existing, await this.projectorStatuses(generation.id));
    }
    if (existing && existing.status !== "building") {
      throw new Error(`Generation ${generation.id} exists in ${existing.status} state`);
    }

    if (!existing) {
      await coordinator.create(buildingGeneration(generation));
    }
    const checkpoint = (
      await this.database.queryAs<{ created_at: Date }>(
        "jina_context_coordinator",
        { tenantIds: [generation.tenantId] },
        `select created_at
         from jina_context.evidence_checkpoints
         where id=$1 and tenant_id=$2 and repository=$3 and ref_name=$4 and commit_sha=$5`,
        [generation.checkpointId, generation.tenantId, generation.repository, generation.ref, generation.commitSha]
      )
    ).rows[0];
    if (!checkpoint) throw new Error("Projection scope does not match its evidence checkpoint");

    for (const consumer of contextProjectionConsumers) {
      await runScopedProjector(this.database, projection, consumer, checkpoint.created_at);
    }
    const published = await coordinator.publish(generation.id, publishedAt);
    const generationEventId = generationPublishedEventId(generation);
    await enqueueGenerationPublishedEvent(this.database, generation, publishedAt, generationEventId);
    await acknowledgePostPublicationDeliveries(this.database, generation, publishedAt, generationEventId);
    return published;
  }

  async getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const generation = (
      await this.database.queryAs<GenerationRow>(
        "jina_context_admin",
        { system: true },
        "select * from jina_context.index_generations where id=$1",
        [generationId]
      )
    ).rows[0];
    if (!generation || generation.status !== "published") return undefined;
    return this.hydrate(generation);
  }

  async getScopedGeneration(
    tenantId: string,
    repositories: readonly string[],
    generationId: string
  ): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const generation = (
      await this.database.queryAs<GenerationRow>(
        "jina_context_admin",
        { tenantIds: [tenantId] },
        "select * from jina_context.index_generations where id=$1 and tenant_id=$2 and repository=any($3::text[])",
        [generationId, tenantId, [...repositories]]
      )
    ).rows[0];
    if (!generation || generation.status !== "published") return undefined;
    return this.hydrate(generation);
  }

  async getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const generation = (
      await this.database.queryAs<GenerationRow>(
        "jina_context_admin",
        { system: true },
        "select * from jina_context.index_generations where id=$1",
        [generationId]
      )
    ).rows[0];
    if (!generation || generation.status !== "published") return undefined;
    const before = await this.currentPrincipalAclFingerprints(generation, principalId);
    if (before.length === 0) return undefined;
    const projection = await this.hydrate(generation, before);
    const after = await this.currentPrincipalAclFingerprints(generation, principalId);
    return before.length === after.length && before.every((value, index) => value === after[index])
      ? projection
      : undefined;
  }

  async latestPublished(tenantId: string, repository: string, ref: string): Promise<GenerationProjection | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<GenerationRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select generation.*
       from jina_context.current_context_board_releases current_release
       join jina_context.index_generations generation
         on generation.id=current_release.release_id
        and generation.tenant_id=current_release.tenant_id
        and generation.repository=current_release.repository
        and generation.ref_name=current_release.ref_name
       where current_release.tenant_id=$1 and current_release.repository=$2
         and current_release.ref_name=$3 and generation.status='published'
       limit 1`,
      [tenantId, repository, ref]
    );
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  async listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<GenerationListingRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select generation.*,coalesce(projector.statuses,'{}'::jsonb) as projector_statuses
       from jina_context.index_generations generation
       left join jina_context.current_context_board_releases current_release
         on current_release.release_id=generation.id
       left join lateral (
         select jsonb_object_agg(status.consumer,status.status) as statuses
         from jina_context.generation_projectors status
         where status.generation_id=generation.id
       ) projector on true
       where generation.tenant_id=$1 and generation.repository=$2
         and generation.status <> 'invalidated'
       order by (current_release.release_id is not null) desc,
                generation.created_at desc,generation.id desc`,
      [tenantId, repository]
    );
    return result.rows.map((row) =>
      generationFromRow(row, row.projector_statuses as IndexGeneration["projectorStatuses"])
    );
  }

  private async hydrate(row: GenerationRow, allowedAclFingerprints?: readonly string[]): Promise<GenerationProjection> {
    const acl = allowedAclFingerprints === undefined ? null : [...allowedAclFingerprints];
    const [statuses, manifest, currentKnowledge, documents, fragments, hierarchyNodes, relations] = await Promise.all([
      this.projectorStatuses(row.id),
      this.database.queryAs<ManifestDbRow>(
        "jina_context_admin",
        { tenantIds: [row.tenant_id] },
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
        { tenantIds: [row.tenant_id] },
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
        { tenantIds: [row.tenant_id] },
        `select document.id,document.generation_id,document.tenant_id,document.repository,
                document.ref_name,document.commit_sha,document.source_kind,document.source_id,
                document.source_revision_id,document.title,document.body,document.contextual_text,
                document.metadata,document.authority_class,document.effective_acl_fingerprint,
                document.source_fingerprint,document.source_anchors,document.projector_name,
                document.projector_version,document.projected_at
           from jina_context.context_documents document
           where document.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by document.id`,
        [row.id, acl]
      ),
      this.database.queryAs<FragmentDbRow>(
        "jina_context_admin",
        { tenantIds: [row.tenant_id] },
        `select fragment.id,fragment.generation_id,fragment.document_id,fragment.ordinal,
                fragment.source_text,fragment.contextual_text,fragment.source_anchors,
                fragment.source_start,fragment.source_end,fragment.content_fingerprint
           from jina_context.context_fragments fragment
           join jina_context.context_documents document
             on document.generation_id=fragment.generation_id
            and document.id=fragment.document_id
           where fragment.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by fragment.document_id,fragment.ordinal`,
        [row.id, acl]
      ),
      this.database.queryAs<HierarchyDbRow>(
        "jina_context_admin",
        { tenantIds: [row.tenant_id] },
        `select hierarchy.id,hierarchy.generation_id,hierarchy.document_id,hierarchy.parent_id,
                hierarchy.title,hierarchy.summary,hierarchy.depth,hierarchy.preorder_start,
                hierarchy.preorder_end,hierarchy.source_anchors,hierarchy.adapter_name,
                hierarchy.adapter_version
           from jina_context.hierarchy_nodes hierarchy
           join jina_context.context_documents document
             on document.generation_id=hierarchy.generation_id
            and document.id=hierarchy.document_id
           where hierarchy.generation_id=$1
             and ($2::text[] is null or (${authorizedDocumentSql("document")}))
           order by hierarchy.document_id,hierarchy.preorder_start`,
        [row.id, acl]
      ),
      this.database.queryAs<RelationDbRow>(
        "jina_context_admin",
        { tenantIds: [row.tenant_id] },
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
      exactIndex: [],
      hierarchyNodes: hierarchyNodes.rows.map(hierarchyFromRow),
      structuralRelations: hydratedRelations
    };
  }

  private async projectorStatuses(generationId: string): Promise<IndexGeneration["projectorStatuses"]> {
    const result = await this.database.queryAs<{ consumer: ContextProjectionConsumer; status: ProjectorStatus }>(
      "jina_context_admin",
      { system: true },
      "select consumer,status from jina_context.generation_projectors where generation_id=$1",
      [generationId]
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.consumer, row.status])
    ) as IndexGeneration["projectorStatuses"];
  }

  private async currentPrincipalAclFingerprints(
    generation: Pick<GenerationRow, "tenant_id" | "repository">,
    principalId: string
  ): Promise<string[]> {
    const result = await this.database.queryAs<{ acl_fingerprint: string }>(
      "jina_context_admin",
      { tenantIds: [generation.tenant_id] },
      `select distinct acl_fingerprint
       from jina_context.current_repository_acl
       where tenant_id=$1 and repository=$2 and principal_id=$3
         and permission in ('read','write','admin')
       order by acl_fingerprint`,
      [generation.tenant_id, generation.repository, principalId]
    );
    return result.rows.map((row) => row.acl_fingerprint);
  }
}

const projectorRoles: Record<ContextProjectionConsumer, ContextDatabaseRole> = {
  manifest: "jina_context_manifest",
  "knowledge-current": "jina_context_knowledge_current",
  lexical: "jina_context_lexical",
  dense: "jina_context_dense",
  hierarchy: "jina_context_hierarchy",
  structural: "jina_context_structural",
  identity: "jina_context_identity",
  acl: "jina_context_acl",
  retention: "jina_context_retention"
};

function buildingGeneration(generation: IndexGeneration): Omit<IndexGeneration, "status" | "publishedAt"> {
  return {
    id: generation.id,
    tenantId: generation.tenantId,
    repository: generation.repository,
    repositoryAccessFingerprint: generation.repositoryAccessFingerprint,
    projectionInputFingerprint: generation.projectionInputFingerprint,
    ref: generation.ref,
    commitSha: generation.commitSha,
    checkpointId: generation.checkpointId,
    projectorVersions: generation.projectorVersions,
    projectorStatuses: generation.projectorStatuses,
    capabilities: generation.capabilities,
    fingerprint: generation.fingerprint,
    createdAt: generation.createdAt
  };
}

function generationPublishedEventId(generation: IndexGeneration): string {
  return `event_generation_${contextDigest({
    id: generation.id,
    fingerprint: generation.fingerprint
  }).slice(0, 24)}`;
}

async function enqueueGenerationPublishedEvent(
  database: ContextDatabase,
  generation: IndexGeneration,
  publishedAt: string,
  eventId: string
): Promise<void> {
  await database.transactionAs("jina_context_admin", { tenantIds: [generation.tenantId] }, (client) =>
    enqueueContextEvent(client, {
      id: eventId,
      sequence: 1,
      tenantId: generation.tenantId,
      repository: generation.repository,
      aggregateType: "retention",
      aggregateId: generation.id,
      eventType: "generation.published",
      payload: { generationId: generation.id, ref: generation.ref, commitSha: generation.commitSha },
      consumers: ["retention"],
      occurredAt: publishedAt
    })
  );
}

async function runScopedProjector(
  database: ContextDatabase,
  projection: GenerationProjection,
  consumer: ContextProjectionConsumer,
  processedThrough: Date
): Promise<void> {
  const generation = projection.generation;
  const completedAt = generation.publishedAt;
  if (!completedAt) throw new Error(`Generation ${generation.id} has no completion time`);
  const status = generation.projectorStatuses[consumer];
  await database.transactionAs(projectorRoles[consumer], { tenantIds: [generation.tenantId] }, async (client) => {
    const leaseId = randomUUID();
    const claimed = await client.query(
      `update jina_context.generation_projectors
       set status='running',lease_id=$3,lease_owner=$4,
           lease_expires_at=$5::timestamptz + interval '5 minutes',
           started_at=coalesce(started_at,$5),completed_at=null,failure=null
       where generation_id=$1 and consumer=$2 and (
         status in ('pending','failed')
         or (status='running' and lease_expires_at <= $5)
       )`,
      [generation.id, consumer, leaseId, `projector:${generation.id}:${consumer}`, completedAt]
    );
    if (claimed.rowCount !== 1) {
      const current = await client.query<{ status: string }>(
        "select status from jina_context.generation_projectors where generation_id=$1 and consumer=$2",
        [generation.id, consumer]
      );
      if (current.rows[0]?.status === status) return;
      throw new Error(`Projector ${consumer} could not claim generation ${generation.id}`);
    }
    if (status !== "failed") {
      if (consumer === "acl") {
        await lockRepositoryAccess(client, generation.tenantId, generation.repository);
        await assertRepositoryAccessFingerprint(
          client,
          generation.tenantId,
          generation.repository,
          generation.repositoryAccessFingerprint
        );
      }
      await projectConsumerOutput(client, projection, consumer);
      if (consumer === "acl") {
        await assertRepositoryAccessFingerprint(
          client,
          generation.tenantId,
          generation.repository,
          generation.repositoryAccessFingerprint
        );
      }
      await acknowledgeScopedDeliveries(client, {
        generationId: generation.id,
        checkpointId: generation.checkpointId,
        consumer,
        tenantId: generation.tenantId,
        repository: generation.repository,
        ref: generation.ref,
        commitSha: generation.commitSha,
        processedAt: completedAt
      });
    }
    const completed = await client.query(
      `update jina_context.generation_projectors
       set status=$4,output_fingerprint=$5,processed_through=$6,completed_at=$7,
           failure=$8::jsonb,lease_id=null,lease_owner=null,lease_expires_at=null
       where generation_id=$1 and consumer=$2 and lease_id=$3
         and status='running' and lease_expires_at > $7`,
      [
        generation.id,
        consumer,
        leaseId,
        status,
        status === "ready" ? generation.fingerprint : null,
        processedThrough,
        completedAt,
        status === "failed" ? JSON.stringify({ reason: "projector reported failed" }) : null
      ]
    );
    if (completed.rowCount !== 1) {
      throw new Error(`Projector ${consumer} lost its generation lease for ${generation.id}`);
    }
    if (status !== "failed") {
      await client.query(
        `insert into jina_context.projection_checkpoints
          (tenant_id,repository,ref_name,consumer,projector_version,processed_through,
           output_fingerprint,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id,repository,ref_name,consumer) do update
         set projector_version=excluded.projector_version,
             processed_through=excluded.processed_through,
             output_fingerprint=excluded.output_fingerprint,
             lease_id=null,lease_owner=null,lease_expires_at=null,
             updated_at=excluded.updated_at`,
        [
          generation.tenantId,
          generation.repository,
          generation.ref,
          consumer,
          generation.projectorVersions[consumer],
          processedThrough,
          status === "ready" ? generation.fingerprint : null,
          completedAt
        ]
      );
    }
  });
}

async function projectConsumerOutput(
  client: PoolClient,
  projection: GenerationProjection,
  consumer: ContextProjectionConsumer
): Promise<void> {
  switch (consumer) {
    case "manifest":
      await insertManifest(client, projection.manifest, projection.generation.id);
      return;
    case "knowledge-current":
      await insertCurrentKnowledge(client, projection.currentKnowledge);
      return;
    case "lexical":
      await insertDocuments(client, projection.documents);
      await insertFragments(client, projection.fragments, projection.documents);
      await insertNativeExactIndex(client, projection.generation.id);
      await insertExactIndex(client, projection.exactIndex);
      return;
    case "hierarchy":
      await insertHierarchy(client, projection.hierarchyNodes, projection.documents);
      return;
    case "structural":
      await insertRelations(client, projection.structuralRelations, projection.generation.projectorVersions.structural);
      return;
    case "identity":
      await projectIdentities(client, projection.generation);
      return;
    case "acl":
      await projectAcl(client, projection.generation);
      return;
    case "dense":
    case "retention":
      return;
  }
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
       and (
         ($10::text is not null and delivery.event_id=$10)
         or (
           $10::text is null and (
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
           )
         )
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
  await acknowledgeClaimedRows(client, claimed.rows, leaseId, input.processedAt, input.consumer);
}

async function acknowledgePostPublicationDeliveries(
  database: ContextDatabase,
  generation: IndexGeneration,
  processedAt: string,
  generationEventId?: string
): Promise<void> {
  if (generationEventId) {
    await database.transactionAs("jina_context_retention", { tenantIds: [generation.tenantId] }, (client) =>
      acknowledgeScopedDeliveries(client, {
        generationId: generation.id,
        checkpointId: generation.checkpointId,
        consumer: "retention",
        tenantId: generation.tenantId,
        repository: generation.repository,
        ref: generation.ref,
        commitSha: generation.commitSha,
        processedAt,
        eventId: generationEventId
      })
    );
  }
  for (const consumer of contextProjectionConsumers) {
    if (generation.projectorStatuses[consumer] === "failed") continue;
    await database.transactionAs(projectorRoles[consumer], { tenantIds: [generation.tenantId] }, async (client) => {
      await acknowledgeSupersededScopedDeliveries(client, { generation, consumer, processedAt });
      await acknowledgeRepositoryGlobalDeliveries(client, { generation, consumer, processedAt });
    });
  }
}

async function acknowledgeSupersededScopedDeliveries(
  client: PoolClient,
  input: {
    generation: IndexGeneration;
    consumer: ContextProjectionConsumer;
    processedAt: string;
  }
): Promise<void> {
  const leaseId = randomUUID();
  const claimed = await client.query<{ delivery_id: string }>(
    `update jina_context.outbox delivery
     set lease_id=$1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '5 minutes',
         attempt=delivery.attempt+1,last_error=null
     where delivery.consumer=$4 and delivery.tenant_id=$5 and delivery.repository=$6
       and delivery.processed_at is null and delivery.available_at <= $3
       and (delivery.lease_expires_at is null or delivery.lease_expires_at <= $3)
       and (
         exists (
           select 1
           from jina_context.evidence_checkpoints current_checkpoint
           join jina_context.evidence_checkpoints event_checkpoint
             on event_checkpoint.tenant_id=current_checkpoint.tenant_id
            and event_checkpoint.repository=current_checkpoint.repository
            and event_checkpoint.ref_name=current_checkpoint.ref_name
           where current_checkpoint.id=$7
             and event_checkpoint.id <> current_checkpoint.id
             and event_checkpoint.ref_sequence <= current_checkpoint.ref_sequence
             and (
               event_checkpoint.id=delivery.aggregate_id
               or event_checkpoint.id=delivery.payload->>'checkpointId'
             )
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
               and revision.commit_sha <> $9
           )
         )
       )
     returning delivery.delivery_id`,
    [
      leaseId,
      `generation:${input.generation.id}:${input.consumer}:superseded`,
      input.processedAt,
      input.consumer,
      input.generation.tenantId,
      input.generation.repository,
      input.generation.checkpointId,
      input.generation.ref,
      input.generation.commitSha
    ]
  );
  await acknowledgeClaimedRows(client, claimed.rows, leaseId, input.processedAt, input.consumer);
}

async function acknowledgeRepositoryGlobalDeliveries(
  client: PoolClient,
  input: {
    generation: IndexGeneration;
    consumer: ContextProjectionConsumer;
    processedAt: string;
  }
): Promise<void> {
  const leaseId = randomUUID();
  const claimed = await client.query<{ delivery_id: string }>(
    `update jina_context.outbox delivery
     set lease_id=$1,lease_owner=$2,lease_expires_at=$3::timestamptz + interval '5 minutes',
         attempt=delivery.attempt+1,last_error=null
     where delivery.consumer=$4 and delivery.tenant_id=$5 and delivery.repository=$6
       and delivery.processed_at is null and delivery.available_at <= $3
       and (delivery.lease_expires_at is null or delivery.lease_expires_at <= $3)
       and delivery.event_type in (
         'access.replaced','access.observed','evidence.observed','evidence.erased'
       )
       and exists (
         select 1 from jina_context.evidence_checkpoints any_checkpoint
         where any_checkpoint.tenant_id=delivery.tenant_id
           and any_checkpoint.repository=delivery.repository
       )
       and not exists (
         select 1
         from (
           select distinct on (checkpoint.ref_name)
             checkpoint.id,checkpoint.ref_name
           from jina_context.evidence_checkpoints checkpoint
           where checkpoint.tenant_id=delivery.tenant_id
             and checkpoint.repository=delivery.repository
           order by checkpoint.ref_name,checkpoint.ref_sequence desc,checkpoint.id desc
         ) latest
         where not exists (
           select 1
           from jina_context.index_generations published
           where published.tenant_id=delivery.tenant_id
             and published.repository=delivery.repository
             and published.ref_name=latest.ref_name
             and published.checkpoint_id=latest.id
             and published.status='published'
             and (
               (
                 delivery.aggregate_type='access'
                 and not exists (
                   select 1
                   from (
                     select distinct on (acl.principal_id)
                       acl.principal_id,acl.permission,acl.acl_fingerprint,acl.source_observation_id
                     from jina_context.repository_acl_observations acl
                     where acl.tenant_id=delivery.tenant_id
                       and acl.repository=delivery.repository
                     order by acl.principal_id,acl.observed_at desc,acl.id desc
                   ) current_acl
                   where not exists (
                     select 1
                     from jina_context.repository_acl_projection projected_acl
                     where projected_acl.generation_id=published.id
                       and projected_acl.principal_id=current_acl.principal_id
                       and projected_acl.permission=current_acl.permission
                       and projected_acl.acl_fingerprint=current_acl.acl_fingerprint
                       and projected_acl.source_observation_id=current_acl.source_observation_id
                   )
                 )
               )
               or (
                 delivery.aggregate_type <> 'access'
                 and published.published_at >= delivery.occurred_at
               )
             )
         )
       )
     returning delivery.delivery_id`,
    [
      leaseId,
      `generation:${input.generation.id}:${input.consumer}:repository-global`,
      input.processedAt,
      input.consumer,
      input.generation.tenantId,
      input.generation.repository
    ]
  );
  await acknowledgeClaimedRows(client, claimed.rows, leaseId, input.processedAt, input.consumer);
}

async function acknowledgeClaimedRows(
  client: PoolClient,
  rows: readonly { delivery_id: string }[],
  leaseId: string,
  processedAt: string,
  consumer: ContextProjectionConsumer
): Promise<void> {
  for (const chunk of projectionChunks(rows)) {
    const acknowledged = await client.query(
      `update jina_context.outbox
       set processed_at=$3,lease_id=null,lease_owner=null,lease_expires_at=null,last_error=null
       where delivery_id = any($1::text[])
         and lease_id=$2 and processed_at is null and lease_expires_at > $3
       returning delivery_id`,
      [chunk.map((row) => row.delivery_id), leaseId, processedAt]
    );
    if (acknowledged.rowCount !== chunk.length) {
      const acknowledgedIds = new Set((acknowledged.rows as { delivery_id: string }[]).map((row) => row.delivery_id));
      const lost = chunk.find((row) => !acknowledgedIds.has(row.delivery_id));
      throw new Error(`Lost ${consumer} outbox lease for ${lost?.delivery_id ?? "claimed delivery"}`);
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
  const rows = entries.map((entry) => ({
    tenant_id: entry.tenantId,
    repository: entry.repository,
    ref_name: entry.ref,
    commit_sha: entry.commitSha,
    path: entry.path,
    blob_sha: entry.blobSha,
    mode: entry.executable ? "100755" : "100644",
    source_fingerprint: entry.contentDigest,
    content_available: entry.contentAvailable
  }));
  for (const chunk of projectionChunks(rows)) {
    await client.query(
      `insert into jina_context.ref_manifest
        (generation_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,mode,source_fingerprint,
         content_available)
       select $1,input.tenant_id,input.repository,input.ref_name,input.commit_sha,input.path,
              input.blob_sha,input.mode,input.source_fingerprint,input.content_available
       from jsonb_to_recordset($2::jsonb) as input(
         tenant_id text,repository text,ref_name text,commit_sha text,path text,blob_sha text,
         mode text,source_fingerprint text,content_available boolean
       )`,
      [generationId, JSON.stringify(chunk)]
    );
  }
}

async function insertCurrentKnowledge(client: PoolClient, entries: readonly CurrentKnowledgeRevision[]): Promise<void> {
  const rows = entries.map((entry) => ({
    generation_id: entry.generationId,
    tenant_id: entry.tenantId,
    repository: entry.repository,
    logical_id: entry.logicalId,
    revision_id: entry.revisionId,
    selection_reason: { reason: entry.selectionReason },
    selection_fingerprint: contextDigest(entry)
  }));
  for (const chunk of projectionChunks(rows)) {
    await client.query(
      `insert into jina_context.current_knowledge_revisions
        (generation_id,tenant_id,repository,logical_id,revision_id,selection_reason,selection_fingerprint)
       select input.generation_id,input.tenant_id,input.repository,input.logical_id,input.revision_id,
              input.selection_reason,input.selection_fingerprint
       from jsonb_to_recordset($1::jsonb) as input(
         generation_id text,tenant_id text,repository text,logical_id text,revision_id text,
         selection_reason jsonb,selection_fingerprint text
       )`,
      [JSON.stringify(chunk)]
    );
  }
}

async function insertDocuments(client: PoolClient, documents: readonly ContextDocument[]): Promise<void> {
  const rows = documents.map((document) => ({
    id: document.id,
    generation_id: document.generationId,
    tenant_id: document.tenantId,
    repository: document.repository,
    ref_name: document.ref,
    commit_sha: document.commitSha,
    source_kind: document.sourceKind,
    source_id: document.sourceId,
    source_revision_id: document.sourceRevisionId ?? null,
    title: document.title,
    body: document.body,
    contextual_text: document.contextualText,
    metadata: {
      ...document.metadata,
      ...(document.knowledgeKind ? { knowledgeKind: document.knowledgeKind } : {})
    },
    authority_class: document.authorityClass,
    effective_acl_fingerprint: document.effectiveAclFingerprint,
    source_fingerprint: document.sourceFingerprint,
    source_anchors: document.anchors,
    projector_name: document.projectorName,
    projector_version: document.projectorVersion,
    projected_at: document.projectedAt
  }));
  for (const chunk of projectionChunks(rows, PROJECTION_BODY_WRITE_CHUNK_SIZE)) {
    await client.query(
      `insert into jina_context.context_documents
        (id,generation_id,tenant_id,repository,ref_name,commit_sha,source_kind,source_id,
         source_revision_id,title,body,contextual_text,metadata,authority_class,
         effective_acl_fingerprint,source_fingerprint,source_anchors,projector_name,
         projector_version,projected_at)
       select input.id,input.generation_id,input.tenant_id,input.repository,input.ref_name,
              input.commit_sha,input.source_kind,input.source_id,input.source_revision_id,input.title,
              input.body,input.contextual_text,input.metadata,input.authority_class,
              input.effective_acl_fingerprint,input.source_fingerprint,input.source_anchors,
              input.projector_name,input.projector_version,input.projected_at
       from jsonb_to_recordset($1::jsonb) as input(
         id text,generation_id text,tenant_id text,repository text,ref_name text,commit_sha text,
         source_kind text,source_id text,source_revision_id text,title text,body text,
         contextual_text text,metadata jsonb,authority_class text,effective_acl_fingerprint text,
         source_fingerprint text,source_anchors jsonb,projector_name text,projector_version text,
         projected_at timestamptz
       )`,
      [JSON.stringify(chunk)]
    );
  }
}

async function insertFragments(
  client: PoolClient,
  fragments: readonly ContextFragment[],
  documents: readonly ContextDocument[]
): Promise<void> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const rows = fragments.map((fragment) => {
    const document = byId.get(fragment.documentId);
    if (!document) throw new Error(`Fragment ${fragment.id} references missing document ${fragment.documentId}`);
    return {
      id: fragment.id,
      generation_id: fragment.generationId,
      document_id: fragment.documentId,
      tenant_id: document.tenantId,
      repository: document.repository,
      ordinal: fragment.ordinal,
      source_text: fragment.sourceText,
      contextual_text: fragment.contextualText,
      source_anchors: fragment.anchors,
      source_start: fragment.startOffset,
      source_end: fragment.endOffset,
      content_fingerprint: fragment.tokenFingerprint,
      effective_acl_fingerprint: document.effectiveAclFingerprint
    };
  });
  for (const chunk of projectionChunks(rows, PROJECTION_BODY_WRITE_CHUNK_SIZE)) {
    await client.query(
      `insert into jina_context.context_fragments
        (id,generation_id,document_id,tenant_id,repository,ordinal,source_text,contextual_text,
         source_anchors,source_start,source_end,content_fingerprint,effective_acl_fingerprint)
       select input.id,input.generation_id,input.document_id,input.tenant_id,input.repository,
              input.ordinal,input.source_text,input.contextual_text,input.source_anchors,
              input.source_start,input.source_end,input.content_fingerprint,
              input.effective_acl_fingerprint
       from jsonb_to_recordset($1::jsonb) as input(
         id text,generation_id text,document_id text,tenant_id text,repository text,
         ordinal integer,source_text text,contextual_text text,source_anchors jsonb,
         source_start integer,source_end integer,content_fingerprint text,
         effective_acl_fingerprint text
       )`,
      [JSON.stringify(chunk)]
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

async function insertNativeExactIndex(client: PoolClient, generationId: string): Promise<void> {
  // The projector claim serializes this generation and the enclosing
  // transaction inserts its documents, so the target is empty here. Deduping
  // per document/field bounds aggregate spill; PK-order output reduces B-tree
  // write amplification without changing token semantics.
  await client.query(
    `insert into jina_context.exact_index (generation_id,term,document_id,field)
     select document.generation_id,
            matched.term collate "default" as term,
            document.id as document_id,
            fields.field_name as field
     from jina_context.context_documents document
     cross join lateral (
       values
         ('title'::text,document.title),
         ('body'::text,document.body)
     ) fields(field_name,field_value)
     cross join lateral (
       select token.term[1] as term
       from regexp_matches(
         lower(normalize(fields.field_value,NFKC) collate "C"),
         '[a-z0-9_$./:@#-]+',
         'g'
       ) token(term)
       where char_length(token.term[1]) between 2 and $2
       group by document.id,fields.field_name,token.term[1]
     ) matched
     where document.generation_id=$1
     order by term,document_id,field`,
    [generationId, EXACT_TERM_MAX_CHARACTERS]
  );
}

async function insertHierarchy(
  client: PoolClient,
  nodes: readonly HierarchyNode[],
  documents: readonly ContextDocument[]
): Promise<void> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  await client.query("set constraints all deferred");
  const rows = nodes.map((node, ordinal) => {
    const document = byId.get(node.documentId);
    if (!document) throw new Error(`Hierarchy node ${node.id} references missing document ${node.documentId}`);
    return {
      id: node.id,
      generation_id: node.generationId,
      document_id: node.documentId,
      tenant_id: document.tenantId,
      repository: document.repository,
      parent_id: node.parentId ?? null,
      ordinal,
      depth: node.depth,
      preorder_start: node.preorderStart,
      preorder_end: node.preorderEnd,
      title: node.title,
      summary: node.summary,
      source_anchors: node.anchors,
      source_start: 0,
      source_end: document.body.length,
      adapter_name: node.adapterName,
      adapter_version: node.adapterVersion,
      node_fingerprint: contextDigest(node)
    };
  });
  for (const chunk of projectionChunks(rows)) {
    await client.query(
      `insert into jina_context.hierarchy_nodes
        (id,generation_id,document_id,tenant_id,repository,parent_id,ordinal,depth,
         preorder_start,preorder_end,title,summary,source_anchors,source_start,source_end,
         adapter_name,adapter_version,node_fingerprint)
       select input.id,input.generation_id,input.document_id,input.tenant_id,input.repository,
              input.parent_id,input.ordinal,input.depth,input.preorder_start,input.preorder_end,
              input.title,input.summary,input.source_anchors,input.source_start,input.source_end,
              input.adapter_name,input.adapter_version,input.node_fingerprint
       from jsonb_to_recordset($1::jsonb) as input(
         id text,generation_id text,document_id text,tenant_id text,repository text,parent_id text,
         ordinal integer,depth integer,preorder_start integer,preorder_end integer,title text,
         summary text,source_anchors jsonb,source_start integer,source_end integer,
         adapter_name text,adapter_version text,node_fingerprint text
       )`,
      [JSON.stringify(chunk)]
    );
  }
}

async function insertRelations(
  client: PoolClient,
  relations: readonly StructuralRelation[],
  projectorVersion: string
): Promise<void> {
  const rows = relations.map((relation) => ({
    id: relation.id,
    generation_id: relation.generationId,
    tenant_id: relation.tenantId,
    repository: relation.repository,
    relation_kind: relation.kind,
    ref_name: relation.ref,
    commit_sha: relation.commitSha,
    source_id: relation.from,
    target_id: relation.to,
    source_anchors: relation.anchors,
    metadata: relation.metadata,
    relation_fingerprint: contextDigest(relation),
    projector_version: projectorVersion
  }));
  for (const chunk of projectionChunks(rows, PROJECTION_RELATION_WRITE_CHUNK_SIZE)) {
    await client.query(
      `insert into jina_context.structural_relations
        (id,generation_id,tenant_id,repository,relation_kind,ref_name,commit_sha,
         source_kind,source_id,target_kind,target_id,source_anchors,metadata,
         relation_fingerprint,projector_version)
       select input.id,input.generation_id,input.tenant_id,input.repository,input.relation_kind,
              input.ref_name,input.commit_sha,'resource',input.source_id,'resource',input.target_id,
              input.source_anchors,input.metadata,input.relation_fingerprint,input.projector_version
       from jsonb_to_recordset($1::jsonb) as input(
         id text,generation_id text,tenant_id text,repository text,relation_kind text,ref_name text,
         commit_sha text,source_id text,target_id text,source_anchors jsonb,metadata jsonb,
         relation_fingerprint text,projector_version text
       )`,
      [JSON.stringify(chunk)]
    );
  }
}

function projectionChunks<T>(values: readonly T[], maxRows = PROJECTION_WRITE_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let chunkBytes = 2;
  for (const value of values) {
    const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8") + (chunk.length === 0 ? 0 : 1);
    if (chunk.length > 0 && (chunk.length >= maxRows || chunkBytes + valueBytes > PROJECTION_WRITE_CHUNK_BYTE_TARGET)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(value);
    chunkBytes += valueBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
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

function generationFromRow(row: GenerationRow, statuses: IndexGeneration["projectorStatuses"]): IndexGeneration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    repositoryAccessFingerprint: row.acl_fingerprint,
    projectionInputFingerprint: row.projection_input_fingerprint,
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

interface ManifestDbRow {
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  path: string;
  blob_sha: string;
  mode: string;
  source_fingerprint: string;
  content_available: boolean;
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
    contentAvailable: row.content_available,
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
