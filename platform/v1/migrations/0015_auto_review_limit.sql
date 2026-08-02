-- Auto-review credit cap (the "capy-style" tenant-owned limit).
--
-- A tenant can cap how many Jina Credits its AUTOMATIC (webhook/scheduled/policy) reviews may consume in
-- a billing cycle. When current-cycle used credits reach the cap, further AUTO-triggered reviews are
-- blocked at the single prepare gate (reason 'auto_review_limit_reached'); MANUAL triggers always bypass
-- the cap. Unlike the platform hard-block exemption (Organization tenants are never hard-blocked on
-- balance), this cap is the tenant's OWN choice, so it applies to Organization tenants too.
--
-- Both columns live on tenant_billing_policy (the fast-iteration, operator/tenant-editable surface). An
-- absent row means the cap is off (enabled defaults false). auto_review_limit_credits is the cap in Jina
-- Credits; null means "no cap set" (the cap is inert unless enabled AND a non-null credits value exists).
alter table tenant_billing_policy
    add column if not exists auto_review_limit_credits integer,
    add column if not exists auto_review_limit_enabled boolean not null default false;

-- The cap is a non-negative credit count when present (null = unset). Mirrors the guardrails added in
-- migration 0009 so an operator/tenant edit can never write a negative cap.
alter table tenant_billing_policy
    add constraint tenant_billing_policy_auto_review_limit_nonneg
        check (auto_review_limit_credits is null or auto_review_limit_credits >= 0);
