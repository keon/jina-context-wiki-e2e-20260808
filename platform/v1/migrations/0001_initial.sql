create extension if not exists "uuid-ossp";

create table tenants (
    id uuid primary key default uuid_generate_v4(),
    github_account_id bigint not null unique,
    github_account_login text not null,
    github_account_type text not null,
    plan text not null default 'free',
    created_at timestamptz not null default now()
);

create table installations (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    github_installation_id bigint not null unique,
    permissions_json jsonb not null default '{}',
    suspended_at timestamptz,
    created_at timestamptz not null default now()
);

create table repositories (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    github_repo_id bigint not null unique,
    owner text not null,
    name text not null,
    default_branch text not null,
    private boolean not null default true,
    enabled boolean not null default true,
    settings_json jsonb not null default '{}',
    created_at timestamptz not null default now()
);

create table bots (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    repository_id uuid references repositories(id) on delete cascade,
    type text not null,
    status text not null default 'active',
    config_json jsonb not null default '{}',
    last_run_at timestamptz,
    last_error text,
    created_at timestamptz not null default now()
);

create table github_events (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid references tenants(id) on delete cascade,
    github_delivery_id text not null unique,
    github_event text not null,
    action text,
    payload_json jsonb not null,
    created_at timestamptz not null default now()
);

create table pull_requests (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    repository_id uuid not null references repositories(id) on delete cascade,
    pr_number bigint not null,
    title text not null,
    author_login text,
    head_sha text not null,
    base_sha text,
    state text not null,
    draft boolean not null default false,
    html_url text,
    updated_at timestamptz,
    created_at timestamptz not null default now(),
    unique (repository_id, pr_number)
);

create table review_runs (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    repository_id uuid not null references repositories(id) on delete cascade,
    pull_request_id uuid references pull_requests(id) on delete set null,
    trigger text not null,
    status text not null,
    idempotency_key text not null unique,
    trigger_run_id text,
    sandbox_id text,
    head_sha text not null,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null default now()
);

create table review_findings (
    id uuid primary key default uuid_generate_v4(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    review_run_id uuid not null references review_runs(id) on delete cascade,
    fingerprint text not null,
    file_path text,
    line_number bigint,
    severity text not null,
    category text not null,
    body text not null,
    github_comment_id bigint,
    created_at timestamptz not null default now(),
    unique (review_run_id, fingerprint)
);

create index idx_repositories_tenant_id on repositories(tenant_id);
create index idx_bots_tenant_id on bots(tenant_id);
create index idx_github_events_tenant_id on github_events(tenant_id);
create index idx_pull_requests_tenant_repo on pull_requests(tenant_id, repository_id);
create index idx_review_runs_tenant_repo on review_runs(tenant_id, repository_id);
create index idx_review_findings_tenant_run on review_findings(tenant_id, review_run_id);
