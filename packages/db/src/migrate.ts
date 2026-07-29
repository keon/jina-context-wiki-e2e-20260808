import { Pool, type PoolConfig } from "pg";
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

const pool = new Pool({ ...config, application_name: "jina-context-migrate", max: 1 });
try {
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
} finally {
  await pool.end();
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
