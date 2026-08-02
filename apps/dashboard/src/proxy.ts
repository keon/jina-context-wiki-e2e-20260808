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
  // Product routes authenticate with the v1 API's GitHub OAuth session and
  // must remain reachable before that session exists. The operational views
  // and their privileged same-origin API proxy retain the existing deployment
  // boundary until v2 has a customer-session token exchange of its own.
  matcher: ["/board/:path*", "/history/:path*", "/tasks/:path*", "/operations/:path*", "/api/:path*"]
};
