-- Add a stable Jina user identity without replacing the existing tenant,
-- membership, session, or GitHub installation tables.
--
-- This migration is intentionally additive for a rolling deployment:
-- old application revisions continue to use GitHub ids, while the transition
-- script backfills the nullable user_id columns for new revisions.

create table if not exists users (
    id uuid primary key default uuid_generate_v4(),
    display_name text,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists user_identities (
    user_id uuid not null references users(id) on delete cascade,
    provider text not null,
    provider_user_id text not null,
    provider_login text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (provider, provider_user_id),
    unique (user_id, provider),
    check (length(btrim(provider)) > 0),
    check (length(btrim(provider_user_id)) > 0)
);

alter table tenants
    add column if not exists kind text,
    add column if not exists name text,
    add column if not exists personal_owner_user_id uuid references users(id);

alter table tenants
    alter column github_account_id drop not null,
    alter column github_account_login drop not null,
    alter column github_account_type drop not null;

alter table tenants
    drop constraint if exists tenants_kind_valid;

alter table tenants
    add constraint tenants_kind_valid
    check (kind is null or kind in ('personal', 'team'));

create unique index if not exists idx_tenants_personal_owner
    on tenants (personal_owner_user_id)
    where kind = 'personal' and personal_owner_user_id is not null;

alter table tenant_members
    add column if not exists user_id uuid references users(id) on delete cascade;

create unique index if not exists idx_tenant_members_internal_user
    on tenant_members (tenant_id, user_id)
    where user_id is not null;

create index if not exists idx_tenant_members_internal_user_reverse
    on tenant_members (user_id)
    where user_id is not null;

alter table dashboard_sessions
    add column if not exists user_id uuid references users(id) on delete cascade;

create index if not exists idx_dashboard_sessions_user
    on dashboard_sessions (user_id)
    where user_id is not null;

alter table user_integrations
    add column if not exists user_id uuid references users(id) on delete cascade;

create unique index if not exists idx_user_integrations_internal_user
    on user_integrations (user_id)
    where user_id is not null;

alter table installations
    add column if not exists github_account_id bigint,
    add column if not exists github_account_login text,
    add column if not exists github_account_type text;

create index if not exists idx_installations_github_account
    on installations (github_account_id)
    where github_account_id is not null;
