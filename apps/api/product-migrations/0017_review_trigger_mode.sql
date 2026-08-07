-- Per-tenant review-trigger mode: lets a team choose when Jina reviews a PR.
--   'every_commit'  -> review on PR open AND every subsequent push (synchronize)  [default, current behavior]
--   'first_commit'  -> review on PR open / reopen / ready-for-review only; later pushes do NOT re-trigger
--   'manual_only'   -> review only after an authorized @usejina pull-request comment
-- Stored on the existing per-tenant settings row (tenant_model_settings) that already backs the Models
-- page. NULL means the default 'every_commit', so existing tenants are unchanged. The webhook reads this
-- (installations -> tenants -> tenant_model_settings) to decide whether automatic PR events trigger.
alter table tenant_model_settings
    add column if not exists review_trigger_mode text;
