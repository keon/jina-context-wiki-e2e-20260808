import {
  ContextDatabase,
  GcsContextArtifactStore,
  GcsWikiArtifactStore,
  PostgresBoardPageIndexAttachmentRepository,
  PostgresBoardContextPublicationRepository,
  PostgresContextQuotaStore,
  PostgresContextEngineStore,
  PostgresEvidenceStore,
  PostgresContextPhaseCheckpointRepository,
  PostgresJsonStateStore,
  PostgresWikiArtifactStore,
  PostgresWikiTriggerPublicationRepository,
  PostgresWikiAuditRepository,
  PostgresIssueGraphRepository,
  PostgresRelationalBoardWorkerStore,
  PostgresSharedIdentityStore,
  type PostgresJsonStateStoreConfig
} from "@jina/db";
import {
  ContextCatalogService,
  FileContextArtifactStore,
  MemoryContextEngineStore,
  MemoryContextPhaseCheckpointStore,
  type ContextEngineStore
} from "@jina/context-engine";
import { createLogger, errorLogFields, startOpenTelemetry } from "@jina/observability";
import { createApiServer } from "./server.js";
import { ContextWikiStageExecutor } from "./context-wiki-execution.js";
import { ApiOwnedContextWikiPublicationRuntime } from "./context-wiki-publication.js";
import { ContextWikiAuditCoordinator } from "./context-wiki-audit.js";
import { ContextQuotaService, InMemoryContextQuotaStore } from "./context-quotas.js";
import { createDedicatedBoardStateStore } from "./postgres-runtime-config.js";
import type { ApiSnapshot } from "./server.js";

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
const stateStore = createDedicatedBoardStateStore(
  postgresConfig,
  (config) =>
    new PostgresJsonStateStore<ApiSnapshot>({
      ...config,
      manageSchema: process.env.JINA_DB_MANAGE_SCHEMA !== "false"
    })
);
const contextStore = createContextStore(contextDatabase);
const contextEvidenceStore = contextDatabase
  ? new PostgresEvidenceStore(contextDatabase)
  : new MemoryContextEngineStore();
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
const contextWikiArtifactBackend = process.env.JINA_WIKI_ARTIFACT_STORE?.trim() || "gcs";
if (contextWikiArtifactBackend !== "gcs" && contextWikiArtifactBackend !== "postgres") {
  throw new Error("JINA_WIKI_ARTIFACT_STORE must be gcs or postgres");
}
// Trigger never receives either backend credential. Staging may select the
// tenant-scoped Postgres adapter when platform IAM cannot grant API GCS access.
const postgresWikiArtifactStore =
  contextWikiArtifactBackend === "postgres" && contextDatabase
    ? new PostgresWikiArtifactStore(contextDatabase)
    : undefined;
if (contextWikiArtifactBackend === "postgres" && !postgresWikiArtifactStore) {
  throw new Error("JINA_WIKI_ARTIFACT_STORE=postgres requires a Context database");
}
const contextWikiArtifactStore =
  contextWikiArtifactBackend === "postgres" ? postgresWikiArtifactStore : contextArtifactStore;
const contextWikiContentStore =
  contextWikiArtifactBackend === "postgres"
    ? postgresWikiArtifactStore
    : process.env.CONTEXT_GCS_BUCKET
      ? new GcsWikiArtifactStore(process.env.CONTEXT_GCS_BUCKET, {
          ...(process.env.GOOGLE_CLOUD_PROJECT ? { projectId: process.env.GOOGLE_CLOUD_PROJECT } : {}),
          ...(process.env.GOOGLE_APPLICATION_CREDENTIALS
            ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS }
            : {})
        })
      : undefined;
const contextWikiPublicationStore = contextDatabase
  ? new PostgresWikiTriggerPublicationRepository(contextDatabase)
  : undefined;
const contextWikiAuditCatalog = new ContextCatalogService(contextStore);
const contextWikiStageExecutor =
  contextWikiArtifactStore && contextWikiContentStore && contextWikiPublicationStore
    ? new ContextWikiStageExecutor({
        artifactStore: contextWikiArtifactStore,
        contentStore: contextWikiContentStore,
        evidenceStore: contextEvidenceStore,
        publication: new ApiOwnedContextWikiPublicationRuntime(
          contextWikiArtifactStore,
          contextWikiContentStore,
          contextWikiPublicationStore
        ),
        priorReleases: contextWikiPublicationStore,
        auditArtifacts: contextWikiContentStore,
        ...(process.env.OPENAI_API_KEY ? { openAiApiKey: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.JINA_WIKI_MODEL ? { openAiModel: process.env.JINA_WIKI_MODEL } : {}),
        ...(process.env.JINA_WIKI_CHROMIUM_EXECUTABLE_PATH
          ? { chromiumExecutablePath: process.env.JINA_WIKI_CHROMIUM_EXECUTABLE_PATH }
          : {})
      })
    : undefined;
const contextWikiAuditCoordinator =
  contextDatabase &&
  contextWikiContentStore &&
  contextWikiPublicationStore &&
  process.env.JINA_CONTEXT_TRIGGER_DISPATCH_SECRET
    ? new ContextWikiAuditCoordinator(
        new PostgresWikiAuditRepository(contextDatabase),
        contextWikiPublicationStore,
        contextWikiContentStore,
        contextWikiContentStore,
        process.env.JINA_CONTEXT_TRIGGER_DISPATCH_SECRET,
        undefined,
        {
          async probe(input) {
            const access = {
              tenantId: input.tenantId,
              repository: input.repository,
              releaseId: input.releaseId,
              principalId: "svc:context-wiki-audit",
              tenantAdmin: true
            } as const;
            const listed = await contextWikiAuditCatalog.listContext(access);
            const searches = await Promise.all(
              input.queries.map(async (query) => {
                const result = await contextWikiAuditCatalog.searchContext({ ...access, query, limit: 5 });
                return {
                  query,
                  resultPaths: result.results.map((candidate) => candidate.logicalId)
                };
              })
            );
            const countTree = (nodes: readonly { readonly children: readonly unknown[] }[]): number =>
              nodes.reduce(
                (count, node) =>
                  count +
                  1 +
                  countTree(
                    node.children as readonly {
                      readonly children: readonly unknown[];
                    }[]
                  ),
                0
              );
            return {
              releaseId: listed.release.id,
              documentPaths: listed.documents.map((document) => document.logicalId),
              treeNodeCount: countTree(listed.tree),
              citationCount: listed.documents.reduce((count, document) => count + document.citations.length, 0),
              searches
            };
          }
        },
        contextWikiArtifactStore,
        process.env.JINA_WIKI_CHROMIUM_EXECUTABLE_PATH
      )
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
  ...(contextWikiArtifactStore ? { contextWikiArtifactStore } : {}),
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
  ...(process.env.JINA_CONTEXT_TRIGGER_SERVICE_TOKEN
    ? { contextWikiTriggerServiceToken: process.env.JINA_CONTEXT_TRIGGER_SERVICE_TOKEN }
    : {}),
  ...(process.env.JINA_CONTEXT_EXECUTION_GRANT_SECRET
    ? { contextWikiExecutionGrantSecret: process.env.JINA_CONTEXT_EXECUTION_GRANT_SECRET }
    : {}),
  ...(process.env.JINA_CONTEXT_TRIGGER_DISPATCH_SECRET
    ? { contextWikiDispatchSecret: process.env.JINA_CONTEXT_TRIGGER_DISPATCH_SECRET }
    : {}),
  ...(contextWikiStageExecutor ? { contextWikiStageExecutor } : {}),
  ...(contextWikiAuditCoordinator ? { contextWikiAuditCoordinator } : {}),
  contextWikiAuditFixEnabled: booleanEnvironment("JINA_WIKI_AUDIT_FIX_ENABLED", false),
  ...(contextWikiPublicationStore ? { contextWikiReleaseQueryStore: contextWikiPublicationStore } : {}),
  ...(contextWikiContentStore ? { contextWikiContentBundleReader: contextWikiContentStore } : {}),
  contextWikiDefaultBranch: process.env.JINA_WIKI_DEFAULT_BRANCH?.trim() || "main",
  contextWikiDefaultLocale: process.env.JINA_WIKI_DEFAULT_LOCALE?.trim() || "en",
  contextWikiAuditPolicyVersion: process.env.JINA_WIKI_AUDIT_POLICY_VERSION?.trim() || "wiki-audit-v1",
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
    console.log("  GET  /board  /events  /wiki/releases  /wiki/list  /wiki/read  /wiki/diff  /health");
    console.log("  GET  /wiki/export");
    console.log("  POST /wiki/build  /wiki/search  /wiki/ask  /mcp");
    console.log("  POST /wiki/webhooks/github  (signed Context deliveries)");
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
