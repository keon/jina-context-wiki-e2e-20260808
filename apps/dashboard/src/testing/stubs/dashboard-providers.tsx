import type { ReactNode } from "react";
import type { CodexHarnessInfo } from "../../dashboard/lib/codex-harness.ts";
import type { TenantQueryScope } from "../../dashboard/lib/query-keys.ts";
import type { SelectedTenant, ViewerTenant } from "../../dashboard/lib/tenants.ts";
import type { DashboardFilters, DashboardResponse, ViewerResponse } from "../../dashboard/lib/types.ts";

/**
 * Stands in for `src/dashboard/providers.tsx` (see `module-stubs.mjs`).
 *
 * The real providers own a viewer fetch, a tenant fetch, two polling schedulers
 * and a fail-closed cache eviction path. None of that is what the page-level
 * regressions here are about: every one of them is a page choosing which of
 * `{ data, loading, error }` — or which of "a workspace is selected" and "none
 * is" — to render. Driving those four inputs directly is the whole point, and it
 * keeps a render test off the network.
 *
 * Consumers import the same specifiers they ship with (`../providers`,
 * `../../dashboard/providers.tsx`); both resolve to the real module's URL, which
 * the loader hook rewrites to this file.
 */

interface DashboardState {
  data: DashboardResponse | null;
  viewer: ViewerResponse | null;
  error: string | null;
  loading: boolean;
  authLoading: boolean;
  authRequired: boolean;
  sessionError: string | null;
  filters: DashboardFilters;
}

const INITIAL_DASHBOARD: DashboardState = {
  data: null,
  viewer: null,
  error: null,
  loading: true,
  authLoading: false,
  authRequired: false,
  sessionError: null,
  filters: { project: "", team: "" }
};

interface TenantState {
  tenants: ViewerTenant[];
  switcherVisible: boolean;
  selected: SelectedTenant | null;
  ready: boolean;
  legacyReviewMode: boolean;
  accessError: string | null;
  fenceVersion: number;
}

const INITIAL_TENANT: TenantState = {
  tenants: [],
  switcherVisible: false,
  selected: null,
  ready: true,
  legacyReviewMode: true,
  accessError: null,
  fenceVersion: 0
};

let dashboardState: DashboardState = { ...INITIAL_DASHBOARD };
let tenantState: TenantState = { ...INITIAL_TENANT };
let harnessState: CodexHarnessInfo = { configured: false };
let reloadViewerCalls = 0;
let retryDiscoveryCalls = 0;

/** Sets what `useDashboard()` reports for the next render. */
export function setDashboardState(patch: Partial<DashboardState>): void {
  dashboardState = { ...dashboardState, ...patch };
}

/** Sets what `useTenant()` / `useTenantQueryScope()` report for the next render. */
export function setTenantState(patch: Partial<TenantState>): void {
  tenantState = { ...tenantState, ...patch };
}

export function setCodexHarnessState(patch: CodexHarnessInfo): void {
  harnessState = patch;
}

/** Returns both doubles to their defaults. Call between tests. */
export function resetProviderStubs(): void {
  dashboardState = { ...INITIAL_DASHBOARD };
  tenantState = { ...INITIAL_TENANT };
  harnessState = { configured: false };
  reloadViewerCalls = 0;
  retryDiscoveryCalls = 0;
}

export function reloadViewerCallCount(): number {
  return reloadViewerCalls;
}

export function retryDiscoveryCallCount(): number {
  return retryDiscoveryCalls;
}

/* The surface the real module exports, in the shapes its consumers destructure. */

export function DashboardProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function TenantProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function CodexHarnessProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useDashboard() {
  return {
    ...dashboardState,
    setFilters: (filters: DashboardFilters) => setDashboardState({ filters }),
    reload: () => undefined,
    reloadViewer: () => {
      reloadViewerCalls += 1;
    },
    setTenantScope: () => undefined
  };
}

export function useTenant() {
  return {
    ...tenantState,
    selectTenant: () => undefined,
    addTenant: () => undefined,
    updateTenant: () => undefined,
    retryDiscovery: () => {
      retryDiscoveryCalls += 1;
    }
  };
}

export function useCodexHarness() {
  return {
    harness: harnessState,
    ready: true,
    setHarness: (info: CodexHarnessInfo) => setCodexHarnessState(info),
    reload: () => undefined
  };
}

export function useTenantFence(): (requestTenantId: string | null) => boolean {
  return (requestTenantId) => requestTenantId === (tenantState.selected?.tenantId ?? null);
}

export function useTenantQueryScope(): TenantQueryScope {
  return {
    viewerUserId: dashboardState.viewer?.user?.id ?? null,
    fenceVersion: tenantState.fenceVersion,
    tenantId: tenantState.selected?.tenantId ?? null
  };
}
