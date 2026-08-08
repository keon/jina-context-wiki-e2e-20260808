import { Pool, type PoolConfig } from "pg";

const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const host = process.env.INSTANCE_UNIX_SOCKET ?? process.env.DB_HOST;
const config: PoolConfig = connectionString
  ? { connectionString }
  : {
      host: requiredEnv("INSTANCE_UNIX_SOCKET or DB_HOST", host),
      user: requiredEnv("DB_USER"),
      password: requiredEnv("DB_PASS"),
      database: requiredEnv("DB_NAME"),
      ...(process.env.DB_PORT ? { port: Number(process.env.DB_PORT) } : {})
    };
const runtimeUser = requiredRoleName(process.env.RUNTIME_DB_USER ?? process.env.CONTEXT_RUNTIME_DB_USER);
const pool = new Pool({ ...config, application_name: "jina-causal-graph-migrate", max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.causal_graph_schema'))");
    const contextDeployment = await client.query(
      `select 1
       where to_regclass('jina_runtime.release_control') is not null
         and exists (
           select 1
           from jina_runtime.release_control
           where id=1 and lease_release_id is not null and lease_expires_at > clock_timestamp()
         )`
    );
    if (contextDeployment.rowCount) {
      throw new Error("an active Context deployment lease is present; causal graph deployment refuses to overlap it");
    }
    const repositoryTable = await client.query<{ relation: string | null }>(
      "select to_regclass('jina_context.repositories')::text as relation"
    );
    if (!repositoryTable.rows[0]?.relation) {
      throw new Error("jina_context.repositories must exist before the causal graph schema is installed");
    }
    await client.query(`
      create table if not exists jina_context.issue_graph_releases (
        release_id text primary key check (release_id ~ '^cir_[0-9a-f]{32}$'),
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        ref_sequence bigint not null check (ref_sequence > 0),
        commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
        build_id text not null,
        content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
        artifact jsonb not null,
        issue_count integer not null check (issue_count >= 0 and issue_count <= 2000),
        causality_count integer not null check (causality_count >= 0 and causality_count <= 5000),
        history_complete boolean not null,
        published_at timestamptz not null,
        foreign key (tenant_id,repository)
          references jina_context.repositories(tenant_id,repository),
        unique (tenant_id,repository,ref_name,ref_sequence),
        unique (tenant_id,repository,content_digest)
      );
      create index if not exists context_issue_graph_releases_scope
        on jina_context.issue_graph_releases
        (tenant_id,repository,ref_name,ref_sequence desc,release_id);
      drop table if exists jina_context.current_issue_graph_releases cascade;
      create schema if not exists jina_runtime;
      create table if not exists jina_runtime.causal_graph_release_control (
        id smallint primary key check (id=1),
        worker_claims_enabled boolean not null default false,
        worker_release_id text,
        worker_credential_sha256 text,
        worker_revision text,
        updated_at timestamptz not null default now(),
        check (
          (not worker_claims_enabled and worker_release_id is null and worker_credential_sha256 is null
             and worker_revision is null)
          or
          (worker_claims_enabled and worker_release_id is not null and worker_credential_sha256 is not null
             and worker_revision is not null)
        )
      );
      do $role$
      begin
        if not exists (select 1 from pg_roles where rolname='jina_context_issue_publish') then
          create role jina_context_issue_publish nologin;
        end if;
      end
      $role$;
      grant usage on schema jina_context to jina_context_issue_publish;
      grant select on jina_context.repositories,jina_context.repository_access,
                      jina_context.issue_graph_releases
        to jina_context_issue_publish;
      grant insert on jina_context.repositories to jina_context_issue_publish;
      grant insert on jina_context.issue_graph_releases to jina_context_issue_publish;
      grant select on jina_context.issue_graph_releases to jina_context_query;
      alter table jina_context.issue_graph_releases enable row level security;
      drop policy if exists context_tenant_scope on jina_context.issue_graph_releases;
      create policy context_tenant_scope on jina_context.issue_graph_releases
        using (tenant_id=any(string_to_array(coalesce(current_setting('jina.tenant_id',true),''),chr(31))));
    `);
    await client.query(`grant jina_context_issue_publish to "${runtimeUser}" with inherit false`);
    await client.query(`grant usage on schema jina_runtime to "${runtimeUser}"`);
    await client.query(`grant select on jina_runtime.causal_graph_release_control to "${runtimeUser}"`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(`${JSON.stringify({ causalGraphSchema: "ready" })}\n`);
} finally {
  await pool.end();
}

function requiredRoleName(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error("RUNTIME_DB_USER is required and must be a safe PostgreSQL role name");
  }
  return normalized;
}

function requiredEnv(name: string, value = process.env[name]): string {
  if (!value) throw new Error(`${name} is required when DATABASE_URL is not set`);
  return value;
}
