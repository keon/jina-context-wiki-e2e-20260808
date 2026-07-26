import {
  ContextDatabase,
  PostgresContextEngineStore,
  PostgresContextPipelineCoordinator,
  PostgresJsonStateStore,
  PostgresSharedIdentityStore,
  type PostgresJsonStateStoreConfig
} from "@jina/db";
import {
  MemoryContextEngineStore,
  MemoryContextPipelineCoordinator,
  type ContextEngineStore,
  type ContextPipelineCoordinator
} from "@jina/context-engine";
import { createLogger, errorLogFields } from "@jina/observability";
import { createApiServer } from "./server.js";
import type { ApiSnapshot, ApiStateStore } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const enableDevEndpoints = process.env.JINA_ENABLE_DEV_ENDPOINTS === "true";
if (enableDevEndpoints && process.env.K_SERVICE) {
  throw new Error("JINA_ENABLE_DEV_ENDPOINTS must not be enabled on Cloud Run");
}
const tenancyMode = process.env.JINA_TENANCY_MODE?.trim() || "fixed";
if (tenancyMode !== "fixed" && tenancyMode !== "shared-db") {
  throw new Error("JINA_TENANCY_MODE must be fixed or shared-db");
}
if (!enableDevEndpoints && (!process.env.INTERNAL_API_TOKEN || !process.env.CONTEXT_API_TOKEN)) {
  throw new Error("INTERNAL_API_TOKEN and CONTEXT_API_TOKEN are required in production");
}
if (!enableDevEndpoints && tenancyMode === "fixed" && !process.env.JINA_TENANT_ID) {
  throw new Error("JINA_TENANT_ID is required in fixed tenancy mode");
}
if (tenancyMode === "shared-db" && process.env.JINA_TENANT_ID) {
  throw new Error("JINA_TENANT_ID must be unset in shared-db tenancy mode");
}

const postgresConfig = databaseConfig();
const contextDatabase = postgresConfig
  ? new ContextDatabase({
      ...postgresConfig,
      manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false",
      manageRoles: process.env.JINA_DB_MANAGE_ROLES === "true"
    })
  : undefined;
const stateStore = createStateStore(postgresConfig);
const contextCoordinator = createContextCoordinator(contextDatabase);
const contextStore = createContextStore(contextDatabase, contextCoordinator);
const sharedIdentityResolver = tenancyMode === "shared-db" ? createSharedIdentityResolver(postgresConfig) : undefined;

const server = createApiServer({
  ...(process.env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
  ...(process.env.JINA_TENANT_ID ? { tenantId: process.env.JINA_TENANT_ID } : {}),
  tenantAliases: commaSeparatedEnv("JINA_TENANT_ALIASES"),
  enableDevEndpoints,
  simulateRuns: process.env.JINA_SIMULATE_RUNS === "true",
  seedDemo: enableDevEndpoints && process.env.JINA_SEED_DEMO !== "false",
  ...(stateStore ? { stateStore } : {}),
  contextStore,
  contextCoordinator,
  ...(sharedIdentityResolver ? { sharedIdentityResolver } : {}),
  ...(process.env.INTERNAL_API_TOKEN ? { internalApiToken: process.env.INTERNAL_API_TOKEN } : {}),
  ...(process.env.CONTEXT_API_TOKEN ? { contextApiToken: process.env.CONTEXT_API_TOKEN } : {}),
  ...(process.env.JINA_CONTEXT_TENANT_ID ? { contextApiTenantId: process.env.JINA_CONTEXT_TENANT_ID } : {}),
  ...(process.env.JINA_CONTEXT_PRINCIPAL_ID ? { contextApiPrincipalId: process.env.JINA_CONTEXT_PRINCIPAL_ID } : {}),
  tenantAdminPrincipalIds: commaSeparatedEnv("JINA_TENANT_ADMIN_PRINCIPALS"),
  mcpAllowedOrigins: commaSeparatedEnv("JINA_MCP_ALLOWED_ORIGINS")
});

const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-api" });

server.listen(port, enableDevEndpoints ? "127.0.0.1" : "0.0.0.0", () => {
  logger.info(`jina api server listening on ${port}`, {
    event: "api.started",
    port,
    storage: stateStore ? "postgres" : "memory",
    devEndpoints: enableDevEndpoints
  });
  if (enableDevEndpoints) {
    console.log(`jina api server: http://localhost:${port}`);
    console.log("  GET  /board  /events  /context/generations  /context/documents  /health");
    console.log("  POST /context/build  /context/query  /mcp (query_context)");
    console.log("  POST /webhooks/github  (signed GitHub App deliveries)");
    console.log("  POST /dev/webhooks/github  (unsigned local demo events)");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info(`received ${signal}; shutting down`, { event: "api.shutdown", signal });
    server.close((error) => {
      if (error) {
        logger.error("API shutdown failed", { event: "api.shutdown_failed", ...errorLogFields(error) });
        process.exitCode = 1;
      }
    });
  });
}

function createStateStore(config: PostgresJsonStateStoreConfig | undefined): ApiStateStore | undefined {
  if (!config) return undefined;
  return new PostgresJsonStateStore<ApiSnapshot>({
    ...config,
    manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
  });
}

function createContextStore(
  database: ContextDatabase | undefined,
  coordinator: ContextPipelineCoordinator
): ContextEngineStore {
  return database ? new PostgresContextEngineStore(database) : new MemoryContextEngineStore(coordinator);
}

function createContextCoordinator(database: ContextDatabase | undefined): ContextPipelineCoordinator {
  return database ? new PostgresContextPipelineCoordinator(database) : new MemoryContextPipelineCoordinator();
}

function createSharedIdentityResolver(config: PostgresJsonStateStoreConfig | undefined): PostgresSharedIdentityStore {
  if (!config) throw new Error("Postgres storage is required in shared-db tenancy mode");
  return new PostgresSharedIdentityStore({ ...config, applicationName: "jina-api-shared-identity" });
}

function databaseConfig(): PostgresJsonStateStoreConfig | undefined {
  const connectionString = process.env.DATABASE_URL;
  const host = process.env.INSTANCE_UNIX_SOCKET ?? process.env.DB_HOST;
  if (!connectionString && !host) return undefined;
  if (connectionString) return { connectionString };
  const databasePort = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;
  return {
    host,
    user: requiredEnv("DB_USER"),
    password: requiredEnv("DB_PASS"),
    database: requiredEnv("DB_NAME"),
    ...(databasePort !== undefined ? { port: databasePort } : {})
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when Postgres storage is enabled`);
  return value;
}

function commaSeparatedEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
