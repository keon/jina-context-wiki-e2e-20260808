import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppAuthProvider } from "../components/auth/app-auth.tsx";
import { UnifiedDashboardShell } from "../components/unified-dashboard-shell.tsx";
import "../dashboard/theme.css";
import "../dashboard/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina",
  description: "Code reviews, Context, models, billing, integrations, and operational workflows."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AppAuthProvider>
          <UnifiedDashboardShell>{children}</UnifiedDashboardShell>
        </AppAuthProvider>
      </body>
    </html>
  );
}
