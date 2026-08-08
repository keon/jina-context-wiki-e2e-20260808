import type { GenerationProjection, IndexGeneration } from "@jina/context-engine";
import { ContextDatabase } from "./database.js";
import { parseStoredContextCatalog } from "./release-catalog.js";

interface CatalogRow {
  readonly catalog: unknown;
}

/** Query adapter for the one-row-per-release Context catalog. */
export class PostgresProjectionRepository {
  constructor(private readonly database: ContextDatabase) {}

  async getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_admin",
      { system: true },
      `select catalog from jina_context.context_releases
       where release_id=$1 and pageindex_attached_at is not null`,
      [generationId],
      "context.release.get"
    );
    return result.rows[0] ? parseStoredContextCatalog(result.rows[0].catalog).projection : undefined;
  }

  async getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined> {
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_admin",
      { system: true },
      `select release.catalog
       from jina_context.context_releases release
       where release.release_id=$1
         and release.pageindex_attached_at is not null
         and exists (
           select 1 from jina_context.repository_access access
           where access.tenant_id=release.tenant_id and access.repository=release.repository
             and access.principal_id=$2 and access.permission in ('read','write','admin')
         )`,
      [generationId, principalId],
      "context.release.get-authorized"
    );
    return result.rows[0] ? parseStoredContextCatalog(result.rows[0].catalog).projection : undefined;
  }

  async listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    const result = await this.database.queryAs<CatalogRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select catalog from jina_context.context_releases
       where tenant_id=$1 and repository=$2
       order by ref_name,ref_sequence desc,release_id desc`,
      [tenantId, repository],
      "context.release.list"
    );
    return result.rows.map((row) => parseStoredContextCatalog(row.catalog).projection.generation);
  }
}
