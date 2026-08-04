-- Track WHERE a tenant membership came from, so installer-derived rows survive the OAuth sync.
--   'oauth'     — synced from the viewer's GitHub org memberships at login/refresh. Subject to
--                 stale-deletion when the fetched set no longer contains the org.
--   'installer' — the person who installed the GitHub App on the org (webhook sender): definitionally an
--                 org admin, and NOT visible via /user/orgs when the org restricts OAuth apps — the exact
--                 gap that hid the org switcher from installing admins. Never stale-deleted by the sync.
alter table tenant_members add column if not exists source text not null default 'oauth';
