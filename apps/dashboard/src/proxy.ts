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
  });
}

export const config = {
  // Every page is now gated by the v1 API's GitHub OAuth session. Retain the
  // legacy same-origin API boundary for old clients, but do not emit a browser
  // Basic-Auth challenge: the merged UI no longer uses this proxy.
  matcher: ["/api/:path*"]
};
