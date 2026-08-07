-- GitHub does not automatically redeliver failed webhook deliveries. This
-- table is therefore the authoritative encrypted ingress boundary: a 2xx
-- response is allowed only after the raw delivery commits here.

create table github_webhook_inbox_control (
    singleton boolean primary key default true check (singleton),
    mode text not null default 'capture_only'
        check (mode in ('capture_only', 'canary_only', 'capture_and_process', 'legacy_forward')),
    generation bigint not null default 1 check (generation > 0),
    first_v2_workflow_id text references jina_runtime.board_workflows(id) on delete restrict,
    first_v2_at timestamptz,
    updated_at timestamptz not null default now(),
    updated_by text not null default 'migration',
    check ((first_v2_workflow_id is null) = (first_v2_at is null)),
    check (mode <> 'legacy_forward' or first_v2_workflow_id is null)
);

insert into github_webhook_inbox_control (
    singleton,
    mode,
    generation,
    first_v2_workflow_id,
    first_v2_at,
    updated_by
)
select
    true,
    'capture_only',
    1,
    workflow.id,
    workflow.created_at,
    case when workflow.id is null then 'migration' else 'migration-existing-v2' end
from (values (true)) seed(singleton)
left join lateral (
    select id, created_at
    from jina_runtime.board_workflows
    where workflow_type = 'pr_review'
      and pipeline_version = 'pr_review.board.v2'
    order by created_at, id
    limit 1
) workflow on true
on conflict (singleton) do nothing;

create table github_webhook_inbox (
    github_delivery_id text primary key
        check (length(github_delivery_id) between 1 and 128),
    github_event text not null
        check (length(github_event) between 1 and 128),
    action text,
    installation_id bigint,
    repository_id bigint,
    repository_full_name text,
    pull_request_number bigint,
    received_at timestamptz not null default now(),
    payload_sha256 char(64) not null
        check (payload_sha256 ~ '^[0-9a-f]{64}$'),
    payload_ciphertext bytea not null,
    encryption_key_version text not null
        check (encryption_key_version ~ '^[1-9][0-9]*$'),
    status text not null default 'pending'
        check (status in ('pending', 'leased', 'completed', 'retry_wait', 'dead_letter')),
    available_at timestamptz not null default now(),
    lease_id uuid,
    lease_expires_at timestamptz,
    lease_generation bigint,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    processed_workflow_id text,
    last_error_code text,
    last_error_at timestamptz,
    completed_at timestamptz,
    check (installation_id is null or installation_id > 0),
    check (repository_id is null or repository_id > 0),
    check (pull_request_number is null or pull_request_number > 0),
    check (repository_full_name is null or repository_full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
    check (
        (status = 'leased' and lease_id is not null and lease_expires_at is not null and lease_generation is not null)
        or
        (status <> 'leased' and lease_id is null and lease_expires_at is null and lease_generation is null)
    ),
    check (
        (status in ('completed', 'dead_letter') and completed_at is not null)
        or
        (status not in ('completed', 'dead_letter') and completed_at is null)
    )
);

create index idx_github_webhook_inbox_ready
    on github_webhook_inbox (status, available_at, received_at, github_delivery_id)
    where status in ('pending', 'retry_wait', 'leased');

create index idx_github_webhook_inbox_repository_pr_order
    on github_webhook_inbox (
        installation_id,
        repository_id,
        pull_request_number,
        received_at,
        github_delivery_id
    );

create index idx_github_webhook_inbox_lease_generation
    on github_webhook_inbox (lease_generation, lease_expires_at)
    where status = 'leased';

-- Recovery-only GitHub redelivery requests are fenced by delivery GUID and a
-- cooldown. This table stores provider identifiers and status codes only; it
-- never stores a webhook signature or payload.
create table github_webhook_redelivery_requests (
    github_delivery_id text primary key
        check (length(github_delivery_id) between 1 and 128),
    provider_delivery_id bigint not null check (provider_delivery_id > 0),
    attempt_count integer not null default 1 check (attempt_count > 0),
    last_requested_at timestamptz not null default now(),
    last_http_status integer check (last_http_status between 100 and 599),
    last_result_at timestamptz
);

create index idx_github_webhook_redelivery_requested_at
    on github_webhook_redelivery_requests (last_requested_at);

create or replace function protect_github_webhook_inbox_identity()
returns trigger
language plpgsql
as $function$
begin
    if new.github_delivery_id <> old.github_delivery_id
       or new.github_event <> old.github_event
       or new.payload_sha256 <> old.payload_sha256
       or new.payload_ciphertext <> old.payload_ciphertext
       or new.encryption_key_version <> old.encryption_key_version
       or new.received_at <> old.received_at then
        raise exception 'GitHub webhook inbox delivery identity is immutable';
    end if;
    if old.processed_workflow_id is not null
       and new.processed_workflow_id is distinct from old.processed_workflow_id then
        raise exception 'GitHub webhook inbox workflow identity is immutable';
    end if;
    return new;
end
$function$;

drop trigger if exists github_webhook_inbox_identity_immutable on github_webhook_inbox;
create trigger github_webhook_inbox_identity_immutable
before update on github_webhook_inbox
for each row execute function protect_github_webhook_inbox_identity();
