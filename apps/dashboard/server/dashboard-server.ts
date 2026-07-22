import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderDashboardPage } from "../app/page.js";
import { isAllowedDashboardApiRequest, retiredDashboardPathRedirectTarget } from "./proxy-policy.js";

export interface DashboardServerConfig {
  readonly apiUrl: string;
  readonly internalApiToken?: string;
}

/** Creates the dashboard HTTP server without binding a port. */
export function createDashboardServer(config: DashboardServerConfig): Server {
  const apiUrl = config.apiUrl;
  const internalApiToken = config.internalApiToken?.trim();
  const page = renderDashboardPage("/api", apiUrl);
  const contextGraphClient = readFileSync(fileURLToPath(new URL("../app/context-graph-client.js", import.meta.url)));

  const server = createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", "http://dashboard.internal");
    const redirectTarget = retiredDashboardPathRedirectTarget(incoming.pathname);
    if (redirectTarget) {
      response.writeHead(308, { location: `${redirectTarget}${incoming.search}` });
      response.end();
      return;
    }
    if (incoming.pathname.startsWith("/api/")) {
      proxyApiRequest(request, response, incoming);
      return;
    }
    if (incoming.pathname.startsWith("/assets/context-graph-client.js")) {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache"
      });
      response.end(request.method === "HEAD" ? undefined : contextGraphClient);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(request.method === "HEAD" ? undefined : page);
  });

  function proxyApiRequest(request: IncomingMessage, response: ServerResponse, incoming: URL): void {
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

  return server;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
