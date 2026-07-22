import type { NextRequest } from "next/server";
import { isAllowedDashboardApiRequest } from "../../../server/proxy-policy.ts";

export const dynamic = "force-dynamic";

/**
 * Same-origin proxy in front of the Jina API, preserving the deployment
 * contract of the previous dashboard server: an allowlisted route policy, and
 * the internal service token only ever attached to requests carrying a
 * validated IAP identity. Conditional-request headers pass through untouched
 * so browser ETag revalidation works end to end.
 */

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "authorization",
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
  const { pathname, search } = request.nextUrl;
  if (!isAllowedDashboardApiRequest(request.method, pathname, Boolean(internalApiToken))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  const iapEmail = request.headers
    .get("x-goog-authenticated-user-email")
    ?.replace(/^accounts\.google\.com:/i, "")
    .trim()
    .toLowerCase();
  const validIapEmail = iapEmail && /^[^\s@]+@[^\s@]+$/.test(iapEmail) ? iapEmail : undefined;
  if (internalApiToken && !validIapEmail) {
    // The internal token authorizes as a tenant-admin service principal; never
    // attach it to a request that lacks a validated IAP identity.
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (internalApiToken) {
    headers.set("authorization", `Bearer ${internalApiToken}`);
    headers.set("x-jina-principal-id", `user:${validIapEmail}`);
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
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
  }
  return new Response(upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

export { proxy as GET, proxy as POST };
