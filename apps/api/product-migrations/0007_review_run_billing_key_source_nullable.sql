-- Phase 2C (Autumn billing service).
-- review_run_billing.rate_mode is fixed at DISPATCH/PREPARE time (spec "Decided": rate mode is
-- pinned generously when the run is enqueued). At that point the run's authoritative key_source
-- ('user' vs 'managed') is not yet known — it is recorded per usage row from the key actually
-- loaded into the sandbox, which happens later. To let prepareReview insert the review_run_billing
-- row with rate_mode up front, key_source must be nullable (it is filled in best-effort at prepare
-- and finalized at settlement). This is the approved Phase 2C deviation from migration 0006.
alter table review_run_billing
    alter column key_source drop not null;
