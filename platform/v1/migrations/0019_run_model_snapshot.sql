-- Snapshot the per-stage model settings onto the run at PREPARE time, so run-time key resolution and
-- billing classify coverage from the SAME model set the worker actually runs — not from live
-- tenant_model_settings, which an admin can edit mid-run (routing/billing would then disagree with the
-- prepared payload). Nullable + additive: runs prepared by an older API have no snapshot and fall back
-- to the live settings (previous behavior).
alter table review_runs add column if not exists model_settings_snapshot jsonb;

-- Reset legacy explicit-key routing values to automatic. The dashboard stopped emitting
-- 'openai'/'openrouter' when the router collapsed them to 'auto', and normalizeModelProvider has read
-- them AS 'auto' since — so any stored value predates the new forced-key semantics. Re-activating those
-- strings now (the new Routing selector accepts them again) would silently flip such tenants from
-- automatic routing to a forced single key. Null them out; tenants can re-pick a force in the new UI.
update tenant_model_settings set model_provider = null where model_provider in ('openai', 'openrouter');
