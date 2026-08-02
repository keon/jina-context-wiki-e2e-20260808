import type { Pool } from "pg";

/**
 * Removes role-administration capabilities from the context runtime login and
 * grants only the shared runtime tables that may live outside jina_context.
 */
export async function hardenContextRuntimeRole(pool: Pool, runtimeUser: string): Promise<void> {
  const escapedRuntimeUser = runtimeUser.replaceAll('"', '""');
  const runtimeLiteral = runtimeUser.replaceAll("'", "''");
  await pool.query(
    `do $runtime_preflight$
     declare runtime_user constant text := '${runtimeLiteral}';
     begin
       if exists (
         select 1
         from pg_roles
         where rolname=runtime_user
           and (rolsuper or rolbypassrls or rolreplication or rolcreatedb or rolcreaterole)
       ) then
         raise exception
           'runtime role % must already be NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE',
           runtime_user
           using errcode='42501';
       end if;
     end
     $runtime_preflight$`
  );
  await pool.query(`alter role "${escapedRuntimeUser}" noinherit`);
  await pool.query(
    `do $hardening$
     declare runtime_user constant text := '${runtimeLiteral}';
     begin
       if exists (
         select 1
         from pg_auth_members membership
         join pg_roles granted on granted.oid=membership.roleid
         join pg_roles member on member.oid=membership.member
         where granted.rolname='cloudsqlsuperuser' and member.rolname=runtime_user
       ) then
         execute format('revoke cloudsqlsuperuser from %I', runtime_user);
       end if;
     end
     $hardening$`
  );
  await pool.query(
    `do $runtime_support$
     declare
       relation_name text;
       runtime_user constant text := '${runtimeLiteral}';
     begin
       if to_regnamespace('jina_runtime') is not null then
         execute format('grant usage on schema jina_runtime to %I', runtime_user);
         if to_regclass('jina_runtime.api_state') is not null then
           execute format(
             'grant select,insert,update on jina_runtime.api_state to %I',
             runtime_user
           );
         end if;
         if to_regclass('jina_runtime.github_deliveries') is not null then
           execute format(
             'grant select,insert on jina_runtime.github_deliveries to %I',
             runtime_user
           );
         end if;
         if to_regclass('jina_runtime.release_control') is not null then
           execute format(
             'grant select on jina_runtime.release_control to %I',
             runtime_user
           );
         end if;
         if to_regclass('jina_runtime.causal_graph_release_control') is not null then
           execute format(
             'grant select on jina_runtime.causal_graph_release_control to %I',
             runtime_user
           );
         end if;
       end if;

       foreach relation_name in array array[
         'repositories','tenants','installations','tenant_members'
       ] loop
         if to_regclass(format('public.%I', relation_name)) is not null then
           execute format(
             'grant select on public.%I to %I',
             relation_name,
             runtime_user
           );
         end if;
       end loop;
     end
     $runtime_support$`
  );
}
