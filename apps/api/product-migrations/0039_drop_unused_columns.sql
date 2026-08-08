-- Drop columns with no readers anywhere in the codebase.
--
-- users.display_name / users.avatar_url: written on every identity upsert but
-- never read back; display names and avatars are sourced live from Clerk and
-- GitHub. The users table remains the durable UUID anchor.
--
-- jina_context.repositories.provider / provider_repository_id / metadata:
-- every live writer inserted the placeholders ('unknown', the repository
-- string, '{}'); nothing reads them. Dropping provider columns also drops the
-- (tenant_id, provider, provider_repository_id) unique constraint, which
-- merely restated the primary key with a constant.

-- installations.permissions_json / repositories.settings_json: '{}' defaults
-- from 0001 that no code has ever written or read.

alter table users
  drop column if exists display_name,
  drop column if exists avatar_url;

alter table installations
  drop column if exists permissions_json;

alter table repositories
  drop column if exists settings_json;

alter table jina_context.repositories
  drop column if exists provider,
  drop column if exists provider_repository_id,
  drop column if exists metadata;
