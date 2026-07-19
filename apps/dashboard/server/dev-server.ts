import { createServer } from "node:http";
import { renderDashboardPage } from "../app/page.js";

const port = Number(process.env.PORT ?? 3000);
const apiUrl = process.env.JINA_API_URL ?? "http://localhost:4000";
const page = renderDashboardPage(apiUrl);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(port, () => {
  console.log(`jina dashboard: http://localhost:${port}  (api: ${apiUrl})`);
});
