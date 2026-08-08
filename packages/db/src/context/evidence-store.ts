import {
  evidenceExcerpt,
  fingerprint,
  normalizeRepository,
  validateEvidenceRecord,
  type EvidenceAnchor,
  type EvidenceCheckpoint,
  type EvidenceRecord,
  type EvidenceSnapshot,
  type EvidenceStore,
  type RefManifestEntry,
  type StructuralFact
} from "@jina/context-engine";
import type { PostgresContextDatabaseConfig } from "./database.js";
import { ContextDatabase } from "./database.js";

interface SnapshotRow {
  readonly snapshot: unknown;
}

/** Durable one-row-per-checkpoint adapter for the compact Context architecture. */
export class PostgresEvidenceStore implements EvidenceStore {
  readonly database: ContextDatabase;

  constructor(config: PostgresContextDatabaseConfig | ContextDatabase) {
    this.database = config instanceof ContextDatabase ? config : new ContextDatabase(config);
  }

  async commitSnapshot(value: EvidenceSnapshot): Promise<EvidenceCheckpoint> {
    const snapshot = validatedSnapshot(value);
    await this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [snapshot.checkpoint.tenantId] },
      async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `context-evidence:${snapshot.checkpoint.id}`
        ]);
        await client.query(
          `insert into jina_context.repositories
             (tenant_id,repository,default_ref,created_at,updated_at)
           values ($1,$2,$3,$4,$4)
           on conflict (tenant_id,repository) do nothing`,
          [
            snapshot.checkpoint.tenantId,
            snapshot.checkpoint.repository,
            snapshot.checkpoint.ref,
            snapshot.checkpoint.createdAt
          ]
        );
        const inserted = await client.query(
          `insert into jina_context.context_evidence_snapshots
             (checkpoint_id,tenant_id,repository,ref_name,ref_sequence,commit_sha,
              evidence_fingerprint,snapshot,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
           on conflict (checkpoint_id) do nothing`,
          [
            snapshot.checkpoint.id,
            snapshot.checkpoint.tenantId,
            snapshot.checkpoint.repository,
            snapshot.checkpoint.ref,
            snapshot.checkpoint.refSequence,
            snapshot.checkpoint.commitSha,
            snapshot.checkpoint.evidenceFingerprint,
            JSON.stringify(snapshot),
            snapshot.checkpoint.createdAt
          ]
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query<SnapshotRow>(
            "select snapshot from jina_context.context_evidence_snapshots where checkpoint_id=$1 for share",
            [snapshot.checkpoint.id]
          );
          const stored = parsedSnapshot(existing.rows[0]?.snapshot);
          if (fingerprint(stored) !== fingerprint(snapshot)) throw new Error("Checkpoint identity collision");
        }
      },
      "context.evidence.commit"
    );
    return structuredClone(snapshot.checkpoint);
  }

  async getCheckpoint(checkpointId: string): Promise<EvidenceCheckpoint | undefined> {
    const snapshot = await this.snapshotById(checkpointId);
    return snapshot ? structuredClone(snapshot.checkpoint) : undefined;
  }

  async latestCheckpoint(tenantId: string, repository: string, ref: string): Promise<EvidenceCheckpoint | undefined> {
    const normalizedRepository = normalizeRepository(repository);
    const result = await this.database.queryAs<SnapshotRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select snapshot from jina_context.context_evidence_snapshots
       where tenant_id=$1 and repository=$2 and ref_name=$3
       order by ref_sequence desc,checkpoint_id desc limit 1`,
      [tenantId, normalizedRepository, ref],
      "context.evidence.latest"
    );
    return result.rows[0] ? structuredClone(parsedSnapshot(result.rows[0].snapshot).checkpoint) : undefined;
  }

  async listEvidence(checkpointId: string): Promise<EvidenceRecord[]> {
    return structuredClone((await this.snapshotById(checkpointId))?.records ?? []);
  }

  async resolveAnchor(
    checkpointId: string,
    anchor: Omit<EvidenceAnchor, "contentDigest">
  ): Promise<EvidenceRecord | undefined> {
    const snapshot = await this.snapshotById(checkpointId);
    const record = snapshot?.records.find(
      (candidate) =>
        candidate.anchor.tenantId === anchor.tenantId &&
        candidate.anchor.repository === normalizeRepository(anchor.repository) &&
        candidate.anchor.sourceType === anchor.sourceType &&
        candidate.anchor.sourceId === anchor.sourceId &&
        (anchor.commitSha === undefined || candidate.anchor.commitSha === anchor.commitSha) &&
        (anchor.pathOrUrl === undefined || candidate.anchor.pathOrUrl === anchor.pathOrUrl)
    );
    return record && evidenceExcerpt(record, anchor) !== undefined ? structuredClone(record) : undefined;
  }

  async listManifest(checkpointId: string): Promise<RefManifestEntry[]> {
    return structuredClone((await this.snapshotById(checkpointId))?.manifest ?? []);
  }

  async listStructuralFacts(checkpointId: string): Promise<StructuralFact[]> {
    return structuredClone((await this.snapshotById(checkpointId))?.structuralFacts ?? []);
  }

  private async snapshotById(checkpointId: string): Promise<EvidenceSnapshot | undefined> {
    if (!checkpointId.trim() || checkpointId.length > 240 || checkpointId.includes("\0")) {
      throw new Error("checkpointId is invalid");
    }
    const result = await this.database.queryAs<SnapshotRow>(
      "jina_context_admin",
      { system: true },
      "select snapshot from jina_context.context_evidence_snapshots where checkpoint_id=$1",
      [checkpointId],
      "context.evidence.get"
    );
    return result.rows[0] ? parsedSnapshot(result.rows[0].snapshot) : undefined;
  }
}

function validatedSnapshot(value: EvidenceSnapshot): EvidenceSnapshot {
  const snapshot = structuredClone(value);
  const checkpoint = snapshot.checkpoint;
  checkpoint.repository = normalizeRepository(checkpoint.repository);
  if (
    !checkpoint.id.trim() ||
    checkpoint.id.length > 240 ||
    !checkpoint.tenantId.trim() ||
    !checkpoint.ref.trim() ||
    !Number.isSafeInteger(checkpoint.refSequence) ||
    checkpoint.refSequence <= 0 ||
    !/^[0-9a-f]{40}$/.test(checkpoint.commitSha) ||
    !/^[0-9a-f]{64}$/.test(checkpoint.evidenceFingerprint)
  ) {
    throw new Error("Evidence checkpoint identity is invalid");
  }
  for (const record of snapshot.records) {
    validateEvidenceRecord(record);
    if (
      record.anchor.tenantId !== checkpoint.tenantId ||
      normalizeRepository(record.anchor.repository) !== checkpoint.repository ||
      (record.anchor.commitSha !== undefined && record.anchor.commitSha !== checkpoint.commitSha)
    ) {
      throw new Error("Evidence record escapes its checkpoint scope");
    }
  }
  if (new Set(snapshot.records.map((record) => record.id)).size !== snapshot.records.length) {
    throw new Error("Duplicate evidence record");
  }
  return snapshot;
}

function parsedSnapshot(value: unknown): EvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Stored evidence snapshot is invalid");
  const snapshot = value as EvidenceSnapshot;
  if (!snapshot.checkpoint || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.manifest)) {
    throw new Error("Stored evidence snapshot is incomplete");
  }
  if (!Array.isArray(snapshot.structuralFacts)) throw new Error("Stored evidence structural facts are invalid");
  return validatedSnapshot(snapshot);
}
