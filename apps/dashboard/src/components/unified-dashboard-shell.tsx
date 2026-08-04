"use client";

import { DashboardProvider, TenantProvider } from "@dashboard/providers";
import { Shell as ProductShell } from "@dashboard/shell";
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
