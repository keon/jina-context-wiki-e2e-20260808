import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { renderDashboardPage } from "../app/page.js";

const port = Number(process.env.PORT ?? 3000);
const apiUrl = process.env.JINA_API_URL ?? "http://localhost:4000";
const internalApiToken = process.env.INTERNAL_API_TOKEN?.trim();
const page = renderDashboardPage("/api", apiUrl);

const server = createServer((request, response) => {
  if ((request.url ?? "").startsWith("/api/")) {
    proxyApiRequest(request, response);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.method === "HEAD" ? undefined : page);
});

server.listen(port, () => {
  console.log(`jina dashboard: http://localhost:${port}  (api: ${apiUrl})`);
});

function proxyApiRequest(request: IncomingMessage, response: ServerResponse): void {
  const incoming = new URL(request.url ?? "/api/", "http://dashboard.internal");
  const allowedRead = request.method === "GET" && (
    incoming.pathname === "/api/board" ||
    incoming.pathname === "/api/events" ||
    incoming.pathname === "/api/task-types" ||
    incoming.pathname === "/api/ontology" ||
    incoming.pathname.startsWith("/api/ontology/graphs/")
  );
  const allowedLocalDemo = !internalApiToken && request.method === "POST" && incoming.pathname === "/api/dev/webhooks/github";
  const allowedOntologyQuery = request.method === "POST" && (
    incoming.pathname === "/api/ontology/ask" || incoming.pathname === "/api/ontology/retrieve"
  );
  if (!allowedRead && !allowedLocalDemo && !allowedOntologyQuery) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"not found"}');
    return;
  }
  const upstreamUrl = new URL(`${incoming.pathname.slice(4)}${incoming.search}`, apiUrl);
  const headers = { ...request.headers };
  const iapEmail = firstHeader(request.headers["x-goog-authenticated-user-email"])
    ?.replace(/^accounts\.google\.com:/i, "").trim().toLowerCase();
  delete headers.host;
  delete headers.connection;
  delete headers.authorization;
  delete headers["x-jina-tenant-id"];
  delete headers["x-jina-principal-id"];
  delete headers["x-goog-authenticated-user-email"];
  if (internalApiToken) headers.authorization = `Bearer ${internalApiToken}`;
  if (internalApiToken && iapEmail && /^[^\s@]+@[^\s@]+$/.test(iapEmail)) {
    headers["x-jina-principal-id"] = `user:${iapEmail}`;
  }
  const upstreamRequest = (upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest)(
    upstreamUrl,
    { method: request.method, headers },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );
  upstreamRequest.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "upstream API unavailable", detail: error.message }));
  });
  request.pipe(upstreamRequest);
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
