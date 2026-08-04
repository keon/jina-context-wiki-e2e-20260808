-- The provider selection collapses to three options + automatic: auto | codex | byok | managed.
-- Legacy single-key forces map onto the BYOK tier (same credentials, same billing class); the code's
-- normalizeModelProvider does the same mapping, this just keeps stored data canonical.
update tenant_model_settings set model_provider = 'byok' where model_provider in ('openai', 'openrouter');
