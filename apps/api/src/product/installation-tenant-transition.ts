import type pg from "pg";

export type InstallationTenantTransitionClient = Pick<pg.PoolClient, "query">;

class InstallationTenantRollbackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationTenantRollbackConflictError";
  }
}

/**
 * Revert the latest unreverted installation move. This refuses to cross a
 * history boundary: once reviews/projects exist under the destination tenant,
 * ownership and billing must be handled as an explicit workspace merge.
 */
export async function rollbackInstallationTenantMove(
  client: InstallationTenantTransitionClient,
  githubInstallationId: number,
  revertedBy: string,
): Promise<{ fromTenantId: string; toTenantId: string }> {
  const move = await client.query<{
    id: string;
    installation_id: string;
    from_tenant_id: string;
    to_tenant_id: string;
    current_tenant_id: string;
  }>(
    `select move.id, move.installation_id, move.from_tenant_id, move.to_tenant_id,
            installation.tenant_id as current_tenant_id
       from installation_tenant_moves move
       join installations installation on installation.id = move.installation_id
      where move.github_installation_id = $1
        and move.reverted_at is null
      order by move.created_at desc
      limit 1
      for update of move, installation`,
    [githubInstallationId],
  );
  const row = move.rows[0];
  if (!row) {
    throw new InstallationTenantRollbackConflictError("no unreverted tenant move exists for this installation");
  }
  if (row.current_tenant_id !== row.to_tenant_id) {
    throw new InstallationTenantRollbackConflictError("installation ownership changed after the recorded move");
  }

  const scope = await client.query<{
    snapshot_count: number;
    current_count: number;
    missing_snapshot_repository: boolean;
    added_repository: boolean;
    unresolved_repository: boolean;
  }>(
    `select
       (
         select count(*)::integer
           from installation_tenant_move_repositories scope
          where scope.move_id = $1
       ) as snapshot_count,
       (
         select count(*)::integer
           from repositories repository
          where repository.installation_id = $2
       ) as current_count,
       exists (
         select 1
           from installation_tenant_move_repositories scope
           left join repositories repository
             on repository.id = scope.repository_id
            and repository.github_repo_id = scope.github_repo_id
            and repository.installation_id = $2
            and repository.tenant_id = $3
          where scope.move_id = $1
            and repository.id is null
       ) as missing_snapshot_repository,
       exists (
         select 1
           from repositories repository
           left join installation_tenant_move_repositories scope
             on scope.move_id = $1
            and scope.repository_id = repository.id
            and scope.github_repo_id = repository.github_repo_id
          where repository.installation_id = $2
            and scope.move_id is null
       ) as added_repository,
       exists (
         select 1
           from repositories repository
          where repository.tenant_id = $3
            and repository.installation_id is null
       ) as unresolved_repository`,
    [row.id, row.installation_id, row.to_tenant_id],
  );
  const scopeState = scope.rows[0]!;
  if (
    scopeState.snapshot_count !== scopeState.current_count
    || scopeState.missing_snapshot_repository
    || scopeState.added_repository
    || scopeState.unresolved_repository
  ) {
    throw new InstallationTenantRollbackConflictError(
      "installation repository scope changed after the move; refusing an inferred rollback",
    );
  }

  const history = await client.query<{ found: boolean }>(
    `select exists (
       select 1
         from repositories repository
         join installation_tenant_move_repositories scope
           on scope.repository_id = repository.id
          and scope.github_repo_id = repository.github_repo_id
        where scope.move_id = $1
          and (
            exists (select 1 from review_runs run where run.repository_id = repository.id)
            or exists (select 1 from pull_requests pull where pull.repository_id = repository.id)
            or exists (select 1 from bots bot where bot.repository_id = repository.id)
            or exists (select 1 from scenario_lineages lineage where lineage.repository_id = repository.id)
          )
     ) as found`,
    [row.id],
  );
  if (history.rows[0]?.found) {
    throw new InstallationTenantRollbackConflictError(
      "installation has Jina history after the move; refusing to change its billing owner",
    );
  }

  await client.query(
    `update repositories repository
        set tenant_id = $2
       from installation_tenant_move_repositories scope
      where scope.move_id = $3
        and scope.repository_id = repository.id
        and repository.installation_id = $1`,
    [row.installation_id, row.from_tenant_id, row.id],
  );
  await client.query(
    `update installations set tenant_id = $2 where id = $1`,
    [row.installation_id, row.from_tenant_id],
  );
  await client.query(
    `update tenants
        set merged_into_tenant_id = null
      where id = $1
        and merged_into_tenant_id = $2`,
    [row.from_tenant_id, row.to_tenant_id],
  );
  await client.query(
    `update installation_tenant_moves
        set reverted_at = now(), reverted_by = $2
      where id = $1`,
    [row.id, revertedBy],
  );
  return { fromTenantId: row.to_tenant_id, toTenantId: row.from_tenant_id };
}
