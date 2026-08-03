import {
  BoardPageIndexAttachmentError,
  PAGEINDEX_OSS_SOURCE_PIN,
  canonicalJson,
  fingerprint,
  stableId,
  validateBoardPageIndexAttachCommit,
  type BoardPageIndexAttachCommit,
  type BoardPageIndexAttachmentRecord,
  type BoardPageIndexAttachmentTransactionPort,
  type BoardPageIndexTreeArtifactV1,
  type ContextArtifactRef,
  type EvidenceAnchor
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString } from "./database.js";
import { refreshRepositoryAclProjection } from "./board-publication-repository.js";

// Publication and attachment serialize on the same ref frontier. Publication
// prepares immutable rows; attachment is the only operation that may advance
// the public current pointer.
const REF_LOCK_PREFIX = "context-board-publication:";

interface PublicationRow {
  release_id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  ref_sequence: string;
  commit_sha: string;
  build_id: string;
  publication_input_digest: string;
  public_snapshot_digest: string;
  release_artifact: ContextArtifactRef;
  pageindex_idempotency_key: string | null;
  pageindex_attachment_input_digest: string | null;
  pageindex_artifact: ContextArtifactRef | null;
  pageindex_metadata: PageIndexMetadata | null;
  pageindex_attached_at: Date | null;
}

interface PageIndexMetadata {
  readonly version: 1;
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly sourcePin: string;
  readonly sourceDigest: string;
  readonly documentCount: number;
  readonly rootCount: number;
  readonly nodeCount: number;
  readonly maxDepth: number;
  readonly treeDigest: string;
  readonly buildDigest: string;
}

interface DocumentRow {
  id: string;
  source_revision_id: string | null;
  tenant_id: string;
  repository: string;
  body_length: number;
  source_anchors: EvidenceAnchor[];
}

interface LivePageIndexLease {
  readonly releaseArtifact: ContextArtifactRef;
  readonly latestAdmittedSequence: number;
}

export class PostgresBoardPageIndexAttachmentRepository implements BoardPageIndexAttachmentTransactionPort {
  constructor(private readonly database: ContextDatabase) {}

  async attachPageIndexAtomically(input: BoardPageIndexAttachCommit): Promise<BoardPageIndexAttachmentRecord> {
    await this.database.initialize();
    const client = await this.database.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
      const runtime = await client.query<{ snapshot: unknown }>(
        "select snapshot from jina_runtime.api_state where id=1 for update"
      );
      const boardSnapshot = runtime.rows[0]?.snapshot;
      if (!boardSnapshot) staleLease("durable board state is unavailable");
      await activateTenantPublicationRole(client, input.scope.tenantId);
      // This transaction holds the same API-state lock used by lease renewal
      // and reclamation. Fence expiry at lock acquisition so a large hierarchy
      // insert cannot invalidate its own otherwise-exclusive owner.
      const leaseFenceClockMillis = await databaseClockMillis(client);
      const liveLease = assertLivePageIndexLease(boardSnapshot, input, leaseFenceClockMillis);
      const artifact = validateBoardPageIndexAttachCommit(input);

      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${REF_LOCK_PREFIX}${input.scope.tenantId}:${input.scope.repository}:${input.scope.ref}`
      ]);
      // Keep the visibility transition atomic with evidence erasure. A
      // prepared generation invalidated by an eraser cannot become public.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `context-erasure:${input.scope.tenantId}:${input.scope.repository}`
      ]);
      const current = await client.query<{
        release_id: string;
        ref_sequence: string;
        commit_sha: string;
      }>(
        `select release_id,ref_sequence::text,commit_sha
         from jina_context.current_context_board_releases
         where tenant_id=$1 and repository=$2 and ref_name=$3
         for update`,
        [input.scope.tenantId, input.scope.repository, input.scope.ref]
      );
      const currentRow = current.rows[0];
      const currentSequence = Number(currentRow?.ref_sequence ?? 0);
      if (liveLease.latestAdmittedSequence > input.scope.refSequence || currentSequence > input.scope.refSequence) {
        throw new BoardPageIndexAttachmentError(
          "stale_ref_sequence",
          `PageIndex sequence ${input.scope.refSequence} is stale; latest admitted is ${Math.max(
            liveLease.latestAdmittedSequence,
            currentSequence
          )}`
        );
      }
      if (currentSequence === input.scope.refSequence && currentRow?.release_id !== input.releaseId) {
        throw new BoardPageIndexAttachmentError(
          "release_not_current",
          "the ref sequence is already bound to a different public release"
        );
      }

      const idempotencyOwner = await client.query<{
        release_id: string;
        pageindex_attachment_input_digest: string;
      }>(
        `select release_id,pageindex_attachment_input_digest
         from jina_context.context_board_publications
         where tenant_id=$1 and pageindex_idempotency_key=$2
         for update`,
        [input.scope.tenantId, input.idempotencyKey]
      );
      const existingOwner = idempotencyOwner.rows[0];
      if (
        existingOwner &&
        (existingOwner.release_id !== input.releaseId ||
          existingOwner.pageindex_attachment_input_digest !== input.attachmentInputDigest)
      ) {
        throw new BoardPageIndexAttachmentError(
          "idempotency_conflict",
          "PageIndex idempotency key is already bound to different immutable inputs"
        );
      }

      const publication = await publicationForUpdate(client, input.releaseId);
      assertPublicationIdentity(publication, input, artifact, liveLease);
      if (publication.pageindex_attachment_input_digest !== null) {
        if (
          publication.pageindex_idempotency_key !== input.idempotencyKey ||
          publication.pageindex_attachment_input_digest !== input.attachmentInputDigest ||
          !sameArtifact(publication.pageindex_artifact, input.treeArtifactRef)
        ) {
          throw new BoardPageIndexAttachmentError(
            "pageindex_conflict",
            "published release already has a different immutable PageIndex attachment"
          );
        }
        const record = recordFromPublication(publication);
        const replayLease = assertLivePageIndexLease(boardSnapshot, input, leaseFenceClockMillis);
        assertAttachmentFrontier(replayLease.latestAdmittedSequence, input.scope.refSequence, currentSequence);
        if (
          currentRow?.release_id !== input.releaseId ||
          currentSequence !== input.scope.refSequence ||
          currentRow.commit_sha !== input.scope.commitSha
        ) {
          throw new BoardPageIndexAttachmentError(
            "attachment_race",
            "attached release is not the public current release for its ref"
          );
        }
        await client.query("commit");
        return record;
      }

      const documents = await releaseDocuments(client, input.releaseId);
      const hierarchyRows = materializeHierarchyRows(input, artifact, documents);
      await client.query("set constraints all deferred");
      await client.query(
        `insert into jina_context.hierarchy_nodes
          (id,generation_id,document_id,tenant_id,repository,parent_id,ordinal,depth,
           preorder_start,preorder_end,title,summary,source_anchors,source_start,
           source_end,adapter_name,adapter_version,node_fingerprint)
         select id,generation_id,document_id,tenant_id,repository,parent_id,ordinal,depth,
                preorder_start,preorder_end,title,summary,source_anchors,source_start,
                source_end,adapter_name,adapter_version,node_fingerprint
         from jsonb_to_recordset($1::jsonb) as row(
           id text,generation_id text,document_id text,tenant_id text,repository text,
           parent_id text,ordinal integer,depth integer,preorder_start integer,
           preorder_end integer,title text,summary text,source_anchors jsonb,
           source_start integer,source_end integer,adapter_name text,
           adapter_version text,node_fingerprint text
         )`,
        [JSON.stringify(hierarchyRows)]
      );

      const projector = await client.query(
        `update jina_context.generation_projectors
         set version=$2,status='ready',output_fingerprint=$3,
             processed_through=$4,completed_at=$4,failure=null,
             lease_id=null,lease_owner=null,lease_expires_at=null
         where generation_id=$1 and consumer='hierarchy'
           and status in ('disabled','failed','skipped')
         returning consumer`,
        [input.releaseId, PAGEINDEX_OSS_SOURCE_PIN, artifact.metrics.treeDigest, input.attachedAt]
      );
      if (projector.rowCount !== 1) {
        throw new BoardPageIndexAttachmentError(
          "attachment_race",
          "hierarchy projector was not in an attachable state"
        );
      }
      await refreshRepositoryAclProjection(client, input.releaseId, input.scope.tenantId, input.scope.repository);
      const generation = await client.query(
        `update jina_context.index_generations
         set projector_versions=jsonb_set(projector_versions,'{hierarchy}',$2::jsonb,true),
             capabilities=jsonb_set(capabilities,'{hierarchy}','"available"'::jsonb,true),
             status='published',
             published_at=$7
         where id=$1 and tenant_id=$3 and repository=$4 and ref_name=$5
           and commit_sha=$6 and status='building' and published_at is null
         returning id`,
        [
          input.releaseId,
          JSON.stringify(PAGEINDEX_OSS_SOURCE_PIN),
          input.scope.tenantId,
          input.scope.repository,
          input.scope.ref,
          input.scope.commitSha,
          input.attachedAt
        ]
      );
      if (generation.rowCount !== 1) {
        throw new BoardPageIndexAttachmentError(
          "release_not_current",
          "prepared generation does not match the PageIndex release"
        );
      }

      const metadata = pageIndexMetadata(artifact);
      const attached = await client.query<PublicationRow>(
        `update jina_context.context_board_publications
         set pageindex_idempotency_key=$2,
             pageindex_attachment_input_digest=$3,
             pageindex_artifact=$4::jsonb,
             pageindex_metadata=$5::jsonb,
             pageindex_attached_at=$6
         where release_id=$1
           and pageindex_idempotency_key is null
           and pageindex_attachment_input_digest is null
           and pageindex_artifact is null
           and pageindex_metadata is null
           and pageindex_attached_at is null
         returning release_id,tenant_id,repository,ref_name,ref_sequence::text,
                   commit_sha,build_id,publication_input_digest,public_snapshot_digest,
                   release_artifact,pageindex_idempotency_key,
                   pageindex_attachment_input_digest,pageindex_artifact,
                   pageindex_metadata,pageindex_attached_at`,
        [
          input.releaseId,
          input.idempotencyKey,
          input.attachmentInputDigest,
          JSON.stringify(input.treeArtifactRef),
          JSON.stringify(metadata),
          input.attachedAt
        ]
      );
      const attachedRow = attached.rows[0];
      if (!attachedRow) {
        throw new BoardPageIndexAttachmentError(
          "attachment_race",
          "PageIndex release metadata changed before attachment commit"
        );
      }
      const advanced = await client.query<{ release_id: string }>(
        `insert into jina_context.current_context_board_releases
          (tenant_id,repository,ref_name,ref_sequence,release_id,commit_sha,
           public_snapshot_digest,advanced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id,repository,ref_name) do update
           set ref_sequence=excluded.ref_sequence,
               release_id=excluded.release_id,
               commit_sha=excluded.commit_sha,
               public_snapshot_digest=excluded.public_snapshot_digest,
               advanced_at=excluded.advanced_at
         where jina_context.current_context_board_releases.ref_sequence < excluded.ref_sequence
            or (
              jina_context.current_context_board_releases.ref_sequence=excluded.ref_sequence
              and jina_context.current_context_board_releases.release_id=excluded.release_id
            )
         returning release_id`,
        [
          input.scope.tenantId,
          input.scope.repository,
          input.scope.ref,
          input.scope.refSequence,
          input.releaseId,
          input.scope.commitSha,
          publication.public_snapshot_digest,
          input.attachedAt
        ]
      );
      if (advanced.rows[0]?.release_id !== input.releaseId) {
        throw new BoardPageIndexAttachmentError(
          "attachment_race",
          "the public current release pointer changed before PageIndex attachment commit"
        );
      }
      await acknowledgePublishedAccessDeliveries(
        client,
        input.scope.tenantId,
        input.scope.repository,
        input.attachedAt
      );
      const commitLease = assertLivePageIndexLease(boardSnapshot, input, leaseFenceClockMillis);
      assertAttachmentFrontier(commitLease.latestAdmittedSequence, input.scope.refSequence, currentSequence);
      await client.query("commit");
      return recordFromPublication(attachedRow);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof BoardPageIndexAttachmentError) throw error;
      throw new BoardPageIndexAttachmentError(
        "attachment_race",
        `atomic PageIndex attachment failed: ${bounded(error)}`
      );
    } finally {
      client.release();
    }
  }
}

async function acknowledgePublishedAccessDeliveries(
  client: PoolClient,
  tenantId: string,
  repository: string,
  processedAt: string
): Promise<void> {
  await client.query(
    `update jina_context.outbox delivery
     set processed_at=$3,lease_id=null,lease_owner=null,lease_expires_at=null,last_error=null
     where delivery.tenant_id=$1 and delivery.repository=$2
       and delivery.aggregate_type='access' and delivery.processed_at is null
       and delivery.consumer in ('acl','retention')
       and not exists (
         select 1
         from jina_context.current_context_board_releases current_release
         cross join jina_context.current_repository_acl current_acl
         where current_release.tenant_id=delivery.tenant_id
           and current_release.repository=delivery.repository
           and current_acl.tenant_id=current_release.tenant_id
           and current_acl.repository=current_release.repository
           and not exists (
             select 1
             from jina_context.repository_acl_projection projected_acl
             where projected_acl.generation_id=current_release.release_id
               and projected_acl.principal_id=current_acl.principal_id
               and projected_acl.permission=current_acl.permission
               and projected_acl.acl_fingerprint=current_acl.acl_fingerprint
           )
       )`,
    [tenantId, repository, processedAt]
  );
}

function assertLivePageIndexLease(
  snapshot: unknown,
  input: BoardPageIndexAttachCommit,
  databaseNowMillis: number
): LivePageIndexLease {
  const root = objectValue(snapshot);
  const board = objectValue(objectValue(root?.intakeState)?.board);
  const tasks = Array.isArray(board?.tasks) ? board.tasks.map(objectValue).filter(isObject) : [];
  const dependencies = Array.isArray(board?.dependencies) ? board.dependencies.map(objectValue).filter(isObject) : [];
  const outbox = Array.isArray(board?.outbox) ? board.outbox.map(objectValue).filter(isObject) : [];
  const events = Array.isArray(board?.events) ? board.events.map(objectValue).filter(isObject) : [];
  const task = tasks.find((candidate) => candidate.id === input.lease.taskId);
  const message = outbox.find((candidate) => candidate.id === input.lease.messageId);
  const metadata = objectValue(task?.metadata);
  const payload = objectValue(message?.payload);
  if (
    !task ||
    !message ||
    task.type !== "index-context-release" ||
    task.kind !== "dispatchable" ||
    task.status !== "in_progress" ||
    task.attempt !== input.lease.attempt ||
    metadata?.tenantId !== input.scope.tenantId ||
    metadata.repository !== input.scope.repository ||
    metadata.ref !== input.scope.ref ||
    metadata.refSequence !== input.scope.refSequence ||
    metadata.commitSha !== input.scope.commitSha ||
    metadata.contextBuildId !== input.scope.buildId ||
    message.taskId !== input.lease.taskId ||
    message.topic !== "run-context-pageindex" ||
    message.status !== "leased" ||
    payload?.attempt !== input.lease.attempt ||
    message.leaseId !== input.lease.leaseId ||
    message.writeFenceToken !== input.lease.writeFenceToken ||
    typeof message.leaseExpiresAt !== "string" ||
    new Date(message.leaseExpiresAt).valueOf() <= databaseNowMillis
  ) {
    staleLease("PageIndex task no longer owns the durable board lease");
  }
  const build = tasks.find((candidate) => candidate.id === input.scope.buildId);
  const buildMetadata = objectValue(build?.metadata);
  if (
    !build ||
    build.type !== "build-context" ||
    buildMetadata?.tenantId !== input.scope.tenantId ||
    buildMetadata.repository !== input.scope.repository ||
    buildMetadata.ref !== input.scope.ref ||
    buildMetadata.refSequence !== input.scope.refSequence ||
    buildMetadata.commitSha !== input.scope.commitSha
  ) {
    staleLease("PageIndex build scope no longer matches its board root");
  }
  const publicationDependencies = dependencies
    .filter((dependency) => dependency.taskId === input.lease.taskId && dependency.required === true)
    .map((dependency) => tasks.find((candidate) => candidate.id === dependency.dependsOnTaskId))
    .filter((candidate) => candidate?.type === "publish-context-release" && candidate.status === "done");
  if (publicationDependencies.length !== 1) {
    staleLease("PageIndex task does not have one completed publication dependency");
  }
  const publicationTask = publicationDependencies[0]!;
  const completion = [...events]
    .reverse()
    .find(
      (event) =>
        event.taskId === publicationTask.id &&
        typeof event.type === "string" &&
        event.type.endsWith(".completed") &&
        objectValue(event.payload)?.version === 1
    );
  const result = objectValue(completion?.payload);
  const releaseArtifact = artifactRefValue(result?.outputArtifact);
  if (result?.releaseId !== input.releaseId || !releaseArtifact) {
    staleLease("PageIndex task is not fenced to the requested published release");
  }
  const admitted = tasks
    .filter((candidate) => {
      const candidateMetadata = objectValue(candidate.metadata);
      return (
        candidate.type === "build-context" &&
        candidateMetadata?.tenantId === input.scope.tenantId &&
        candidateMetadata.repository === input.scope.repository &&
        candidateMetadata.ref === input.scope.ref &&
        Number.isSafeInteger(candidateMetadata.refSequence)
      );
    })
    .map((candidate) => Number(objectValue(candidate.metadata)!.refSequence));
  return { releaseArtifact, latestAdmittedSequence: Math.max(0, ...admitted) };
}

function assertAttachmentFrontier(
  latestAdmittedSequence: number,
  requestedSequence: number,
  currentSequence: number
): void {
  if (latestAdmittedSequence > requestedSequence || currentSequence > requestedSequence) {
    throw new BoardPageIndexAttachmentError(
      "stale_ref_sequence",
      `PageIndex sequence ${requestedSequence} is stale; latest admitted is ${Math.max(
        latestAdmittedSequence,
        currentSequence
      )}`
    );
  }
}

function assertPublicationIdentity(
  publication: PublicationRow,
  input: BoardPageIndexAttachCommit,
  artifact: BoardPageIndexTreeArtifactV1,
  liveLease: LivePageIndexLease
): void {
  if (
    publication.release_id !== input.releaseId ||
    publication.tenant_id !== input.scope.tenantId ||
    publication.repository !== input.scope.repository ||
    publication.ref_name !== input.scope.ref ||
    Number(publication.ref_sequence) !== input.scope.refSequence ||
    publication.commit_sha !== input.scope.commitSha ||
    publication.build_id !== input.scope.buildId ||
    publication.publication_input_digest !== artifact.release.publicationInputDigest ||
    publication.public_snapshot_digest !== artifact.release.publicSnapshotDigest ||
    !sameArtifact(publication.release_artifact, liveLease.releaseArtifact)
  ) {
    throw new BoardPageIndexAttachmentError(
      "release_not_current",
      "PageIndex release does not match the authoritative publication"
    );
  }
}

async function publicationForUpdate(client: PoolClient, releaseId: string): Promise<PublicationRow> {
  const result = await client.query<PublicationRow>(
    `select release_id,tenant_id,repository,ref_name,ref_sequence::text,commit_sha,
            build_id,publication_input_digest,public_snapshot_digest,release_artifact,
            pageindex_idempotency_key,pageindex_attachment_input_digest,
            pageindex_artifact,pageindex_metadata,pageindex_attached_at
     from jina_context.context_board_publications
     where release_id=$1
     for update`,
    [releaseId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new BoardPageIndexAttachmentError("release_not_current", "PageIndex release publication does not exist");
  }
  return row;
}

async function releaseDocuments(client: PoolClient, generationId: string): Promise<DocumentRow[]> {
  const result = await client.query<DocumentRow>(
    `select id,source_revision_id,tenant_id,repository,
            char_length(body)::integer body_length,source_anchors
     from jina_context.context_documents
     where generation_id=$1 and source_kind='knowledge'
     order by source_revision_id,id
     for share`,
    [generationId]
  );
  return result.rows;
}

function materializeHierarchyRows(
  input: BoardPageIndexAttachCommit,
  artifact: BoardPageIndexTreeArtifactV1,
  documents: readonly DocumentRow[]
): Record<string, unknown>[] {
  const documentByRevision = new Map(documents.map((document) => [document.source_revision_id, document]));
  if (documents.length !== artifact.representedDocuments.length || documentByRevision.has(null)) {
    throw new BoardPageIndexAttachmentError(
      "invalid_pageindex_attachment",
      "PageIndex represented documents do not cover the complete published catalog"
    );
  }
  for (const represented of artifact.representedDocuments) {
    if (!documentByRevision.has(represented.documentId)) {
      throw new BoardPageIndexAttachmentError(
        "invalid_pageindex_attachment",
        `PageIndex document ${represented.documentId} is absent from the published release`
      );
    }
  }
  const idByExternal = new Map(
    artifact.nodes.map((node) => [
      node.externalId,
      stableId("hn", {
        generationId: input.releaseId,
        adapterName: artifact.source.adapterName,
        externalId: node.externalId
      })
    ])
  );
  return artifact.nodes.map((node, ordinal) => {
    const document = documentByRevision.get(node.documentId)!;
    const expectedAnchors = new Set(document.source_anchors.map((anchor) => fingerprint(anchor)));
    const actualAnchors = new Set(node.anchors.map((anchor) => fingerprint(anchor)));
    if (
      expectedAnchors.size !== actualAnchors.size ||
      [...actualAnchors].some((anchor) => !expectedAnchors.has(anchor))
    ) {
      throw new BoardPageIndexAttachmentError(
        "invalid_pageindex_attachment",
        `PageIndex node ${node.externalId} is not grounded by its published document`
      );
    }
    return {
      id: idByExternal.get(node.externalId)!,
      generation_id: input.releaseId,
      document_id: document.id,
      tenant_id: document.tenant_id,
      repository: document.repository,
      parent_id: node.parentExternalId === undefined ? null : idByExternal.get(node.parentExternalId),
      ordinal,
      depth: node.depth,
      preorder_start: node.preorderStart,
      preorder_end: node.preorderEnd,
      title: node.title,
      summary: node.summary,
      source_anchors: node.anchors,
      source_start: 0,
      source_end: document.body_length,
      adapter_name: artifact.source.adapterName,
      adapter_version: artifact.source.adapterVersion,
      node_fingerprint: fingerprint({
        releaseId: input.releaseId,
        externalId: node.externalId,
        documentId: document.id,
        parentExternalId: node.parentExternalId,
        title: node.title,
        summary: node.summary,
        depth: node.depth,
        preorderStart: node.preorderStart,
        preorderEnd: node.preorderEnd,
        anchors: node.anchors
      })
    };
  });
}

function pageIndexMetadata(artifact: BoardPageIndexTreeArtifactV1): PageIndexMetadata {
  return {
    version: 1,
    adapterName: artifact.source.adapterName,
    adapterVersion: artifact.source.adapterVersion,
    sourcePin: artifact.source.sourcePin,
    sourceDigest: artifact.source.sourceDigest,
    documentCount: artifact.metrics.documentCount,
    rootCount: artifact.metrics.rootCount,
    nodeCount: artifact.metrics.nodeCount,
    maxDepth: artifact.metrics.maxDepth,
    treeDigest: artifact.metrics.treeDigest,
    buildDigest: artifact.metrics.buildDigest
  };
}

function recordFromPublication(publication: PublicationRow): BoardPageIndexAttachmentRecord {
  const metadata = publication.pageindex_metadata;
  const artifact = publication.pageindex_artifact;
  const inputDigest = publication.pageindex_attachment_input_digest;
  const attachedAt = publication.pageindex_attached_at;
  if (!metadata || !artifact || !inputDigest || !attachedAt) {
    throw new BoardPageIndexAttachmentError("attachment_race", "PageIndex attachment row is incomplete");
  }
  return {
    releaseId: publication.release_id,
    generationId: publication.release_id,
    attachmentInputDigest: inputDigest,
    treeArtifactRef: artifact,
    treeDigest: metadata.treeDigest,
    buildDigest: metadata.buildDigest,
    adapterName: metadata.adapterName,
    adapterVersion: metadata.adapterVersion,
    documentCount: metadata.documentCount,
    nodeCount: metadata.nodeCount,
    maxDepth: metadata.maxDepth,
    attachedAt: dateString(attachedAt)
  };
}

async function databaseClockMillis(client: PoolClient): Promise<number> {
  const clock = await client.query<{ now_ms: string }>(
    "select (extract(epoch from clock_timestamp()) * 1000)::text as now_ms"
  );
  const now = Number(clock.rows[0]?.now_ms);
  if (!Number.isFinite(now)) staleLease("database clock is unavailable");
  return now;
}

async function activateTenantPublicationRole(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("set local role jina_context_tenant_admin");
  await client.query("select set_config('jina.tenant_id',$1,true)", [tenantId]);
}

function artifactRefValue(value: unknown): ContextArtifactRef | undefined {
  const artifact = objectValue(value);
  if (
    !artifact ||
    typeof artifact.uri !== "string" ||
    typeof artifact.key !== "string" ||
    typeof artifact.contentType !== "string" ||
    !Number.isSafeInteger(artifact.bytes) ||
    typeof artifact.sha256 !== "string"
  ) {
    return undefined;
  }
  return {
    uri: artifact.uri,
    key: artifact.key,
    contentType: artifact.contentType,
    bytes: Number(artifact.bytes),
    sha256: artifact.sha256,
    ...(typeof artifact.objectGeneration === "string" ? { objectGeneration: artifact.objectGeneration } : {})
  };
}

function sameArtifact(left: ContextArtifactRef | null | undefined, right: ContextArtifactRef): boolean {
  return left !== null && left !== undefined && canonicalJson(left) === canonicalJson(right);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isObject(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined;
}

function staleLease(message: string): never {
  throw new BoardPageIndexAttachmentError("stale_pageindex_lease", message);
}

function bounded(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
