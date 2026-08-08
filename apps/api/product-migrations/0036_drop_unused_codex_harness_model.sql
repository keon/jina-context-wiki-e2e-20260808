-- Review execution has always selected its Codex model from the per-stage tenant settings. The old
-- per-user harness pin was persisted and returned but never consumed by either review worker.
alter table public.user_integrations
  drop column if exists codex_harness_model;
