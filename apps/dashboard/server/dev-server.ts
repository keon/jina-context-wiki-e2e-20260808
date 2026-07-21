import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderDashboardPage } from "../app/page.js";
import { isAllowedDashboardApiRequest } from "./proxy-policy.js";

const port = Number(process.env.PORT ?? 3000);
const apiUrl = process.env.JINA_API_URL ?? "http://localhost:4000";
const internalApiToken = process.env.INTERNAL_API_TOKEN?.trim();
const page = renderDashboardPage("/api", apiUrl);
const ontologyGraphClient = readFileSync(fileURLToPath(new URL("../app/ontology-graph-client.js", import.meta.url)));

const server = createServer((request, response) => {
  if ((request.url ?? "").startsWith("/api/")) {
    proxyApiRequest(request, response);
    return;
  }
  if ((request.url ?? "").startsWith("/assets/ontology-graph-client.js")) {
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache"
    });
    response.end(request.method === "HEAD" ? undefined : ontologyGraphClient);
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(request.method === "HEAD" ? undefined : page);
});

server.listen(port, () => {
  console.log(`jina dashboard: http://localhost:${port}  (api: ${apiUrl})`);
});

function proxyApiRequest(request: IncomingMessage, response: ServerResponse): void {
  const incoming = new URL(request.url ?? "/api/", "http://dashboard.internal");
  if (!isAllowedDashboardApiRequest(request.method, incoming.pathname, Boolean(internalApiToken))) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"not found"}');
    return;
  }
  const upstreamUrl = new URL(`${incoming.pathname.slice(4)}${incoming.search}`, apiUrl);
  const headers = { ...request.headers };
  const iapEmail = firstHeader(request.headers["x-goog-authenticated-user-email"])
    ?.replace(/^accounts\.google\.com:/i, "")
    .trim()
    .toLowerCase();
  delete headers.host;
  delete headers.connection;
  delete headers.authorization;
  delete headers["x-jina-tenant-id"];
  delete headers["x-jina-principal-id"];
  delete headers["x-goog-authenticated-user-email"];
  const validIapEmail = iapEmail && /^[^\s@]+@[^\s@]+$/.test(iapEmail) ? iapEmail : undefined;
  if (internalApiToken && !validIapEmail) {
    // The internal token authorizes as a tenant-admin service principal; never
    // attach it to a request that lacks a validated IAP identity.
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"unauthenticated"}');
    return;
  }
  if (internalApiToken) {
    headers.authorization = `Bearer ${internalApiToken}`;
    headers["x-jina-principal-id"] = `user:${validIapEmail}`;
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
