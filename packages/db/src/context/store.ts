import {
  normalizeRepository,
  repositoryAclFingerprint,
  type ApiTokenRecord,
  type ContextEngineStore,
  type GenerationProjection,
  type IndexGeneration,
  type KnowledgeDocumentRevision,
  type KnowledgeEvidenceCitation,
  type MintApiTokenInput,
  type VerifiedApiToken
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import type { PostgresContextDatabaseConfig } from "./database.js";
import { ContextDatabase } from "./database.js";
import { PostgresApiTokenRepository } from "./api-token-repository.js";
import { PostgresIssueGraphRepository } from "./issue-graph-repository.js";
import { PostgresProjectionRepository } from "./projection-repository.js";
import { parseStoredContextCatalog } from "./release-catalog.js";

interface CatalogRow {
  readonly release_id: string;
  readonly catalog: unknown;
}

/** Live Context persistence: release catalogs, repository access, tokens, and causal graphs. */
export class PostgresContextEngineStore implements ContextEngineStore {
  readonly database: ContextDatabase;
  readonly projection: PostgresProjectionRepository;
  readonly apiTokens: PostgresApiTokenRepository;
  readonly issueGraphs: PostgresIssueGraphRepository;

  constructor(config: PostgresContextDatabaseConfig | ContextDatabase) {
    this.database = config instanceof ContextDatabase ? config : new ContextDatabase(config);
    this.projection = new PostgresProjectionRepository(this.database);
    this.apiTokens = new PostgresApiTokenRepository(this.database);
    this.issueGraphs = new PostgresIssueGraphRepository(this.database);
  }

  publishIssueGraphRelease(release: import("@jina/context-engine").IssueGraphRelease) {
    return this.issueGraphs.publishIssueGraphRelease(release);
  }

  currentIssueGraphRelease(tenantId: string, repository: string, ref: string) {
    return this.issueGraphs.currentIssueGraphRelease(tenantId, repository, ref);
  }

  currentAuthorizedIssueGraphRelease(tenantId: string, repository: string, ref: string, principalId: string) {
    return this.issueGraphs.currentAuthorizedIssueGraphRelease(tenantId, repository, ref, principalId);
  }

  listIssueGraphReleases(tenantId: string, repository: string, ref: string) {
    return this.issueGraphs.listIssueGraphReleases(tenantId, repository, ref);
  }

  verifyApiToken(secretHash: string, expectedTenantId?: string): Promise<VerifiedApiToken | undefined> {
    return this.apiTokens.verifyApiToken(secretHash, expectedTenantId);
  }

  stampApiTokenUse(tenantId: string, tokenId: string, usedAt: string): Promise<void> {
    return this.apiTokens.stampApiTokenUse(tenantId, tokenId, usedAt);
  }

  mintApiToken(token: MintApiTokenInput): Promise<ApiTokenRecord> {
    return this.apiTokens.mintApiToken(token);
  }

  listApiTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    return this.apiTokens.listApiTokens(tenantId);
  }

  revokeApiToken(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined> {
    return this.apiTokens.revokeApiToken(tenantId, tokenId, revokedBy, revokedAt);
  }

  runInTenantScope<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runInTenantScope(tenantId, operation);
  }

  contextDatabaseTelemetry() {
    return this.database.telemetry();
  }

  getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    return this.projection.getGeneration(generationId);
  }

  getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined> {
    return this.projection.getAuthorizedGeneration(generationId, principalId);
  }

  listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    return this.projection.listGenerations(tenantId, normalizeRepository(repository));
  }

  async listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    const catalogs = await this.releaseCatalogs(tenantId, normalizeRepository(repository));
    const revisions = new Map<string, KnowledgeDocumentRevision>();
    for (const row of catalogs) {
      for (const revision of parseStoredContextCatalog(row.catalog).revisions) revisions.set(revision.id, revision);
    }
    return [...revisions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listCitations(revisionId: string): Promise<KnowledgeEvidenceCitation[]> {
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_admin",
      { system: true },
      `select release_id,catalog from jina_context.context_releases
       where pageindex_attached_at is not null
         and catalog @> jsonb_build_object('revisions',jsonb_build_array(jsonb_build_object('id',$1::text)))
       order by ref_sequence desc,release_id desc`,
      [revisionId],
      "context.citations.single"
    );
    for (const row of result.rows) {
      const citations = parseStoredContextCatalog(row.catalog).citations.filter(
        (citation) => citation.revisionId === revisionId
      );
      if (citations.length > 0) return [...citations].sort((left, right) => left.ordinal - right.ordinal);
    }
    return [];
  }

  async listCitationsForRevisions(
    revisionIds: readonly string[]
  ): Promise<ReadonlyMap<string, KnowledgeEvidenceCitation[]>> {
    const requested = new Set(revisionIds);
    const citations = new Map<string, KnowledgeEvidenceCitation[]>(revisionIds.map((id) => [id, []]));
    if (requested.size === 0) return citations;
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_admin",
      { system: true },
      `select release_id,catalog from jina_context.context_releases
       where pageindex_attached_at is not null
       order by ref_sequence desc,release_id desc`,
      [],
      "context.citations.batch"
    );
    for (const row of result.rows) {
      for (const citation of parseStoredContextCatalog(row.catalog).citations) {
        if (requested.has(citation.revisionId) && citations.get(citation.revisionId)!.length === 0) {
          citations.set(
            citation.revisionId,
            parseStoredContextCatalog(row.catalog)
              .citations.filter((candidate) => candidate.revisionId === citation.revisionId)
              .sort((left, right) => left.ordinal - right.ordinal)
          );
        }
      }
    }
    return citations;
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    const desired = new Set(repositories.map(normalizeRepository));
    await this.database.transactionAs("jina_context_admin", { tenantIds: [tenantId] }, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `repository-access:${tenantId}:${principalId}`
      ]);
      await this.setRepositoryAccess(client, tenantId, principalId, desired);
    });
  }

  async mergeRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    const desired = new Set(repositories.map(normalizeRepository));
    await this.database.transactionAs("jina_context_admin", { tenantIds: [tenantId] }, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `repository-access:${tenantId}:${principalId}`
      ]);
      const current = await client.query<{ repository: string }>(
        `select repository from jina_context.repository_access
         where tenant_id=$1 and principal_id=$2 and permission in ('read','write','admin')`,
        [tenantId, principalId]
      );
      for (const row of current.rows) desired.add(row.repository);
      await this.setRepositoryAccess(client, tenantId, principalId, desired);
    });
  }

  private async setRepositoryAccess(
    client: PoolClient,
    tenantId: string,
    principalId: string,
    desired: ReadonlySet<string>
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const repository of desired) {
      await client.query(
        `insert into jina_context.repositories
          (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
         values ($1,$2,'unknown',$2,'main','{}'::jsonb,$3,$3)
         on conflict (tenant_id,repository) do nothing`,
        [tenantId, repository, now]
      );
    }
    const registered = await client.query<{ repository: string }>(
      "select repository from jina_context.repositories where tenant_id=$1",
      [tenantId]
    );
    for (const { repository } of registered.rows) {
      await client.query(
        `insert into jina_context.repository_access
          (tenant_id,repository,principal_id,permission,acl_fingerprint,updated_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id,repository,principal_id) do update
           set permission=excluded.permission,acl_fingerprint=excluded.acl_fingerprint,
               updated_at=excluded.updated_at`,
        [
          tenantId,
          repository,
          principalId,
          desired.has(repository) ? "read" : "denied",
          repositoryAclFingerprint(tenantId, repository),
          now
        ]
      );
    }
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]> {
    const result = await this.database.queryAs<{ repository: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select repository from jina_context.repository_access
       where tenant_id=$1 and principal_id=$2 and permission in ('read','write','admin')
       order by repository`,
      [tenantId, principalId]
    );
    return result.rows.map((row) => row.repository);
  }

  async aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]> {
    const result = await this.database.queryAs<{ acl_fingerprint: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select acl_fingerprint from jina_context.repository_access
       where tenant_id=$1 and repository=$2 and principal_id=$3
         and permission in ('read','write','admin')`,
      [tenantId, normalizeRepository(repository), principalId]
    );
    return result.rows.map((row) => row.acl_fingerprint);
  }

  async listRepositories(tenantId: string): Promise<string[]> {
    const result = await this.database.queryAs<{ repository: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      "select repository from jina_context.repositories where tenant_id=$1 order by repository",
      [tenantId],
      "context.repositories.list"
    );
    return result.rows.map((row) => row.repository);
  }

  async contextCatalogMetrics(tenantId: string): Promise<{
    readonly publishedGenerationCount: number;
    readonly documentCount: number;
    readonly fragmentCount: number;
    readonly hierarchyNodeCount: number;
  }> {
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select release_id,catalog from jina_context.context_releases
       where tenant_id=$1 and pageindex_attached_at is not null`,
      [tenantId],
      "context.metrics.catalog-counts"
    );
    let documentCount = 0;
    let fragmentCount = 0;
    let hierarchyNodeCount = 0;
    for (const row of result.rows) {
      const projection = parseStoredContextCatalog(row.catalog).projection;
      documentCount += projection.documents.length;
      fragmentCount += projection.fragments.length;
      hierarchyNodeCount += projection.hierarchyNodes.length;
    }
    return {
      publishedGenerationCount: result.rows.length,
      documentCount,
      fragmentCount,
      hierarchyNodeCount
    };
  }

  async migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void> {
    if (fromTenantId === toTenantId) return;
    const access = await this.database.queryAs<{ principal_id: string; repository: string }>(
      "jina_context_admin",
      { tenantIds: [fromTenantId] },
      `select principal_id,repository from jina_context.repository_access
       where tenant_id=$1 and permission in ('read','write','admin')`,
      [fromTenantId]
    );
    const grouped = new Map<string, string[]>();
    for (const row of access.rows)
      grouped.set(row.principal_id, [...(grouped.get(row.principal_id) ?? []), row.repository]);
    for (const [principalId, repositories] of grouped) {
      await this.mergeRepositoryAccess(toTenantId, principalId, repositories);
    }
  }

  async health(): Promise<{ ok: boolean; adapter: string }> {
    try {
      await this.database.initialize();
      await this.database.pool.query("select 1");
      return { ok: true, adapter: "postgres" };
    } catch {
      return { ok: false, adapter: "postgres" };
    }
  }

  close(): Promise<void> {
    return this.database.close();
  }

  private async releaseCatalogs(tenantId: string, repository: string): Promise<CatalogRow[]> {
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select release_id,catalog from jina_context.context_releases
       where tenant_id=$1 and repository=$2
         and pageindex_attached_at is not null
       order by ref_sequence desc,release_id desc`,
      [tenantId, repository]
    );
    return result.rows;
  }
}
