import { PostgresJsonStateStore } from "@jina/db";
import { createApiServer } from "./server.js";
import type { ApiSnapshot, ApiStateStore } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const enableDevEndpoints = process.env.JINA_ENABLE_DEV_ENDPOINTS === "true";
const stateStore = createStateStore();

const server = createApiServer({
  ...(process.env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
  ...(process.env.JINA_TENANT_ID ? { tenantId: process.env.JINA_TENANT_ID } : {}),
  enableDevEndpoints,
  simulateRuns: process.env.JINA_SIMULATE_RUNS === "true",
  seedDemo: enableDevEndpoints && process.env.JINA_SEED_DEMO !== "false",
  ...(stateStore ? { stateStore } : {})
});

server.listen(port, () => {
  console.log(`jina api server: http://localhost:${port}`);
  console.log(`  storage: ${stateStore ? "postgres" : "memory"}`);
  console.log("  GET  /board  /events  /health");
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
  const connectionString = process.env.DATABASE_URL;
  const host = process.env.INSTANCE_UNIX_SOCKET ?? process.env.DB_HOST;
  if (!connectionString && !host) {
    return undefined;
  }

  if (connectionString) {
    return new PostgresJsonStateStore<ApiSnapshot>({ connectionString });
  }

  const user = requiredEnv("DB_USER");
  const password = requiredEnv("DB_PASS");
  const database = requiredEnv("DB_NAME");
  const port = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;
  return new PostgresJsonStateStore<ApiSnapshot>({
    host,
    user,
    password,
    database,
    ...(port !== undefined ? { port } : {})
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when Postgres storage is enabled`);
  }
  return value;
}
