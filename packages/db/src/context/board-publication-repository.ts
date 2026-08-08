import {
  BoardContextPublicationError,
  CurrentKnowledgeBuilder,
  ExactProjector,
  LexicalProjector,
  fingerprint,
  normalizeRepository,
  parseContextPriorReleaseSeed,
  type BoardContextPublicationCommit,
  type BoardContextPublicationRecord,
  type BoardContextReleaseSeedPort,
  type BoardContextPublicationTransactionPort,
  type ContextPriorReleaseSeed,
  type GenerationProjection,
  type IndexGeneration,
  type KnowledgeEvidenceCitation
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, dateString } from "./database.js";
import { storedContextCatalog } from "./release-catalog.js";

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
      `select release_id,ref_sequence::text,commit_sha,public_snapshot_digest,release_artifact
       from jina_context.context_releases
       where tenant_id=$1 and repository=$2 and ref_name=$3
         and pageindex_attached_at is not null
       order by ref_sequence desc,release_id desc
       limit 1`,
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
      // release materialization took longer than the lease TTL while renewal was
      // blocked by this same lock.
      const leaseFenceClockMillis = await databaseClockMillis(client);
      const latestAdmittedSequence = assertLiveBoardPublicationLease(boardSnapshot, input, leaseFenceClockMillis);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${REF_LOCK_PREFIX}${input.scope.tenantId}:${input.scope.repository}:${input.scope.ref}`
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

      const current = await client.query<{
        ref_sequence: string;
        release_id: string;
      }>(
        `select ref_sequence::text,release_id
         from jina_context.context_releases
         where tenant_id=$1 and repository=$2 and ref_name=$3
           and pageindex_attached_at is not null
         order by ref_sequence desc,release_id desc
         limit 1
         for update`,
        [input.scope.tenantId, input.scope.repository, input.scope.ref]
      );
      const currentSequence = Number(current.rows[0]?.ref_sequence ?? 0);
      const currentReleaseId = current.rows[0]?.release_id;
      if (
        !contextPublicationMayAdvanceCurrent({
          ...(currentSequence > 0 && currentReleaseId
            ? {
                current: {
                  refSequence: currentSequence,
                  releaseId: currentReleaseId
                }
              }
            : {}),
          ...(input.priorRelease ? { priorRelease: input.priorRelease } : {})
        })
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
      const projection = materializeProjection(input);
      await client.query(
        `insert into jina_context.repositories
          (tenant_id,repository,default_ref,created_at,updated_at)
         values ($1,$2,$3,$4,$4)
         on conflict (tenant_id,repository) do nothing`,
        [input.scope.tenantId, input.scope.repository, input.scope.ref, input.publishedAt]
      );
      await client.query(
        `insert into jina_context.context_releases
          (release_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,build_id,
           checkpoint_id,idempotency_key,publication_input_digest,public_snapshot_digest,
           certification_artifact,publication_plan_artifact,release_artifact,catalog,
           page_count,prepared_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15::jsonb,$16,$17)`,
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
          JSON.stringify(
            storedContextCatalog({
              projection,
              revisions: input.revisions,
              citations: input.citations
            })
          ),
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

export function contextPublicationMayAdvanceCurrent(input: {
  readonly current?: {
    readonly refSequence: number;
    readonly releaseId: string;
  };
  readonly priorRelease?: Pick<ContextPriorReleaseSeed, "releaseId" | "refSequence">;
}): boolean {
  if (!input.current) return input.priorRelease === undefined;
  return (
    input.priorRelease?.releaseId === input.current.releaseId &&
    input.priorRelease.refSequence === input.current.refSequence
  );
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

function materializeProjection(input: BoardContextPublicationCommit): GenerationProjection {
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
  const knowledge = new CurrentKnowledgeBuilder().project({
    generationId: input.releaseId,
    revisions: [...input.revisions],
    citations: citationsByRevision,
    aclFingerprints: aclByCitation
  });
  const fragments = new LexicalProjector().project(knowledge.documents);
  const exactIndex = new ExactProjector().project(knowledge.documents);
  const generation: IndexGeneration = {
    id: input.releaseId,
    tenantId: input.scope.tenantId,
    repository: input.scope.repository,
    ref: input.scope.ref,
    commitSha: input.scope.commitSha,
    checkpointId: input.snapshot.checkpoint.id,
    // Board publication prepares the complete projection, but PageIndex is a
    // mandatory part of the public release. The attachment transaction is the
    // only writer that may transition this generation to `published`.
    status: "building",
    capabilities: {
      sourceCompleteness: input.snapshot.checkpoint.sourceCompleteness,
      derivedKnowledge: "available",
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
    manifest: [...input.snapshot.manifest],
    currentKnowledge: knowledge.selections,
    documents: knowledge.documents,
    fragments,
    exactIndex,
    hierarchyNodes: [],
    structuralRelations: []
  };
}

async function publicationByIdempotencyKey(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string
): Promise<PublicationRow | undefined> {
  const result = await client.query<PublicationRow>(
    `select release_id,ref_sequence::text,commit_sha,publication_input_digest,
            public_snapshot_digest,release_artifact,prepared_at as published_at
     from jina_context.context_releases
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
