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

const releaseId = requiredReleaseId(process.env.JINA_CAUSAL_GRAPH_RELEASE_ID);
const credential = requiredCredential(process.env.JINA_CAUSAL_GRAPH_RELEASE_CREDENTIAL);
const workerRevision = requiredWorkerRevision(process.env.JINA_CAUSAL_GRAPH_WORKER_REVISION);
const runtimeUser = requiredRoleName(process.env.RUNTIME_DB_USER ?? process.env.CONTEXT_RUNTIME_DB_USER);
const credentialSha256 = createHash("sha256").update(credential, "utf8").digest("hex");
const pool = new Pool({ ...config, application_name: "jina-causal-graph-release", max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.causal_graph_release_control'))");
    await client.query("create schema if not exists jina_runtime");
    await client.query(`
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
      )
    `);
    await client.query(`grant usage on schema jina_runtime to "${runtimeUser}"`);
    await client.query(`grant select on jina_runtime.causal_graph_release_control to "${runtimeUser}"`);
    await client.query(
      `insert into jina_runtime.causal_graph_release_control
         (id,worker_claims_enabled,worker_release_id,worker_credential_sha256,worker_revision,updated_at)
       values (1,true,$1,$2,$3,clock_timestamp())
       on conflict (id) do update set
         worker_claims_enabled=excluded.worker_claims_enabled,
         worker_release_id=excluded.worker_release_id,
         worker_credential_sha256=excluded.worker_credential_sha256,
         worker_revision=excluded.worker_revision,
         updated_at=excluded.updated_at`,
      [releaseId, credentialSha256, workerRevision]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(`${JSON.stringify({ releaseId, workerRevision, activated: true })}\n`);
} finally {
  await pool.end();
}

function requiredReleaseId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error("JINA_CAUSAL_GRAPH_RELEASE_ID is required and invalid");
  }
  return normalized;
}

function requiredCredential(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 32 || normalized.length > 512) {
    throw new Error("JINA_CAUSAL_GRAPH_RELEASE_CREDENTIAL must contain 32..512 characters");
  }
  return normalized;
}

function requiredWorkerRevision(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !normalized.startsWith("jina-causal-graph-worker-")) {
    throw new Error("JINA_CAUSAL_GRAPH_WORKER_REVISION must identify the causal graph worker service");
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
