-- Keep Clerk's organization directory additive during the identity cutover.
--
-- tenant_members remains the legacy GitHub/installer membership ledger so a
-- rollback to the pre-Clerk application revision never requires reconstructing
-- overwritten provenance. New revisions can authorize against the union while
-- DASHBOARD_AUTH_MODE=hybrid, then against this table alone in Clerk mode.
create table if not exists clerk_tenant_memberships (
    tenant_id uuid not null references tenants(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    clerk_user_id text not null,
    github_user_id bigint not null,
    github_login text not null,
    role text not null check (role in ('admin', 'member')),
    synced_at timestamptz not null default now(),
    primary key (tenant_id, clerk_user_id),
    unique (tenant_id, user_id),
    check (length(btrim(clerk_user_id)) > 0),
    check (length(btrim(github_login)) > 0)
);

create index if not exists idx_clerk_tenant_memberships_user
    on clerk_tenant_memberships (user_id, tenant_id);

create index if not exists idx_clerk_tenant_memberships_clerk_user
    on clerk_tenant_memberships (clerk_user_id);
