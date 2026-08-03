import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "authorization",
  "cookie",
  "content-length",
  "accept-encoding",
]);
const STRIPPED_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "content-encoding", "content-length"]);

async function proxy(request: NextRequest): Promise<Response> {
  const { isAuthenticated, getToken } = await auth();
  if (!isAuthenticated) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const token = await getToken();
  if (!token) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const apiOrigin = process.env.JINA_LEGACY_API_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!apiOrigin) return Response.json({ error: "legacy API is not configured" }, { status: 503 });
  const upstreamPath = request.nextUrl.pathname.slice("/legacy-api".length);
  const upstreamUrl = new URL(`${upstreamPath}${request.nextUrl.search}`, apiOrigin);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  const openRouterCookie = request.cookies.get("jina_openrouter_pkce");
  if (openRouterCookie) headers.set("cookie", `${openRouterCookie.name}=${openRouterCookie.value}`);
  headers.set("authorization", `Bearer ${token}`);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    return Response.json(
      { error: "legacy API unavailable", detail: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    responseHeaders.append(
      name,
      name.toLowerCase() === "set-cookie" ? value.replace(/Path=\/v1\//gi, "Path=/legacy-api/v1/") : value,
    );
  }
  return new Response(upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
