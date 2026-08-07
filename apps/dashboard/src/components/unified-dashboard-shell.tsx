"use client";

import { CodexHarnessProvider, DashboardProvider, TenantProvider } from "@dashboard/providers";
import { createDashboardQueryClient } from "@dashboard/lib/query-client";
import { Shell as ProductShell } from "@dashboard/shell";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function UnifiedDashboardShell({ children }: { readonly children: ReactNode }) {
  // One client for the life of the tab, created lazily in state rather than at
  // module scope: a module-level client would be shared between concurrent
  // server renders, and a client rebuilt per render would discard the cache on
  // every state change.
  const [queryClient] = useState(createDashboardQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider>
        <TenantProvider>
          {/* Above the shell so the shell's reconnect banner and the Models page share one read. */}
          <CodexHarnessProvider>
            <ProductShell>{children}</ProductShell>
          </CodexHarnessProvider>
        </TenantProvider>
      </DashboardProvider>
    </QueryClientProvider>
  );
}
