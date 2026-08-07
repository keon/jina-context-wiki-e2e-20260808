-- Per-user model provider API keys entered on the Integrations page.
-- NOTE: stored as-is for the MVP; encrypt at rest (or use a secret manager)
-- before handling production keys. Keys are never returned to the client in full.
create table if not exists user_integrations (
    github_user_id bigint primary key,
    anthropic_api_key text,
    openai_api_key text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
