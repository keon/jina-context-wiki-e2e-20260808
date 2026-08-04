-- Dashboard harness-health checks resolve failed reviews by their PR author.
create index if not exists idx_pull_requests_author_login
    on pull_requests (lower(author_login))
    where author_login is not null;

create index if not exists idx_review_runs_pull_request
    on review_runs (pull_request_id)
    where pull_request_id is not null;
