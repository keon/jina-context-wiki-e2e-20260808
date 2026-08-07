import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { dashboardProxyUsesClerk } from "./server/auth-mode";
import { stagingClerkAuthOptions } from "./server/staging-auth-origin";

const dashboardProxy = dashboardProxyUsesClerk()
  ? clerkMiddleware(
      () => NextResponse.next(),
      (request) => stagingClerkAuthOptions(request.nextUrl.hostname) ?? {}
    )
  : () => NextResponse.next();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  return dashboardProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)"
  ]
};
