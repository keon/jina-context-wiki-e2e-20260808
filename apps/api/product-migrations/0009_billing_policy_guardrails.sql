-- Billing policy guardrails + infra retry indexes (round-3 review).
--
-- FINDING 3: tenant_billing_policy rows are operator-editable and were previously trusted blindly by
-- policyFromRow (api/src/store.ts) — a reviewer drove a NEGATIVE infra credit charge all the way into
-- an Autumn track. policyFromRow now clamps every field, and these CHECK constraints stop the bad
-- value from ever being written: subsidies must be a fraction in [0, 1], per-run credits non-negative.
--
-- Normalize pre-existing operator-edited rows before validation. The constraints are added NOT VALID
-- first so new writes are protected immediately while validation remains an explicit rollout step.
update tenant_billing_policy
set subsidy_rate = 0.3000
where subsidy_rate < 0 or subsidy_rate > 1;

update tenant_billing_policy
set overage_subsidy_rate = 0.3000
where overage_subsidy_rate < 0 or overage_subsidy_rate > 1;

update tenant_billing_policy
set infra_credits_per_run = 0
where infra_credits_per_run < 0;

update tenant_billing_policy
set overage_infra_credits_per_run = 0
where overage_infra_credits_per_run < 0;

alter table tenant_billing_policy
    add constraint tenant_billing_policy_subsidy_rate_range
        check (subsidy_rate >= 0 and subsidy_rate <= 1) not valid;

alter table tenant_billing_policy
    add constraint tenant_billing_policy_overage_subsidy_rate_range
        check (overage_subsidy_rate >= 0 and overage_subsidy_rate <= 1) not valid;

alter table tenant_billing_policy
    add constraint tenant_billing_policy_infra_credits_nonneg
        check (infra_credits_per_run >= 0) not valid;

alter table tenant_billing_policy
    add constraint tenant_billing_policy_overage_infra_credits_nonneg
        check (overage_infra_credits_per_run >= 0) not valid;

alter table tenant_billing_policy validate constraint tenant_billing_policy_subsidy_rate_range;
alter table tenant_billing_policy validate constraint tenant_billing_policy_overage_subsidy_rate_range;
alter table tenant_billing_policy validate constraint tenant_billing_policy_infra_credits_nonneg;
alter table tenant_billing_policy validate constraint tenant_billing_policy_overage_infra_credits_nonneg;

-- Non-blocking note from the reviewer: the infra retry scans in store.ts had no supporting index.
-- listRunsWithPendingInfra filters `infra_billing_status = 'pending'` (then joins review_runs on
-- status); listStaleTrackingInfra filters `infra_billing_status = 'tracking' and infra_claimed_at < $2`.
-- Two partial indexes, one per scan, so each drains without a full table scan. NOTE: the DECISION 1
-- 'shadow_computed' terminal status is deliberately NOT indexed here — the retry drain never selects it.
create index if not exists idx_review_run_billing_infra_pending
    on review_run_billing(infra_billing_status)
    where infra_billing_status = 'pending';

create index if not exists idx_review_run_billing_infra_tracking
    on review_run_billing(infra_claimed_at)
    where infra_billing_status = 'tracking';
