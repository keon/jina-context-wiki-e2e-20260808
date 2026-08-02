import { NextResponse, type NextRequest } from "next/server";
import { dashboardWebAuthorization, isValidBasicAuthorization } from "./server/proxy-policy";

export function proxy(request: NextRequest): NextResponse {
  if (!process.env.INTERNAL_API_TOKEN?.trim()) return NextResponse.next();

  // Existing Google Cloud deployments continue to rely on IAP. Vercel uses
  // app-level HTTP authentication because production Vercel Authentication is
  // not available for this project plan.
  if (request.headers.get("x-goog-authenticated-user-email")) return NextResponse.next();
  if (
    isValidBasicAuthorization(
      dashboardWebAuthorization(request.headers.get("authorization"), request.headers.get("x-jina-web-authorization")),
      process.env.JINA_WEB_AUTH_USERNAME,
      process.env.JINA_WEB_AUTH_PASSWORD
    )
  ) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Jina Dashboard", charset="UTF-8"' }
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
