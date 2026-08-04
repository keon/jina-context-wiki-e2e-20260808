do $board_preflight$
begin
  if to_regclass('jina_runtime.board_workflows') is null then
    raise exception
      'jina_runtime.board_workflows is required before product migration 0030; run migrate:all so runtime migrations execute first';
  end if;
end
$board_preflight$;

alter table review_runs
  add column if not exists orchestrator text not null default 'trigger';

alter table review_runs
  add column if not exists board_workflow_id text;

alter table review_runs
  add column if not exists manual_command_tag text;

alter table review_runs
  add column if not exists review_instructions text;

alter table review_runs
  drop constraint if exists review_runs_orchestrator_check;

alter table review_runs
  add constraint review_runs_orchestrator_check
  check (orchestrator in ('trigger','board'));

alter table review_runs
  drop constraint if exists review_runs_board_binding_check;

alter table review_runs
  add constraint review_runs_board_binding_check
  check (orchestrator <> 'board' or board_workflow_id is not null);

alter table review_runs
  drop constraint if exists review_runs_board_workflow_fk;

alter table review_runs
  add constraint review_runs_board_workflow_fk
  foreign key (board_workflow_id)
  references jina_runtime.board_workflows(id)
  on delete restrict;

create unique index if not exists idx_review_runs_board_workflow
  on review_runs (board_workflow_id)
  where board_workflow_id is not null;

create index if not exists idx_review_runs_manual_scope
  on review_runs (repository_id, pull_request_id, created_at desc, id desc)
  where manual_command_tag is not null;
