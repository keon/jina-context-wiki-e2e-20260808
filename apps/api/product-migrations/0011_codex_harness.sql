-- Codex harness BYOH: a user connects their ChatGPT-subscription Codex credentials
-- (the content of ~/.codex/auth.json) so reviews for PRs THEY AUTHOR run Codex natively
-- on their own subscription (own-harness: the tenant is billed infra-only).
--
-- codex_harness_auth holds the encrypted auth.json blob (AES-256-GCM envelope via the
-- SECRETS_ENCRYPTION_KEY path in api/src/crypto.ts, same as openrouter_api_key). The API
-- never returns this blob (or any part of it) to the dashboard.
--
-- github_login is stamped from the dashboard session on every save so run-time author-login
-- resolution works: a run resolves the AUTHOR's harness by joining pull_requests.author_login
-- to user_integrations.github_login. It refreshes whenever the user saves an integration
-- (acceptable staleness on GitHub login renames — the next save re-stamps the current login).
alter table user_integrations
    add column if not exists github_login text,
    add column if not exists codex_harness_auth text,
    add column if not exists codex_harness_connected_at timestamptz;

-- Author-login lookup for run-time harness resolution (case-insensitive on GitHub login).
-- UNIQUE so case-insensitive author-login resolution can never pick a wrong row
-- nondeterministically (PR #141 re-review hardening note). Multiple NULL logins
-- remain allowed (Postgres treats index NULLs as distinct).
create unique index if not exists idx_user_integrations_login
    on user_integrations (lower(github_login));
