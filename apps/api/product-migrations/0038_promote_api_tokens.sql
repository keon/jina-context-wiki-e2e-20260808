-- Promote api_tokens from jina_context to public.
--
-- API tokens are tenant credentials, not Context data: upcoming product
-- features authenticate with the same tokens, so the table now belongs to the
-- product schema. The declarative Context schema (packages/db) creates
-- public.api_tokens before this migration runs, and the Context capability
-- role keeps its scoped grants and row policies against the new location.
--
-- The compatibility view keeps the previous name readable and writable for
-- the still-running previous revision during the deploy window; the view is
-- security_invoker so the base table's row policies apply to the caller
-- exactly as they did on the old table. Safe to drop once no revision that
-- reads jina_context.api_tokens can run (fold into the next baseline squash).

do $promote$
begin
  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'jina_context'
       and c.relname = 'api_tokens'
       and c.relkind = 'r'
  ) then
    insert into public.api_tokens
      (id,tenant_id,principal_id,name,secret_hash,scopes,
       created_at,created_by,expires_at,last_used_at,revoked_at,revoked_by)
    select id,tenant_id,principal_id,name,secret_hash,scopes,
           created_at,created_by,expires_at,last_used_at,revoked_at,revoked_by
      from jina_context.api_tokens
    on conflict (id) do nothing;

    drop table jina_context.api_tokens;
  end if;
end
$promote$;

create or replace view jina_context.api_tokens
  with (security_invoker = true)
  as select * from public.api_tokens;

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'jina_context_tokens') then
    grant select,insert on jina_context.api_tokens to jina_context_tokens;
    grant update (last_used_at,revoked_at,revoked_by) on jina_context.api_tokens
      to jina_context_tokens;
  end if;
end
$grants$;
