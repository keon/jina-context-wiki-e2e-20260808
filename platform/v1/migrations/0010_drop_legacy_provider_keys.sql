-- Remove legacy per-tenant OpenAI/Anthropic provider keys (rollout step 10).
-- OpenRouter is the only model gateway; production had ZERO rows with these
-- columns populated when this was written, and the dashboard/API/runtime no
-- longer read or write them.
--
-- DEPLOY ORDER: run this migration only AFTER the API revision that stops
-- selecting these columns is live — the previous revision's queries reference
-- them and would 500.
alter table user_integrations
    drop column if exists anthropic_api_key,
    drop column if exists openai_api_key;
