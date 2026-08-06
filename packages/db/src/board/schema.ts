export const BOARD_RUNTIME_MIGRATION_0001_SQL = `
create table jina_runtime.board_workflows (
  id text primary key,
  tenant_id text not null,
  workflow_type text not null,
  pipeline_version text not null,
  subject_type text not null,
  subject_id text not null,
  dedupe_key text not null,
  concurrency_key text not null,
  status text not null,
  epoch bigint not null default 1 check (epoch > 0),
  trigger_type text not null,
  trace_id char(32) not null check (trace_id ~ '^[0-9a-f]{32}$'),
  admission_traceparent text check (
    admission_traceparent is null or octet_length(admission_traceparent) <= 256
  ),
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 65536),
  unique (tenant_id,dedupe_key),
  unique (tenant_id,id),
  check (status in ('shadow','queued','running','superseding','succeeded','failed','canceled','superseded')),
  check ((status in ('succeeded','failed','canceled','superseded')) = (completed_at is not null))
);

create index board_workflows_tenant_status_updated
  on jina_runtime.board_workflows (tenant_id,status,updated_at desc,id desc);
create index board_workflows_type_status_created
  on jina_runtime.board_workflows (workflow_type,status,created_at,id);
create index board_workflows_subject_epoch
  on jina_runtime.board_workflows (tenant_id,subject_type,subject_id,epoch desc);
create index board_workflows_active
  on jina_runtime.board_workflows (tenant_id,updated_at,id)
  where status in ('queued','running','superseding');

create table jina_runtime.board_tasks (
  id text primary key,
  tenant_id text not null,
  workflow_id text not null,
  parent_task_id text,
  task_type text not null,
  topic text,
  status text not null,
  priority integer not null default 0,
  available_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts > 0),
  current_attempt_id uuid,
  delivery_id text unique,
  delivery_idempotency_key text,
  required boolean not null default true,
  cleanup_task boolean not null default false,
  pipeline_version text not null,
  enqueue_traceparent text check (
    enqueue_traceparent is null or octet_length(enqueue_traceparent) <= 256
  ),
  completion_traceparent text check (
    completion_traceparent is null or octet_length(completion_traceparent) <= 256
  ),
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  result_artifact jsonb check (
    result_artifact is null or octet_length(result_artifact::text) <= 16384
  ),
  result_digest char(64) check (result_digest is null or result_digest ~ '^[0-9a-f]{64}$'),
  usage_digest char(64) check (usage_digest is null or usage_digest ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 65536),
  unique (tenant_id,workflow_id,id),
  foreign key (tenant_id,workflow_id)
    references jina_runtime.board_workflows (tenant_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,parent_task_id)
    references jina_runtime.board_tasks (tenant_id,workflow_id,id) on delete restrict
    deferrable initially deferred,
  check (status in ('blocked','queued','leased','retry_wait','succeeded','failed','canceled','superseded')),
  check ((status in ('queued','retry_wait')) = (available_at is not null)),
  check ((status = 'leased') = (current_attempt_id is not null)),
  check ((status in ('succeeded','failed','canceled','superseded')) = (completed_at is not null)),
  check (attempt_count <= max_attempts)
);

create index board_tasks_ready
  on jina_runtime.board_tasks (topic,priority desc,available_at,created_at,id)
  where status in ('queued','retry_wait');
create index board_tasks_workflow_created
  on jina_runtime.board_tasks (workflow_id,created_at,id);
create index board_tasks_tenant_status_updated
  on jina_runtime.board_tasks (tenant_id,status,updated_at,id);
create index board_tasks_parent
  on jina_runtime.board_tasks (parent_task_id)
  where parent_task_id is not null;

create table jina_runtime.board_dependencies (
  tenant_id text not null,
  workflow_id text not null,
  task_id text not null,
  depends_on_task_id text not null,
  condition text not null,
  required boolean not null default true,
  relationship text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (task_id,depends_on_task_id),
  foreign key (tenant_id,workflow_id)
    references jina_runtime.board_workflows (tenant_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,task_id)
    references jina_runtime.board_tasks (tenant_id,workflow_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,depends_on_task_id)
    references jina_runtime.board_tasks (tenant_id,workflow_id,id) on delete restrict,
  check (task_id <> depends_on_task_id),
  check (condition in ('success','terminal'))
);

create index board_dependencies_dependency
  on jina_runtime.board_dependencies (depends_on_task_id,task_id);
create index board_dependencies_workflow
  on jina_runtime.board_dependencies (workflow_id,task_id);

create table jina_runtime.board_attempts (
  id uuid primary key,
  tenant_id text not null,
  workflow_id text not null,
  task_id text not null,
  delivery_id text not null,
  delivery_idempotency_key text not null,
  attempt_number integer not null check (attempt_number > 0),
  claim_number integer not null check (claim_number > 0),
  worker_id text not null,
  worker_service text not null,
  worker_release text not null,
  worker_revision text not null,
  lease_id uuid not null,
  fence_token_hash bytea not null,
  lease_expires_at timestamptz not null,
  status text not null,
  trace_id char(32) not null check (trace_id ~ '^[0-9a-f]{32}$'),
  span_id char(16) not null check (span_id ~ '^[0-9a-f]{16}$'),
  started_at timestamptz not null default clock_timestamp(),
  last_renewed_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  failure_category text,
  diagnostic text check (diagnostic is null or octet_length(diagnostic) <= 4096),
  usage jsonb check (usage is null or octet_length(usage::text) <= 16384),
  unique (task_id,claim_number),
  unique (delivery_id,claim_number),
  unique (tenant_id,workflow_id,id),
  unique (tenant_id,workflow_id,task_id,id),
  foreign key (tenant_id,workflow_id)
    references jina_runtime.board_workflows (tenant_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,task_id)
    references jina_runtime.board_tasks (tenant_id,workflow_id,id) on delete restrict,
  check (status in ('leased','released','succeeded','failed','expired','fenced')),
  check ((status = 'leased') = (finished_at is null))
);

create unique index board_attempts_one_lease
  on jina_runtime.board_attempts (task_id)
  where status='leased';
create index board_attempts_expiry
  on jina_runtime.board_attempts (lease_expires_at,task_id)
  where status='leased';
create index board_attempts_workflow_started
  on jina_runtime.board_attempts (workflow_id,started_at,id);

alter table jina_runtime.board_tasks
  add constraint board_tasks_current_attempt
  foreign key (tenant_id,workflow_id,id,current_attempt_id)
  references jina_runtime.board_attempts (tenant_id,workflow_id,task_id,id)
  on delete restrict
  deferrable initially immediate;

create table jina_runtime.board_events (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  workflow_id text not null,
  task_id text,
  attempt_id uuid,
  event_type text not null,
  source_event_id text,
  source_event_seq integer check (source_event_seq is null or source_event_seq > 0),
  actor_type text not null,
  actor_id text not null,
  trace_id char(32) not null check (trace_id ~ '^[0-9a-f]{32}$'),
  span_id char(16) check (span_id is null or span_id ~ '^[0-9a-f]{16}$'),
  occurred_at timestamptz not null default clock_timestamp(),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 65536),
  foreign key (tenant_id,workflow_id)
    references jina_runtime.board_workflows (tenant_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,task_id)
    references jina_runtime.board_tasks (tenant_id,workflow_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,attempt_id)
    references jina_runtime.board_attempts (tenant_id,workflow_id,id) on delete restrict
);

create index board_events_workflow_id
  on jina_runtime.board_events (workflow_id,id);
create index board_events_task_id
  on jina_runtime.board_events (task_id,id)
  where task_id is not null;
create index board_events_tenant_occurred
  on jina_runtime.board_events (tenant_id,occurred_at desc,id desc);
create index board_events_type_occurred
  on jina_runtime.board_events (event_type,occurred_at,id);
create unique index board_events_source_identity
  on jina_runtime.board_events (workflow_id,source_event_id)
  where source_event_id is not null;

create table jina_runtime.board_effect_receipts (
  idempotency_key text primary key,
  tenant_id text not null,
  workflow_id text not null,
  task_id text not null,
  attempt_id uuid,
  effect_type text not null,
  effect_version integer not null check (effect_version > 0),
  provider text not null,
  status text not null,
  request_digest text not null,
  provider_id text,
  authority_record_id text,
  result_digest text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  last_error_category text,
  last_error text check (last_error is null or octet_length(last_error) <= 4096),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 16384),
  foreign key (tenant_id,workflow_id)
    references jina_runtime.board_workflows (tenant_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,task_id)
    references jina_runtime.board_tasks (tenant_id,workflow_id,id) on delete restrict,
  foreign key (tenant_id,workflow_id,attempt_id)
    references jina_runtime.board_attempts (tenant_id,workflow_id,id) on delete restrict,
  check (status in ('started','succeeded','failed','ambiguous')),
  check ((status = 'started') = (completed_at is null))
);

create index board_effect_receipts_workflow
  on jina_runtime.board_effect_receipts (workflow_id,started_at,idempotency_key);
create index board_effect_receipts_reconcile
  on jina_runtime.board_effect_receipts (status,updated_at,idempotency_key)
  where status in ('started','failed','ambiguous');
`;

/**
 * Adds a durable, non-leased wait state for Board tasks whose external effect
 * is still running. Migration 0001 is checksummed and must remain byte-stable.
 */
export const BOARD_RUNTIME_MIGRATION_0002_SQL = `
alter table jina_runtime.board_tasks
  drop constraint board_tasks_status_check,
  drop constraint board_tasks_check;

alter table jina_runtime.board_tasks
  add constraint board_tasks_status_check
    check (status in (
      'blocked','queued','leased','retry_wait','waiting_external',
      'succeeded','failed','canceled','superseded'
    )),
  add constraint board_tasks_available_at_check
    check ((status in ('queued','retry_wait','waiting_external')) = (available_at is not null));

drop index jina_runtime.board_tasks_ready;

create index board_tasks_ready
  on jina_runtime.board_tasks (topic,priority desc,available_at,created_at,id)
  where status in ('queued','retry_wait','waiting_external');

create unique index board_effect_receipts_provider_identity
  on jina_runtime.board_effect_receipts (provider,provider_id)
  where provider_id is not null;
`;
