import { NextResponse, type NextRequest } from "next/server";
import { evaluateAdminAccess } from "./lib/admin-auth";

// Runs before every rendered route. Credential env is read inside the handler so
// it is evaluated at request time by the self-hosted Node server, not inlined.
//
// `NODE_ENV` is the deliberate exception: Next inlines it at build time, so the
// unauthenticated local-development path is compiled out of every deployed
// image and cannot be re-enabled by a runtime environment variable.
const ALLOW_UNAUTHENTICATED_LOCAL_DEV = process.env.NODE_ENV !== "production";

export function proxy(request: NextRequest): NextResponse {
  const decision = evaluateAdminAccess({
    authorizationHeader: request.headers.get("authorization"),
    webAuthUsername: process.env.JINA_WEB_AUTH_USERNAME,
    webAuthPassword: process.env.JINA_WEB_AUTH_PASSWORD,
    allowUnauthenticatedLocalDev: ALLOW_UNAUTHENTICATED_LOCAL_DEV
  });

  if (!decision.ok) {
    if (decision.status === 503) {
      console.error(
        "[admin] refusing every request: %s (set JINA_WEB_AUTH_USERNAME and JINA_WEB_AUTH_PASSWORD)",
        decision.error
      );
    }
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
