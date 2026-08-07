-- A Jina tenant is the workspace and billing boundary. GitHub installations
-- are connections to that workspace, and each repository must retain the
-- exact connection whose token can access it.
--
-- installation_id remains nullable during the rolling deployment so the
-- previous API revision can continue writing repositories. The new revision
-- always supplies it, and the backfill resolves every unambiguous legacy row.

alter table repositories
    add column if not exists installation_id uuid;

-- Prefer the installation whose GitHub account owns the repository. This also
-- handles tenants that accumulated more than one installation after a reinstall.
update repositories repository
set installation_id = (
  select installation.id
  from installations installation
  where installation.tenant_id = repository.tenant_id
    and lower(coalesce(installation.github_account_login, '')) = lower(repository.owner)
  order by
    (installation.suspended_at is null) desc,
    installation.created_at desc
  limit 1
)
where repository.installation_id is null
  and exists (
    select 1
    from installations installation
    where installation.tenant_id = repository.tenant_id
      and lower(coalesce(installation.github_account_login, '')) = lower(repository.owner)
  );

-- Historical installations predate copied account metadata. Resolve those
-- only when the tenant has exactly one installation, so the migration never
-- guesses which credential owns a repository.
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
  );

create index if not exists idx_repositories_installation_id
    on repositories (installation_id)
    where installation_id is not null;

-- PostgreSQL needs a composite unique target for the tenant-consistency
-- foreign key. The primary key still remains the installation identity.
create unique index if not exists idx_installations_id_tenant
    on installations (id, tenant_id);

alter table repositories
    drop constraint if exists repositories_installation_tenant_fk;

alter table repositories
    add constraint repositories_installation_tenant_fk
    foreign key (installation_id, tenant_id)
    references installations (id, tenant_id)
    deferrable initially deferred;

-- Every explicit workspace reassignment is auditable. A rollback tool can use
-- this append-only record without reconstructing prior ownership from logs.
create table if not exists installation_tenant_moves (
    id uuid primary key default uuid_generate_v4(),
    installation_id uuid not null references installations(id),
    github_installation_id bigint not null,
    from_tenant_id uuid not null references tenants(id),
    to_tenant_id uuid not null references tenants(id),
    moved_by_user_id uuid references users(id),
    moved_by_github_user_id bigint,
    created_at timestamptz not null default now(),
    reverted_at timestamptz,
    reverted_by text,
    check (from_tenant_id <> to_tenant_id)
);

create index if not exists idx_installation_tenant_moves_installation
    on installation_tenant_moves (installation_id, created_at desc);
