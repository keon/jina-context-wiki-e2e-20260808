-- Tenant membership + tenant-scoped integrations (feature/tenant-membership).
--
-- Retires the documented identity hack (user_integrations.github_user_id =
-- tenants.github_account_id) that made OpenRouter keys and model settings work for
-- PERSONAL accounts only. Org tenants become first-class: membership is persisted
-- (synced from the viewer's own OAuth token at login) and OpenRouter keys move to a
-- TENANT-scoped table so org keys are admin-managed and personal tenants are unchanged
-- in effect. The Codex harness stays INDIVIDUAL (user_integrations, author-scoped).

-- Who may administer / read a tenant. Synced from the viewer's GitHub org memberships
-- at login (GET /user/memberships/orgs?state=active) plus an 'admin' self-membership on
-- their own personal tenant. role is 'admin' (org owner/admin, or personal-tenant owner)
-- or 'member'. synced_at supports staleness auditing; sync failures leave stale rows in
-- place (stale membership beats a broken login).
create table if not exists tenant_members (
    tenant_id uuid not null references tenants(id) on delete cascade,
    github_user_id bigint not null,
    github_login text,
    role text not null,             -- 'admin' | 'member'
    synced_at timestamptz not null default now(),
    primary key (tenant_id, github_user_id)
);

-- Reverse lookup: all tenants a given viewer belongs to (listViewerTenants) and the
-- stale-delete sweep during membership sync both scan by github_user_id.
create index if not exists idx_tenant_members_user on tenant_members(github_user_id);

-- Tenant-scoped OpenRouter credentials. Replaces the per-user openrouter_* columns on
-- user_integrations (dropped in 0013 after this code deploys). openrouter_api_key is
-- encrypted at rest as an AES-256-GCM envelope keyed by SECRETS_ENCRYPTION_KEY (see
-- api/src/crypto.ts), exactly as the user_integrations column was. The API only ever
-- returns configured state, source, label, and last four characters. configured_by_*
-- records the admin who last connected the key.
create table if not exists tenant_integrations (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    openrouter_api_key text,
    openrouter_key_source text,     -- 'oauth' | 'manual'
    openrouter_key_label text,
    openrouter_connected_at timestamptz,
    configured_by_user_id bigint,
    configured_by_login text,
    updated_at timestamptz not null default now()
);

-- One-time data migration: copy every existing user_integrations OpenRouter key into the
-- tenant that the legacy personal-account identity join resolved it against
-- (tenants.github_account_id = user_integrations.github_user_id). Org tenants had no way
-- to store a key under the old model, so only personal-account keys exist to copy. The
-- configured_by_* fields are stamped from the source row's owner. Idempotent on re-run
-- (on conflict do nothing keeps a hand-set tenant key from being clobbered).
insert into tenant_integrations
    (tenant_id, openrouter_api_key, openrouter_key_source, openrouter_key_label,
     openrouter_connected_at, configured_by_user_id, configured_by_login, updated_at)
select t.id, ui.openrouter_api_key, ui.openrouter_key_source, ui.openrouter_key_label,
       ui.openrouter_connected_at, ui.github_user_id, ui.github_login, now()
  from user_integrations ui
  join tenants t on t.github_account_id = ui.github_user_id
 where ui.openrouter_api_key is not null
on conflict (tenant_id) do nothing;

-- Feature (c): the Codex harness stays individual, but a user may now pin which harness
-- model their own-harness reviews use. null = the Codex default lineup. Validated against
-- HARNESS_MODELS in api/src/codex-harness.ts on save.
alter table user_integrations
    add column if not exists codex_harness_model text;
