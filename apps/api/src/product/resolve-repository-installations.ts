import type pg from "pg";

import {
  getInstallationForApp,
  listInstallationRepositories,
  type InstallationRepositoryAccess,
} from "./github-app.js";
import { INTERNAL_USER_TRANSITION_LOCK_KEY } from "./internal-user.js";

type ResolutionClient = Pick<pg.PoolClient, "query">;

interface RepositoryCandidate {
  id: string;
  tenant_id: string;
  github_repo_id: string;
}

interface InstallationCandidate {
  id: string;
  tenant_id: string;
  github_installation_id: string;
}

export interface RepositoryInstallationResolutionReport {
  candidates: number;
  resolved: number;
  unresolved: number;
  ambiguous: number;
  deletedInstallations: number;
}

type InstallationRepositoryLister = (
  installationId: number,
) => Promise<InstallationRepositoryAccess[] | undefined>;

/**
 * Resolve legacy repositories against GitHub's authoritative per-installation
 * repository lists. Updates happen in the caller's transaction, so dry-run can
 * exercise the exact production path and roll it back.
 */
export async function resolveRepositoryInstallations(
  client: ResolutionClient,
  listRepositories: InstallationRepositoryLister = listExistingInstallationRepositories,
): Promise<RepositoryInstallationResolutionReport> {
  const lock = await client.query<{ acquired: boolean }>(
    "select pg_try_advisory_xact_lock($1) as acquired",
    [INTERNAL_USER_TRANSITION_LOCK_KEY],
  );
  if (!lock.rows[0]?.acquired) {
    throw new Error(
      "repository installation resolution could not acquire the exclusive identity lock; retry later",
    );
  }

  const repositories = await client.query<RepositoryCandidate>(`
    select repository.id, repository.tenant_id, repository.github_repo_id::text
    from repositories repository
    where repository.enabled = true
      and not exists (
        select 1
        from installations installation
        where installation.id = repository.installation_id
          and installation.tenant_id = repository.tenant_id
      )
    order by repository.tenant_id, repository.github_repo_id
    for update
  `);
  if (repositories.rows.length === 0) {
    return {
      candidates: 0,
      resolved: 0,
      unresolved: 0,
      ambiguous: 0,
      deletedInstallations: 0,
    };
  }

  const tenantIds = [...new Set(repositories.rows.map((repository) => repository.tenant_id))];
  const installations = await client.query<InstallationCandidate>(
    `select id, tenant_id, github_installation_id::text
     from installations
     where tenant_id = any($1::uuid[])
       and suspended_at is null
       and deleted_at is null
     order by tenant_id, github_installation_id`,
    [tenantIds],
  );
  const repositoryIdsByInstallation = new Map<string, Set<string>>();
  let deletedInstallations = 0;
  for (const installation of installations.rows) {
    let visible;
    try {
      visible = await listRepositories(Number(installation.github_installation_id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not inspect GitHub installation ${installation.github_installation_id}: ${message}`,
        { cause: error },
      );
    }
    if (visible === undefined) {
      // A signed App lookup returning 404 is authoritative deletion. Persist
      // the unavailable lifecycle state and disable only repositories already
      // linked to that exact installation; unlinked rows are still resolved
      // solely from the repository sets of installations GitHub recognizes.
      await client.query(
        `update installations
         set
           suspended_at = coalesce(suspended_at, now()),
           deleted_at = coalesce(deleted_at, now())
         where id = $1`,
        [installation.id],
      );
      await client.query(
        `update repositories
         set enabled = false
         where installation_id = $1`,
        [installation.id],
      );
      repositoryIdsByInstallation.set(installation.id, new Set());
      deletedInstallations += 1;
      continue;
    }
    repositoryIdsByInstallation.set(
      installation.id,
      new Set(
        visible
          .map((repository) => repository.githubRepoId)
          .filter((repositoryId): repositoryId is number => repositoryId !== undefined)
          .map(String),
      ),
    );
  }

  let resolved = 0;
  let ambiguous = 0;
  for (const repository of repositories.rows) {
    const matches = installations.rows.filter(
      (installation) =>
        installation.tenant_id === repository.tenant_id
        && repositoryIdsByInstallation.get(installation.id)?.has(repository.github_repo_id),
    );
    if (matches.length !== 1) {
      if (matches.length > 1) ambiguous += 1;
      continue;
    }
    await client.query(
      `update repositories
       set installation_id = $2
       where id = $1`,
      [repository.id, matches[0].id],
    );
    resolved += 1;
  }

  return {
    candidates: repositories.rows.length,
    resolved,
    unresolved: repositories.rows.length - resolved,
    ambiguous,
    deletedInstallations,
  };
}

async function listExistingInstallationRepositories(
  installationId: number,
): Promise<InstallationRepositoryAccess[] | undefined> {
  const installation = await getInstallationForApp(installationId);
  if (!installation) return undefined;
  return listInstallationRepositories(installationId);
}
