-- Maps a GitHub pull-request *review* comment (the inline, threaded kind) to the
-- scenario lineage it was posted for. When a user replies to one of these
-- comments, the pull_request_review_comment webhook carries in_reply_to_id; we
-- look that id up here to learn which scenario the reply is about — so a reply
-- can rerun/ask a scenario without an @jina mention or a typed scenario ref.
create table if not exists scenario_review_comments (
  github_comment_id bigint primary key,
  review_run_id uuid not null references review_runs(id) on delete cascade,
  lineage_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists scenario_review_comments_review_run_idx
  on scenario_review_comments (review_run_id);
