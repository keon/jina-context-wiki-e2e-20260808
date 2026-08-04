-- Bounded dashboard projections for review list reads.
--
-- Full result/event JSON remains the audit/detail source of truth. The dashboard
-- list reads only these compact columns so a list request never detoasts or
-- serializes multi-megabyte runtime-review artifacts.

alter table review_runs
    add column if not exists dashboard_result_json jsonb;

alter table review_run_events
    add column if not exists dashboard_payload_json jsonb;

-- One-time compatibility backfill for historical runs. Future writes populate
-- the projection in the API at the same time as the source-of-truth column.
update review_runs r
set dashboard_result_json = jsonb_strip_nulls(jsonb_build_object(
    'status', r.result_json->'status',
    'github_comment_url', nullif(left(r.result_json->>'github_comment_url', 2048), ''),
    'github_check_run_url', nullif(left(r.result_json->>'github_check_run_url', 2048), ''),
    'review_gate', case
      when jsonb_typeof(r.result_json->'review_gate') = 'object' then
        jsonb_strip_nulls(jsonb_build_object(
          'blocking_level', r.result_json#>'{review_gate,blocking_level}',
          'conclusion', r.result_json#>'{review_gate,conclusion}',
          'blocking', r.result_json#>'{review_gate,blocking}',
          'blocking_count', r.result_json#>'{review_gate,blocking_count}',
          'scenario_counts', case
            when jsonb_typeof(r.result_json#>'{review_gate,scenario_counts}') = 'object' then
              jsonb_strip_nulls(jsonb_build_object(
                'total', r.result_json#>'{review_gate,scenario_counts,total}',
                'high', r.result_json#>'{review_gate,scenario_counts,high}',
                'medium', r.result_json#>'{review_gate,scenario_counts,medium}',
                'low', r.result_json#>'{review_gate,scenario_counts,low}',
                'unknown', r.result_json#>'{review_gate,scenario_counts,unknown}'
              ))
          end
        ))
    end,
    'publish_error', nullif(left(r.result_json->>'publish_error', 500), ''),
    'simulation_error', nullif(left(r.result_json->>'simulation_error', 500), ''),
    'final_review_error', nullif(left(r.result_json->>'final_review_error', 500), ''),
    'error', nullif(left(r.result_json->>'error', 500), ''),
    'simulation', case
      when jsonb_typeof(r.result_json->'simulation') = 'object' then
        jsonb_strip_nulls(jsonb_build_object(
          'status', r.result_json#>'{simulation,status}',
          'duration_ms', r.result_json#>'{simulation,duration_ms}',
          'counts', case
            when jsonb_typeof(r.result_json#>'{simulation,counts}') = 'object' then
              jsonb_strip_nulls(jsonb_build_object(
                'total', r.result_json#>'{simulation,counts,total}',
                'pass', r.result_json#>'{simulation,counts,pass}',
                'fail', r.result_json#>'{simulation,counts,fail}',
                'warn', r.result_json#>'{simulation,counts,warn}'
              ))
          end,
          'scenarios', '[]'::jsonb,
          'error', nullif(left(r.result_json#>>'{simulation,error}', 500), '')
        ))
    end,
    'final_review', case
      when jsonb_typeof(r.result_json->'final_review') = 'object' then
        jsonb_strip_nulls(jsonb_build_object(
          'status', r.result_json#>'{final_review,status}',
          'summary', nullif(left(r.result_json#>>'{final_review,summary}', 500), ''),
          'findings', '[]'::jsonb
        ))
    end
  ))
where r.result_json is not null
  and r.dashboard_result_json is null;

-- Preserve only fields consumed by list presentation. Rich runtime work,
-- findings, tasks, areas, comments, and markdown stay in payload_json and are
-- fetched by the existing review detail route.
update review_run_events e
set dashboard_payload_json = case
  when e.status = 'runtime_review_completed' then
    jsonb_strip_nulls(jsonb_build_object(
      'status', e.payload_json->'status',
      'summary', nullif(left(e.payload_json->>'summary', 500), ''),
      'findings_count', e.payload_json->'findings_count',
      'comments_count', e.payload_json->'comments_count',
      'publishable_findings_count', e.payload_json->'publishable_findings_count',
      'inline_comment_count', e.payload_json->'inline_comment_count',
      'file_comment_count', e.payload_json->'file_comment_count',
      'unanchored_findings_count', e.payload_json->'unanchored_findings_count',
      'low_confidence_findings_held_back', e.payload_json->'low_confidence_findings_held_back',
      'areas_count', e.payload_json->'areas_count',
      'tasks_count', e.payload_json->'tasks_count',
      'blocked_count', e.payload_json->'blocked_count',
      'error', nullif(left(e.payload_json->>'error', 500), '')
    ))
  when e.status in (
    'github_runtime_review_published',
    'github_runtime_review_publish_skipped',
    'github_runtime_review_publish_failed'
  ) then
    jsonb_strip_nulls(jsonb_build_object(
      'publication_status', e.payload_json->'publication_status',
      'reason', nullif(left(e.payload_json->>'reason', 500), ''),
      'error', nullif(left(e.payload_json->>'error', 500), ''),
      'github_review_url', nullif(left(e.payload_json->>'github_review_url', 2048), ''),
      'publishable_findings_count', e.payload_json->'publishable_findings_count',
      'inline_comment_count', e.payload_json->'inline_comment_count',
      'file_comment_count', e.payload_json->'file_comment_count'
    ))
  else null
end
where e.dashboard_payload_json is null
  and e.status in (
    'runtime_review_completed',
    'github_runtime_review_published',
    'github_runtime_review_publish_skipped',
    'github_runtime_review_publish_failed'
  );
