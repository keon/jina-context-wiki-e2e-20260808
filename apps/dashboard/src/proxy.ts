import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { dashboardProxyUsesClerk } from "./server/auth-mode";

const dashboardProxy = dashboardProxyUsesClerk() ? clerkMiddleware() : () => NextResponse.next();

export default dashboardProxy;

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)"
  ]
};
