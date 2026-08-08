-- Record completion of the one-time legacy-to-Clerk membership bootstrap.
--
-- This marker is deliberately separate from clerk_tenant_memberships. That
-- live projection can become empty after an administrator removes the user's
-- final Clerk organization membership. A durable marker prevents a later
-- login from restoring that intentionally removed access from legacy rows.
create table if not exists clerk_membership_bootstraps (
    user_id uuid primary key references users(id) on delete cascade,
    clerk_user_id text not null unique,
    completed_at timestamptz not null default now(),
    check (length(btrim(clerk_user_id)) > 0)
);

