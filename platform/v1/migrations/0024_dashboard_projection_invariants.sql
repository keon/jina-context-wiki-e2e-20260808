-- Keep bounded dashboard projections complete across rolling deployments.
--
-- Migration 0023 adds and backfills the projection columns before the new API
-- deploys. During that migration-to-cutover window, however, the old API still
-- writes only the canonical JSON columns. These database projection functions
-- and triggers make the derived-column invariant writer-independent:
--
-- - the API remains the primary projection owner and writes the compact value;
-- - old or alternate writers receive the same bounded fallback in the database;
-- - a source change that leaves its projection untouched is repaired atomically;
-- - constraints prevent relevant canonical records from committing without a
--   list-safe projection.

create or replace function jina_dashboard_bounded_text(value jsonb, max_length integer default 500)
returns text
language sql
immutable
parallel safe
as $function$
  select case
    when jsonb_typeof(value) = 'string'
      then nullif(left(btrim(value #>> '{}'), max_length), '')
  end
$function$;

create or replace function jina_dashboard_number(value jsonb)
returns jsonb
language sql
immutable
parallel safe
as $function$
  select case when jsonb_typeof(value) = 'number' then value end
$function$;

create or replace function jina_dashboard_boolean(value jsonb)
returns jsonb
language sql
immutable
parallel safe
as $function$
  select case when jsonb_typeof(value) = 'boolean' then value end
$function$;

create or replace function jina_dashboard_review_result_projection(source jsonb)
returns jsonb
language sql
immutable
parallel safe
as $function$
  select case
    when source is null or jsonb_typeof(source) <> 'object' then null
    else jsonb_strip_nulls(jsonb_build_object(
      'status', jina_dashboard_bounded_text(source->'status'),
      'github_comment_url', jina_dashboard_bounded_text(source->'github_comment_url', 2048),
      'github_check_run_url', jina_dashboard_bounded_text(source->'github_check_run_url', 2048),
      'review_gate', case
        when jsonb_typeof(source->'review_gate') = 'object' then
          jsonb_strip_nulls(jsonb_build_object(
            'blocking_level', jina_dashboard_bounded_text(source#>'{review_gate,blocking_level}'),
            'conclusion', jina_dashboard_bounded_text(source#>'{review_gate,conclusion}'),
            'blocking', jina_dashboard_boolean(source#>'{review_gate,blocking}'),
            'blocking_count', jina_dashboard_number(source#>'{review_gate,blocking_count}'),
            'scenario_counts', case
              when jsonb_typeof(source#>'{review_gate,scenario_counts}') = 'object' then
                nullif(jsonb_strip_nulls(jsonb_build_object(
                  'total', jina_dashboard_number(source#>'{review_gate,scenario_counts,total}'),
                  'high', jina_dashboard_number(source#>'{review_gate,scenario_counts,high}'),
                  'medium', jina_dashboard_number(source#>'{review_gate,scenario_counts,medium}'),
                  'low', jina_dashboard_number(source#>'{review_gate,scenario_counts,low}'),
                  'unknown', jina_dashboard_number(source#>'{review_gate,scenario_counts,unknown}')
                )), '{}'::jsonb)
            end
          ))
      end,
      'publish_error', jina_dashboard_bounded_text(source->'publish_error'),
      'simulation_error', jina_dashboard_bounded_text(source->'simulation_error'),
      'final_review_error', jina_dashboard_bounded_text(source->'final_review_error'),
      'error', jina_dashboard_bounded_text(source->'error'),
      'simulation', case
        when jsonb_typeof(source->'simulation') = 'object' then
          jsonb_strip_nulls(jsonb_build_object(
            'status', jina_dashboard_bounded_text(source#>'{simulation,status}'),
            'duration_ms', jina_dashboard_number(source#>'{simulation,duration_ms}'),
            'counts', case
              when jsonb_typeof(source#>'{simulation,counts}') = 'object' then
                nullif(jsonb_strip_nulls(jsonb_build_object(
                  'total', jina_dashboard_number(source#>'{simulation,counts,total}'),
                  'pass', jina_dashboard_number(source#>'{simulation,counts,pass}'),
                  'fail', jina_dashboard_number(source#>'{simulation,counts,fail}'),
                  'warn', jina_dashboard_number(source#>'{simulation,counts,warn}')
                )), '{}'::jsonb)
            end,
            'scenarios', '[]'::jsonb,
            'error', jina_dashboard_bounded_text(source#>'{simulation,error}')
          ))
      end,
      'final_review', case
        when jsonb_typeof(source->'final_review') = 'object' then
          jsonb_strip_nulls(jsonb_build_object(
            'status', jina_dashboard_bounded_text(source#>'{final_review,status}'),
            'summary', jina_dashboard_bounded_text(source#>'{final_review,summary}'),
            'findings', '[]'::jsonb
          ))
      end
    ))
  end
$function$;

create or replace function jina_dashboard_event_payload_projection(event_status text, source jsonb)
returns jsonb
language sql
immutable
parallel safe
as $function$
  select case
    when source is null or jsonb_typeof(source) <> 'object' then null
    when event_status = 'runtime_review_completed' then
      jsonb_strip_nulls(jsonb_build_object(
        'status', jina_dashboard_bounded_text(source->'status'),
        'summary', jina_dashboard_bounded_text(source->'summary'),
        'findings_count', jina_dashboard_number(source->'findings_count'),
        'comments_count', jina_dashboard_number(source->'comments_count'),
        'publishable_findings_count', jina_dashboard_number(source->'publishable_findings_count'),
        'inline_comment_count', jina_dashboard_number(source->'inline_comment_count'),
        'file_comment_count', jina_dashboard_number(source->'file_comment_count'),
        'unanchored_findings_count', jina_dashboard_number(source->'unanchored_findings_count'),
        'low_confidence_findings_held_back', jina_dashboard_number(source->'low_confidence_findings_held_back'),
        'areas_count', jina_dashboard_number(source->'areas_count'),
        'tasks_count', jina_dashboard_number(source->'tasks_count'),
        'blocked_count', jina_dashboard_number(source->'blocked_count'),
        'error', jina_dashboard_bounded_text(source->'error')
      ))
    when event_status in (
      'github_runtime_review_published',
      'github_runtime_review_publish_skipped',
      'github_runtime_review_publish_failed'
    ) then
      jsonb_strip_nulls(jsonb_build_object(
        'publication_status', jina_dashboard_bounded_text(source->'publication_status'),
        'reason', jina_dashboard_bounded_text(source->'reason'),
        'error', jina_dashboard_bounded_text(source->'error'),
        'github_review_url', jina_dashboard_bounded_text(source->'github_review_url', 2048),
        'publishable_findings_count', jina_dashboard_number(source->'publishable_findings_count'),
        'inline_comment_count', jina_dashboard_number(source->'inline_comment_count'),
        'file_comment_count', jina_dashboard_number(source->'file_comment_count')
      ))
  end
$function$;

create or replace function jina_dashboard_project_review_run()
returns trigger
language plpgsql
as $function$
begin
  if new.result_json is null then
    new.dashboard_result_json := null;
  elsif new.dashboard_result_json is null
     or (
       tg_op = 'UPDATE'
       and new.result_json is distinct from old.result_json
       and new.dashboard_result_json is not distinct from old.dashboard_result_json
     ) then
    new.dashboard_result_json := jina_dashboard_review_result_projection(new.result_json);
  end if;
  return new;
end
$function$;

create or replace function jina_dashboard_project_review_event()
returns trigger
language plpgsql
as $function$
begin
  if new.dashboard_payload_json is null
     or (
       tg_op = 'UPDATE'
       and (new.status, new.payload_json) is distinct from (old.status, old.payload_json)
       and new.dashboard_payload_json is not distinct from old.dashboard_payload_json
     ) then
    new.dashboard_payload_json := jina_dashboard_event_payload_projection(new.status, new.payload_json);
  end if;
  return new;
end
$function$;

drop trigger if exists review_runs_dashboard_projection on review_runs;
create trigger review_runs_dashboard_projection
before insert or update of result_json, dashboard_result_json on review_runs
for each row execute function jina_dashboard_project_review_run();

drop trigger if exists review_run_events_dashboard_projection on review_run_events;
create trigger review_run_events_dashboard_projection
before insert or update of status, payload_json, dashboard_payload_json on review_run_events
for each row execute function jina_dashboard_project_review_event();

-- Close any rows written by the old API after migration 0023's one-time
-- backfill and before this invariant became active.
update review_runs
set dashboard_result_json = jina_dashboard_review_result_projection(result_json)
where result_json is not null
  and jsonb_typeof(result_json) = 'object'
  and dashboard_result_json is null;

update review_run_events
set dashboard_payload_json = jina_dashboard_event_payload_projection(status, payload_json)
where dashboard_payload_json is null
  and jsonb_typeof(payload_json) = 'object'
  and status in (
    'runtime_review_completed',
    'github_runtime_review_published',
    'github_runtime_review_publish_skipped',
    'github_runtime_review_publish_failed'
  );

do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'review_runs'::regclass
      and conname = 'review_runs_dashboard_projection_present'
  ) then
    alter table review_runs
      add constraint review_runs_dashboard_projection_present
      check (
        result_json is null
        or jsonb_typeof(result_json) <> 'object'
        or dashboard_result_json is not null
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'review_run_events'::regclass
      and conname = 'review_run_events_dashboard_projection_present'
  ) then
    alter table review_run_events
      add constraint review_run_events_dashboard_projection_present
      check (
        status not in (
          'runtime_review_completed',
          'github_runtime_review_published',
          'github_runtime_review_publish_skipped',
          'github_runtime_review_publish_failed'
        )
        or jsonb_typeof(payload_json) <> 'object'
        or dashboard_payload_json is not null
      ) not valid;
  end if;
end
$constraint$;

alter table review_runs
  validate constraint review_runs_dashboard_projection_present;

alter table review_run_events
  validate constraint review_run_events_dashboard_projection_present;
