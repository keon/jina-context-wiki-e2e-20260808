"use client";

import { DashboardProvider, TenantProvider } from "@jina-v1-dashboard/app/providers";
import { Shell as ProductShell } from "@jina-v1-dashboard/app/shell";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isOperationsPath } from "../lib/dashboard-routes.ts";
import { ConnectionIndicator, PageNav } from "./chrome.tsx";

export function UnifiedDashboardShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();

  if (isOperationsPath(pathname)) {
    return (
      <main className="shell">
        <header className="app-header">
          <div className="topbar">
            <div className="brand-lockup">
              <span className="brand-mark" aria-hidden="true">
                J
              </span>
              <span className="brand-name">Jina</span>
            </div>
            <PageNav />
            <ConnectionIndicator apiLabel="Context API" />
          </div>
        </header>
        {children}
      </main>
    );
  }

  return (
    <DashboardProvider>
      <TenantProvider>
        <ProductShell>{children}</ProductShell>
      </TenantProvider>
    </DashboardProvider>
  );
}
