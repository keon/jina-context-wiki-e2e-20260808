import {
  BoardPageIndexAttachmentError,
  canonicalJson,
  fingerprint,
  stableId,
  validateBoardPageIndexAttachCommit,
  type BoardPageIndexAttachCommit,
  type BoardPageIndexAttachmentRecord,
  type BoardPageIndexAttachmentTransactionPort,
  type BoardPageIndexTreeArtifactV1,
  type ContextDocument,
  type ContextArtifactRef,
  type HierarchyNode
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString } from "./database.js";
import { parseStoredContextCatalog, storedContextCatalog } from "./release-catalog.js";

// Publication and attachment serialize on the same ref frontier. Publication
// prepares immutable rows; attachment makes a release eligible to be selected
// as current by its sequence.
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
  catalog: unknown;
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

interface LivePageIndexLease {
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
      const current = await client.query<{
        release_id: string;
        ref_sequence: string;
        commit_sha: string;
      }>(
        `select release_id,ref_sequence::text,commit_sha
         from jina_context.context_releases
         where tenant_id=$1 and repository=$2 and ref_name=$3
           and pageindex_attached_at is not null
         order by ref_sequence desc,release_id desc
         limit 1
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
         from jina_context.context_releases
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
      assertPublicationIdentity(publication, input, artifact);
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

      const catalog = parseStoredContextCatalog(publication.catalog);
      const documents = catalog.projection.documents;
      const hierarchyRows = materializeHierarchyRows(input, artifact, documents);
      const attachedCatalog = storedContextCatalog({
        projection: {
          ...catalog.projection,
          generation: {
            ...catalog.projection.generation,
            status: "published",
            capabilities: {
              ...catalog.projection.generation.capabilities,
              hierarchy: "available"
            },
            publishedAt: input.attachedAt
          },
          hierarchyNodes: hierarchyRows
        },
        revisions: catalog.revisions,
        citations: catalog.citations
      });

      const metadata = pageIndexMetadata(artifact);
      const attached = await client.query<PublicationRow>(
        `update jina_context.context_releases
         set pageindex_idempotency_key=$2,
             pageindex_attachment_input_digest=$3,
             pageindex_artifact=$4::jsonb,
             pageindex_metadata=$5::jsonb,
             pageindex_attached_at=$6,
             catalog=$7::jsonb
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
                   pageindex_metadata,pageindex_attached_at,catalog`,
        [
          input.releaseId,
          input.idempotencyKey,
          input.attachmentInputDigest,
          JSON.stringify(input.treeArtifactRef),
          JSON.stringify(metadata),
          input.attachedAt,
          JSON.stringify(attachedCatalog)
        ]
      );
      const attachedRow = attached.rows[0];
      if (!attachedRow) {
        throw new BoardPageIndexAttachmentError(
          "attachment_race",
          "PageIndex release metadata changed before attachment commit"
        );
      }
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

function assertLivePageIndexLease(
  snapshot: unknown,
  input: BoardPageIndexAttachCommit,
  databaseNowMillis: number
): LivePageIndexLease {
  const root = objectValue(snapshot);
  const board = objectValue(objectValue(root?.intakeState)?.board);
  const tasks = Array.isArray(board?.tasks) ? board.tasks.map(objectValue).filter(isObject) : [];
  const outbox = Array.isArray(board?.outbox) ? board.outbox.map(objectValue).filter(isObject) : [];
  const task = tasks.find((candidate) => candidate.id === input.lease.taskId);
  const message = outbox.find((candidate) => candidate.id === input.lease.messageId);
  const metadata = objectValue(task?.metadata);
  const payload = objectValue(message?.payload);
  if (
    !task ||
    !message ||
    task.type !== "publish-context-release" ||
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
    message.topic !== "run-context-publication" ||
    message.status !== "leased" ||
    payload?.attempt !== input.lease.attempt ||
    message.leaseId !== input.lease.leaseId ||
    message.writeFenceToken !== input.lease.writeFenceToken ||
    typeof message.leaseExpiresAt !== "string" ||
    new Date(message.leaseExpiresAt).valueOf() <= databaseNowMillis
  ) {
    staleLease("Context publication task no longer owns the durable board lease");
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
  return { latestAdmittedSequence: Math.max(0, ...admitted) };
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
  artifact: BoardPageIndexTreeArtifactV1
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
    !sameArtifact(publication.release_artifact, input.releaseArtifactRef)
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
            pageindex_artifact,pageindex_metadata,pageindex_attached_at,catalog
     from jina_context.context_releases
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

function materializeHierarchyRows(
  input: BoardPageIndexAttachCommit,
  artifact: BoardPageIndexTreeArtifactV1,
  documents: readonly ContextDocument[]
): HierarchyNode[] {
  const documentByRevision = new Map(documents.map((document) => [document.sourceRevisionId, document]));
  if (documents.length !== artifact.representedDocuments.length || documentByRevision.has(undefined)) {
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
  return artifact.nodes.map((node) => {
    const document = documentByRevision.get(node.documentId)!;
    const expectedAnchors = new Set(document.anchors.map((anchor) => fingerprint(anchor)));
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
      generationId: input.releaseId,
      documentId: document.id,
      ...(node.parentExternalId === undefined ? {} : { parentId: idByExternal.get(node.parentExternalId)! }),
      depth: node.depth,
      preorderStart: node.preorderStart,
      preorderEnd: node.preorderEnd,
      title: node.title,
      summary: node.summary,
      anchors: [...node.anchors],
      adapterName: artifact.source.adapterName,
      adapterVersion: artifact.source.adapterVersion
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
