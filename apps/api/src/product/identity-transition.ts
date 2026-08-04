import type pg from "pg";

import { INTERNAL_USER_TRANSITION_LOCK_KEY } from "./internal-user.js";

export type IdentityTransitionClient = Pick<pg.PoolClient, "query">;

export type IdentityTransitionReport = {
  candidates: number;
  identitiesCreated: number;
  membershipsBackfilled: number;
  integrationsBackfilled: number;
  sessionsBackfilled: number;
  tenantsClassified: number;
  installationsBackfilled: number;
  installationInstallersBackfilled: number;
  repositoriesBackfilled: number;
  unmappedIdentities: number;
  unmappedMemberships: number;
  unmappedIntegrations: number;
  unmappedSessions: number;
  unmappedRepositories: number;
};

/**
 * Backfill stable Jina users from every durable place that currently records a
 * GitHub user. The caller owns the transaction so production can choose commit
 * or dry-run rollback, and tests can keep all fixture data isolated.
 */
export async function runInternalUserTransition(
  client: IdentityTransitionClient,
): Promise<IdentityTransitionReport> {
  const lock = await client.query<{ acquired: boolean }>(
    "select pg_try_advisory_xact_lock($1) as acquired",
    [INTERNAL_USER_TRANSITION_LOCK_KEY],
  );
  if (!lock.rows[0]?.acquired) {
    throw new Error(
      "internal-user transition could not acquire the exclusive identity lock; retry after active sign-ins finish",
    );
  }

  await client.query(`
    create temporary table if not exists jina_identity_transition_candidates (
      provider_user_id text primary key,
      provider_login text,
      display_name text,
      avatar_url text
    ) on commit drop
  `);
  await client.query("truncate table jina_identity_transition_candidates");
  await client.query(`
    insert into jina_identity_transition_candidates
      (provider_user_id, provider_login, display_name, avatar_url)
    with raw_candidates as (
      select
        session_json #>> '{user,id}' as provider_user_id,
        nullif(btrim(session_json #>> '{user,login}'), '') as provider_login,
        nullif(btrim(session_json #>> '{user,name}'), '') as display_name,
        nullif(btrim(session_json #>> '{user,avatar_url}'), '') as avatar_url,
        1 as source_priority
      from dashboard_sessions
      where session_json #>> '{user,id}' ~ '^[1-9][0-9]*$'

      union all

      select
        github_user_id::text,
        nullif(btrim(github_login), ''),
        null,
        null,
        2
      from user_integrations
      where github_user_id > 0

      union all

      select
        github_user_id::text,
        nullif(btrim(github_login), ''),
        null,
        null,
        3
      from tenant_members
      where github_user_id > 0

      union all

      select
        github_account_id::text,
        nullif(btrim(github_account_login), ''),
        nullif(btrim(github_account_login), ''),
        null,
        4
      from tenants
      where lower(coalesce(github_account_type, '')) = 'user'
        and github_account_id > 0
    )
    select distinct on (provider_user_id)
      provider_user_id,
      provider_login,
      display_name,
      avatar_url
    from raw_candidates
    where provider_user_id ~ '^[1-9][0-9]*$'
    order by
      provider_user_id,
      (provider_login is not null and lower(provider_login) <> 'unknown') desc,
      (display_name is not null) desc,
      source_priority
  `);

  const created = await client.query(`
    with missing as (
      select
        uuid_generate_v4() as user_id,
        candidate.provider_user_id,
        candidate.provider_login,
        candidate.display_name,
        candidate.avatar_url
      from jina_identity_transition_candidates candidate
      where not exists (
        select 1
        from user_identities identity
        where identity.provider = 'github'
          and identity.provider_user_id = candidate.provider_user_id
      )
    ),
    inserted_users as (
      insert into users (id, display_name, avatar_url)
      select user_id, display_name, avatar_url
      from missing
      returning id
    )
    insert into user_identities
      (user_id, provider, provider_user_id, provider_login)
    select
      missing.user_id,
      'github',
      missing.provider_user_id,
      missing.provider_login
    from missing
    join inserted_users on inserted_users.id = missing.user_id
    on conflict (provider, provider_user_id) do nothing
  `);

  // Backfill only missing profile fields. After the API rollout, a live GitHub
  // refresh is more authoritative than an older session discovered here.
  await client.query(`
    update user_identities identity
    set
      provider_login = candidate.provider_login,
      updated_at = now()
    from jina_identity_transition_candidates candidate
    where identity.provider = 'github'
      and identity.provider_user_id = candidate.provider_user_id
      and identity.provider_login is null
      and candidate.provider_login is not null
  `);

  await client.query(`
    update users app_user
    set
      display_name = coalesce(app_user.display_name, candidate.display_name),
      avatar_url = coalesce(app_user.avatar_url, candidate.avatar_url),
      updated_at = now()
    from user_identities identity
    join jina_identity_transition_candidates candidate
      on candidate.provider_user_id = identity.provider_user_id
    where identity.provider = 'github'
      and identity.user_id = app_user.id
      and (
        (app_user.display_name is null and candidate.display_name is not null)
        or (app_user.avatar_url is null and candidate.avatar_url is not null)
      )
  `);

  const memberships = await client.query(`
    update tenant_members member
    set user_id = identity.user_id
    from user_identities identity
    where identity.provider = 'github'
      and identity.provider_user_id = member.github_user_id::text
      and member.user_id is distinct from identity.user_id
  `);

  const integrations = await client.query(`
    update user_integrations integration
    set user_id = identity.user_id
    from user_identities identity
    where identity.provider = 'github'
      and identity.provider_user_id = integration.github_user_id::text
      and integration.user_id is distinct from identity.user_id
  `);

  const sessions = await client.query(`
    update dashboard_sessions session
    set user_id = identity.user_id
    from user_identities identity
    where identity.provider = 'github'
      and session.session_json #>> '{user,id}' = identity.provider_user_id
      and session.user_id is distinct from identity.user_id
  `);

  const tenants = await client.query(`
    update tenants tenant
    set
      kind = coalesce(tenant.kind, case
        when lower(coalesce(tenant.github_account_type, '')) = 'user' then 'personal'
        else 'team'
      end),
      name = coalesce(tenant.name, nullif(btrim(tenant.github_account_login), '')),
      personal_owner_user_id = case
        when coalesce(
          tenant.kind,
          case when lower(coalesce(tenant.github_account_type, '')) = 'user' then 'personal' else 'team' end
        ) = 'personal'
          then identity.user_id
        else tenant.personal_owner_user_id
      end
    from user_identities identity
    where identity.provider = 'github'
      and identity.provider_user_id = tenant.github_account_id::text
      and (
        tenant.kind is null
        or tenant.name is distinct from coalesce(tenant.name, nullif(btrim(tenant.github_account_login), ''))
        or tenant.personal_owner_user_id is distinct from case
          when coalesce(
            tenant.kind,
            case when lower(coalesce(tenant.github_account_type, '')) = 'user' then 'personal' else 'team' end
          ) = 'personal'
            then identity.user_id
          else tenant.personal_owner_user_id
        end
      )
  `);

  const teamTenants = await client.query(`
    update tenants tenant
    set
      kind = coalesce(tenant.kind, 'team'),
      name = coalesce(tenant.name, nullif(btrim(tenant.github_account_login), ''))
    where lower(coalesce(tenant.github_account_type, '')) <> 'user'
      and (
        tenant.kind is null
        or tenant.name is distinct from coalesce(tenant.name, nullif(btrim(tenant.github_account_login), ''))
      )
  `);

  const installations = await client.query(`
    update installations installation
    set
      github_account_id = coalesce(installation.github_account_id, tenant.github_account_id),
      github_account_login = coalesce(installation.github_account_login, tenant.github_account_login),
      github_account_type = coalesce(installation.github_account_type, tenant.github_account_type)
    from tenants tenant
    where tenant.id = installation.tenant_id
      and (
        installation.github_account_id is null
        or installation.github_account_login is null
        or installation.github_account_type is null
      )
  `);

  // A signed GitHub App installation webhook records the installer as an
  // admin membership. Preserve that proof on the installation itself so a
  // later setup callback still works when the organization restricts OAuth
  // Apps and GitHub hides /user/memberships/orgs from our OAuth token.
  const installationInstallers = await client.query(`
    update installations installation
    set
      installed_by_github_user_id = (
        select min(member.github_user_id)
        from tenant_members member
        where member.tenant_id = installation.tenant_id
          and member.source = 'installer'
          and member.role = 'admin'
        having count(*) = 1
      ),
      installer_verified_at = now()
    where installation.installed_by_github_user_id is null
      and 1 = (
        select count(*)
        from tenant_members member
        where member.tenant_id = installation.tenant_id
          and member.source = 'installer'
          and member.role = 'admin'
      )
  `);

  // Catch repositories written by an older API revision after migration 0026.
  // Resolve by owner metadata only when exactly one installation matches.
  // Multiple installations for the same GitHub account are valid, so choosing
  // the newest one would silently attach a repository to the wrong connection.
  // The single-installation fallback is likewise used only when unambiguous.
  const repositoriesByOwner = await client.query(`
    update repositories repository
    set installation_id = (
      select min(installation.id::text)::uuid
      from installations installation
      where installation.tenant_id = repository.tenant_id
        and lower(coalesce(installation.github_account_login, '')) = lower(repository.owner)
      having count(*) = 1
    )
    where repository.installation_id is null
      and 1 = (
        select count(*)
        from installations installation
        where installation.tenant_id = repository.tenant_id
          and lower(coalesce(installation.github_account_login, '')) = lower(repository.owner)
      )
  `);
  const repositoriesBySingleInstallation = await client.query(`
    update repositories repository
    set installation_id = (
      select min(installation.id::text)::uuid
      from installations installation
      where installation.tenant_id = repository.tenant_id
      having count(*) = 1
    )
    where repository.installation_id is null
      and 1 = (
        select count(*)
        from installations installation
        where installation.tenant_id = repository.tenant_id
      )
  `);

  const summary = await client.query<{
    candidates: number;
    unmapped_memberships: number;
    unmapped_integrations: number;
    unmapped_sessions: number;
    unmapped_repositories: number;
  }>(`
    select
      (select count(*)::integer from jina_identity_transition_candidates) as candidates,
      (select count(*)::integer from tenant_members where user_id is null) as unmapped_memberships,
      (select count(*)::integer from user_integrations where user_id is null) as unmapped_integrations,
      (
        select count(*)::integer
        from dashboard_sessions
        where user_id is null
          and session_json #>> '{user,id}' ~ '^[1-9][0-9]*$'
      ) as unmapped_sessions,
      (
        select count(*)::integer
        from repositories repository
        where repository.enabled = true
          and not exists (
            select 1
            from installations installation
            where installation.id = repository.installation_id
              and installation.tenant_id = repository.tenant_id
          )
      ) as unmapped_repositories
  `);
  const counts = summary.rows[0]!;
  const unmappedIdentities =
    counts.unmapped_memberships
    + counts.unmapped_integrations
    + counts.unmapped_sessions;

  return {
    candidates: counts.candidates,
    identitiesCreated: created.rowCount ?? 0,
    membershipsBackfilled: memberships.rowCount ?? 0,
    integrationsBackfilled: integrations.rowCount ?? 0,
    sessionsBackfilled: sessions.rowCount ?? 0,
    tenantsClassified: (tenants.rowCount ?? 0) + (teamTenants.rowCount ?? 0),
    installationsBackfilled: installations.rowCount ?? 0,
    installationInstallersBackfilled: installationInstallers.rowCount ?? 0,
    repositoriesBackfilled:
      (repositoriesByOwner.rowCount ?? 0) + (repositoriesBySingleInstallation.rowCount ?? 0),
    unmappedIdentities,
    unmappedMemberships: counts.unmapped_memberships,
    unmappedIntegrations: counts.unmapped_integrations,
    unmappedSessions: counts.unmapped_sessions,
    unmappedRepositories: counts.unmapped_repositories,
  };
}
