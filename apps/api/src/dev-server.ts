import {
  PostgresJsonStateStore,
  PostgresOntologyGraphStore,
  type PostgresJsonStateStoreConfig
} from "@jina/db";
import { MemoryOntologyGraphStore, type OntologyGraphStore } from "@jina/ontology";
import { createApiServer } from "./server.js";
import type { ApiSnapshot, ApiStateStore } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const enableDevEndpoints = process.env.JINA_ENABLE_DEV_ENDPOINTS === "true";
const stateStore = createStateStore();
const ontologyStore = createOntologyStore();
if (!enableDevEndpoints && (!process.env.INTERNAL_API_TOKEN || !process.env.JINA_TENANT_ID)) {
  throw new Error("INTERNAL_API_TOKEN and JINA_TENANT_ID are required in production");
}

const server = createApiServer({
  ...(process.env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
  ...(process.env.JINA_TENANT_ID ? { tenantId: process.env.JINA_TENANT_ID } : {}),
  tenantAliases: commaSeparatedEnv("JINA_TENANT_ALIASES"),
  enableDevEndpoints,
  simulateRuns: process.env.JINA_SIMULATE_RUNS === "true",
  seedDemo: enableDevEndpoints && process.env.JINA_SEED_DEMO !== "false",
  ...(stateStore ? { stateStore } : {}),
  ontologyStore,
  ...(process.env.INTERNAL_API_TOKEN ? { internalApiToken: process.env.INTERNAL_API_TOKEN } : {}),
  tenantAdminPrincipalIds: commaSeparatedEnv("JINA_TENANT_ADMIN_PRINCIPALS"),
  mcpAllowedOrigins: commaSeparatedEnv("JINA_MCP_ALLOWED_ORIGINS")
});

server.listen(port, () => {
  console.log(`jina api server: http://localhost:${port}`);
  console.log(`  storage: ${stateStore ? "postgres" : "memory"}`);
  console.log("  GET  /board  /events  /ontology  /health");
  console.log("  POST /mcp  (query_graph MCP tool)");
  console.log("  POST /webhooks/github  (signed GitHub App deliveries)");
  if (enableDevEndpoints) {
    console.log("  POST /dev/webhooks/github  (unsigned local demo events)");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`received ${signal}; shutting down`);
    server.close((error) => {
      if (error) {
        console.error("API shutdown failed", error);
        process.exitCode = 1;
      }
    });
  });
}

function createStateStore(): ApiStateStore | undefined {
  const config = databaseConfig();
  if (!config) {
    return undefined;
  }
  return new PostgresJsonStateStore<ApiSnapshot>(config);
}

function createOntologyStore(): OntologyGraphStore {
  const config = databaseConfig();
  return config ? new PostgresOntologyGraphStore({
    ...config,
    manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
  }) : new MemoryOntologyGraphStore();
}

function databaseConfig(): PostgresJsonStateStoreConfig | undefined {
  const connectionString = process.env.DATABASE_URL;
  const host = process.env.INSTANCE_UNIX_SOCKET ?? process.env.DB_HOST;
  if (!connectionString && !host) return undefined;
  if (connectionString) return { connectionString };
  const port = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;
  return {
    host,
    user: requiredEnv("DB_USER"),
    password: requiredEnv("DB_PASS"),
    database: requiredEnv("DB_NAME"),
    ...(port !== undefined ? { port } : {})
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when Postgres storage is enabled`);
  }
  return value;
}

function commaSeparatedEnv(name: string): readonly string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}
