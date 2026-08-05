import {
  ContextDatabase,
  GcsContextArtifactStore,
  PostgresBoardPageIndexAttachmentRepository,
  PostgresBoardContextPublicationRepository,
  PostgresContextQuotaStore,
  PostgresContextEngineStore,
  PostgresContextPhaseCheckpointRepository,
  PostgresJsonStateStore,
  PostgresIssueGraphRepository,
  PostgresRelationalBoardWorkerStore,
  PostgresSharedIdentityStore,
  type PostgresJsonStateStoreConfig
} from "@jina/db";
import {
  FileContextArtifactStore,
  MemoryContextEngineStore,
  MemoryContextPhaseCheckpointStore,
  type ContextEngineStore
} from "@jina/context-engine";
import { createLogger, errorLogFields, startOpenTelemetry } from "@jina/observability";
import { createApiServer } from "./server.js";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import type { ApiSnapshot, ApiStateStore } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const openTelemetry = startOpenTelemetry({
  serviceName: "jina-api",
  ...(process.env.K_REVISION ? { serviceVersion: process.env.K_REVISION } : {}),
  ...(process.env.JINA_ENVIRONMENT ? { environment: process.env.JINA_ENVIRONMENT } : {}),
  attributes: {
    ...(process.env.K_SERVICE ? { "gcp.cloud_run.service": process.env.K_SERVICE } : {}),
    ...(process.env.K_REVISION ? { "gcp.cloud_run.revision": process.env.K_REVISION } : {})
  }
});
const enableDevEndpoints = process.env.JINA_ENABLE_DEV_ENDPOINTS === "true";
const trustDevIdentityHeaders = booleanEnvironment("JINA_TRUST_DEV_IDENTITY_HEADERS", enableDevEndpoints);
if (trustDevIdentityHeaders && !enableDevEndpoints) {
  throw new Error("JINA_TRUST_DEV_IDENTITY_HEADERS requires JINA_ENABLE_DEV_ENDPOINTS=true");
}
if (enableDevEndpoints && process.env.K_SERVICE) {
  throw new Error("JINA_ENABLE_DEV_ENDPOINTS must not be enabled on Cloud Run");
}
const devContextMaxActiveBuilds = optionalPositiveIntegerEnv("JINA_DEV_CONTEXT_MAX_ACTIVE_BUILDS");
if (devContextMaxActiveBuilds !== undefined && !enableDevEndpoints) {
  throw new Error("JINA_DEV_CONTEXT_MAX_ACTIVE_BUILDS requires JINA_ENABLE_DEV_ENDPOINTS=true");
}
const tenancyMode = process.env.JINA_TENANCY_MODE?.trim() || "fixed";
const requireWorkerReleaseGate = booleanEnvironment("JINA_REQUIRE_WORKER_RELEASE_GATE", false);
if (requireWorkerReleaseGate && enableDevEndpoints) {
  throw new Error("JINA_REQUIRE_WORKER_RELEASE_GATE must remain disabled for local development");
}
if (tenancyMode !== "fixed" && tenancyMode !== "shared-db") {
  throw new Error("JINA_TENANCY_MODE must be fixed or shared-db");
}
if (!trustDevIdentityHeaders && (!process.env.INTERNAL_API_TOKEN || !process.env.CONTEXT_API_TOKEN)) {
  throw new Error(
    "INTERNAL_API_TOKEN and CONTEXT_API_TOKEN are required when development identity headers are not trusted"
  );
}
if (!trustDevIdentityHeaders && tenancyMode === "fixed" && !process.env.JINA_TENANT_ID) {
  throw new Error("JINA_TENANT_ID is required in fixed tenancy mode when development identity headers are not trusted");
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
const stateStore = createStateStore(postgresConfig, contextDatabase?.pool);
const contextStore = createContextStore(contextDatabase);
const contextPhaseCheckpointStore = contextDatabase
  ? new PostgresContextPhaseCheckpointRepository(contextDatabase)
  : new MemoryContextPhaseCheckpointStore();
const relationalBoardWorkerStore = contextDatabase
  ? new PostgresRelationalBoardWorkerStore(contextDatabase.pool)
  : undefined;
const contextBoardPublicationTransaction = contextDatabase
  ? new PostgresBoardContextPublicationRepository(contextDatabase)
  : undefined;
const contextBoardPageIndexAttachmentTransaction = contextDatabase
  ? new PostgresBoardPageIndexAttachmentRepository(contextDatabase)
  : undefined;
const issueGraphPublicationTransaction = contextDatabase
  ? new PostgresIssueGraphRepository(contextDatabase)
  : undefined;
const contextQuotaService = new ContextQuotaService({
  store: contextDatabase ? new PostgresContextQuotaStore(contextDatabase) : new InMemoryContextQuotaStore(),
  ...(devContextMaxActiveBuilds === undefined
    ? {}
    : {
        defaults: {
          maxActiveBuilds: devContextMaxActiveBuilds
        }
      })
});
const sharedIdentityResolver = tenancyMode === "shared-db" ? createSharedIdentityResolver(postgresConfig) : undefined;
const contextWorkerLeaseMs = optionalPositiveIntegerEnv("CONTEXT_WORKER_LEASE_MS");
const contextArtifactStore = process.env.CONTEXT_GCS_BUCKET
  ? new GcsContextArtifactStore(process.env.CONTEXT_GCS_BUCKET, {
      ...(process.env.GOOGLE_CLOUD_PROJECT ? { projectId: process.env.GOOGLE_CLOUD_PROJECT } : {}),
      ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } : {})
    })
  : enableDevEndpoints
    ? new FileContextArtifactStore(process.env.CONTEXT_ARTIFACT_DIRECTORY?.trim() || ".jina/context-artifacts")
    : undefined;

const productApiRequestHandler = await loadProductApiRequestHandler(contextDatabase?.pool);

const server = createApiServer({
  ...(process.env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
  ...(process.env.JINA_TENANT_ID ? { tenantId: process.env.JINA_TENANT_ID } : {}),
  tenantAliases: commaSeparatedEnv("JINA_TENANT_ALIASES"),
  enableDevEndpoints,
  trustDevIdentityHeaders,
  simulateRuns: process.env.JINA_SIMULATE_RUNS === "true",
  ...(stateStore ? { stateStore } : {}),
  contextStore,
  contextPhaseCheckpointStore,
  ...(relationalBoardWorkerStore ? { relationalBoardWorkerStore } : {}),
  ...(contextArtifactStore ? { contextArtifactStore } : {}),
  ...(contextBoardPublicationTransaction ? { contextBoardPublicationTransaction } : {}),
  ...(contextBoardPublicationTransaction ? { contextBoardReleaseSeedStore: contextBoardPublicationTransaction } : {}),
  ...(contextBoardPageIndexAttachmentTransaction ? { contextBoardPageIndexAttachmentTransaction } : {}),
  ...(issueGraphPublicationTransaction ? { issueGraphPublicationTransaction } : {}),
  contextQuotaService,
  ...(sharedIdentityResolver ? { sharedIdentityResolver } : {}),
  ...(process.env.INTERNAL_API_TOKEN ? { internalApiToken: process.env.INTERNAL_API_TOKEN } : {}),
  requireWorkerReleaseGate,
  ...(process.env.JINA_INTERNAL_PRINCIPAL_ID ? { internalApiPrincipalId: process.env.JINA_INTERNAL_PRINCIPAL_ID } : {}),
  ...(process.env.CONTEXT_API_TOKEN ? { contextApiToken: process.env.CONTEXT_API_TOKEN } : {}),
  ...(process.env.JINA_CONTEXT_TENANT_ID ? { contextApiTenantId: process.env.JINA_CONTEXT_TENANT_ID } : {}),
  ...(process.env.JINA_CONTEXT_PRINCIPAL_ID ? { contextApiPrincipalId: process.env.JINA_CONTEXT_PRINCIPAL_ID } : {}),
  tenantAdminPrincipalIds: commaSeparatedEnv("JINA_TENANT_ADMIN_PRINCIPALS"),
  mcpAllowedOrigins: commaSeparatedEnv("JINA_MCP_ALLOWED_ORIGINS"),
  ...(contextWorkerLeaseMs === undefined ? {} : { contextWorkerLeaseMs }),
  ...(productApiRequestHandler ? { productApiRequestHandler } : {})
});

const logger = createLogger({ service: process.env.K_SERVICE ?? "jina-api" });

server.listen(port, enableDevEndpoints ? "127.0.0.1" : "0.0.0.0", () => {
  logger.info(`jina api server listening on ${port}`, {
    event: "api.started",
    port,
    storage: stateStore ? "postgres" : "memory",
    devEndpoints: enableDevEndpoints,
    trustDevIdentityHeaders
  });
  if (enableDevEndpoints) {
    console.log(`jina api server: http://localhost:${port}`);
    console.log("  GET  /board  /events  /context/releases  /context/list  /context/read  /context/diff  /health");
    console.log("  POST /context/build  /context/search  /mcp");
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
      void openTelemetry.shutdown();
    });
  });
}

function createStateStore(
  config: PostgresJsonStateStoreConfig | undefined,
  sharedPool: ContextDatabase["pool"] | undefined
): ApiStateStore | undefined {
  if (!config) return undefined;
  return new PostgresJsonStateStore<ApiSnapshot>({
    ...config,
    ...(sharedPool ? { pool: sharedPool } : {}),
    manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
  });
}

function createContextStore(database: ContextDatabase | undefined): ContextEngineStore {
  return database ? new PostgresContextEngineStore(database) : new MemoryContextEngineStore();
}

function createSharedIdentityResolver(config: PostgresJsonStateStoreConfig | undefined): PostgresSharedIdentityStore {
  if (!config) throw new Error("Postgres storage is required in shared-db tenancy mode");
  return new PostgresSharedIdentityStore({ ...config, applicationName: "jina-api-shared-identity" });
}

function databaseConfig(): PostgresJsonStateStoreConfig | undefined {
  const connectionString = process.env.DATABASE_URL;
  const host = process.env.INSTANCE_UNIX_SOCKET ?? process.env.DB_HOST;
  if (!connectionString && !host) return undefined;
  const max = optionalPositiveIntegerEnv("JINA_DB_POOL_MAX");
  if (connectionString) return { connectionString, ...(max === undefined ? {} : { max }) };
  const databasePort = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;
  return {
    host,
    user: requiredEnv("DB_USER"),
    password: requiredEnv("DB_PASS"),
    database: requiredEnv("DB_NAME"),
    ...(max === undefined ? {} : { max }),
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

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

async function loadProductApiRequestHandler(databasePool: import("pg").Pool | undefined) {
  if (!booleanEnvironment("JINA_PRODUCT_API_ENABLED", false)) return undefined;
  // Keep the product compiler boundary independent while the absorbed code is
  // progressively refactored onto the shared kernel.
  const productModulePath = "./product/index.js";
  const product = (await import(productModulePath)) as {
    createProductApiRequestHandler: (options?: {
      readonly databasePool?: import("pg").Pool;
    }) => (
      request: import("node:http").IncomingMessage,
      response: import("node:http").ServerResponse
    ) => void | Promise<void>;
  };
  return product.createProductApiRequestHandler(databasePool ? { databasePool } : {});
}
