import { NextResponse, type NextRequest } from "next/server";
import { evaluateAdminAccess } from "./lib/admin-auth";

// Runs before every rendered route. Env is read inside the handler so it is
// evaluated at request time by the self-hosted Node server, not inlined.
export function proxy(request: NextRequest): NextResponse {
  const decision = evaluateAdminAccess({
    authRequired: Boolean(process.env.INTERNAL_API_TOKEN?.trim() || process.env.JINA_GLOBAL_ADMIN_TOKEN?.trim()),
    authorizationHeader: request.headers.get("authorization"),
    webAuthUsername: process.env.JINA_WEB_AUTH_USERNAME,
    webAuthPassword: process.env.JINA_WEB_AUTH_PASSWORD
  });

  if (!decision.ok) {
    return NextResponse.json(
      { error: decision.error },
      {
        status: decision.status,
        ...(decision.status === 401
          ? { headers: { "www-authenticate": 'Basic realm="Jina Admin", charset="UTF-8"' } }
          : {})
      }
    );
  }
  const requestHeaders = new Headers(request.headers);
  // Never trust a caller-supplied actor. Replace it with the identity that
  // passed this app's Basic-auth boundary before forwarding internally.
  requestHeaders.set("x-jina-admin-actor-id", decision.actorId);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Guard every route except Next's own static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
