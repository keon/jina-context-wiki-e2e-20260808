import { NextResponse, type NextRequest } from "next/server";
import { evaluateAdminAccess } from "./lib/admin-auth";

// Runs before every rendered route. Env is read inside the handler so it is
// evaluated at request time by the self-hosted Node server, not inlined.
export function middleware(request: NextRequest): NextResponse {
  const decision = evaluateAdminAccess({
    authRequired: Boolean(process.env.INTERNAL_API_TOKEN?.trim()),
    iapEmailHeader: request.headers.get("x-goog-authenticated-user-email"),
    allowlistRaw: process.env.JINA_ADMIN_ALLOWED_EMAILS
  });

  if (!decision.ok) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }
  return NextResponse.next();
}

export const config = {
  // Guard every route except Next's own static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
