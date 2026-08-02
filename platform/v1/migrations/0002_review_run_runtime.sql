-- Operational columns + events the dashboard needs on top of the base schema.

alter table review_runs
    add column if not exists delivery_id text,
    add column if not exists source_event text,
    add column if not exists bot_type text not null default 'code_review',
    add column if not exists bot_status text not null default 'queued',
    add column if not exists result_json jsonb,
    add column if not exists error text,
    add column if not exists updated_at timestamptz not null default now();

alter table pull_requests
    add column if not exists head_ref text,
    add column if not exists base_ref text;

create table if not exists review_run_events (
    id uuid primary key default uuid_generate_v4(),
    review_run_id uuid not null references review_runs(id) on delete cascade,
    status text not null,
    payload_json jsonb,
    trigger_run_id text,
    recorded_at timestamptz not null default now()
);

create index if not exists idx_review_run_events_run on review_run_events(review_run_id, recorded_at);
