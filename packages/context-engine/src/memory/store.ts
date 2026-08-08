import {
  evidenceExcerpt,
  validateEvidenceRecord,
  type EvidenceAnchor,
  type EvidenceCheckpoint,
  type EvidenceRecord,
  type EvidenceSnapshot,
  type RefManifestEntry,
  type StructuralFact
} from "../domain/evidence.js";
import { fingerprint, normalizeRepository, repositoryAclFingerprint } from "../domain/fingerprint.js";
import type { KnowledgeDocumentRevision, KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import type { GenerationProjection, IndexGeneration } from "../domain/projection.js";
import type {
  ApiTokenRecord,
  ContextEngineStore,
  MintApiTokenInput,
  VerifiedApiToken
} from "../ports/context-engine-store.js";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { IssueGraphRelease } from "../ports/issue-graph-store.js";

function scopeKey(tenantId: string, repository: string, ref: string): string {
  return `${tenantId}\u0000${repository}\u0000${ref}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Drops the hash on the way out, so no read path can return it by accident. */
function publicApiToken(token: ApiTokenRecord & { readonly secretHash: string }): ApiTokenRecord {
  const { secretHash: _secretHash, ...rest } = token;
  return { ...rest, scopes: [...rest.scopes] };
}

/**
 * Lightweight local/test adapter for the current runtime contracts.
 *
 * Evidence snapshots exist only to run the same final publication validator as
 * production. Published catalogs are database-only, so the memory adapter does
 * not emulate the retired knowledge and projector pipeline.
 */
export class MemoryContextEngineStore implements ContextEngineStore, EvidenceStore {
  readonly #checkpoints = new Map<string, EvidenceCheckpoint>();
  readonly #snapshots = new Map<string, EvidenceSnapshot>();
  readonly #latestCheckpoints = new Map<string, string>();
  readonly #repositoryAccess = new Map<string, Set<string>>();
  readonly #repositories = new Set<string>();
  readonly #apiTokens = new Map<string, ApiTokenRecord & { readonly secretHash: string }>();
  readonly #issueGraphReleases = new Map<string, IssueGraphRelease>();
  #closed = false;

  runInTenantScope<T>(_tenantId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Context engine store is closed");
  }

  async commitSnapshot(snapshot: EvidenceSnapshot): Promise<EvidenceCheckpoint> {
    this.#assertOpen();
    const existing = this.#checkpoints.get(snapshot.checkpoint.id);
    if (existing !== undefined) {
      if (existing.evidenceFingerprint !== snapshot.checkpoint.evidenceFingerprint) {
        throw new Error("Checkpoint identity collision");
      }
      return copy(existing);
    }
    for (const record of snapshot.records) validateEvidenceRecord(record);
    if (new Set(snapshot.records.map((record) => record.id)).size !== snapshot.records.length) {
      throw new Error("Duplicate evidence record");
    }
    this.#checkpoints.set(snapshot.checkpoint.id, copy(snapshot.checkpoint));
    this.#snapshots.set(snapshot.checkpoint.id, copy(snapshot));
    this.#repositories.add(`${snapshot.checkpoint.tenantId}\u0000${snapshot.checkpoint.repository}`);
    const key = scopeKey(snapshot.checkpoint.tenantId, snapshot.checkpoint.repository, snapshot.checkpoint.ref);
    const latestId = this.#latestCheckpoints.get(key);
    const latest = latestId === undefined ? undefined : this.#checkpoints.get(latestId);
    if (latest === undefined || snapshot.checkpoint.refSequence > latest.refSequence) {
      this.#latestCheckpoints.set(key, snapshot.checkpoint.id);
    }
    return copy(snapshot.checkpoint);
  }

  async getCheckpoint(checkpointId: string): Promise<EvidenceCheckpoint | undefined> {
    const value = this.#checkpoints.get(checkpointId);
    return value === undefined ? undefined : copy(value);
  }

  async latestCheckpoint(tenantId: string, repository: string, ref: string): Promise<EvidenceCheckpoint | undefined> {
    const id = this.#latestCheckpoints.get(scopeKey(tenantId, normalizeRepository(repository), ref));
    return id === undefined ? undefined : this.getCheckpoint(id);
  }

  async listEvidence(checkpointId: string): Promise<EvidenceRecord[]> {
    return copy(this.#snapshots.get(checkpointId)?.records ?? []);
  }

  async resolveAnchor(
    checkpointId: string,
    anchor: Omit<EvidenceAnchor, "contentDigest">
  ): Promise<EvidenceRecord | undefined> {
    const record = (this.#snapshots.get(checkpointId)?.records ?? []).find(
      (candidate) =>
        candidate.anchor.tenantId === anchor.tenantId &&
        candidate.anchor.repository === anchor.repository &&
        candidate.anchor.sourceType === anchor.sourceType &&
        candidate.anchor.sourceId === anchor.sourceId &&
        (anchor.commitSha === undefined || candidate.anchor.commitSha === anchor.commitSha) &&
        (anchor.pathOrUrl === undefined || candidate.anchor.pathOrUrl === anchor.pathOrUrl)
    );
    return record && evidenceExcerpt(record, anchor) !== undefined ? copy(record) : undefined;
  }

  async listManifest(checkpointId: string): Promise<RefManifestEntry[]> {
    return copy(this.#snapshots.get(checkpointId)?.manifest ?? []);
  }

  async listStructuralFacts(checkpointId: string): Promise<StructuralFact[]> {
    return copy(this.#snapshots.get(checkpointId)?.structuralFacts ?? []);
  }

  async publishIssueGraphRelease(release: IssueGraphRelease): Promise<IssueGraphRelease> {
    this.#assertOpen();
    const existing = this.#issueGraphReleases.get(release.id);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(release)) throw new Error("Issue graph release identity collision");
      return copy(existing);
    }
    const repository = normalizeRepository(release.repository);
    const current = await this.currentIssueGraphRelease(release.tenantId, repository, release.ref);
    if (current && current.refSequence >= release.refSequence) {
      throw new Error("Issue graph release ref sequence is stale");
    }
    const stored = { ...copy(release), repository };
    this.#issueGraphReleases.set(stored.id, stored);
    this.#repositories.add(`${stored.tenantId}\u0000${repository}`);
    return copy(stored);
  }

  async currentIssueGraphRelease(
    tenantId: string,
    repository: string,
    ref: string
  ): Promise<IssueGraphRelease | undefined> {
    return (await this.listIssueGraphReleases(tenantId, repository, ref))[0];
  }

  async currentAuthorizedIssueGraphRelease(
    tenantId: string,
    repository: string,
    ref: string,
    principalId: string
  ): Promise<IssueGraphRelease | undefined> {
    const normalized = normalizeRepository(repository);
    const allowed = this.#repositoryAccess.get(`${tenantId}\u0000${principalId}`);
    return allowed?.has(normalized) ? this.currentIssueGraphRelease(tenantId, normalized, ref) : undefined;
  }

  async listIssueGraphReleases(tenantId: string, repository: string, ref: string): Promise<IssueGraphRelease[]> {
    const normalized = normalizeRepository(repository);
    return [...this.#issueGraphReleases.values()]
      .filter((release) => release.tenantId === tenantId && release.repository === normalized && release.ref === ref)
      .sort((left, right) => right.refSequence - left.refSequence || right.id.localeCompare(left.id))
      .map(copy);
  }

  async getGeneration(_generationId: string): Promise<GenerationProjection | undefined> {
    return undefined;
  }

  async getAuthorizedGeneration(
    _generationId: string,
    _principalId: string
  ): Promise<GenerationProjection | undefined> {
    return undefined;
  }

  async listGenerations(_tenantId: string, _repository: string): Promise<IndexGeneration[]> {
    return [];
  }

  async listRevisions(_tenantId: string, _repository: string): Promise<KnowledgeDocumentRevision[]> {
    return [];
  }

  async listCitations(_revisionId: string): Promise<KnowledgeEvidenceCitation[]> {
    return [];
  }

  async listCitationsForRevisions(
    revisionIds: readonly string[]
  ): Promise<ReadonlyMap<string, KnowledgeEvidenceCitation[]>> {
    return new Map(revisionIds.map((revisionId) => [revisionId, []]));
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    this.#assertOpen();
    this.#setRepositoryAccess(tenantId, principalId, repositories);
  }

  async mergeRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    this.#assertOpen();
    const key = `${tenantId}\u0000${principalId}`;
    this.#setRepositoryAccess(tenantId, principalId, [
      ...(this.#repositoryAccess.get(key) ?? new Set<string>()),
      ...repositories
    ]);
  }

  #setRepositoryAccess(tenantId: string, principalId: string, repositories: Iterable<string>): void {
    const normalized = new Set([...repositories].map(normalizeRepository));
    this.#repositoryAccess.set(`${tenantId}\u0000${principalId}`, normalized);
    for (const repository of normalized) this.#repositories.add(`${tenantId}\u0000${repository}`);
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]> {
    return [...(this.#repositoryAccess.get(`${tenantId}\u0000${principalId}`) ?? new Set())].sort();
  }

  async aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]> {
    const normalized = normalizeRepository(repository);
    const repositories = this.#repositoryAccess.get(`${tenantId}\u0000${principalId}`) ?? new Set();
    return repositories.has(normalized) ? [repositoryAclFingerprint(tenantId, normalized)] : [];
  }

  async listRepositories(tenantId: string): Promise<string[]> {
    const prefix = `${tenantId}\u0000`;
    return [...this.#repositories]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  async contextCatalogMetrics(_tenantId: string): Promise<{
    readonly publishedGenerationCount: number;
    readonly documentCount: number;
    readonly fragmentCount: number;
    readonly hierarchyNodeCount: number;
  }> {
    return { publishedGenerationCount: 0, documentCount: 0, fragmentCount: 0, hierarchyNodeCount: 0 };
  }

  async verifyApiToken(secretHash: string, expectedTenantId?: string): Promise<VerifiedApiToken | undefined> {
    this.#assertOpen();
    for (const token of this.#apiTokens.values()) {
      if (token.secretHash !== secretHash) continue;
      if (expectedTenantId !== undefined && token.tenantId !== expectedTenantId) return undefined;
      if (token.revokedAt || Date.parse(token.expiresAt) <= Date.now()) return undefined;
      return {
        tokenId: token.id,
        tenantId: token.tenantId,
        principalId: token.principalId,
        scopes: [...token.scopes],
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {})
      };
    }
    return undefined;
  }

  async stampApiTokenUse(tenantId: string, tokenId: string, usedAt: string): Promise<void> {
    const token = this.#apiTokens.get(tokenId);
    if (token?.tenantId === tenantId) this.#apiTokens.set(tokenId, { ...token, lastUsedAt: usedAt });
  }

  async mintApiToken(token: MintApiTokenInput): Promise<ApiTokenRecord> {
    this.#assertOpen();
    if (this.#apiTokens.has(token.id)) throw new Error(`Duplicate API token id ${token.id}`);
    if ([...this.#apiTokens.values()].some((existing) => existing.secretHash === token.secretHash)) {
      throw new Error("Duplicate API token secret");
    }
    const stored = { ...token, scopes: [...token.scopes] };
    this.#apiTokens.set(token.id, stored);
    return publicApiToken(stored);
  }

  async listApiTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    return [...this.#apiTokens.values()]
      .filter((token) => token.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map(publicApiToken);
  }

  async revokeApiToken(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined> {
    const token = this.#apiTokens.get(tokenId);
    if (!token || token.tenantId !== tenantId) return undefined;
    if (token.revokedAt) return publicApiToken(token);
    const revoked = { ...token, revokedAt, revokedBy };
    this.#apiTokens.set(tokenId, revoked);
    return publicApiToken(revoked);
  }

  async migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void> {
    this.#assertOpen();
    if (fromTenantId === toTenantId) return;
    for (const [key, repositories] of [...this.#repositoryAccess]) {
      if (!key.startsWith(`${fromTenantId}\u0000`)) continue;
      const principalId = key.slice(fromTenantId.length + 1);
      const targetKey = `${toTenantId}\u0000${principalId}`;
      this.#repositoryAccess.set(
        targetKey,
        new Set([...(this.#repositoryAccess.get(targetKey) ?? []), ...repositories])
      );
      for (const repository of repositories) this.#repositories.add(`${toTenantId}\u0000${repository}`);
      this.#repositoryAccess.delete(key);
    }
  }

  async health(): Promise<{ ok: boolean; adapter: string }> {
    return { ok: !this.#closed, adapter: "memory" };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
