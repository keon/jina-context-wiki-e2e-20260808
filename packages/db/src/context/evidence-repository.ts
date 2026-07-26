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
import type { ContextWriteFence } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { lockRepositoryAccess } from "./access.js";
import { ContextDatabase, contextDigest, contextStableId, dateString } from "./database.js";
import { enqueueContextEvent } from "./outbox-repository.js";
import { appendProjectionInputEvent, lockProjectionInput } from "./projection-input.js";
import { assertContextWriteFence } from "./write-fence.js";

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

  async registerRepository(input: RepositoryRegistration, fence?: ContextWriteFence): Promise<void> {
    await this.database.transactionAs("jina_context_ingest", { tenantIds: [input.tenantId] }, async (client) => {
      await assertContextWriteFence(client, input.tenantId, "run-ingest-evidence", fence);
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
      await assertContextWriteFence(client, input.tenantId, "run-ingest-evidence", fence);
    });
  }

  async appendObservation(observation: ProviderObservation, fence?: ContextWriteFence): Promise<void> {
    await this.database.transactionAs("jina_context_ingest", { tenantIds: [observation.tenantId] }, async (client) => {
      await assertContextWriteFence(client, observation.tenantId, "run-ingest-evidence", fence);
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
      await assertContextWriteFence(client, observation.tenantId, "run-ingest-evidence", fence);
    });
  }

  async appendRepositoryAcl(observation: RepositoryAclObservation, fence?: ContextWriteFence): Promise<void> {
    await this.database.transactionAs("jina_context_ingest", { tenantIds: [observation.tenantId] }, async (client) => {
      await assertContextWriteFence(client, observation.tenantId, "run-ingest-evidence", fence);
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
      await assertContextWriteFence(client, observation.tenantId, "run-ingest-evidence", fence);
    });
  }

  async commitSnapshot(snapshot: EvidenceSnapshot, fence?: ContextWriteFence): Promise<EvidenceCheckpoint> {
    await this.database.transactionAs(
      "jina_context_ingest",
      { tenantIds: [snapshot.checkpoint.tenantId] },
      async (client) => {
        await assertContextWriteFence(client, snapshot.checkpoint.tenantId, "run-ingest-evidence", fence);
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `context-generation-ref:${snapshot.checkpoint.tenantId}:${snapshot.checkpoint.repository}:${snapshot.checkpoint.ref}`
        ]);
        await lockProjectionInput(client, snapshot.checkpoint.tenantId, snapshot.checkpoint.repository);
        await ensureRepository(client, snapshot.checkpoint);
        for (const record of snapshot.records) await insertEvidenceRecord(client, record);
        for (const entry of snapshot.manifest)
          await ensureManifestBlob(client, entry, snapshot.records, snapshot.checkpoint.createdAt);
        for (const fact of snapshot.structuralFacts)
          await insertStructuralFact(client, fact, snapshot.checkpoint.createdAt);
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
        for (const [ordinal, record] of snapshot.records.entries()) {
          await client.query(
            `insert into jina_context.evidence_checkpoint_records
            (checkpoint_id,tenant_id,repository,evidence_id,ordinal)
           values ($1,$2,$3,$4,$5) on conflict do nothing`,
            [checkpoint.id, checkpoint.tenantId, checkpoint.repository, record.id, ordinal]
          );
        }
        for (const entry of snapshot.manifest) {
          await client.query(
            `insert into jina_context.evidence_checkpoint_manifest
            (checkpoint_id,tenant_id,repository,ref_name,commit_sha,path,blob_sha,
             content_digest,content_available,language,executable)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
            [
              checkpoint.id,
              entry.tenantId,
              entry.repository,
              entry.ref,
              entry.commitSha,
              entry.path,
              entry.blobSha,
              entry.contentDigest,
              entry.contentAvailable,
              entry.language ?? null,
              entry.executable
            ]
          );
        }
        for (const [ordinal, fact] of snapshot.structuralFacts.entries()) {
          await client.query(
            `insert into jina_context.evidence_checkpoint_structural_facts
            (checkpoint_id,tenant_id,repository,structural_fact_id,ordinal)
           values ($1,$2,$3,$4,$5) on conflict do nothing`,
            [checkpoint.id, fact.tenantId, fact.repository, fact.id, ordinal]
          );
        }
        const latest = await client.query<{ id: string }>(
          `select id from jina_context.evidence_checkpoints
         where tenant_id=$1 and repository=$2 and ref_name=$3
         order by ref_sequence desc,id desc limit 1`,
          [checkpoint.tenantId, checkpoint.repository, checkpoint.ref]
        );
        const admitted = await client.query<{ ref_sequence: string }>(
          `select coalesce(max(ref_sequence),0)::text ref_sequence
         from jina_context.pipeline_builds
         where tenant_id=$1 and repository=$2 and ref_name=$3`,
          [checkpoint.tenantId, checkpoint.repository, checkpoint.ref]
        );
        const latestAdmittedSequence = Number(admitted.rows[0]!.ref_sequence);
        if (!Number.isSafeInteger(latestAdmittedSequence) || latestAdmittedSequence < 0) {
          throw new Error(`Ref sequence exceeds the supported range for ${checkpoint.repository}@${checkpoint.ref}`);
        }
        if (latest.rows[0]?.id === checkpoint.id && checkpoint.refSequence >= latestAdmittedSequence) {
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
        await assertContextWriteFence(client, checkpoint.tenantId, "run-ingest-evidence", fence);
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

async function insertEvidenceRecord(client: PoolClient, record: EvidenceRecord): Promise<void> {
  const anchor = record.anchor;
  await client.query(
    `insert into jina_context.evidence_records
      (id,tenant_id,repository,ref_name,source_type,source_id,content_digest,commit_sha,
       path_or_url,start_line,end_line,json_pointer,observed_at,title,body,metadata,
       authority_class,acl_fingerprint,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)
     on conflict (tenant_id,repository,id) do nothing`,
    [
      record.id,
      anchor.tenantId,
      anchor.repository,
      record.ref,
      anchor.sourceType,
      anchor.sourceId,
      anchor.contentDigest,
      anchor.commitSha ?? null,
      anchor.pathOrUrl ?? null,
      anchor.startLine ?? null,
      anchor.endLine ?? null,
      anchor.jsonPointer ?? null,
      anchor.observedAt ?? null,
      record.title,
      record.body,
      JSON.stringify(record.metadata),
      record.authorityClass,
      record.aclFingerprint,
      record.createdAt
    ]
  );
  const stored = await client.query(
    `select 1 from jina_context.evidence_records
     where tenant_id=$1 and repository=$2 and id=$3 and ref_name=$4
       and source_type=$5 and source_id=$6 and content_digest=$7
       and commit_sha is not distinct from $8
       and path_or_url is not distinct from $9
       and start_line is not distinct from $10
       and end_line is not distinct from $11
       and json_pointer is not distinct from $12
       and title=$13 and body=$14 and acl_fingerprint=$15`,
    [
      anchor.tenantId,
      anchor.repository,
      record.id,
      record.ref,
      anchor.sourceType,
      anchor.sourceId,
      anchor.contentDigest,
      anchor.commitSha ?? null,
      anchor.pathOrUrl ?? null,
      anchor.startLine ?? null,
      anchor.endLine ?? null,
      anchor.jsonPointer ?? null,
      record.title,
      record.body,
      record.aclFingerprint
    ]
  );
  if (stored.rowCount !== 1) throw new Error(`Evidence record identity collision for ${record.id}`);
}

async function ensureManifestBlob(
  client: PoolClient,
  entry: RefManifestEntry,
  evidence: readonly EvidenceRecord[],
  recordedAt: string
): Promise<void> {
  if (!entry.contentAvailable) return;
  const source = evidence.find(
    (record) =>
      record.anchor.sourceType === "blob" &&
      record.anchor.sourceId === entry.blobSha &&
      record.anchor.contentDigest === entry.contentDigest
  );
  await client.query(
    `insert into jina_context.blobs
      (tenant_id,repository,blob_sha,content_digest,byte_size,media_type,encoding,content,recorded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (tenant_id,repository,blob_sha) do nothing`,
    [
      entry.tenantId,
      entry.repository,
      entry.blobSha,
      entry.contentDigest,
      source ? Buffer.byteLength(source.body, "utf8") : 0,
      source?.metadata.mediaType ?? (entry.contentAvailable ? "text/plain" : "application/octet-stream"),
      source ? "utf-8" : null,
      source?.body ?? null,
      recordedAt
    ]
  );
  const stored = await client.query(
    `select 1 from jina_context.blobs
     where tenant_id=$1 and repository=$2 and blob_sha=$3 and content_digest=$4`,
    [entry.tenantId, entry.repository, entry.blobSha, entry.contentDigest]
  );
  if (stored.rowCount !== 1) throw new Error(`Blob identity collision for ${entry.blobSha}`);
}

async function persistGitSnapshot(client: PoolClient, snapshot: EvidenceSnapshot): Promise<void> {
  const git = snapshot.git;
  if (!git) return;
  const { checkpoint, manifest, structuralFacts } = snapshot;
  const observationPayload = {
    commitSha: checkpoint.commitSha,
    ref: checkpoint.ref,
    ...git.commit
  };
  const observationDigest = contextDigest(observationPayload);
  const observationId = contextStableId("observation", {
    tenantId: checkpoint.tenantId,
    repository: checkpoint.repository,
    source: "git",
    commitSha: checkpoint.commitSha,
    observationDigest
  });
  await client.query(
    `insert into jina_context.observations
      (id,tenant_id,repository,source,source_type,external_id,occurred_at,recorded_at,payload,content_digest)
     values ($1,$2,$3,'git','git_object',$4,$5,$6,$7::jsonb,$8)
     on conflict (tenant_id,repository,id) do nothing`,
    [
      observationId,
      checkpoint.tenantId,
      checkpoint.repository,
      checkpoint.commitSha,
      git.commit.committedAt ?? checkpoint.createdAt,
      checkpoint.createdAt,
      JSON.stringify(observationPayload),
      observationDigest
    ]
  );
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
      contextDigest(manifest.map(({ path, blobSha, executable }) => ({ path, blobSha, executable }))),
      checkpoint.createdAt
    ]
  );
  await client.query(
    `insert into jina_context.commits
      (tenant_id,repository,sha,tree_sha,author_external_id,authored_at,committed_at,message,source_observation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (tenant_id,repository,sha) do nothing`,
    [
      checkpoint.tenantId,
      checkpoint.repository,
      checkpoint.commitSha,
      git.commit.treeSha,
      git.commit.author ?? null,
      git.commit.authoredAt ?? null,
      git.commit.committedAt ?? null,
      git.commit.message,
      observationId
    ]
  );
  for (const [ordinal, parentSha] of git.commit.parentShas.entries()) {
    await client.query(
      `insert into jina_context.commit_parents
        (tenant_id,repository,commit_sha,ordinal,parent_sha)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [checkpoint.tenantId, checkpoint.repository, checkpoint.commitSha, ordinal, parentSha]
    );
  }
  for (const historical of git.history ?? []) {
    if (historical.sha === checkpoint.commitSha) continue;
    const historicalPayload = { commitSha: historical.sha, ...historical };
    const historicalDigest = contextDigest(historicalPayload);
    const historicalObservationId = contextStableId("observation", {
      tenantId: checkpoint.tenantId,
      repository: checkpoint.repository,
      source: "git",
      commitSha: historical.sha,
      observationDigest: historicalDigest
    });
    await client.query(
      `insert into jina_context.observations
        (id,tenant_id,repository,source,source_type,external_id,occurred_at,recorded_at,payload,content_digest)
       values ($1,$2,$3,'git','git_object',$4,$5,$6,$7::jsonb,$8)
       on conflict (tenant_id,repository,id) do nothing`,
      [
        historicalObservationId,
        checkpoint.tenantId,
        checkpoint.repository,
        historical.sha,
        historical.committedAt ?? checkpoint.createdAt,
        checkpoint.createdAt,
        JSON.stringify(historicalPayload),
        historicalDigest
      ]
    );
    await client.query(
      `insert into jina_context.commits
        (tenant_id,repository,sha,tree_sha,author_external_id,authored_at,committed_at,message,source_observation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (tenant_id,repository,sha) do nothing`,
      [
        checkpoint.tenantId,
        checkpoint.repository,
        historical.sha,
        historical.treeSha,
        historical.author ?? null,
        historical.authoredAt ?? null,
        historical.committedAt ?? null,
        historical.message,
        historicalObservationId
      ]
    );
    for (const [ordinal, parentSha] of historical.parentShas.entries()) {
      await client.query(
        `insert into jina_context.commit_parents
          (tenant_id,repository,commit_sha,ordinal,parent_sha)
         values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [checkpoint.tenantId, checkpoint.repository, historical.sha, ordinal, parentSha]
      );
    }
  }
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
  for (const entry of manifest) {
    await client.query(
      `insert into jina_context.tree_entries
        (tenant_id,repository,tree_sha,path,blob_sha,mode)
       values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [
        checkpoint.tenantId,
        checkpoint.repository,
        git.commit.treeSha,
        entry.path,
        entry.blobSha,
        entry.executable ? "100755" : "100644"
      ]
    );
    if (!entry.contentAvailable) continue;
    const facts = structuralFacts.filter((fact) => fact.anchors.some((anchor) => anchor.sourceId === entry.blobSha));
    const sourceRecord = snapshot.records.find(
      (record) =>
        record.anchor.sourceType === "blob" &&
        record.anchor.sourceId === entry.blobSha &&
        record.anchor.pathOrUrl === entry.path
    );
    const supported =
      entry.language !== undefined && entry.language !== "text" && sourceRecord?.metadata.contentOmitted !== true;
    await client.query(
      `insert into jina_context.blob_analyses
        (tenant_id,repository,blob_sha,parser_name,parser_version,language,status,diagnostics,output_digest,created_at)
       values ($1,$2,$3,'deterministic-source-parser',$4,$5,$6,'[]'::jsonb,$7,$8)
       on conflict do nothing`,
      [
        checkpoint.tenantId,
        checkpoint.repository,
        entry.blobSha,
        checkpoint.parserVersion,
        entry.language ?? null,
        supported ? "complete" : "unsupported",
        contextDigest(facts),
        checkpoint.createdAt
      ]
    );
    await persistParsedFacts(client, checkpoint, entry, facts);
  }
  for (const [ordinal, change] of git.changes.entries()) {
    await client.query(
      `insert into jina_context.commit_changes
        (tenant_id,repository,commit_sha,ordinal,change_kind,path,old_path,old_blob_sha,new_blob_sha)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
      [
        checkpoint.tenantId,
        checkpoint.repository,
        checkpoint.commitSha,
        ordinal,
        change.kind,
        change.path,
        change.oldPath ?? null,
        change.oldBlobSha ?? null,
        change.newBlobSha ?? null
      ]
    );
  }
}

async function persistParsedFacts(
  client: PoolClient,
  checkpoint: EvidenceCheckpoint,
  entry: RefManifestEntry,
  facts: readonly StructuralFact[]
): Promise<void> {
  for (const fact of facts) {
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
      await client.query(
        `insert into jina_context.symbols
          (id,tenant_id,repository,blob_sha,parser_name,parser_version,moniker,name,kind,
           start_line,end_line,metadata)
         values ($1,$2,$3,$4,'deterministic-source-parser',$5,$6,$7,$8,$9,$10,$11::jsonb)
         on conflict do nothing`,
        [
          contextStableId("symbol", { factId: fact.id }),
          checkpoint.tenantId,
          checkpoint.repository,
          entry.blobSha,
          checkpoint.parserVersion,
          fact.to,
          name,
          kind,
          startLine,
          endLine,
          JSON.stringify(fact.metadata)
        ]
      );
    } else if (fact.kind === "imports") {
      const names = Array.isArray(fact.metadata.importedNames)
        ? fact.metadata.importedNames.filter((value): value is string => typeof value === "string")
        : [];
      const values = names.length ? names : [undefined];
      for (const [ordinal, importedName] of values.entries()) {
        const line = fact.anchors[0]?.startLine;
        if (!line) continue;
        await client.query(
          `insert into jina_context.imports
            (id,tenant_id,repository,blob_sha,parser_name,parser_version,specifier,
             imported_name,start_line,end_line,metadata)
           values ($1,$2,$3,$4,'deterministic-source-parser',$5,$6,$7,$8,$8,$9::jsonb)
           on conflict do nothing`,
          [
            contextStableId("import", { factId: fact.id, ordinal }),
            checkpoint.tenantId,
            checkpoint.repository,
            entry.blobSha,
            checkpoint.parserVersion,
            fact.to,
            importedName ?? null,
            line,
            JSON.stringify(fact.metadata)
          ]
        );
      }
    }
  }
}

async function insertStructuralFact(client: PoolClient, fact: StructuralFact, createdAt: string): Promise<void> {
  const first = fact.anchors[0];
  await client.query(
    `insert into jina_context.structural_facts
      (id,tenant_id,repository,ref_name,relation_kind,source_kind,source_id,target_kind,target_id,
       commit_sha,path,start_line,end_line,source_anchors,metadata,derivation_name,derivation_version,
       fact_digest,created_at)
     values ($1,$2,$3,$4,$5,'resource',$6,'resource',$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17)
     on conflict (tenant_id,repository,id) do nothing`,
    [
      fact.id,
      fact.tenantId,
      fact.repository,
      fact.ref,
      fact.kind,
      fact.from,
      fact.to,
      fact.commitSha,
      first?.pathOrUrl ?? null,
      first?.startLine ?? null,
      first?.endLine ?? null,
      JSON.stringify(fact.anchors),
      JSON.stringify(fact.metadata),
      fact.derivationName,
      fact.derivationVersion,
      contextDigest(fact),
      createdAt
    ]
  );
  const stored = await client.query(
    `select 1 from jina_context.structural_facts
     where tenant_id=$1 and repository=$2 and id=$3 and fact_digest=$4`,
    [fact.tenantId, fact.repository, fact.id, contextDigest(fact)]
  );
  if (stored.rowCount !== 1) throw new Error(`Structural fact identity collision for ${fact.id}`);
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
    executable: row.executable
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
