import {
  PostgresJsonStateStore,
  PostgresContextGraphStore,
  PostgresContextGraphPipelineCoordinator,
  PostgresSharedIdentityStore,
  type PostgresJsonStateStoreConfig
} from "@jina/db";
import {
  MemoryContextGraphStore,
  MemoryContextGraphPipelineCoordinator,
  type ContextGraphStore,
  type ContextGraphPipelineCoordinator
} from "@jina/context-graph";
import { createLogger, errorLogFields } from "@jina/observability";
import { resolveDatabaseConfigs } from "./database-config.js";
import { createApiServer } from "./server.js";
import type { ApiSnapshot, ApiStateStore } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const enableDevEndpoints = process.env.JINA_ENABLE_DEV_ENDPOINTS === "true";
if (enableDevEndpoints && process.env.K_SERVICE) {
  throw new Error("JINA_ENABLE_DEV_ENDPOINTS must not be enabled on Cloud Run");
}
const databaseConfigs = resolveDatabaseConfigs(process.env);
const stateStore = createStateStore(databaseConfigs.primary);
const contextGraphStore = createContextGraphStore(databaseConfigs.graph);
const contextGraphCoordinator = createContextGraphCoordinator(databaseConfigs.graph);
const tenancyMode = process.env.JINA_TENANCY_MODE?.trim() || "fixed";
if (tenancyMode !== "fixed" && tenancyMode !== "shared-db") {
  throw new Error("JINA_TENANCY_MODE must be fixed or shared-db");
}
const sharedIdentityResolver =
  tenancyMode === "shared-db" ? createSharedIdentityResolver(databaseConfigs.primary) : undefined;
if (
  !enableDevEndpoints &&
  (!process.env.INTERNAL_API_TOKEN || !process.env.GRAPH_API_TOKEN || !process.env.JINA_GLOBAL_ADMIN_TOKEN)
) {
  throw new Error("INTERNAL_API_TOKEN, GRAPH_API_TOKEN, and JINA_GLOBAL_ADMIN_TOKEN are required in production");
}
if (
  process.env.JINA_GLOBAL_ADMIN_TOKEN &&
  process.env.INTERNAL_API_TOKEN &&
  process.env.JINA_GLOBAL_ADMIN_TOKEN === process.env.INTERNAL_API_TOKEN
) {
  throw new Error("JINA_GLOBAL_ADMIN_TOKEN must differ from INTERNAL_API_TOKEN");
}
if (!enableDevEndpoints && tenancyMode === "fixed" && !process.env.JINA_TENANT_ID) {
  throw new Error("JINA_TENANT_ID is required in fixed tenancy mode");
}
if (tenancyMode === "shared-db" && process.env.JINA_TENANT_ID) {
  throw new Error("JINA_TENANT_ID must be unset in shared-db tenancy mode");
}

const server = createApiServer({
  ...(process.env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
  githubWebhookEnabled: process.env.JINA_GITHUB_WEBHOOK_ENABLED !== "false",
  ...(process.env.JINA_TENANT_ID ? { tenantId: process.env.JINA_TENANT_ID } : {}),
  tenantAliases: commaSeparatedEnv("JINA_TENANT_ALIASES"),
  enableDevEndpoints,
  simulateRuns: process.env.JINA_SIMULATE_RUNS === "true",
  seedDemo: enableDevEndpoints && process.env.JINA_SEED_DEMO !== "false",
  ...(stateStore ? { stateStore } : {}),
  contextGraphStore,
  contextGraphCoordinator,
  ...(sharedIdentityResolver ? { sharedIdentityResolver } : {}),
  ...(process.env.INTERNAL_API_TOKEN ? { internalApiToken: process.env.INTERNAL_API_TOKEN } : {}),
  ...(process.env.JINA_GLOBAL_ADMIN_TOKEN ? { globalAdminToken: process.env.JINA_GLOBAL_ADMIN_TOKEN } : {}),
  ...(process.env.GRAPH_API_TOKEN ? { graphApiToken: process.env.GRAPH_API_TOKEN } : {}),
  ...(process.env.SECRETS_ENCRYPTION_KEY ? { secretsEncryptionKey: process.env.SECRETS_ENCRYPTION_KEY } : {}),
  tenantAdminPrincipalIds: commaSeparatedEnv("JINA_TENANT_ADMIN_PRINCIPALS"),
  mcpAllowedOrigins: commaSeparatedEnv("JINA_MCP_ALLOWED_ORIGINS")
});

// This file is also the production container entrypoint, so lifecycle events
// must be single-line JSON for Cloud Logging; the human-readable endpoint
// listing stays dev-only.
const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-api" });

server.listen(port, enableDevEndpoints ? "127.0.0.1" : "0.0.0.0", () => {
  logger.info(`jina api server listening on ${port}`, {
    event: "api.started",
    port,
    storage: stateStore ? "postgres" : "memory",
    graphStorage: contextGraphStore instanceof PostgresContextGraphStore ? "postgres" : "memory",
    graphDatabase: databaseConfigs.graphIsDedicated ? "dedicated" : "primary",
    devEndpoints: enableDevEndpoints
  });
  if (enableDevEndpoints) {
    console.log(`jina api server: http://localhost:${port}`);
    console.log("  GET  /board  /events  /context-graph  /health");
    console.log("  POST /mcp  (query_graph MCP tool)");
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
  if (!config) {
    return undefined;
  }
  return new PostgresJsonStateStore<ApiSnapshot>({
    ...config,
    manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
  });
}

function createContextGraphStore(config: PostgresJsonStateStoreConfig | undefined): ContextGraphStore {
  return config
    ? new PostgresContextGraphStore({
        ...config,
        manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
      })
    : new MemoryContextGraphStore();
}

function createContextGraphCoordinator(
  config: PostgresJsonStateStoreConfig | undefined
): ContextGraphPipelineCoordinator {
  return config
    ? new PostgresContextGraphPipelineCoordinator({
        ...config,
        manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
      })
    : new MemoryContextGraphPipelineCoordinator();
}

function createSharedIdentityResolver(config: PostgresJsonStateStoreConfig | undefined): PostgresSharedIdentityStore {
  if (!config) throw new Error("Postgres storage is required in shared-db tenancy mode");
  return new PostgresSharedIdentityStore({ ...config, applicationName: "jina-api-shared-identity" });
}

function commaSeparatedEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
