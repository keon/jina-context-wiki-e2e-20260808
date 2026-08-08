import type { KnowledgeDocumentRevision, KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import type { GenerationProjection, IndexGeneration } from "../domain/projection.js";
import type { IssueGraphStore } from "./issue-graph-store.js";

export interface ContextDatabaseTelemetry {
  readonly pool: {
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
    readonly max: number;
  };
  readonly metrics: {
    readonly counters: readonly {
      readonly name: string;
      readonly labels: Readonly<Record<string, string>>;
      readonly value: number;
    }[];
    readonly durations: readonly {
      readonly name: string;
      readonly labels: Readonly<Record<string, string>>;
      readonly count: number;
      readonly totalMs: number;
      readonly maxMs: number;
    }[];
    readonly droppedSeries: number;
  };
}

/** A token as anyone but its holder sees it: never the secret, never its hash. */
export interface ApiTokenRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
}

export interface MintApiTokenInput {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly name: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
}

/** What verification resolves from a presented secret. Liveness is already decided. */
export interface VerifiedApiToken {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt?: string;
}

/** Persistence required by the live API catalog and governance routes. */
export interface ContextEngineStore extends IssueGraphStore {
  getGeneration(generationId: string): Promise<GenerationProjection | undefined>;
  getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined>;
  listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]>;
  listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]>;
  listCitations(revisionId: string): Promise<KnowledgeEvidenceCitation[]>;
  listCitationsForRevisions(revisionIds: readonly string[]): Promise<ReadonlyMap<string, KnowledgeEvidenceCitation[]>>;
  runInTenantScope<T>(tenantId: string, operation: () => Promise<T>): Promise<T>;
  /** Process-local database latency and pool-pressure telemetry for operator diagnostics. */
  contextDatabaseTelemetry?(): ContextDatabaseTelemetry;
  replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void>;
  mergeRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void>;
  repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]>;
  aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]>;
  listRepositories(tenantId: string): Promise<string[]>;
  /** Aggregate catalog counts without hydrating every immutable release. */
  contextCatalogMetrics(tenantId: string): Promise<{
    readonly publishedGenerationCount: number;
    readonly documentCount: number;
    readonly fragmentCount: number;
    readonly hierarchyNodeCount: number;
  }>;
  verifyApiToken(secretHash: string, expectedTenantId?: string): Promise<VerifiedApiToken | undefined>;
  stampApiTokenUse(tenantId: string, tokenId: string, usedAt: string): Promise<void>;
  mintApiToken(token: MintApiTokenInput): Promise<ApiTokenRecord>;
  listApiTokens(tenantId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined>;
  migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void>;
  health(): Promise<{ ok: boolean; adapter: string }>;
  close(): Promise<void>;
}
