import { Pool, type PoolConfig } from "pg";
import { applySchema } from "./apply-schema.js";
import { CONTEXT_ROLES_SQL, CONTEXT_RUNTIME_ROLES } from "./context/roles.js";
import { CONTEXT_PGVECTOR_SCHEMA_SQL, CONTEXT_SCHEMA_SQL } from "./context/schema.js";
import { hardenContextRuntimeRole } from "./legacy-context-cutover.js";

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
    await pool.query(`grant ${CONTEXT_RUNTIME_ROLES.join(",")} to "${runtimeUser}"`);
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
