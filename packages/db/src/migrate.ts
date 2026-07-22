import { Pool, type PoolConfig } from "pg";
import { applySchema } from "./apply-schema.js";
import { CONTEXT_GRAPH_ROLES_SQL } from "./context-graph-roles.js";
import { CONTEXT_GRAPH_SCHEMA_SQL } from "./postgres-context-graph-store.js";

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

const pool = new Pool({ ...config, application_name: "jina-context-graph-migrate", max: 1 });
try {
  await applySchema(pool, "jina_context_graph.schema", CONTEXT_GRAPH_SCHEMA_SQL);
  if (process.argv.includes("--install-roles")) await pool.query(CONTEXT_GRAPH_ROLES_SQL);
} finally {
  await pool.end();
}

function requiredEnv(name: string, value = process.env[name]): string {
  if (!value) throw new Error(`${name} is required when DATABASE_URL is not set`);
  return value;
}
