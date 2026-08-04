-- Drop the per-user OpenRouter columns from user_integrations. OpenRouter keys are now
-- TENANT-scoped (tenant_integrations, populated by 0012); the dashboard/API/runtime no
-- longer read or write these columns.
--
-- DEPLOY ORDER (same discipline as 0010): run this migration only AFTER the API revision
-- that stops selecting these columns is live. The previous revision's queries reference
-- them and would 500. 0012 already copied the key data into tenant_integrations, so this
-- drop loses nothing.
alter table user_integrations
    drop column if exists openrouter_api_key,
    drop column if exists openrouter_key_source,
    drop column if exists openrouter_key_label,
    drop column if exists openrouter_connected_at;
