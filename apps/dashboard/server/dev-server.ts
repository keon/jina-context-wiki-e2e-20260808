import { createDashboardServer } from "./dashboard-server.js";

const port = Number(process.env.PORT ?? 3000);
const apiUrl = process.env.JINA_API_URL ?? "http://localhost:4000";
const internalApiToken = process.env.INTERNAL_API_TOKEN?.trim();

const server = createDashboardServer({ apiUrl, ...(internalApiToken ? { internalApiToken } : {}) });

server.listen(port, () => {
  console.log(`jina dashboard: http://localhost:${port}  (api: ${apiUrl})`);
});
