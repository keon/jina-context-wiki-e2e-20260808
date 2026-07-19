import { createApiServer } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const enableDevEndpoints = process.env.JINA_ENABLE_DEV_ENDPOINTS === "true";

const server = createApiServer({
  ...(process.env.GITHUB_WEBHOOK_SECRET ? { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
  ...(process.env.JINA_TENANT_ID ? { tenantId: process.env.JINA_TENANT_ID } : {}),
  enableDevEndpoints,
  simulateRuns: process.env.JINA_SIMULATE_RUNS === "true",
  seedDemo: enableDevEndpoints && process.env.JINA_SEED_DEMO !== "false"
});

server.listen(port, () => {
  console.log(`jina api server: http://localhost:${port}`);
  console.log("  GET  /board  /events  /healthz");
  console.log("  POST /webhooks/github  (signed GitHub App deliveries)");
  if (enableDevEndpoints) {
    console.log("  POST /dev/webhooks/github  (unsigned local demo events)");
  }
});
