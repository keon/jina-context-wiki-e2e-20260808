/** Canonical union of Board V1 and Trigger V2 compact catalogs. */
export const CONTEXT_CATALOG_ROWS_SQL = `(
  select release_id,tenant_id,repository,ref_name,ref_sequence,catalog,
         pageindex_attached_at as activated_at
  from jina_context.context_releases
  union all
  select release_id,tenant_id,repository,ref_name,ref_sequence,catalog,
         published_at as activated_at
  from jina_context.context_board_publications
)`;
