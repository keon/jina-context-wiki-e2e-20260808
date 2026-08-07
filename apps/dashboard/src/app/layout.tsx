import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppAuthProvider } from "../components/auth/app-auth.tsx";
import { UnifiedDashboardShell } from "../components/unified-dashboard-shell.tsx";
import { requestHostname, stagingClerkAuthOptions } from "../server/staging-auth-origin.ts";
import "@jina/theme/theme.css";
import "../dashboard/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina",
  description: "Code reviews, Wiki, models, billing, integrations, and operational workflows."
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const requestHeaders = await headers();
  const hostname = requestHostname(requestHeaders.get("x-forwarded-host"), requestHeaders.get("host"));
  const clerkOptions = stagingClerkAuthOptions(hostname);

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AppAuthProvider {...(clerkOptions ? { clerkOptions } : {})}>
          <UnifiedDashboardShell>{children}</UnifiedDashboardShell>
        </AppAuthProvider>
      </body>
    </html>
  );
}
