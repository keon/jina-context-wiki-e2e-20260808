import { createHash } from "node:crypto";
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

const enabled = process.env.JINA_WORKER_RELEASE_ENABLED !== "false";
const runtimeUser = requiredRoleName(process.env.RUNTIME_DB_USER ?? process.env.CONTEXT_RUNTIME_DB_USER);
const release = enabled
  ? {
      releaseId: requiredReleaseId(process.env.JINA_WORKER_RELEASE_ID),
      credentialSha256: createHash("sha256")
        .update(requiredCredential(process.env.JINA_WORKER_RELEASE_CREDENTIAL), "utf8")
        .digest("hex"),
      contextRevision: requiredWorkerRevision(
        process.env.JINA_CONTEXT_WORKER_REVISION,
        "jina-context-worker-staging-",
        "JINA_CONTEXT_WORKER_REVISION"
      ),
      taskRevision: requiredWorkerRevision(
        process.env.JINA_TASK_WORKER_REVISION,
        "jina-task-worker-staging-",
        "JINA_TASK_WORKER_REVISION"
      )
    }
  : undefined;
const pool = new Pool({ ...config, application_name: "jina-worker-release-activation", max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.release_control'))");
    await client.query("create schema if not exists jina_runtime");
    await client.query(`
      create table if not exists jina_runtime.release_control (
        id smallint primary key check (id = 1),
        lease_release_id text,
        lease_credential_sha256 text,
        lease_expires_at timestamptz,
        worker_claims_enabled boolean not null default false,
        worker_accepts_claims boolean not null default true,
        worker_release_id text,
        worker_credential_sha256 text,
        context_worker_revision text,
        task_worker_revision text,
        updated_at timestamptz not null default now(),
        check (
          (lease_release_id is null and lease_credential_sha256 is null and lease_expires_at is null)
          or
          (lease_release_id is not null and lease_credential_sha256 is not null and lease_expires_at is not null)
        ),
        check (
          (not worker_claims_enabled and worker_release_id is null and worker_credential_sha256 is null
             and context_worker_revision is null and task_worker_revision is null)
          or
          (worker_claims_enabled and worker_release_id is not null and worker_credential_sha256 is not null
             and context_worker_revision is not null and task_worker_revision is not null)
        )
      )
    `);
    await client.query(`grant usage on schema jina_runtime to "${runtimeUser}"`);
    await client.query(`grant select on jina_runtime.release_control to "${runtimeUser}"`);
    if (release) {
      await client.query(
        `insert into jina_runtime.release_control
           (id,worker_claims_enabled,worker_accepts_claims,worker_release_id,worker_credential_sha256,
            context_worker_revision,task_worker_revision,updated_at)
         values (1,true,true,$1,$2,$3,$4,clock_timestamp())
         on conflict (id) do update set
           worker_claims_enabled=excluded.worker_claims_enabled,
           worker_accepts_claims=excluded.worker_accepts_claims,
           worker_release_id=excluded.worker_release_id,
           worker_credential_sha256=excluded.worker_credential_sha256,
           context_worker_revision=excluded.context_worker_revision,
           task_worker_revision=excluded.task_worker_revision,
           updated_at=excluded.updated_at`,
        [release.releaseId, release.credentialSha256, release.contextRevision, release.taskRevision]
      );
      await client.query(`grant select,insert,update on jina_runtime.api_state to "${runtimeUser}"`);
    } else {
      await client.query(
        `insert into jina_runtime.release_control
           (id,worker_claims_enabled,worker_accepts_claims,worker_release_id,worker_credential_sha256,
            context_worker_revision,task_worker_revision,updated_at)
         values (1,false,true,null,null,null,null,clock_timestamp())
         on conflict (id) do update set
           worker_claims_enabled=false,
           worker_accepts_claims=true,
           worker_release_id=null,
           worker_credential_sha256=null,
           context_worker_revision=null,
           task_worker_revision=null,
           updated_at=clock_timestamp()`
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(
    `${JSON.stringify({
      enabled,
      releaseId: release?.releaseId,
      contextRevision: release?.contextRevision,
      taskRevision: release?.taskRevision
    })}\n`
  );
} finally {
  await pool.end();
}

function requiredReleaseId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error("JINA_WORKER_RELEASE_ID is required and invalid");
  }
  return normalized;
}

function requiredCredential(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 32 || normalized.length > 512) {
    throw new Error("JINA_WORKER_RELEASE_CREDENTIAL must contain 32..512 characters");
  }
  return normalized;
}

function requiredWorkerRevision(value: string | undefined, prefix: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized || !normalized.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(normalized)) {
    throw new Error(`${name} must identify its staging worker service`);
  }
  return normalized;
}

function requiredRoleName(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error("RUNTIME_DB_USER is required and must be a safe PostgreSQL role name");
  }
  return normalized.replaceAll('"', '""');
}

function requiredEnv(name: string, value = process.env[name]): string {
  if (!value) throw new Error(`${name} is required when DATABASE_URL is not set`);
  return value;
}
