import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { UnifiedDashboardShell } from "../components/unified-dashboard-shell.tsx";
import "../v1/theme.css";
import "../v1/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jina",
  description: "Code reviews, Context, models, billing, integrations, and operational workflows."
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <UnifiedDashboardShell>{children}</UnifiedDashboardShell>
      </body>
    </html>
  );
}
