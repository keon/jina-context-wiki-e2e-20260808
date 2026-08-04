-- Preserve installer proof for GitHub organizations that hide membership from
-- OAuth Apps, and make temporary account-derived tenants safely retireable.
--
-- New columns are nullable and the snapshot table is append-only, so the
-- previous API revision remains compatible throughout a rolling deployment.

alter table installations
    add column if not exists installed_by_github_user_id bigint,
    add column if not exists installer_verified_at timestamptz,
    add column if not exists deleted_at timestamptz;

create index if not exists idx_installations_installed_by_github_user
    on installations (installed_by_github_user_id)
    where installed_by_github_user_id is not null;

alter table tenants
    add column if not exists merged_into_tenant_id uuid references tenants(id);

alter table tenants
    drop constraint if exists tenants_not_merged_into_self;

alter table tenants
    add constraint tenants_not_merged_into_self
    check (merged_into_tenant_id is null or merged_into_tenant_id <> id);

create index if not exists idx_tenants_merged_into
    on tenants (merged_into_tenant_id)
    where merged_into_tenant_id is not null;

-- Snapshot the exact repository set covered by a workspace reassignment.
-- repository_id is intentionally not a foreign key: GitHub may later remove a
-- repository, and rollback must detect that drift rather than block the
-- webhook deletion or silently infer a different set.
create table if not exists installation_tenant_move_repositories (
    move_id uuid not null references installation_tenant_moves(id) on delete cascade,
    repository_id uuid not null,
    github_repo_id bigint not null,
    primary key (move_id, github_repo_id),
    unique (move_id, repository_id)
);
