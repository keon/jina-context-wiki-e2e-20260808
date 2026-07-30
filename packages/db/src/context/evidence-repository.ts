import type {
  EvidenceAnchor,
  EvidenceCheckpoint,
  EvidenceRecord,
  EvidenceSnapshot,
  EvidenceStore,
  RefManifestEntry,
  StructuralFact
} from "@jina/context-engine";
import { evidenceExcerpt } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { lockRepositoryAccess } from "./access.js";
import { ContextDatabase, contextDigest, contextStableId, dateString } from "./database.js";
import { enqueueContextEvent } from "./outbox-repository.js";
import { appendProjectionInputEvent, lockProjectionInput } from "./projection-input.js";

const SNAPSHOT_INSERT_CHUNK_SIZE = 2_000;
const SNAPSHOT_INSERT_CHUNK_BYTE_TARGET = 4 * 1024 * 1024;

interface CheckpointRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  ref_sequence: string;
  commit_sha: string;
  parser_version: string;
  source_completeness: "complete" | "partial";
  observation_frontier: string;
  evidence_fingerprint: string;
  manifest_fingerprint: string;
  acl_fingerprint: string;
  created_at: Date;
}

interface EvidenceRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  source_type: EvidenceAnchor["sourceType"];
  source_id: string;
  content_digest: string;
  commit_sha: string | null;
  path_or_url: string | null;
  start_line: number | null;
  end_line: number | null;
  json_pointer: string | null;
  observed_at: Date | null;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  authority_class: EvidenceRecord["authorityClass"];
  acl_fingerprint: string;
  created_at: Date;
}

interface ManifestRow {
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  path: string;
  blob_sha: string;
  content_digest: string;
  content_available: boolean;
  language: string | null;
  executable: boolean;
  entry_type: "file" | "symlink" | "gitlink";
  link_target: string | null;
}

interface StructuralFactRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  relation_kind: StructuralFact["kind"];
  source_id: string;
  target_id: string;
  source_anchors: EvidenceAnchor[];
  metadata: Record<string, unknown>;
  derivation_name: string;
  derivation_version: string;
}

export interface RepositoryRegistration {
  readonly tenantId: string;
  readonly repository: string;
  readonly provider: string;
  readonly providerRepositoryId: string;
  readonly defaultRef: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface ProviderObservation {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly source: string;
  readonly sourceType:
    | "provider_event"
    | "provider_snapshot"
    | "git_object"
    | "parser_result"
    | "human_input"
    | "model_output"
    | "tombstone";
  readonly externalId?: string;
  readonly occurredAt?: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly contentDigest: string;
}

export interface RepositoryAclObservation {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly principalId: string;
  readonly permission: "read" | "write" | "admin" | "denied";
  readonly aclFingerprint: string;
  readonly sourceObservationId: string;
  readonly observedAt: string;
}

export class PostgresEvidenceRepository implements EvidenceStore {
  constructor(private readonly database: ContextDatabase) {}

  async registerRepository(input: RepositoryRegistration): Promise<void> {
    await this.database.transactionAs("jina_context_ingest", { tenantIds: [input.tenantId] }, async (client) => {
      await client.query(
        `insert into jina_context.repositories
        (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
       on conflict (tenant_id,repository) do update
       set provider=excluded.provider,provider_repository_id=excluded.provider_repository_id,
           default_ref=excluded.default_ref,metadata=excluded.metadata,updated_at=excluded.updated_at
       where (
         jina_context.repositories.provider='unknown'
         or (
           jina_context.repositories.provider=excluded.provider
           and jina_context.repositories.provider_repository_id=excluded.provider_repository_id
         )
       )`,
        [
          input.tenantId,
          input.repository,
          input.provider,
          input.providerRepositoryId,
          input.defaultRef,
          JSON.stringify(input.metadata ?? {}),
          input.at
        ]
      );
    });
  }

  async appendObservation(observation: ProviderObservation): Promise<void> {
    await this.database.transactionAs("jina_context_ingest", { tenantIds: [observation.tenantId] }, async (client) => {
      await insertObservation(client, observation);
      await enqueueContextEvent(client, {
        id: contextStableId("event", { observation: observation.id }),
        sequence: 1,
        tenantId: observation.tenantId,
        repository: observation.repository,
        aggregateType: "evidence",
        aggregateId: observation.id,
        eventType: "evidence.observed",
        payload: { observationId: observation.id, sourceType: observation.sourceType },
        consumers: ["retention"],
        occurredAt: observation.recordedAt
      });
    });
  }

  async appendRepositoryAcl(observation: RepositoryAclObservation): Promise<void> {
    await this.database.transactionAs("jina_context_ingest", { tenantIds: [observation.tenantId] }, async (client) => {
      await lockRepositoryAccess(client, observation.tenantId, observation.repository);
      await client.query(
        `insert into jina_context.repository_acl_observations
          (id,tenant_id,repository,principal_id,permission,acl_fingerprint,
           source_observation_id,observed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id,repository,id) do nothing`,
        [
          observation.id,
          observation.tenantId,
          observation.repository,
          observation.principalId,
          observation.permission,
          observation.aclFingerprint,
          observation.sourceObservationId,
          observation.observedAt
        ]
      );
      await enqueueContextEvent(client, {
        id: contextStableId("event", { aclObservation: observation.id }),
        sequence: 1,
        tenantId: observation.tenantId,
        repository: observation.repository,
        aggregateType: "access",
        aggregateId: observation.id,
        eventType: "access.observed",
        payload: { aclObservationId: observation.id, principalId: observation.principalId },
        consumers: ["acl", "retention"],
        occurredAt: observation.observedAt
      });
    });
  }

  async commitSnapshot(snapshot: EvidenceSnapshot): Promise<EvidenceCheckpoint> {
    await this.database.transactionAs(
      "jina_context_ingest",
      { tenantIds: [snapshot.checkpoint.tenantId] },
      async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `context-generation-ref:${snapshot.checkpoint.tenantId}:${snapshot.checkpoint.repository}:${snapshot.checkpoint.ref}`
        ]);
        await lockProjectionInput(client, snapshot.checkpoint.tenantId, snapshot.checkpoint.repository);
        await ensureRepository(client, snapshot.checkpoint);
        await insertEvidenceRecords(client, snapshot.records);
        await ensureManifestBlobs(client, snapshot.manifest, snapshot.records, snapshot.checkpoint.createdAt);
        await insertStructuralFacts(client, snapshot.structuralFacts, snapshot.checkpoint.createdAt);
        if (snapshot.git) await persistGitSnapshot(client, snapshot);

        const checkpoint = snapshot.checkpoint;
        await client.query(
          `insert into jina_context.evidence_checkpoints
          (id,tenant_id,repository,ref_name,ref_sequence,commit_sha,parser_version,source_completeness,
           observation_frontier,evidence_fingerprint,manifest_fingerprint,acl_fingerprint,created_at)
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
         where id=$1 and tenant_id=$2 and repository=$3 and ref_name=$4 and commit_sha=$5
           and ref_sequence=$6 and parser_version=$7 and observation_frontier=$8
           and evidence_fingerprint=$9 and manifest_fingerprint=$10 and acl_fingerprint=$11`,
          [
            checkpoint.id,
            checkpoint.tenantId,
            checkpoint.repository,
            checkpoint.ref,
            checkpoint.commitSha,
            checkpoint.refSequence,
            checkpoint.parserVersion,
            checkpoint.observationFrontier,
            checkpoint.evidenceFingerprint,
            checkpoint.manifestFingerprint,
            checkpoint.aclFingerprint
          ]
        );
        if (storedCheckpoint.rowCount !== 1) {
          throw new Error(`Evidence checkpoint identity collision for ${checkpoint.id}`);
        }
        await insertCheckpointRecords(client, checkpoint, snapshot.records);
        await insertCheckpointManifest(client, checkpoint, snapshot.manifest);
        await insertCheckpointStructuralFacts(client, checkpoint, snapshot.structuralFacts);
        const latest = await client.query<{ id: string }>(
          `select id from jina_context.evidence_checkpoints
         where tenant_id=$1 and repository=$2 and ref_name=$3
         order by ref_sequence desc,id desc limit 1`,
          [checkpoint.tenantId, checkpoint.repository, checkpoint.ref]
        );
        if (latest.rows[0]?.id === checkpoint.id) {
          await appendProjectionInputEvent(client, {
            tenantId: checkpoint.tenantId,
            repository: checkpoint.repository,
            id: `projection-input:evidence:${checkpoint.id}`,
            eventType: "evidence.checkpoint.committed",
            aggregateId: checkpoint.id,
            occurredAt: checkpoint.createdAt
          });
          await enqueueContextEvent(client, {
            id: contextStableId("event", { checkpoint: checkpoint.id }),
            sequence: 1,
            tenantId: checkpoint.tenantId,
            repository: checkpoint.repository,
            aggregateType: "evidence",
            aggregateId: checkpoint.id,
            eventType: "evidence.checkpoint.committed",
            payload: {
              checkpointId: checkpoint.id,
              ref: checkpoint.ref,
              commitSha: checkpoint.commitSha,
              evidenceFingerprint: checkpoint.evidenceFingerprint,
              manifestFingerprint: checkpoint.manifestFingerprint,
              aclFingerprint: checkpoint.aclFingerprint
            },
            consumers: ["manifest", "lexical", "structural", "identity", "acl", "retention"],
            occurredAt: checkpoint.createdAt
          });
        }
      }
    );
    return snapshot.checkpoint;
  }

  async getCheckpoint(checkpointId: string): Promise<EvidenceCheckpoint | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<CheckpointRow>(
      "jina_context_admin",
      { system: true },
      "select * from jina_context.evidence_checkpoints where id=$1",
      [checkpointId]
    );
    return result.rows[0] ? checkpointFromRow(result.rows[0]) : undefined;
  }

  async latestCheckpoint(tenantId: string, repository: string, ref: string): Promise<EvidenceCheckpoint | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<CheckpointRow>(
      "jina_context_ingest",
      { tenantIds: [tenantId] },
      `select * from jina_context.evidence_checkpoints
       where tenant_id=$1 and repository=$2 and ref_name=$3
       order by ref_sequence desc,id desc limit 1`,
      [tenantId, repository, ref]
    );
    return result.rows[0] ? checkpointFromRow(result.rows[0]) : undefined;
  }

  async listEvidence(checkpointId: string): Promise<EvidenceRecord[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<EvidenceRow>(
      "jina_context_admin",
      { system: true },
      `select evidence.*
       from jina_context.evidence_checkpoint_records selection
       join jina_context.evidence_records evidence
         on evidence.tenant_id=selection.tenant_id
        and evidence.repository=selection.repository
        and evidence.id=selection.evidence_id
       where selection.checkpoint_id=$1
         and not exists (
           select 1 from jina_context.erasure_filters erasure
           where erasure.tenant_id=evidence.tenant_id
             and erasure.repository=evidence.repository
             and erasure.source_type=evidence.source_type
             and (erasure.source_id is null or erasure.source_id=evidence.source_id)
             and (erasure.content_digest is null or erasure.content_digest=evidence.content_digest)
             and (
               erasure.path_pattern is null
               or evidence.path_or_url like erasure.path_pattern escape '\\'
             )
         )
       order by selection.ordinal`,
      [checkpointId]
    );
    return result.rows.map(evidenceFromRow);
  }

  async resolveAnchor(
    checkpointId: string,
    anchor: Omit<EvidenceAnchor, "contentDigest">
  ): Promise<EvidenceRecord | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<EvidenceRow>(
      "jina_context_admin",
      { system: true },
      `select evidence.*
       from jina_context.evidence_checkpoint_records selection
       join jina_context.evidence_records evidence
         on evidence.tenant_id=selection.tenant_id
        and evidence.repository=selection.repository
        and evidence.id=selection.evidence_id
       where selection.checkpoint_id=$1
         and evidence.tenant_id=$2 and evidence.repository=$3
         and evidence.source_type=$4 and evidence.source_id=$5
         and evidence.commit_sha is not distinct from $6
         and ($7::text is null or evidence.path_or_url=$7)
         and not exists (
           select 1 from jina_context.erasure_filters erasure
           where erasure.tenant_id=evidence.tenant_id
             and erasure.repository=evidence.repository
             and erasure.source_type=evidence.source_type
             and (erasure.source_id is null or erasure.source_id=evidence.source_id)
             and (erasure.content_digest is null or erasure.content_digest=evidence.content_digest)
             and (
               erasure.path_pattern is null
               or evidence.path_or_url like erasure.path_pattern escape '\\'
             )
         )
       order by evidence.created_at desc,evidence.id limit 1`,
      [
        checkpointId,
        anchor.tenantId,
        anchor.repository,
        anchor.sourceType,
        anchor.sourceId,
        anchor.commitSha ?? null,
        anchor.pathOrUrl ?? null
      ]
    );
    const record = result.rows[0] ? evidenceFromRow(result.rows[0]) : undefined;
    return record && evidenceExcerpt(record, anchor) !== undefined ? record : undefined;
  }

  async listManifest(checkpointId: string): Promise<RefManifestEntry[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<ManifestRow>(
      "jina_context_admin",
      { system: true },
      `select manifest.*
       from jina_context.evidence_checkpoint_manifest manifest
       where manifest.checkpoint_id=$1
         and not exists (
           select 1 from jina_context.erasure_filters erasure
           where erasure.tenant_id=manifest.tenant_id
             and erasure.repository=manifest.repository
             and erasure.source_type='blob'
             and (erasure.source_id is null or erasure.source_id=manifest.blob_sha)
             and (erasure.content_digest is null or erasure.content_digest=manifest.content_digest)
             and (
               erasure.path_pattern is null
               or manifest.path like erasure.path_pattern escape '\\'
             )
         )
       order by manifest.path`,
      [checkpointId]
    );
    return result.rows.map(manifestFromRow);
  }

  async listStructuralFacts(checkpointId: string): Promise<StructuralFact[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<StructuralFactRow>(
      "jina_context_admin",
      { system: true },
      `select fact.*
       from jina_context.evidence_checkpoint_structural_facts selection
       join jina_context.structural_facts fact
         on fact.tenant_id=selection.tenant_id
        and fact.repository=selection.repository
        and fact.id=selection.structural_fact_id
       where selection.checkpoint_id=$1
         and not exists (
           select 1
           from jina_context.erasure_filters erasure
           join lateral jsonb_array_elements(fact.source_anchors) anchor on true
           where erasure.tenant_id=fact.tenant_id
             and erasure.repository=fact.repository
             and erasure.source_type=anchor->>'sourceType'
             and (erasure.source_id is null or erasure.source_id=anchor->>'sourceId')
             and (erasure.content_digest is null or erasure.content_digest=anchor->>'contentDigest')
             and (
               erasure.path_pattern is null
               or anchor->>'pathOrUrl' like erasure.path_pattern escape '\\'
             )
         )
       order by selection.ordinal`,
      [checkpointId]
    );
    return result.rows.map(structuralFactFromRow);
  }
}

async function ensureRepository(client: PoolClient, checkpoint: EvidenceCheckpoint): Promise<void> {
  await client.query(
    `insert into jina_context.repositories
      (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
     values ($1,$2,'unknown',$2,$3,'{}'::jsonb,$4,$4)
     on conflict (tenant_id,repository) do nothing`,
    [checkpoint.tenantId, checkpoint.repository, checkpoint.ref, checkpoint.createdAt]
  );
}

async function insertObservation(client: PoolClient, input: ProviderObservation): Promise<void> {
  await client.query(
    `insert into jina_context.observations
      (id,tenant_id,repository,source,source_type,external_id,occurred_at,recorded_at,payload,content_digest)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     on conflict (tenant_id,repository,id) do nothing`,
    [
      input.id,
      input.tenantId,
      input.repository,
      input.source,
      input.sourceType,
      input.externalId ?? null,
      input.occurredAt ?? null,
      input.recordedAt,
      JSON.stringify(input.payload),
      input.contentDigest
    ]
  );
}

async function insertEvidenceRecords(client: PoolClient, records: readonly EvidenceRecord[]): Promise<void> {
  for (const chunk of snapshotChunks(records)) {
    const rows = chunk.map((record) => ({
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
    const recordset = `
      select *
      from jsonb_to_recordset($1::jsonb) as input(
        id text,tenant_id text,repository text,ref_name text,source_type text,source_id text,
        content_digest text,commit_sha text,path_or_url text,start_line integer,end_line integer,
        json_pointer text,observed_at timestamptz,title text,body text,metadata jsonb,
        authority_class text,acl_fingerprint text,created_at timestamptz
      )`;
    await client.query(
      `with input as (${recordset})
       insert into jina_context.evidence_records
        (id,tenant_id,repository,ref_name,source_type,source_id,content_digest,commit_sha,
         path_or_url,start_line,end_line,json_pointer,observed_at,title,body,metadata,
         authority_class,acl_fingerprint,created_at)
       select id,tenant_id,repository,ref_name,source_type,source_id,content_digest,commit_sha,
              path_or_url,start_line,end_line,json_pointer,observed_at,title,body,metadata,
              authority_class,acl_fingerprint,created_at
       from input
       on conflict (tenant_id,repository,id) do nothing`,
      [JSON.stringify(rows)]
    );
    const collisions = await client.query<{ id: string }>(
      `with input as (${recordset})
       select input.id
       from input
       left join jina_context.evidence_records stored
         on stored.tenant_id=input.tenant_id
        and stored.repository=input.repository
        and stored.id=input.id
        and stored.ref_name=input.ref_name
        and stored.source_type=input.source_type
        and stored.source_id=input.source_id
        and stored.content_digest=input.content_digest
        and stored.commit_sha is not distinct from input.commit_sha
        and stored.path_or_url is not distinct from input.path_or_url
        and stored.start_line is not distinct from input.start_line
        and stored.end_line is not distinct from input.end_line
        and stored.json_pointer is not distinct from input.json_pointer
        and stored.title=input.title
        and stored.body=input.body
        and stored.acl_fingerprint=input.acl_fingerprint
       where stored.id is null
       limit 1`,
      [JSON.stringify(rows)]
    );
    if (collisions.rows[0]) {
      throw new Error(`Evidence record identity collision for ${collisions.rows[0].id}`);
    }
  }
}

async function ensureManifestBlobs(
  client: PoolClient,
  manifest: readonly RefManifestEntry[],
  evidence: readonly EvidenceRecord[],
  recordedAt: string
): Promise<void> {
  const byIdentity = new Map(
    evidence
      .filter((record) => record.anchor.sourceType === "blob")
      .map((record) => [`${record.anchor.sourceId}\u001f${record.anchor.contentDigest}`, record])
  );
  const rows = manifest
    .filter((entry) => entry.contentAvailable)
    .map((entry) => {
      const source = byIdentity.get(`${entry.blobSha}\u001f${entry.contentDigest}`);
      return {
        tenant_id: entry.tenantId,
        repository: entry.repository,
        blob_sha: entry.blobSha,
        content_digest: entry.contentDigest,
        byte_size: source ? Buffer.byteLength(source.body, "utf8") : 0,
        media_type: source?.metadata.mediaType ?? "text/plain",
        encoding: source ? "utf-8" : null,
        content: source?.body ?? null,
        recorded_at: recordedAt
      };
    });
  for (const chunk of snapshotChunks(rows)) {
    const recordset = `
      select *
      from jsonb_to_recordset($1::jsonb) as input(
        tenant_id text,repository text,blob_sha text,content_digest text,byte_size bigint,
        media_type text,encoding text,content text,recorded_at timestamptz
      )`;
    await client.query(
      `with input as (${recordset})
       insert into jina_context.blobs
        (tenant_id,repository,blob_sha,content_digest,byte_size,media_type,encoding,content,recorded_at)
       select tenant_id,repository,blob_sha,content_digest,byte_size,media_type,encoding,content,recorded_at
       from input
       on conflict (tenant_id,repository,blob_sha) do nothing`,
      [JSON.stringify(chunk)]
    );
    const collisions = await client.query<{ blob_sha: string }>(
      `with input as (${recordset})
       select input.blob_sha
       from input
       left join jina_context.blobs stored
         on stored.tenant_id=input.tenant_id
        and stored.repository=input.repository
        and stored.blob_sha=input.blob_sha
        and stored.content_digest=input.content_digest
       where stored.blob_sha is null
       limit 1`,
      [JSON.stringify(chunk)]
    );
    if (collisions.rows[0]) {
      throw new Error(`Blob identity collision for ${collisions.rows[0].blob_sha}`);
    }
  }
}

async function persistGitSnapshot(client: PoolClient, snapshot: EvidenceSnapshot): Promise<void> {
  const git = snapshot.git;
  if (!git) return;
  const { checkpoint, manifest, structuralFacts } = snapshot;
  const commits = [
    {
      sha: checkpoint.commitSha,
      metadata: git.commit,
      payload: { commitSha: checkpoint.commitSha, ref: checkpoint.ref, ...git.commit }
    },
    ...(git.history ?? [])
      .filter((historical) => historical.sha !== checkpoint.commitSha)
      .map((historical) => ({
        sha: historical.sha,
        metadata: historical,
        payload: { commitSha: historical.sha, ...historical }
      }))
  ].map((commit) => {
    const observationDigest = contextDigest(commit.payload);
    return {
      ...commit,
      observationDigest,
      observationId: contextStableId("observation", {
        tenantId: checkpoint.tenantId,
        repository: checkpoint.repository,
        source: "git",
        commitSha: commit.sha,
        observationDigest
      })
    };
  });
  await insertSnapshotRows(
    client,
    commits.map((commit) => ({
      id: commit.observationId,
      tenant_id: checkpoint.tenantId,
      repository: checkpoint.repository,
      external_id: commit.sha,
      occurred_at: commit.metadata.committedAt ?? checkpoint.createdAt,
      recorded_at: checkpoint.createdAt,
      payload: commit.payload,
      content_digest: commit.observationDigest
    })),
    `id text,tenant_id text,repository text,external_id text,occurred_at timestamptz,
     recorded_at timestamptz,payload jsonb,content_digest text`,
    `insert into jina_context.observations
      (id,tenant_id,repository,source,source_type,external_id,occurred_at,recorded_at,payload,content_digest)
     select id,tenant_id,repository,'git','git_object',external_id,occurred_at,recorded_at,payload,content_digest
     from input
     on conflict (tenant_id,repository,id) do nothing`
  );
  const observationId = commits[0]!.observationId;
  await client.query(
    `insert into jina_context.trees
      (tenant_id,repository,tree_sha,entry_count,content_digest,recorded_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id,repository,tree_sha) do nothing`,
    [
      checkpoint.tenantId,
      checkpoint.repository,
      git.commit.treeSha,
      manifest.length,
      contextDigest(
        manifest.map(({ path, blobSha, executable, entryType, linkTarget }) => ({
          path,
          blobSha,
          executable,
          entryType: entryType ?? "file",
          ...(linkTarget === undefined ? {} : { linkTarget })
        }))
      ),
      checkpoint.createdAt
    ]
  );
  await insertSnapshotRows(
    client,
    commits.map((commit) => ({
      tenant_id: checkpoint.tenantId,
      repository: checkpoint.repository,
      sha: commit.sha,
      tree_sha: commit.metadata.treeSha,
      author_external_id: commit.metadata.author ?? null,
      authored_at: commit.metadata.authoredAt ?? null,
      committed_at: commit.metadata.committedAt ?? null,
      message: commit.metadata.message,
      source_observation_id: commit.observationId
    })),
    `tenant_id text,repository text,sha text,tree_sha text,author_external_id text,
     authored_at timestamptz,committed_at timestamptz,message text,source_observation_id text`,
    `insert into jina_context.commits
      (tenant_id,repository,sha,tree_sha,author_external_id,authored_at,committed_at,message,source_observation_id)
     select tenant_id,repository,sha,tree_sha,author_external_id,authored_at,committed_at,message,
            source_observation_id
     from input
     on conflict (tenant_id,repository,sha) do nothing`
  );
  await insertSnapshotRows(
    client,
    commits.flatMap((commit) =>
      commit.metadata.parentShas.map((parentSha, ordinal) => ({
        tenant_id: checkpoint.tenantId,
        repository: checkpoint.repository,
        commit_sha: commit.sha,
        ordinal,
        parent_sha: parentSha
      }))
    ),
    `tenant_id text,repository text,commit_sha text,ordinal integer,parent_sha text`,
    `insert into jina_context.commit_parents
      (tenant_id,repository,commit_sha,ordinal,parent_sha)
     select tenant_id,repository,commit_sha,ordinal,parent_sha
     from input
     on conflict do nothing`
  );
  const refId = contextStableId("ref", {
    tenantId: checkpoint.tenantId,
    repository: checkpoint.repository,
    ref: checkpoint.ref,
    refSequence: checkpoint.refSequence,
    commitSha: checkpoint.commitSha,
    observationId
  });
  await client.query(
    `insert into jina_context.refs
      (id,tenant_id,repository,ref_name,ref_sequence,commit_sha,is_default,source_observation_id,observed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
    [
      refId,
      checkpoint.tenantId,
      checkpoint.repository,
      checkpoint.ref,
      checkpoint.refSequence,
      checkpoint.commitSha,
      checkpoint.ref === "main" || checkpoint.ref === "master",
      observationId,
      checkpoint.createdAt
    ]
  );
  await insertSnapshotRows(
    client,
    manifest.map((entry) => ({
      tenant_id: checkpoint.tenantId,
      repository: checkpoint.repository,
      tree_sha: git.commit.treeSha,
      path: entry.path,
      blob_sha: entry.blobSha,
      mode:
        entry.entryType === "gitlink"
          ? "160000"
          : entry.entryType === "symlink"
            ? "120000"
            : entry.executable
              ? "100755"
              : "100644"
    })),
    `tenant_id text,repository text,tree_sha text,path text,blob_sha text,mode text`,
    `insert into jina_context.tree_entries
      (tenant_id,repository,tree_sha,path,blob_sha,mode)
     select tenant_id,repository,tree_sha,path,blob_sha,mode
     from input
     on conflict do nothing`
  );
  const factsByBlob = new Map<string, StructuralFact[]>();
  for (const fact of structuralFacts) {
    for (const sourceId of new Set(fact.anchors.map((anchor) => anchor.sourceId))) {
      const facts = factsByBlob.get(sourceId);
      if (facts) facts.push(fact);
      else factsByBlob.set(sourceId, [fact]);
    }
  }
  const sourceByBlobPath = new Map(
    snapshot.records
      .filter((record) => record.anchor.sourceType === "blob")
      .map((record) => [`${record.anchor.sourceId}\u001f${record.anchor.pathOrUrl ?? ""}`, record])
  );
  const analysisRows = new Map<
    string,
    {
      tenant_id: string;
      repository: string;
      blob_sha: string;
      parser_version: string;
      language: string | null;
      status: "complete" | "unsupported";
      diagnostics: readonly unknown[];
      output_digest: string;
      created_at: string;
    }
  >();
  for (const entry of manifest) {
    if (!entry.contentAvailable) continue;
    const facts = factsByBlob.get(entry.blobSha) ?? [];
    const sourceRecord = sourceByBlobPath.get(`${entry.blobSha}\u001f${entry.path}`);
    const supported =
      entry.language !== undefined && entry.language !== "text" && sourceRecord?.metadata.contentOmitted !== true;
    analysisRows.set(entry.blobSha, {
      tenant_id: checkpoint.tenantId,
      repository: checkpoint.repository,
      blob_sha: entry.blobSha,
      parser_version: checkpoint.parserVersion,
      language: entry.language ?? null,
      status: supported ? "complete" : "unsupported",
      diagnostics: [],
      output_digest: contextDigest(facts),
      created_at: checkpoint.createdAt
    });
  }
  await insertSnapshotRows(
    client,
    [...analysisRows.values()],
    `tenant_id text,repository text,blob_sha text,parser_version text,language text,status text,
     diagnostics jsonb,output_digest text,created_at timestamptz`,
    `insert into jina_context.blob_analyses
      (tenant_id,repository,blob_sha,parser_name,parser_version,language,status,diagnostics,output_digest,created_at)
     select tenant_id,repository,blob_sha,'deterministic-source-parser',parser_version,language,status,
            diagnostics,output_digest,created_at
     from input
     on conflict do nothing`
  );
  await persistParsedFacts(
    client,
    checkpoint,
    manifest.filter((entry) => entry.contentAvailable),
    factsByBlob
  );
  await insertSnapshotRows(
    client,
    git.changes.map((change, ordinal) => ({
      tenant_id: checkpoint.tenantId,
      repository: checkpoint.repository,
      commit_sha: checkpoint.commitSha,
      ordinal,
      change_kind: change.kind,
      path: change.path,
      old_path: change.oldPath ?? null,
      old_blob_sha: change.oldBlobSha ?? null,
      new_blob_sha: change.newBlobSha ?? null
    })),
    `tenant_id text,repository text,commit_sha text,ordinal integer,change_kind text,path text,
     old_path text,old_blob_sha text,new_blob_sha text`,
    `insert into jina_context.commit_changes
      (tenant_id,repository,commit_sha,ordinal,change_kind,path,old_path,old_blob_sha,new_blob_sha)
     select tenant_id,repository,commit_sha,ordinal,change_kind,path,old_path,old_blob_sha,new_blob_sha
     from input
     on conflict do nothing`
  );
}

async function persistParsedFacts(
  client: PoolClient,
  checkpoint: EvidenceCheckpoint,
  entries: readonly RefManifestEntry[],
  factsByBlob: ReadonlyMap<string, readonly StructuralFact[]>
): Promise<void> {
  const symbolRows: Record<string, unknown>[] = [];
  const importRows: Record<string, unknown>[] = [];
  const seenSymbols = new Set<string>();
  const seenImports = new Set<string>();
  for (const entry of entries) {
    for (const fact of factsByBlob.get(entry.blobSha) ?? []) {
      if (fact.kind === "defines") {
        const symbol =
          fact.metadata.symbol && typeof fact.metadata.symbol === "object" && !Array.isArray(fact.metadata.symbol)
            ? (fact.metadata.symbol as Record<string, unknown>)
            : undefined;
        const name = typeof symbol?.name === "string" ? symbol.name : fact.to.split("#").at(-1);
        const kind = typeof symbol?.kind === "string" ? symbol.kind : "symbol";
        const startLine = typeof symbol?.startLine === "number" ? symbol.startLine : fact.anchors[0]?.startLine;
        const endLine = typeof symbol?.endLine === "number" ? symbol.endLine : fact.anchors[0]?.endLine;
        if (!name || !startLine || !endLine) continue;
        const id = contextStableId("symbol", { factId: fact.id });
        if (seenSymbols.has(id)) continue;
        seenSymbols.add(id);
        symbolRows.push({
          id,
          tenant_id: checkpoint.tenantId,
          repository: checkpoint.repository,
          blob_sha: entry.blobSha,
          parser_version: checkpoint.parserVersion,
          moniker: fact.to,
          name,
          kind,
          start_line: startLine,
          end_line: endLine,
          metadata: fact.metadata
        });
      } else if (fact.kind === "imports") {
        const names = Array.isArray(fact.metadata.importedNames)
          ? fact.metadata.importedNames.filter((value): value is string => typeof value === "string")
          : [];
        const values = names.length ? names : [undefined];
        for (const [ordinal, importedName] of values.entries()) {
          const line = fact.anchors[0]?.startLine;
          if (!line) continue;
          const id = contextStableId("import", { factId: fact.id, ordinal });
          if (seenImports.has(id)) continue;
          seenImports.add(id);
          importRows.push({
            id,
            tenant_id: checkpoint.tenantId,
            repository: checkpoint.repository,
            blob_sha: entry.blobSha,
            parser_version: checkpoint.parserVersion,
            specifier: fact.to,
            imported_name: importedName ?? null,
            start_line: line,
            end_line: line,
            metadata: fact.metadata
          });
        }
      }
    }
  }
  await insertSnapshotRows(
    client,
    symbolRows,
    `id text,tenant_id text,repository text,blob_sha text,parser_version text,moniker text,
     name text,kind text,start_line integer,end_line integer,metadata jsonb`,
    `insert into jina_context.symbols
      (id,tenant_id,repository,blob_sha,parser_name,parser_version,moniker,name,kind,
       start_line,end_line,metadata)
     select id,tenant_id,repository,blob_sha,'deterministic-source-parser',parser_version,moniker,name,
            kind,start_line,end_line,metadata
     from input
     on conflict do nothing`
  );
  await insertSnapshotRows(
    client,
    importRows,
    `id text,tenant_id text,repository text,blob_sha text,parser_version text,specifier text,
     imported_name text,start_line integer,end_line integer,metadata jsonb`,
    `insert into jina_context.imports
      (id,tenant_id,repository,blob_sha,parser_name,parser_version,specifier,
       imported_name,start_line,end_line,metadata)
     select id,tenant_id,repository,blob_sha,'deterministic-source-parser',parser_version,specifier,
            imported_name,start_line,end_line,metadata
     from input
     on conflict do nothing`
  );
}

async function insertSnapshotRows<T>(
  client: PoolClient,
  rows: readonly T[],
  recordDefinition: string,
  insertStatement: string
): Promise<void> {
  for (const chunk of snapshotChunks(rows)) {
    await client.query(
      `with input as (
         select * from jsonb_to_recordset($1::jsonb) as input(${recordDefinition})
       )
       ${insertStatement}`,
      [JSON.stringify(chunk)]
    );
  }
}

async function insertStructuralFacts(
  client: PoolClient,
  facts: readonly StructuralFact[],
  createdAt: string
): Promise<void> {
  for (const chunk of snapshotChunks(facts)) {
    const rows = chunk.map((fact) => {
      const first = fact.anchors[0];
      return {
        id: fact.id,
        tenant_id: fact.tenantId,
        repository: fact.repository,
        ref_name: fact.ref,
        relation_kind: fact.kind,
        source_id: fact.from,
        target_id: fact.to,
        commit_sha: fact.commitSha,
        path: first?.pathOrUrl ?? null,
        start_line: first?.startLine ?? null,
        end_line: first?.endLine ?? null,
        source_anchors: fact.anchors,
        metadata: fact.metadata,
        derivation_name: fact.derivationName,
        derivation_version: fact.derivationVersion,
        fact_digest: contextDigest(fact),
        created_at: createdAt
      };
    });
    const recordset = `
      select *
      from jsonb_to_recordset($1::jsonb) as input(
        id text,tenant_id text,repository text,ref_name text,relation_kind text,
        source_id text,target_id text,commit_sha text,path text,start_line integer,end_line integer,
        source_anchors jsonb,metadata jsonb,derivation_name text,derivation_version text,
        fact_digest text,created_at timestamptz
      )`;
    await client.query(
      `with input as (${recordset})
       insert into jina_context.structural_facts
        (id,tenant_id,repository,ref_name,relation_kind,source_kind,source_id,target_kind,target_id,
         commit_sha,path,start_line,end_line,source_anchors,metadata,derivation_name,derivation_version,
         fact_digest,created_at)
       select id,tenant_id,repository,ref_name,relation_kind,'resource',source_id,'resource',target_id,
              commit_sha,path,start_line,end_line,source_anchors,metadata,derivation_name,derivation_version,
              fact_digest,created_at
       from input
       on conflict (tenant_id,repository,id) do nothing`,
      [JSON.stringify(rows)]
    );
    const collisions = await client.query<{ id: string }>(
      `with input as (${recordset})
       select input.id
       from input
       left join jina_context.structural_facts stored
         on stored.tenant_id=input.tenant_id
        and stored.repository=input.repository
        and stored.id=input.id
        and stored.fact_digest=input.fact_digest
       where stored.id is null
       limit 1`,
      [JSON.stringify(rows)]
    );
    if (collisions.rows[0]) {
      throw new Error(`Structural fact identity collision for ${collisions.rows[0].id}`);
    }
  }
}

async function insertCheckpointRecords(
  client: PoolClient,
  checkpoint: EvidenceCheckpoint,
  records: readonly EvidenceRecord[]
): Promise<void> {
  const selections = records.map((record, ordinal) => ({ evidence_id: record.id, ordinal }));
  for (const chunk of snapshotChunks(selections)) {
    await client.query(
      `insert into jina_context.evidence_checkpoint_records
        (checkpoint_id,tenant_id,repository,evidence_id,ordinal)
       select $1,$2,$3,input.evidence_id,input.ordinal
       from jsonb_to_recordset($4::jsonb) as input(evidence_id text,ordinal integer)
       on conflict do nothing`,
      [checkpoint.id, checkpoint.tenantId, checkpoint.repository, JSON.stringify(chunk)]
    );
  }
}

async function insertCheckpointManifest(
  client: PoolClient,
  checkpoint: EvidenceCheckpoint,
  manifest: readonly RefManifestEntry[]
): Promise<void> {
  const selections = manifest.map((entry) => ({
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
  for (const chunk of snapshotChunks(selections)) {
    await client.query(
      `insert into jina_context.evidence_checkpoint_manifest
        (checkpoint_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,
         content_digest,content_available,language,executable,entry_type,link_target)
       select $1,$2,$3,input.ref_name,input.commit_sha,input.path,input.blob_sha,
              input.content_digest,input.content_available,input.language,input.executable,
              input.entry_type,input.link_target
       from jsonb_to_recordset($4::jsonb) as input(
         ref_name text,commit_sha text,path text,blob_sha text,content_digest text,
         content_available boolean,language text,executable boolean,entry_type text,link_target text
       )
       on conflict do nothing`,
      [checkpoint.id, checkpoint.tenantId, checkpoint.repository, JSON.stringify(chunk)]
    );
  }
}

async function insertCheckpointStructuralFacts(
  client: PoolClient,
  checkpoint: EvidenceCheckpoint,
  facts: readonly StructuralFact[]
): Promise<void> {
  const selections = facts.map((fact, ordinal) => ({ structural_fact_id: fact.id, ordinal }));
  for (const chunk of snapshotChunks(selections)) {
    await client.query(
      `insert into jina_context.evidence_checkpoint_structural_facts
        (checkpoint_id,tenant_id,repository,structural_fact_id,ordinal)
       select $1,$2,$3,input.structural_fact_id,input.ordinal
       from jsonb_to_recordset($4::jsonb) as input(structural_fact_id text,ordinal integer)
       on conflict do nothing`,
      [checkpoint.id, checkpoint.tenantId, checkpoint.repository, JSON.stringify(chunk)]
    );
  }
}

function snapshotChunks<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let chunkBytes = 2;
  for (const value of values) {
    const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8") + (chunk.length === 0 ? 0 : 1);
    if (
      chunk.length > 0 &&
      (chunk.length >= SNAPSHOT_INSERT_CHUNK_SIZE || chunkBytes + valueBytes > SNAPSHOT_INSERT_CHUNK_BYTE_TARGET)
    ) {
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

function checkpointFromRow(row: CheckpointRow): EvidenceCheckpoint {
  const refSequence = Number(row.ref_sequence);
  if (!Number.isSafeInteger(refSequence) || refSequence <= 0) {
    throw new Error(`Invalid ref sequence on evidence checkpoint ${row.id}`);
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    refSequence,
    commitSha: row.commit_sha,
    parserVersion: row.parser_version,
    sourceCompleteness: row.source_completeness,
    observationFrontier: row.observation_frontier,
    evidenceFingerprint: row.evidence_fingerprint,
    manifestFingerprint: row.manifest_fingerprint,
    aclFingerprint: row.acl_fingerprint,
    createdAt: dateString(row.created_at)
  };
}

function evidenceFromRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    anchor: {
      tenantId: row.tenant_id,
      repository: row.repository,
      sourceType: row.source_type,
      sourceId: row.source_id,
      contentDigest: row.content_digest,
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      ...(row.path_or_url ? { pathOrUrl: row.path_or_url } : {}),
      ...(row.start_line !== null ? { startLine: row.start_line } : {}),
      ...(row.end_line !== null ? { endLine: row.end_line } : {}),
      ...(row.json_pointer ? { jsonPointer: row.json_pointer } : {}),
      ...(row.observed_at ? { observedAt: dateString(row.observed_at) } : {})
    },
    ref: row.ref_name,
    title: row.title,
    body: row.body,
    metadata: row.metadata,
    authorityClass: row.authority_class,
    aclFingerprint: row.acl_fingerprint,
    createdAt: dateString(row.created_at)
  };
}

function manifestFromRow(row: ManifestRow): RefManifestEntry {
  return {
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    path: row.path,
    blobSha: row.blob_sha,
    contentDigest: row.content_digest,
    contentAvailable: row.content_available,
    ...(row.language ? { language: row.language } : {}),
    executable: row.executable,
    ...(row.entry_type === "file" ? {} : { entryType: row.entry_type }),
    ...(row.link_target === null ? {} : { linkTarget: row.link_target })
  };
}

function structuralFactFromRow(row: StructuralFactRow): StructuralFact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repository: row.repository,
    ref: row.ref_name,
    commitSha: row.commit_sha,
    kind: row.relation_kind,
    from: row.source_id,
    to: row.target_id,
    anchors: row.source_anchors,
    derivationName: row.derivation_name,
    derivationVersion: row.derivation_version,
    metadata: row.metadata
  };
}
