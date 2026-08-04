-- BYOK provider keys: let a tenant bring its own native OpenAI and Anthropic (Claude) API keys,
-- alongside the existing openrouter_api_key. All three live on tenant_integrations (tenant-scoped,
-- admin-managed) and are encrypted at rest via the SECRETS_ENCRYPTION_KEY path in api/src/crypto.ts,
-- exactly like openrouter_api_key. There is no key SOURCE column for these (manual entry only, no OAuth),
-- so a boolean-presence + connected_at pair is all the dashboard needs.
--
-- Runtime: a resolved openai_api_key routes openai/* review models NATIVELY to api.openai.com under the
-- tenant's own key (a BYOK "user" run, billed infra-only). anthropic_api_key is stored/surfaced only for
-- now — the Codex runtime speaks OpenAI's API, not Anthropic's, so Claude routing lands when Claude
-- models are supported end-to-end.
alter table tenant_integrations
    add column if not exists openai_api_key text,
    add column if not exists openai_connected_at timestamptz,
    add column if not exists anthropic_api_key text,
    add column if not exists anthropic_connected_at timestamptz;
