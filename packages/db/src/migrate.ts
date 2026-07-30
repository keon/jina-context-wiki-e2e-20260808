import { createHash } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { applySchema } from "./apply-schema.js";
import { hardenContextRuntimeRole } from "./context/runtime-role.js";
import { CONTEXT_ROLES_SQL, CONTEXT_RUNTIME_ROLES } from "./context/roles.js";
import { CONTEXT_PGVECTOR_SCHEMA_SQL, CONTEXT_SCHEMA_SQL } from "./context/schema.js";

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

const deploymentLease = deploymentLeaseInput(process.env);
// A production migration keeps a second connection open solely to hold the
// same Board advisory lock used by worker mutations and release-control
// transitions. Schema application uses the other connection.
const pool = new Pool({ ...config, application_name: "jina-context-migrate", max: deploymentLease ? 2 : 1 });
let deploymentGuard: PoolClient | undefined;
try {
  if (deploymentLease) {
    deploymentGuard = await acquireDeploymentGuard(pool, deploymentLease);
  }
  await applySchema(pool, "jina_context.schema", CONTEXT_SCHEMA_SQL);
  if (process.argv.includes("--install-pgvector")) {
    await applySchema(pool, "jina_context.pgvector", CONTEXT_PGVECTOR_SCHEMA_SQL);
  }
  if (process.argv.includes("--install-roles")) {
    await applySchema(pool, "jina_context.roles", CONTEXT_ROLES_SQL);
    const runtimeUser = requiredRuntimeRoleName(process.env.CONTEXT_RUNTIME_DB_USER);
    await hardenContextRuntimeRole(pool, runtimeUser);
    await pool.query(`revoke jina_context_admin from "${runtimeUser}"`);
    // `inherit false` keeps each capability dormant until a transaction activates
    // exactly one with `set local role`, which is what makes the capability split
    // real. Carrying it per membership rather than on the runtime role itself means
    // this migration only needs ADMIN OPTION on the capability roles it just
    // created, never on the runtime login, so a managed runtime login created by
    // the instance superuser needs no privileged preparation. Requires PostgreSQL 16.
    await pool.query(`grant ${CONTEXT_RUNTIME_ROLES.join(",")} to "${runtimeUser}" with inherit false`);
    // PostgreSQL records one membership per grantor and applies the most permissive,
    // so a capability granted inheritably by anyone else would silently reactivate
    // passive access. This migration can only revoke its own grants, so assert the
    // effective state and name whoever must revoke theirs.
    const inheriting = await pool.query<{ capability: string; grantor: string }>(
      `select granted.rolname as capability,grantor.rolname as grantor
       from pg_auth_members membership
       join pg_roles granted on granted.oid=membership.roleid
       join pg_roles member on member.oid=membership.member
       join pg_roles grantor on grantor.oid=membership.grantor
       where member.rolname=$1 and membership.inherit_option
         and granted.rolname=any($2::text[])
       order by granted.rolname`,
      [runtimeUser, [...CONTEXT_RUNTIME_ROLES]]
    );
    if (inheriting.rows.length > 0) {
      const memberships = inheriting.rows.map((row) => `${row.capability} (granted by ${row.grantor})`).join(", ");
      throw new Error(
        `Context capabilities must stay dormant for ${runtimeUser}, but these memberships still inherit: ${memberships}. ` +
          "Each must be revoked by its grantor, then reapplied by this migration."
      );
    }
  }
  if (deploymentGuard && deploymentLease) {
    await assertDeploymentLease(deploymentGuard, deploymentLease);
  }
} finally {
  if (deploymentGuard) {
    await deploymentGuard.query("select pg_advisory_unlock(hashtext('jina_runtime.api_state'))").catch(() => undefined);
    deploymentGuard.release();
  }
  await pool.end();
}

interface DeploymentLeaseInput {
  readonly releaseId: string;
  readonly credentialSha256: string;
}

function deploymentLeaseInput(environment: NodeJS.ProcessEnv): DeploymentLeaseInput | undefined {
  const releaseId = environment.JINA_WORKER_RELEASE_ID?.trim();
  const credential = environment.JINA_WORKER_RELEASE_CREDENTIAL?.trim();
  if (!releaseId && !credential) return undefined;
  if (!releaseId || !credential) {
    throw new Error(
      "JINA_WORKER_RELEASE_ID and JINA_WORKER_RELEASE_CREDENTIAL must be configured together for migration"
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(releaseId)) {
    throw new Error("JINA_WORKER_RELEASE_ID is invalid");
  }
  if (credential.length < 32 || credential.length > 512) {
    throw new Error("JINA_WORKER_RELEASE_CREDENTIAL must contain 32..512 characters");
  }
  return {
    releaseId,
    credentialSha256: createHash("sha256").update(credential, "utf8").digest("hex")
  };
}

async function acquireDeploymentGuard(pool: Pool, lease: DeploymentLeaseInput): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("set statement_timeout='60s'");
    await client.query("select pg_advisory_lock(hashtext('jina_runtime.api_state'))");
    await client.query("set statement_timeout=0");
    await assertDeploymentLease(client, lease);
    return client;
  } catch (error) {
    await client.query("select pg_advisory_unlock(hashtext('jina_runtime.api_state'))").catch(() => undefined);
    client.release();
    throw error;
  }
}

async function assertDeploymentLease(client: PoolClient, lease: DeploymentLeaseInput): Promise<void> {
  const active = await client.query(
    `select 1
     from jina_runtime.release_control
     where id=1
       and lease_release_id=$1
       and lease_credential_sha256=$2
       and lease_expires_at > clock_timestamp()`,
    [lease.releaseId, lease.credentialSha256]
  );
  if (active.rowCount !== 1) {
    throw new Error(`coordinated release ${lease.releaseId} does not hold a live deployment lease`);
  }
}

function requiredRuntimeRoleName(value: string | undefined): string {
  if (!value) throw new Error("CONTEXT_RUNTIME_DB_USER is required with --install-roles");
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(value)) {
    throw new Error("CONTEXT_RUNTIME_DB_USER is not a safe PostgreSQL role name");
  }
  return value;
}

function requiredEnv(name: string, value = process.env[name]): string {
  if (!value) throw new Error(`${name} is required when DATABASE_URL is not set`);
  return value;
}
