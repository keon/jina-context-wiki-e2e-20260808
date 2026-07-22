import { NextResponse, type NextRequest } from "next/server";
import { evaluateAdminAccess } from "./lib/admin-auth";

// Runs before every rendered route. Env is read inside the handler so it is
// evaluated at request time by the self-hosted Node server, not inlined.
export function middleware(request: NextRequest): NextResponse {
  const decision = evaluateAdminAccess({
    authRequired: Boolean(process.env.INTERNAL_API_TOKEN?.trim()),
    iapEmailHeader: request.headers.get("x-goog-authenticated-user-email"),
    allowlistRaw: process.env.JINA_ADMIN_ALLOWED_EMAILS,
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
  return NextResponse.next();
}

export const config = {
  // Guard every route except Next's own static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
