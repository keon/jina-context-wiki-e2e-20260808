-- Single-flight billing claims (crash-window double-charge fix).
--
-- Before an Autumn `track`, a usage row / run infra charge is atomically claimed:
-- billing_status moves 'pending' -> 'tracking', the Autumn event id is stamped, and a
-- claimed_at timestamp is recorded. The conditional UPDATE (... where status='pending')
-- is the mutual exclusion: only one caller wins, so concurrent retry drains never both
-- track the same row.
--
-- On track success the row moves 'tracking' -> 'billed'. On a track failure that did NOT
-- charge, the claim is reverted 'tracking' -> 'pending'. A crash AFTER a successful track
-- but BEFORE the 'billed' persist leaves the row stuck 'tracking'; the retry job treats a
-- stale 'tracking' claim (claimed_at older than the grace window, ~10 min) as retryable,
-- re-tracks with the SAME idempotency event id, and logs `possible_duplicate_charge` so ops
-- can reconcile (exactly-once if Autumn honors the key, a flagged duplicate otherwise).
alter table review_llm_usage
    add column if not exists claimed_at timestamptz;

alter table review_run_billing
    add column if not exists infra_claimed_at timestamptz;

-- Retry scan for stale usage claims.
create index if not exists idx_review_llm_usage_tracking
    on review_llm_usage(claimed_at) where billing_status = 'tracking';
