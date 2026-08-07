import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { dashboardProxyUsesClerk } from "./server/auth-mode";
import { stagingDevelopmentAuthRedirect } from "./server/staging-auth-origin";

const dashboardProxy = dashboardProxyUsesClerk() ? clerkMiddleware() : () => NextResponse.next();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const redirect = stagingDevelopmentAuthRedirect(request.nextUrl);
  if (redirect) return NextResponse.redirect(redirect);

  return dashboardProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)"
  ]
};
