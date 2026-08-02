"use client";

import { DashboardProvider, TenantProvider } from "@jina-v1-dashboard/app/providers";
import { Shell as ProductShell } from "@jina-v1-dashboard/app/shell";
import type { ReactNode } from "react";

export function UnifiedDashboardShell({ children }: { readonly children: ReactNode }) {
  return (
    <DashboardProvider>
      <TenantProvider>
        <ProductShell>{children}</ProductShell>
      </TenantProvider>
    </DashboardProvider>
  );
}
