const CONTEXT_ROLES = [
  "jina_context_query",
  "jina_context_quota",
  "jina_context_tokens",
  "jina_context_issue_publish",
  "jina_context_tenant_admin",
  "jina_context_admin"
] as const;

export const CONTEXT_RUNTIME_ROLES = CONTEXT_ROLES.filter((role) => role !== "jina_context_admin");

export type ContextDatabaseRole = (typeof CONTEXT_ROLES)[number];

const tenantScopeSql = (column = "tenant_id", allowAdminSystemScope = true) =>
  `(${column}=any(string_to_array(coalesce(current_setting('jina.tenant_id',true),''),chr(31)))${
    allowAdminSystemScope
      ? " or (current_user='jina_context_admin' and current_setting('jina.tenant_id',true)='*')"
      : ""
  })`;

const tenantScopedTables = [
  "repositories",
  "repository_access",
  "context_releases",
  "issue_graph_releases",
  "context_phase_checkpoints",
  "context_quota_ledgers",
  "api_tokens"
] as const;

export const CONTEXT_ROLES_SQL = `
do $roles$
declare role_name text;
begin
  foreach role_name in array array[${CONTEXT_ROLES.map((role) => `'${role}'`).join(",")}] loop
    if not exists (select 1 from pg_roles where rolname=role_name) then
      execute format('create role %I nologin',role_name);
    end if;
  end loop;
end
$roles$;

revoke all on schema jina_context from public;
revoke all on all tables in schema jina_context from public;
revoke all on all sequences in schema jina_context from public;
revoke execute on all functions in schema jina_context from public;

grant usage on schema jina_context to ${CONTEXT_ROLES.join(",")};

grant select on
  jina_context.repositories,jina_context.repository_access,
  jina_context.context_releases,jina_context.issue_graph_releases
to jina_context_query;

grant select,insert,update on jina_context.context_quota_ledgers
  to jina_context_quota;

grant select,insert on jina_context.api_tokens to jina_context_tokens;
grant update (last_used_at,revoked_at,revoked_by) on jina_context.api_tokens
  to jina_context_tokens;

grant select on jina_context.repositories,jina_context.issue_graph_releases
  to jina_context_issue_publish;
grant insert on jina_context.repositories,jina_context.issue_graph_releases
  to jina_context_issue_publish;

grant all privileges on all tables in schema jina_context to
  jina_context_tenant_admin,jina_context_admin;
grant all privileges on all sequences in schema jina_context to
  jina_context_tenant_admin,jina_context_admin;
grant execute on all functions in schema jina_context to
  jina_context_tenant_admin,jina_context_admin;

alter table jina_context.api_tokens enable row level security;
drop policy if exists context_api_tokens_verify on jina_context.api_tokens;
create policy context_api_tokens_verify on jina_context.api_tokens
  for select to jina_context_tokens
  using (
    current_setting('jina.tenant_id',true)='*'
    and revoked_at is null
    and expires_at > now()
  );

${tenantScopedTables
  .map(
    (table) => `
alter table jina_context.${table} enable row level security;
drop policy if exists context_tenant_scope on jina_context.${table};
create policy context_tenant_scope on jina_context.${table}
  using (${tenantScopeSql()})
  with check (${tenantScopeSql()});`
  )
  .join("\n")}

alter default privileges in schema jina_context revoke all on tables from public;
alter default privileges in schema jina_context revoke all on sequences from public;
alter default privileges in schema jina_context revoke execute on functions from public;
`;
