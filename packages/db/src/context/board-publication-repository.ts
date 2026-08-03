import {
  BoardContextPublicationError,
  CurrentKnowledgeProjector,
  ExactProjector,
  LexicalProjector,
  contextProjectionConsumers,
  fingerprint,
  normalizeRepository,
  parseContextPriorReleaseSeed,
  sameImmutableKnowledgeCitation,
  sameImmutableKnowledgeRevision,
  type BoardContextPublicationCommit,
  type BoardContextPublicationRecord,
  type BoardContextReleaseSeedPort,
  type BoardContextPublicationTransactionPort,
  type ContextPriorReleaseSeed,
  type ContextDocument,
  type ContextFragment,
  type CurrentKnowledgeRevision,
  type ExactIndexEntry,
  type IndexGeneration,
  type KnowledgeEvidenceCitation,
  type ProjectorStatus
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString } from "./database.js";

const REF_LOCK_PREFIX = "context-board-publication:";

interface PublicationRow {
  release_id: string;
  ref_sequence: string;
  commit_sha: string;
  publication_input_digest: string;
  public_snapshot_digest: string;
  release_artifact: BoardContextPublicationRecord["releaseArtifact"];
  published_at: Date;
}

interface MaterializedProjection {
  readonly generation: IndexGeneration;
  readonly currentKnowledge: readonly CurrentKnowledgeRevision[];
  readonly documents: readonly ContextDocument[];
  readonly fragments: readonly ContextFragment[];
  readonly exactIndex: readonly ExactIndexEntry[];
}

/**
 * Production board publication transaction.
 *
 * This intentionally uses the database owner connection rather than composing
 * repository methods that each open their own transaction. The API state
 * advisory lock is the same lock used by PostgresJsonStateStore, so the board
 * lease cannot renew, complete, or be replaced between validation and commit.
 */
export class PostgresBoardContextPublicationRepository
  implements BoardContextPublicationTransactionPort, BoardContextReleaseSeedPort
{
  constructor(private readonly database: ContextDatabase) {}

  async findCurrentReleaseSeed(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
  }): Promise<ContextPriorReleaseSeed | undefined> {
    const tenantId = input.tenantId.trim();
    const repository = normalizeRepository(input.repository);
    const ref = input.ref.trim();
    if (!tenantId || !ref) throw new Error("current Context release scope is invalid");
    const result = await this.database.queryAs<{
      release_id: string;
      ref_sequence: string;
      commit_sha: string;
      public_snapshot_digest: string;
      release_artifact: unknown;
    }>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select c.release_id,c.ref_sequence::text,c.commit_sha,c.public_snapshot_digest,
              p.release_artifact
       from jina_context.current_context_board_releases c
       join jina_context.context_board_publications p
         on p.tenant_id=c.tenant_id and p.release_id=c.release_id
       where c.tenant_id=$1 and c.repository=$2 and c.ref_name=$3`,
      [tenantId, repository, ref]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return parseContextPriorReleaseSeed({
      version: 1,
      tenantId,
      repository,
      ref,
      refSequence: Number(row.ref_sequence),
      commitSha: row.commit_sha,
      releaseId: row.release_id,
      publicSnapshotDigest: row.public_snapshot_digest,
      releaseArtifact: row.release_artifact
    });
  }

  async publishAtomically(input: BoardContextPublicationCommit): Promise<BoardContextPublicationRecord> {
    await this.database.initialize();
    const client = await this.database.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
      const runtime = await client.query<{ snapshot: unknown }>(
        "select snapshot from jina_runtime.api_state where id=1 for update"
      );
      const boardSnapshot = runtime.rows[0]?.snapshot;
      if (!boardSnapshot) throw staleLease("durable board state is unavailable");
      await activateTenantPublicationRole(client, input.scope.tenantId);
      // The API-state advisory lock freezes lease ownership for this whole
      // transaction. Evaluate expiry once when the lock is acquired; using a
      // later wall clock would make a valid owner lose its fence merely because
      // bulk projection inserts took longer than the lease TTL while renewal
      // was blocked by this same lock.
      const leaseFenceClockMillis = await databaseClockMillis(client);
      const latestAdmittedSequence = assertLiveBoardPublicationLease(boardSnapshot, input, leaseFenceClockMillis);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${REF_LOCK_PREFIX}${input.scope.tenantId}:${input.scope.repository}:${input.scope.ref}`
      ]);
      // Serialize publication with authoritative evidence erasure. If erasure
      // wins, its durable filter is observed below; if publication wins, the
      // eraser invalidates the prepared generation before PageIndex can expose
      // it.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `context-erasure:${input.scope.tenantId}:${input.scope.repository}`
      ]);

      const existing = await publicationByIdempotencyKey(client, input.scope.tenantId, input.idempotencyKey);
      if (existing) {
        if (existing.publication_input_digest !== input.publicationInputDigest) {
          throw new BoardContextPublicationError(
            "idempotency_conflict",
            "publication idempotency key is already bound to different certified inputs"
          );
        }
        assertLiveBoardPublicationLease(boardSnapshot, input, leaseFenceClockMillis);
        await client.query("commit");
        return recordFromRow(existing);
      }

      const current = await client.query<{ ref_sequence: string; release_id: string; commit_sha: string }>(
        `select ref_sequence::text,release_id,commit_sha
         from jina_context.current_context_board_releases
         where tenant_id=$1 and repository=$2 and ref_name=$3
         for update`,
        [input.scope.tenantId, input.scope.repository, input.scope.ref]
      );
      const currentSequence = Number(current.rows[0]?.ref_sequence ?? 0);
      const currentReleaseId = current.rows[0]?.release_id;
      if (
        currentSequence > 0 &&
        (!input.priorRelease ||
          input.priorRelease.releaseId !== currentReleaseId ||
          input.priorRelease.refSequence !== currentSequence)
      ) {
        throw new BoardContextPublicationError(
          "stale_ref_sequence",
          "publication is not based on the current immutable prior Context release"
        );
      }
      if (currentSequence === 0 && input.priorRelease) {
        throw new BoardContextPublicationError(
          "publication_race",
          "publication declares a prior Context release but the ref has no current release"
        );
      }
      if (latestAdmittedSequence > input.scope.refSequence || currentSequence > input.scope.refSequence) {
        throw new BoardContextPublicationError(
          "stale_ref_sequence",
          `publication sequence ${input.scope.refSequence} is stale; latest admitted is ${Math.max(
            latestAdmittedSequence,
            currentSequence
          )}`
        );
      }
      if (currentSequence === input.scope.refSequence && current.rows[0]?.release_id !== input.releaseId) {
        throw new BoardContextPublicationError(
          "publication_race",
          "the ref sequence is already bound to a different release"
        );
      }

      validateCommitCoherence(input);
      await assertPublicationEvidenceNotErased(client, input);
      const projection = materializeProjection(input);
      await persistSnapshot(client, input);
      await persistKnowledge(client, input);
      await persistProjection(client, input, projection);
      await client.query(
        `insert into jina_context.context_board_publications
          (release_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,build_id,
           checkpoint_id,idempotency_key,publication_input_digest,public_snapshot_digest,
           certification_artifact,publication_plan_artifact,release_artifact,page_count,published_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)`,
        [
          input.releaseId,
          input.scope.tenantId,
          input.scope.repository,
          input.scope.ref,
          input.scope.refSequence,
          input.scope.commitSha,
          input.scope.buildId,
          input.snapshot.checkpoint.id,
          input.idempotencyKey,
          input.publicationInputDigest,
          input.publicSnapshotDigest,
          JSON.stringify(input.certificationArtifact),
          JSON.stringify(input.publicationPlanArtifact),
          JSON.stringify(input.releaseArtifact),
          input.pages.length,
          input.publishedAt
        ]
      );
      // The API-state row and advisory lock are still held: repeat the exact
      // lease check immediately before commit, as required by the fence.
      assertLiveBoardPublicationLease(boardSnapshot, input, leaseFenceClockMillis);
      await client.query("commit");
      return {
        releaseId: input.releaseId,
        publicationInputDigest: input.publicationInputDigest,
        publicSnapshotDigest: input.publicSnapshotDigest,
        releaseArtifact: input.releaseArtifact,
        refSequence: input.scope.refSequence,
        commitSha: input.scope.commitSha,
        publishedAt: input.publishedAt
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof BoardContextPublicationError) throw error;
      throw new BoardContextPublicationError(
        "publication_race",
        `atomic context publication failed: ${boundedError(error)}`
      );
    } finally {
      client.release();
    }
  }
}

async function assertPublicationEvidenceNotErased(
  client: PoolClient,
  input: BoardContextPublicationCommit
): Promise<void> {
  const anchors = input.citations.map((citation) => citation.anchor);
  if (anchors.length === 0) return;
  const erased = await client.query(
    `select 1
     from jsonb_to_recordset($1::jsonb) as citation(
       source_type text,source_id text,path_or_url text,content_digest text
     )
     join jina_context.erasure_filters erasure
       on erasure.tenant_id=$2
      and erasure.repository=$3
      and erasure.source_type=citation.source_type
      and (erasure.source_id is null or erasure.source_id=citation.source_id)
      and (erasure.content_digest is null or erasure.content_digest=citation.content_digest)
      and (
        erasure.path_pattern is null
        or citation.path_or_url like erasure.path_pattern escape '\\'
      )
     limit 1`,
    [
      JSON.stringify(
        anchors.map((anchor) => ({
          source_type: anchor.sourceType,
          source_id: anchor.sourceId,
          path_or_url: anchor.pathOrUrl,
          content_digest: anchor.contentDigest
        }))
      ),
      input.scope.tenantId,
      input.scope.repository
    ]
  );
  if (erased.rowCount) {
    throw new BoardContextPublicationError(
      "certification_mismatch",
      "publication evidence was erased before the authoritative commit"
    );
  }
}

function assertLiveBoardPublicationLease(
  snapshot: unknown,
  input: BoardContextPublicationCommit,
  databaseNowMillis: number
): number {
  const root = objectValue(snapshot);
  const intake = objectValue(root?.intakeState);
  const board = objectValue(intake?.board);
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
    throw staleLease("publication task no longer owns the durable board lease");
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
    throw staleLease("publication build scope no longer matches its board root");
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
  return Math.max(0, ...admitted);
}

async function databaseClockMillis(client: PoolClient): Promise<number> {
  const clock = await client.query<{ now_ms: string }>(
    "select (extract(epoch from clock_timestamp()) * 1000)::text as now_ms"
  );
  const now = Number(clock.rows[0]?.now_ms);
  if (!Number.isFinite(now)) throw staleLease("database clock is unavailable");
  return now;
}

async function activateTenantPublicationRole(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("set local role jina_context_tenant_admin");
  await client.query("select set_config('jina.tenant_id',$1,true)", [tenantId]);
}

function validateCommitCoherence(input: BoardContextPublicationCommit): void {
  const checkpoint = input.snapshot.checkpoint;
  if (
    checkpoint.tenantId !== input.scope.tenantId ||
    checkpoint.repository !== input.scope.repository ||
    checkpoint.ref !== input.scope.ref ||
    checkpoint.refSequence !== input.scope.refSequence ||
    checkpoint.commitSha !== input.scope.commitSha ||
    input.run.checkpointId !== checkpoint.id ||
    input.run.tenantId !== input.scope.tenantId ||
    input.run.repository !== input.scope.repository
  ) {
    throw new BoardContextPublicationError(
      "certification_mismatch",
      "publication snapshot or derivation run escapes the certified board scope"
    );
  }
  if (
    input.priorRelease &&
    (input.priorRelease.tenantId !== input.scope.tenantId ||
      input.priorRelease.repository !== input.scope.repository ||
      input.priorRelease.ref !== input.scope.ref ||
      input.priorRelease.refSequence >= input.scope.refSequence)
  ) {
    throw new BoardContextPublicationError(
      "certification_mismatch",
      "publication prior release escapes or does not precede the certified scope"
    );
  }
  const revisionIds = new Set(input.revisions.map((revision) => revision.id));
  if (
    revisionIds.size !== input.revisions.length ||
    input.run.revisionIds.length !== revisionIds.size ||
    input.run.revisionIds.some((id) => !revisionIds.has(id)) ||
    input.pages.length !== revisionIds.size
  ) {
    throw new BoardContextPublicationError(
      "invalid_publication",
      "publication revisions, pages, and derivation run do not form one complete set"
    );
  }
  const citations = new Map(input.revisions.map((revision) => [revision.id, [] as KnowledgeEvidenceCitation[]]));
  for (const citation of input.citations) {
    const group = citations.get(citation.revisionId);
    if (!group)
      throw new BoardContextPublicationError("invalid_publication", "citation references an unknown revision");
    group.push(citation);
  }
  for (const [revisionId, group] of citations) {
    group.sort((left, right) => left.ordinal - right.ordinal);
    if (group.length === 0 || group.some((citation, index) => citation.ordinal !== index)) {
      throw new BoardContextPublicationError(
        "invalid_publication",
        `citation ordinals are incomplete for ${revisionId}`
      );
    }
  }
}

function materializeProjection(input: BoardContextPublicationCommit): MaterializedProjection {
  const citationsByRevision = new Map(
    input.revisions.map((revision) => [
      revision.id,
      input.citations.filter((citation) => citation.revisionId === revision.id)
    ])
  );
  const aclByCitation = new Map<string, string>();
  for (const citation of input.citations) {
    const evidence = input.snapshot.records.find(
      (candidate) =>
        candidate.anchor.sourceType === citation.anchor.sourceType &&
        candidate.anchor.sourceId === citation.anchor.sourceId &&
        candidate.anchor.contentDigest === citation.anchor.contentDigest &&
        candidate.anchor.pathOrUrl === citation.anchor.pathOrUrl
    );
    if (!evidence) {
      throw new BoardContextPublicationError(
        "certification_mismatch",
        `citation ${citation.id} is absent from the certified snapshot`
      );
    }
    aclByCitation.set(citation.id, evidence.aclFingerprint);
  }
  const knowledge = new CurrentKnowledgeProjector().project({
    generationId: input.releaseId,
    projectedAt: input.publishedAt,
    revisions: [...input.revisions],
    citations: citationsByRevision,
    aclFingerprints: aclByCitation
  });
  const fragments = new LexicalProjector().project(knowledge.documents);
  const exactIndex = new ExactProjector().project(knowledge.documents);
  const projectorVersions = {
    manifest: "manifest-v1",
    "knowledge-current": "knowledge-current-v2",
    lexical: "lexical-v2",
    dense: "disabled-v1",
    hierarchy: "pageindex-pending-v1",
    structural: "disabled-derived-only-v1",
    identity: "identity-v1",
    acl: "acl-v1",
    retention: "retention-v1"
  };
  const projectorStatuses: Record<(typeof contextProjectionConsumers)[number], ProjectorStatus> = {
    manifest: "ready",
    "knowledge-current": "ready",
    lexical: "ready",
    dense: "disabled",
    hierarchy: "disabled",
    structural: "skipped",
    identity: "ready",
    acl: "ready",
    retention: "ready"
  };
  const generation: IndexGeneration = {
    id: input.releaseId,
    tenantId: input.scope.tenantId,
    repository: input.scope.repository,
    repositoryAccessFingerprint: input.snapshot.checkpoint.aclFingerprint,
    projectionInputFingerprint: input.publicationInputDigest,
    ref: input.scope.ref,
    commitSha: input.scope.commitSha,
    checkpointId: input.snapshot.checkpoint.id,
    // Board publication prepares the complete projection, but PageIndex is a
    // mandatory part of the public release. The attachment transaction is the
    // only writer that may transition this generation to `published`.
    status: "building",
    projectorVersions,
    projectorStatuses,
    capabilities: {
      sourceCompleteness: input.snapshot.checkpoint.sourceCompleteness,
      derivedKnowledge: "available",
      dense: "disabled",
      hierarchy: "disabled"
    },
    fingerprint: fingerprint({
      publicationInputDigest: input.publicationInputDigest,
      documents: knowledge.documents.map((document) => document.sourceFingerprint),
      fragments: fragments.map((fragment) => fragment.tokenFingerprint),
      exactIndex
    }),
    createdAt: input.publishedAt
  };
  return {
    generation,
    currentKnowledge: knowledge.selections,
    documents: knowledge.documents,
    fragments,
    exactIndex
  };
}

async function persistSnapshot(client: PoolClient, input: BoardContextPublicationCommit): Promise<void> {
  const checkpoint = input.snapshot.checkpoint;
  await client.query(
    `insert into jina_context.repositories
      (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
     values ($1,$2,'unknown',$2,$3,'{}'::jsonb,$4,$4)
     on conflict (tenant_id,repository) do nothing`,
    [checkpoint.tenantId, checkpoint.repository, checkpoint.ref, checkpoint.createdAt]
  );
  const evidenceRows = input.snapshot.records.map((record) => ({
    id: record.id,
    tenant_id: record.anchor.tenantId,
    repository: record.anchor.repository,
    ref_name: record.ref,
    source_type: record.anchor.sourceType,
    source_id: record.anchor.sourceId,
    content_digest: record.anchor.contentDigest,
    commit_sha: record.anchor.commitSha ?? null,
    path_or_url: record.anchor.pathOrUrl ?? null,
    start_line: record.anchor.startLine ?? null,
    end_line: record.anchor.endLine ?? null,
    json_pointer: record.anchor.jsonPointer ?? null,
    observed_at: record.anchor.observedAt ?? null,
    title: record.title,
    body: record.body,
    metadata: record.metadata,
    authority_class: record.authorityClass,
    acl_fingerprint: record.aclFingerprint,
    created_at: record.createdAt
  }));
  await client.query(
    `with input as (
       select * from jsonb_to_recordset($1::jsonb) as row(
         id text,tenant_id text,repository text,ref_name text,source_type text,source_id text,
         content_digest text,commit_sha text,path_or_url text,start_line integer,end_line integer,
         json_pointer text,observed_at timestamptz,title text,body text,metadata jsonb,
         authority_class text,acl_fingerprint text,created_at timestamptz
       )
     )
     insert into jina_context.evidence_records
      (id,tenant_id,repository,ref_name,source_type,source_id,content_digest,commit_sha,
       path_or_url,start_line,end_line,json_pointer,observed_at,title,body,metadata,
       authority_class,acl_fingerprint,created_at)
     select id,tenant_id,repository,ref_name,source_type,source_id,content_digest,commit_sha,
            path_or_url,start_line,end_line,json_pointer,observed_at,title,body,metadata,
            authority_class,acl_fingerprint,created_at
     from input
     on conflict (tenant_id,repository,id) do nothing`,
    [JSON.stringify(evidenceRows)]
  );
  const matchingEvidence = await client.query<{ count: string }>(
    `select count(*)::text count
     from jsonb_to_recordset($1::jsonb) as input(
       id text,tenant_id text,repository text,content_digest text
     )
     join jina_context.evidence_records stored
       on stored.id=input.id and stored.tenant_id=input.tenant_id
      and stored.repository=input.repository and stored.content_digest=input.content_digest`,
    [JSON.stringify(evidenceRows)]
  );
  if (Number(matchingEvidence.rows[0]?.count ?? -1) !== evidenceRows.length) {
    throw new BoardContextPublicationError("publication_race", "evidence record identity collision");
  }
  await client.query(
    `insert into jina_context.evidence_checkpoints
      (id,tenant_id,repository,ref_name,ref_sequence,commit_sha,parser_version,
       source_completeness,observation_frontier,evidence_fingerprint,manifest_fingerprint,
       acl_fingerprint,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (id) do nothing`,
    [
      checkpoint.id,
      checkpoint.tenantId,
      checkpoint.repository,
      checkpoint.ref,
      checkpoint.refSequence,
      checkpoint.commitSha,
      checkpoint.parserVersion,
      checkpoint.sourceCompleteness,
      checkpoint.observationFrontier,
      checkpoint.evidenceFingerprint,
      checkpoint.manifestFingerprint,
      checkpoint.aclFingerprint,
      checkpoint.createdAt
    ]
  );
  const storedCheckpoint = await client.query(
    `select 1 from jina_context.evidence_checkpoints
     where id=$1 and tenant_id=$2 and repository=$3 and ref_name=$4
       and ref_sequence=$5 and commit_sha=$6 and evidence_fingerprint=$7
       and manifest_fingerprint=$8`,
    [
      checkpoint.id,
      checkpoint.tenantId,
      checkpoint.repository,
      checkpoint.ref,
      checkpoint.refSequence,
      checkpoint.commitSha,
      checkpoint.evidenceFingerprint,
      checkpoint.manifestFingerprint
    ]
  );
  if (storedCheckpoint.rowCount !== 1) {
    throw new BoardContextPublicationError("publication_race", "evidence checkpoint identity collision");
  }
  await client.query(
    `insert into jina_context.evidence_checkpoint_records
      (checkpoint_id,tenant_id,repository,evidence_id,ordinal)
     select $1,$2,$3,row.id,row.ordinality-1
     from unnest($4::text[]) with ordinality row(id,ordinality)
     on conflict (checkpoint_id,ordinal) do nothing`,
    [checkpoint.id, checkpoint.tenantId, checkpoint.repository, input.snapshot.records.map((record) => record.id)]
  );
  const manifestRows = input.snapshot.manifest.map((entry) => ({
    checkpoint_id: checkpoint.id,
    tenant_id: entry.tenantId,
    repository: entry.repository,
    ref_name: entry.ref,
    commit_sha: entry.commitSha,
    path: entry.path,
    blob_sha: entry.blobSha,
    content_digest: entry.contentDigest,
    content_available: entry.contentAvailable,
    language: entry.language ?? null,
    executable: entry.executable,
    entry_type: entry.entryType ?? "file",
    link_target: entry.linkTarget ?? null
  }));
  await client.query(
    `insert into jina_context.evidence_checkpoint_manifest
      (checkpoint_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,
       content_digest,content_available,language,executable,entry_type,link_target)
     select checkpoint_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,
            content_digest,content_available,language,executable,entry_type,link_target
     from jsonb_to_recordset($1::jsonb) as row(
       checkpoint_id text,tenant_id text,repository text,ref_name text,commit_sha text,
       path text,blob_sha text,content_digest text,content_available boolean,language text,
       executable boolean,entry_type text,link_target text
     )
     on conflict (checkpoint_id,path) do nothing`,
    [JSON.stringify(manifestRows)]
  );
}

async function persistKnowledge(client: PoolClient, input: BoardContextPublicationCommit): Promise<void> {
  const run = input.run;
  const checkpoint = input.snapshot.checkpoint;
  await client.query(
    `insert into jina_context.derivation_runs
      (id,tenant_id,repository,ref_name,commit_sha,checkpoint_id,focus,focus_fingerprint,
       evidence_fingerprint,generator_name,generator_version,model,prompt_version,
       schema_version,cache_key,status,raw_output,validation_diagnostics,revision_ids,
       started_at,completed_at)
     values ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,'succeeded',
             '[]'::jsonb,'[]'::jsonb,$15::text[],$16,$16)
     on conflict (tenant_id,repository,id) do nothing`,
    [
      run.id,
      run.tenantId,
      run.repository,
      checkpoint.ref,
      checkpoint.commitSha,
      checkpoint.id,
      run.focusFingerprint,
      checkpoint.evidenceFingerprint,
      run.generatorName,
      run.generatorVersion,
      run.model,
      run.promptVersion,
      run.schemaVersion,
      run.cacheKey,
      run.revisionIds,
      run.createdAt
    ]
  );
  for (const revision of input.revisions) {
    await client.query(
      `insert into jina_context.knowledge_documents
        (tenant_id,repository,logical_id,kind,subject,created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6)
       on conflict (tenant_id,repository,logical_id) do nothing`,
      [
        revision.tenantId,
        revision.repository,
        revision.logicalId,
        revision.kind,
        JSON.stringify({ logicalId: revision.logicalId, scope: revision.scope }),
        revision.createdAt
      ]
    );
    await client.query(
      `insert into jina_context.knowledge_document_revisions
        (id,tenant_id,repository,logical_id,derivation_run_id,title,body_markdown,
         summary,structured_summary,scope,ref_name,commit_sha,evidence_fingerprint,
         body_digest,generator_name,generator_version,model,prompt_version,confidence,
         author_kind,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,
               $15,$16,$17,$18,$19,'model',$20)
       on conflict (tenant_id,repository,id) do nothing`,
      [
        revision.id,
        revision.tenantId,
        revision.repository,
        revision.logicalId,
        run.id,
        revision.title,
        revision.bodyMarkdown,
        revision.summary,
        JSON.stringify(revision.structuredSummary),
        JSON.stringify(revision.scope),
        revision.scope.ref,
        revision.scope.commitSha,
        revision.evidenceFingerprint,
        revision.bodyDigest,
        revision.generatorName,
        revision.generatorVersion,
        revision.model,
        revision.promptVersion,
        revision.confidence,
        revision.createdAt
      ]
    );
  }
  for (const citation of input.citations) {
    const revision = input.revisions.find((candidate) => candidate.id === citation.revisionId)!;
    const anchor = citation.anchor;
    await client.query(
      `insert into jina_context.knowledge_revision_evidence
        (tenant_id,repository,revision_id,ordinal,claim_role,claim_ids,
         public_citation_id,public_claim_span,source_type,source_id,content_digest,
         commit_sha,path_or_url,start_line,end_line,json_pointer,observed_at,anchor)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
       on conflict (tenant_id,repository,revision_id,ordinal) do nothing`,
      [
        revision.tenantId,
        revision.repository,
        citation.revisionId,
        citation.ordinal,
        citation.claim,
        [citation.id],
        citation.citationId ?? null,
        citation.claimSpan ?? null,
        anchor.sourceType,
        anchor.sourceId,
        anchor.contentDigest,
        anchor.commitSha ?? null,
        anchor.pathOrUrl ?? null,
        anchor.startLine ?? null,
        anchor.endLine ?? null,
        anchor.jsonPointer ?? null,
        anchor.observedAt ?? null,
        JSON.stringify(anchor)
      ]
    );
  }
  // Identity collisions are impossible to distinguish with ON CONFLICT alone.
  // Rehydrate the canonical immutable fields before making anything queryable.
  for (const revision of input.revisions) {
    const stored = await client.query<{
      id: string;
      logical_id: string;
      tenant_id: string;
      repository: string;
      kind: typeof revision.kind;
      title: string;
      body_markdown: string;
      summary: string;
      structured_summary: Record<string, unknown>;
      scope: typeof revision.scope;
      evidence_fingerprint: string;
      body_digest: string;
      generator_name: string;
      generator_version: string;
      model: string;
      prompt_version: string;
      confidence: number;
      created_at: Date;
    }>(
      `select revision.*,document.kind
       from jina_context.knowledge_document_revisions revision
       join jina_context.knowledge_documents document
         on document.tenant_id=revision.tenant_id
        and document.repository=revision.repository
        and document.logical_id=revision.logical_id
       where revision.tenant_id=$1 and revision.repository=$2 and revision.id=$3`,
      [revision.tenantId, revision.repository, revision.id]
    );
    const row = stored.rows[0];
    const canonical = row && {
      id: row.id,
      logicalId: row.logical_id,
      tenantId: row.tenant_id,
      repository: row.repository,
      kind: row.kind,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      summary: row.summary,
      structuredSummary: row.structured_summary,
      scope: row.scope,
      evidenceFingerprint: row.evidence_fingerprint,
      bodyDigest: row.body_digest,
      generatorName: row.generator_name,
      generatorVersion: row.generator_version,
      model: row.model,
      promptVersion: row.prompt_version,
      confidence: row.confidence,
      createdAt: dateString(row.created_at)
    };
    if (!canonical || !sameImmutableKnowledgeRevision(canonical, revision)) {
      throw new BoardContextPublicationError("publication_race", `knowledge revision collision for ${revision.id}`);
    }
    const storedCitations = await client.query<{
      revision_id: string;
      ordinal: number;
      claim_role: string;
      claim_ids: string[];
      public_citation_id: string | null;
      public_claim_span: string | null;
      anchor: KnowledgeEvidenceCitation["anchor"];
    }>(
      `select revision_id,ordinal,claim_role,claim_ids,public_citation_id,public_claim_span,anchor
       from jina_context.knowledge_revision_evidence
       where tenant_id=$1 and repository=$2 and revision_id=$3
       order by ordinal`,
      [revision.tenantId, revision.repository, revision.id]
    );
    const expected = input.citations
      .filter((citation) => citation.revisionId === revision.id)
      .sort((left, right) => left.ordinal - right.ordinal);
    const actual = storedCitations.rows.map((citation): KnowledgeEvidenceCitation => ({
      id: citation.claim_ids[0]!,
      revisionId: citation.revision_id,
      ordinal: citation.ordinal,
      claim: citation.claim_role,
      ...(citation.public_citation_id
        ? {
            citationId: citation.public_citation_id,
            claimSpan: citation.public_claim_span!
          }
        : {}),
      anchor: citation.anchor
    }));
    if (
      actual.length !== expected.length ||
      actual.some((citation, index) => !sameImmutableKnowledgeCitation(citation, expected[index]!))
    ) {
      throw new BoardContextPublicationError(
        "publication_race",
        `knowledge citation collection collision for ${revision.id}`
      );
    }
  }
}

async function persistProjection(
  client: PoolClient,
  input: BoardContextPublicationCommit,
  projection: MaterializedProjection
): Promise<void> {
  const generation = projection.generation;
  await client.query(
    `insert into jina_context.index_generations
      (id,tenant_id,repository,ref_name,commit_sha,checkpoint_id,kind,status,
       barrier_occurred_at,projector_versions,capabilities,required_fingerprint,
       acl_fingerprint,projection_input_fingerprint,degraded_capabilities,
       created_at,published_at)
     values ($1,$2,$3,$4,$5,$6,'enriched','building',$7,$8::jsonb,$9::jsonb,
             $10,$11,$12,'{}'::text[],$13,null)`,
    [
      generation.id,
      generation.tenantId,
      generation.repository,
      generation.ref,
      generation.commitSha,
      generation.checkpointId,
      input.snapshot.checkpoint.createdAt,
      JSON.stringify(generation.projectorVersions),
      JSON.stringify(generation.capabilities),
      generation.fingerprint,
      generation.repositoryAccessFingerprint,
      generation.projectionInputFingerprint,
      generation.createdAt
    ]
  );
  for (const consumer of contextProjectionConsumers) {
    const status = generation.projectorStatuses[consumer];
    await client.query(
      `insert into jina_context.generation_projectors
        (generation_id,consumer,required,version,status,output_fingerprint,
         processed_through,completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        generation.id,
        consumer,
        ["manifest", "lexical", "identity", "acl", "retention"].includes(consumer),
        generation.projectorVersions[consumer],
        status,
        status === "ready" ? generation.fingerprint : null,
        input.snapshot.checkpoint.createdAt,
        input.publishedAt
      ]
    );
  }
  await refreshRepositoryAclProjection(client, generation.id, generation.tenantId, generation.repository);
  const manifestRows = input.snapshot.manifest.map((entry) => ({
    generation_id: generation.id,
    tenant_id: entry.tenantId,
    repository: entry.repository,
    ref_name: entry.ref,
    commit_sha: entry.commitSha,
    path: entry.path,
    blob_sha: entry.blobSha,
    mode: entry.executable ? "100755" : "100644",
    source_fingerprint: entry.contentDigest,
    content_available: entry.contentAvailable,
    source_anchors: input.snapshot.records
      .filter(
        (record) =>
          record.anchor.sourceType === "blob" &&
          record.anchor.sourceId === entry.blobSha &&
          record.anchor.pathOrUrl === entry.path
      )
      .map((record) => record.anchor)
  }));
  await client.query(
    `insert into jina_context.ref_manifest
      (generation_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,mode,
       source_fingerprint,content_available,source_anchors)
     select generation_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,mode,
            source_fingerprint,content_available,source_anchors
     from jsonb_to_recordset($1::jsonb) as row(
       generation_id text,tenant_id text,repository text,ref_name text,commit_sha text,
       path text,blob_sha text,mode text,source_fingerprint text,content_available boolean,
       source_anchors jsonb
     )`,
    [JSON.stringify(manifestRows)]
  );
  const selections = projection.currentKnowledge.map((selection) => ({
    generation_id: selection.generationId,
    tenant_id: selection.tenantId,
    repository: selection.repository,
    logical_id: selection.logicalId,
    revision_id: selection.revisionId,
    selection_reason: { reason: selection.selectionReason },
    selection_fingerprint: fingerprint(selection)
  }));
  await client.query(
    `insert into jina_context.current_knowledge_revisions
      (generation_id,tenant_id,repository,logical_id,revision_id,selection_reason,selection_fingerprint)
     select generation_id,tenant_id,repository,logical_id,revision_id,
            selection_reason,selection_fingerprint
     from jsonb_to_recordset($1::jsonb) as row(
       generation_id text,tenant_id text,repository text,logical_id text,revision_id text,
       selection_reason jsonb,selection_fingerprint text
     )`,
    [JSON.stringify(selections)]
  );
  const documents = projection.documents.map((document) => ({
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
      documentPath: input.pages.find((page) => page.revisionId === document.sourceRevisionId)?.documentPath ?? null
    },
    authority_class: document.authorityClass,
    effective_acl_fingerprint: document.effectiveAclFingerprint,
    source_fingerprint: document.sourceFingerprint,
    source_anchors: document.anchors,
    projector_name: document.projectorName,
    projector_version: document.projectorVersion,
    projected_at: document.projectedAt
  }));
  await client.query(
    `insert into jina_context.context_documents
      (id,generation_id,tenant_id,repository,ref_name,commit_sha,source_kind,source_id,
       source_revision_id,title,body,contextual_text,metadata,authority_class,
       effective_acl_fingerprint,source_fingerprint,source_anchors,projector_name,
       projector_version,projected_at)
     select id,generation_id,tenant_id,repository,ref_name,commit_sha,source_kind,source_id,
            source_revision_id,title,body,contextual_text,metadata,authority_class,
            effective_acl_fingerprint,source_fingerprint,source_anchors,projector_name,
            projector_version,projected_at
     from jsonb_to_recordset($1::jsonb) as row(
       id text,generation_id text,tenant_id text,repository text,ref_name text,commit_sha text,
       source_kind text,source_id text,source_revision_id text,title text,body text,
       contextual_text text,metadata jsonb,authority_class text,effective_acl_fingerprint text,
       source_fingerprint text,source_anchors jsonb,projector_name text,
       projector_version text,projected_at timestamptz
     )`,
    [JSON.stringify(documents)]
  );
  const documentById = new Map(projection.documents.map((document) => [document.id, document]));
  const fragments = projection.fragments.map((fragment) => ({
    id: fragment.id,
    generation_id: fragment.generationId,
    document_id: fragment.documentId,
    tenant_id: documentById.get(fragment.documentId)!.tenantId,
    repository: documentById.get(fragment.documentId)!.repository,
    ordinal: fragment.ordinal,
    source_text: fragment.sourceText,
    contextual_text: fragment.contextualText,
    source_anchors: fragment.anchors,
    source_start: fragment.startOffset,
    source_end: fragment.endOffset,
    content_fingerprint: fragment.tokenFingerprint,
    effective_acl_fingerprint: documentById.get(fragment.documentId)!.effectiveAclFingerprint
  }));
  await client.query(
    `insert into jina_context.context_fragments
      (id,generation_id,document_id,tenant_id,repository,ordinal,source_text,
       contextual_text,source_anchors,source_start,source_end,content_fingerprint,
       effective_acl_fingerprint)
     select id,generation_id,document_id,tenant_id,repository,ordinal,source_text,
            contextual_text,source_anchors,source_start,source_end,content_fingerprint,
            effective_acl_fingerprint
     from jsonb_to_recordset($1::jsonb) as row(
       id text,generation_id text,document_id text,tenant_id text,repository text,
       ordinal integer,source_text text,contextual_text text,source_anchors jsonb,
       source_start integer,source_end integer,content_fingerprint text,
       effective_acl_fingerprint text
     )`,
    [JSON.stringify(fragments)]
  );
  const exact = projection.exactIndex.map((entry) => ({
    generation_id: entry.generationId,
    term: entry.term,
    document_id: entry.documentId,
    field: entry.field
  }));
  await client.query(
    `insert into jina_context.exact_index (generation_id,term,document_id,field)
     select generation_id,term,document_id,field
     from jsonb_to_recordset($1::jsonb) as row(
       generation_id text,term text,document_id text,field text
     )`,
    [JSON.stringify(exact)]
  );
}

export async function refreshRepositoryAclProjection(
  client: PoolClient,
  generationId: string,
  tenantId: string,
  repository: string
): Promise<void> {
  await client.query(
    `insert into jina_context.repository_acl_projection
      (generation_id,tenant_id,repository,principal_id,permission,acl_fingerprint,source_observation_id)
     select distinct on (acl.principal_id)
       $1,acl.tenant_id,acl.repository,acl.principal_id,acl.permission,
       acl.acl_fingerprint,acl.source_observation_id
     from jina_context.repository_acl_observations acl
     where acl.tenant_id=$2 and acl.repository=$3
     order by acl.principal_id,acl.observed_at desc,acl.id desc
     on conflict (generation_id,principal_id) do update
       set permission=excluded.permission,
           acl_fingerprint=excluded.acl_fingerprint,
           source_observation_id=excluded.source_observation_id`,
    [generationId, tenantId, repository]
  );
}

async function publicationByIdempotencyKey(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string
): Promise<PublicationRow | undefined> {
  const result = await client.query<PublicationRow>(
    `select release_id,ref_sequence::text,commit_sha,publication_input_digest,
            public_snapshot_digest,release_artifact,published_at
     from jina_context.context_board_publications
     where tenant_id=$1 and idempotency_key=$2
     for update`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0];
}

function recordFromRow(row: PublicationRow): BoardContextPublicationRecord {
  return {
    releaseId: row.release_id,
    publicationInputDigest: row.publication_input_digest,
    publicSnapshotDigest: row.public_snapshot_digest,
    releaseArtifact: row.release_artifact,
    refSequence: Number(row.ref_sequence),
    commitSha: row.commit_sha,
    publishedAt: dateString(row.published_at)
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isObject(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined;
}

function staleLease(message: string): BoardContextPublicationError {
  return new BoardContextPublicationError("stale_publication_lease", message);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
