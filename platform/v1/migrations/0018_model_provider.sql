-- Explicit per-tenant model PROVIDER selection, decoupled from per-stage model choice.
--   null / 'auto'  -> current precedence: tenant OpenRouter key > tenant native OpenAI key > managed
--   'managed'      -> always use Jina's managed key (ignore any tenant BYOK key)
--   'openai'       -> use the tenant's native OpenAI key (BYOK); fall back to managed if unset
--   'openrouter'   -> use the tenant's OpenRouter key (BYOK); fall back to managed if unset
-- The author's personal harness is an INDIVIDUAL opt-in and still overrides this for the PRs they author.
-- NULL means 'auto', so every existing tenant keeps today's behavior unchanged.
alter table tenant_model_settings
    add column if not exists model_provider text;
