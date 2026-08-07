-- Clerk owns organization identity and membership. Jina retains its tenant row
-- as the durable data, billing, GitHub-installation, and artifact boundary.
alter table tenants
    add column if not exists clerk_organization_id text;

create unique index if not exists idx_tenants_clerk_organization
    on tenants (clerk_organization_id)
    where clerk_organization_id is not null;

