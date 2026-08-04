import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { DashboardProvider, TenantProvider } from "./providers";
import { Shell } from "./shell";
import "./theme.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Jina Simulation",
  description: "Reviews, bot status, and generated scenarios for Jina Simulation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <DashboardProvider>
          <TenantProvider>
            <Shell>{children}</Shell>
          </TenantProvider>
        </DashboardProvider>
      </body>
    </html>
  );
}
