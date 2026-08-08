import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { dashboardAllowsLegacySession, dashboardProxyUsesClerk } from "../../../server/auth-mode.ts";
import {
  dashboardWebAuthorization,
  isAllowedDashboardApiRequest,
  isProductDashboardApiRequest,
  resolveDashboardPrincipal
} from "../../../server/proxy-policy.ts";

export const dynamic = "force-dynamic";

/**
 * Same-origin proxy in front of the Jina API, preserving the deployment
 * contract of the previous dashboard server: an allowlisted route policy, and
 * the internal service token only ever attached to requests carrying an
 * identity established by IAP or the Vercel app's HTTP authentication.
 * Conditional-request headers pass through untouched so browser ETag
 * revalidation works end to end.
 */

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "authorization",
  "cookie",
  "x-jina-web-authorization",
  "content-length",
  "accept-encoding",
  "x-jina-tenant-id",
  "x-jina-principal-id",
  "x-goog-authenticated-user-email"
]);

const STRIPPED_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "content-encoding", "content-length"]);

async function proxy(request: NextRequest): Promise<Response> {
  const apiUrl = process.env.JINA_API_URL ?? "http://localhost:4000";
  const internalApiToken = process.env.INTERNAL_API_TOKEN?.trim();
  const tenantId = process.env.JINA_TENANT_ID?.trim();
  const { pathname, search } = request.nextUrl;
  const productApiRequest = isProductDashboardApiRequest(request.method, pathname);
  if (!isAllowedDashboardApiRequest(request.method, pathname, Boolean(internalApiToken))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  if (productApiRequest) {
    const clerkAuth = dashboardProxyUsesClerk() ? await auth() : null;
    const token = clerkAuth?.isAuthenticated ? await clerkAuth.getToken() : null;
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (dashboardAllowsLegacySession()) {
      const legacySession = request.cookies.get("jina_dashboard_session");
      if (legacySession) headers.set("cookie", `${legacySession.name}=${legacySession.value}`);
    }
    if (!token && !headers.has("cookie")) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    const openRouterCookie = request.cookies.get("jina_openrouter_pkce");
    if (openRouterCookie) {
      const current = headers.get("cookie");
      headers.set("cookie", [current, `${openRouterCookie.name}=${openRouterCookie.value}`].filter(Boolean).join("; "));
    }
  } else {
    const principal = resolveDashboardPrincipal({
      iapEmailHeader: request.headers.get("x-goog-authenticated-user-email"),
      authorizationHeader: dashboardWebAuthorization(
        request.headers.get("authorization"),
        request.headers.get("x-jina-web-authorization")
      ),
      webAuthUsername: process.env.JINA_WEB_AUTH_USERNAME,
      webAuthPassword: process.env.JINA_WEB_AUTH_PASSWORD,
      webPrincipal: process.env.JINA_WEB_PRINCIPAL_ID
    });
    if (internalApiToken && !principal) {
      // The internal token authorizes as a tenant-admin service principal; never
      // attach it to a request that lacks an authenticated deployment boundary.
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (internalApiToken) {
      headers.set("authorization", `Bearer ${internalApiToken}`);
      headers.set("x-jina-principal-id", principal!);
      if (tenantId) headers.set("x-jina-tenant-id", tenantId);
    }
  }

  const upstreamUrl = new URL(`${pathname.slice("/api".length)}${search}`, apiUrl);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
      redirect: "manual",
      cache: "no-store"
    });
  } catch (error) {
    return Response.json(
      { error: "upstream API unavailable", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 }
    );
  }
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    responseHeaders.append(
      name,
      productApiRequest && name.toLowerCase() === "set-cookie"
        ? value.replace(/Path=\/dashboard(?:\/|;)/gi, (match) =>
            match.endsWith(";") ? "Path=/api/dashboard;" : "Path=/api/dashboard/"
          )
        : value
    );
  }
  return new Response(upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
