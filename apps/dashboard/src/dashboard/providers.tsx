"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiUrl, reviewRunsPath } from "./lib/api";
import { startCompletionPolling } from "./lib/completion-polling";
import {
  shouldDiscardDashboardData,
  shouldShowDashboardLoading,
  type DashboardReloadOptions,
} from "./lib/dashboard-refresh";
import { localDashboardFixtureEnabled, localViewerFixture, mergeLocalDashboardFixture } from "./lib/local-fixture";
import type { DashboardFilters, DashboardResponse, ViewerResponse } from "./lib/types";
import {
  isResponseForCurrentTenant,
  normalizeViewerTenants,
  resolveSelectedTenant,
  sortViewerTenants,
  tenantStorageKey,
  type SelectedTenant,
  type ViewerTenant,
} from "./lib/tenants";
import { invalidateViewerSession, reconcileSessionRefresh } from "./lib/viewer-session";

type DashboardContextValue = {
  data: DashboardResponse | null;
  viewer: ViewerResponse | null;
  error: string | null;
  loading: boolean;
  authLoading: boolean;
  authRequired: boolean;
  filters: DashboardFilters;
  setFilters: (filters: DashboardFilters) => void;
  reload: () => void;
  reloadViewer: () => void;
  setTenantScope: (tenantId: string | null, ready: boolean) => void;
};

const emptyFilters: DashboardFilters = { project: "", team: "" };
type DashboardTenantScope = { tenantId: string | null; ready: boolean; version: number };
const initialTenantScope: DashboardTenantScope = { tenantId: null, ready: false, version: 0 };

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [viewer, setViewer] = useState<ViewerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(true);
  const [filters, setFilters] = useState<DashboardFilters>(emptyFilters);
  const [tenantScope, setTenantScopeState] = useState<DashboardTenantScope>(initialTenantScope);

  const viewerAbortRef = useRef<AbortController | null>(null);
  const reloadAbortRef = useRef<AbortController | null>(null);
  const viewerRef = useRef<ViewerResponse | null>(null);
  const tenantScopeRef = useRef<DashboardTenantScope>(initialTenantScope);
  viewerRef.current = viewer;

  const setTenantScope = useCallback((tenantId: string | null, ready: boolean) => {
    const current = tenantScopeRef.current;
    if (current.tenantId === tenantId && current.ready === ready) return;
    const next = { tenantId, ready, version: current.version + 1 };
    tenantScopeRef.current = next;
    reloadAbortRef.current?.abort();
    setData(null);
    setFilters(emptyFilters);
    setLoading(ready);
    setTenantScopeState(next);
  }, []);

  const reloadViewer = useCallback(async () => {
    viewerAbortRef.current?.abort();
    reloadAbortRef.current?.abort();
    const controller = new AbortController();
    viewerAbortRef.current = controller;
    setAuthLoading(true);
    setData(null);
    const current = () => viewerAbortRef.current === controller && !controller.signal.aborted;
    try {
      const localViewer = localViewerFixture();
      if (localViewer) {
        if (!current()) return;
        setViewer(localViewer);
        setError(null);
        return;
      }
      const response = await fetch(apiUrl("/dashboard/me"), {
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
      });
      if (response.status === 401) {
        if (!current()) return;
        setViewer({
          auth: { mode: "clerk", enabled: true },
          authenticated: false,
          organizations: [],
          teams: [],
          projects: [],
        });
        setError(null);
        return;
      }
      if (!response.ok) {
        throw new Error(`Dashboard auth returned ${response.status}`);
      }
      const nextViewer = (await response.json()) as ViewerResponse;
      if (!current()) return;
      setViewer(nextViewer);
      setError(null);
    } catch (loadError) {
      if (!current()) return;
      const fixture = localViewerFixture();
      if (fixture) {
        setViewer(fixture);
        setError(null);
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (viewerAbortRef.current === controller) {
        viewerAbortRef.current = null;
        setAuthLoading(false);
      }
    }
  }, []);

  const reload = useCallback(async ({ background = false }: DashboardReloadOptions = {}) => {
    if (!tenantScope.ready) return;
    reloadAbortRef.current?.abort();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    const requestScope = tenantScope;
    const expectedUserId = viewerRef.current?.user?.id;
    if (shouldShowDashboardLoading({ background })) setLoading(true);
    const current = () =>
      reloadAbortRef.current === controller &&
      !controller.signal.aborted &&
      tenantScopeRef.current.version === requestScope.version;
    try {
      if (localDashboardFixtureEnabled()) {
        if (!current()) return;
        setData(mergeLocalDashboardFixture(null));
        setError(null);
        return;
      }
      // An authenticated dashboard must never fall back to the legacy viewer-wide feed if tenant
      // discovery unexpectedly returns no workspace.
      if (!requestScope.tenantId && viewerRef.current?.auth.enabled) {
        if (!current()) return;
        setData(null);
        setError("No Jina organization is available for this account.");
        return;
      }
      const params = new URLSearchParams();
      if (filters.project) params.set("project", filters.project);
      if (filters.team) params.set("team", filters.team);
      const path = reviewRunsPath(requestScope.tenantId);
      const response = await fetch(apiUrl(path, params), {
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
      });
      if (response.status === 401) {
        if (!current()) return;
        setData(localDashboardFixtureEnabled() ? mergeLocalDashboardFixture(null) : null);
        setViewer((currentViewer) => invalidateViewerSession(currentViewer, expectedUserId));
        setError(null);
        return;
      }
      if (!response.ok) {
        // Authorization failures invalidate the last successful response. For
        // transient API/network failures, keep it visible while surfacing the
        // error and retrying in the background.
        if (shouldDiscardDashboardData(response.status) && current()) setData(null);
        throw new Error(`Dashboard API returned ${response.status}`);
      }
      const nextData = mergeLocalDashboardFixture((await response.json()) as DashboardResponse);
      if (!current()) return;
      setData(nextData);
      setError(null);
    } catch (loadError) {
      if (!current()) return;
      if (localDashboardFixtureEnabled()) {
        setData(mergeLocalDashboardFixture(null));
        setError(null);
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (reloadAbortRef.current === controller) {
        reloadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [filters.project, filters.team, tenantScope]);

  useEffect(() => {
    void reloadViewer();
  }, [reloadViewer]);

  useEffect(() => {
    return () => {
      viewerAbortRef.current?.abort();
      reloadAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!viewer || !tenantScope.ready) return;
    if (viewer.auth.enabled && !viewer.authenticated) {
      setLoading(false);
      setData(null);
      return;
    }
    const polling = startCompletionPolling(() => reload({ background: true }), 10_000);
    return () => polling.stop();
  }, [reload, tenantScope.ready, viewer?.auth.enabled, viewer?.authenticated, viewer?.user?.id]);

  const hasDashboardData = Boolean(data);
  useEffect(() => {
    if (!hasDashboardData || !viewer?.authenticated || !viewer.user) return;

    let controller: AbortController | undefined;
    const expectedUserId = viewer.user.id;
    const refreshAccess = async () => {
      controller?.abort();
      controller = new AbortController();
      const response = await fetch(apiUrl("/dashboard/session/refresh"), {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const refreshed = (await response.json()) as ViewerResponse;
      if (!controller.signal.aborted) {
        setViewer((current) => reconcileSessionRefresh(current, expectedUserId, refreshed));
      }
    };

    // GitHub membership/repository refresh is deliberately deferred until the
    // first dashboard response is visible, then refreshed at a low frequency.
    const polling = startCompletionPolling(refreshAccess, 5 * 60_000);
    return () => {
      polling.stop();
      controller?.abort();
    };
  }, [hasDashboardData, viewer?.authenticated, viewer?.user?.id]);

  const value = useMemo<DashboardContextValue>(
    () => ({
      data,
      viewer,
      error,
      loading,
      authLoading,
      authRequired: Boolean(viewer?.auth.enabled && !viewer.authenticated),
      filters,
      setFilters,
      reload: () => void reload(),
      reloadViewer: () => void reloadViewer(),
      setTenantScope,
    }),
    [data, viewer, error, loading, authLoading, filters, reload, reloadViewer, setTenantScope],
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error("useDashboard must be used within a DashboardProvider");
  }
  return context;
}

/* ------------------------------------------------------------------ tenants --- */

type TenantContextValue = {
  // All tenants the viewer belongs to (personal first). Empty when the fetch
  // failed or hasn't resolved — see `switcherVisible`.
  tenants: ViewerTenant[];
  // Whether to render the workspace menu: the /tenants fetch succeeded and
  // there is an active workspace. The menu also exposes organization creation.
  switcherVisible: boolean;
  // The active tenant, or null while tenant loading failed/unresolved or the
  // viewer has no tenant. Authenticated pages never use a legacy viewer-wide
  // route merely because this is null.
  selected: SelectedTenant | null;
  // True once tenant discovery has completed for the current viewer.
  ready: boolean;
  // Only auth-disabled development and the explicit local fixture may use the
  // backward-compatible viewer-wide review endpoints.
  legacyReviewMode: boolean;
  selectTenant: (tenantId: string) => void;
  addTenant: (tenant: ViewerTenant) => void;
  updateTenant: (tenant: ViewerTenant) => void;
  // Increments when tenant authorization is lost, invalidating in-flight page requests even if both
  // the old and new selections use the legacy null scope.
  fenceVersion: number;
};

const TenantContext = createContext<TenantContextValue | null>(null);

function readStoredTenantId(viewerUserId: number | null): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(tenantStorageKey(viewerUserId));
  } catch {
    return null;
  }
}

function writeStoredTenantId(viewerUserId: number | null, tenantId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(tenantStorageKey(viewerUserId), tenantId);
  } catch {
    /* storage disabled — selection simply won't persist */
  }
}

/**
 * Fetches the viewer's tenants while authenticated and exposes the switcher's
 * selection. Periodic and focus refreshes surface new installations and org
 * memberships without requiring a reload or re-login. Mounted at shell level,
 * inside DashboardProvider.
 */
export function TenantProvider({ children }: { children: ReactNode }) {
  const { viewer, authRequired, authLoading, reloadViewer, setTenantScope } = useDashboard();
  const [tenants, setTenants] = useState<ViewerTenant[]>([]);
  // False until a successful fetch. Authenticated review reads stay blocked on failure;
  // only explicit auth-disabled/local-fixture mode may use the legacy viewer-wide feed.
  const [loaded, setLoaded] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [fenceVersion, setFenceVersion] = useState(0);
  // The viewer id the current tenants/selection belong to; null before any fetch or after sign-out.
  const fetchedForUserRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reloadViewerRef = useRef(reloadViewer);
  reloadViewerRef.current = reloadViewer;

  const authenticated = Boolean(viewer && !authRequired);
  const viewerUserId = viewer?.user?.id ?? null;
  const legacyReviewMode = Boolean(viewer && (!viewer.auth.enabled || localDashboardFixtureEnabled()));

  useEffect(() => {
    if (authLoading) return;

    if (legacyReviewMode) {
      setTenantScope(null, true);
      return;
    }

    // Sign-out / unauthenticated: drop the previous viewer's tenants and selection so a different
    // account signing in later can never read or write against them (FINDING 2).
    if (!authenticated || viewerUserId == null) {
      setTenantScope(null, false);
      if (fetchedForUserRef.current !== null) {
        fetchedForUserRef.current = null;
        abortRef.current?.abort();
        setTenants([]);
        setLoaded(false);
        setSelectedTenantId(null);
      }
      return;
    }

    if (fetchedForUserRef.current !== viewerUserId) {
      fetchedForUserRef.current = viewerUserId;
      abortRef.current?.abort();
      // Clear the prior viewer's state immediately and adopt THIS viewer's namespaced stored selection.
      setTenants([]);
      setLoaded(false);
      setSelectedTenantId(readStoredTenantId(viewerUserId));
      setTenantScope(null, false);
    }

    let accessDenied = false;
    const refresh = async () => {
      if (accessDenied) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(apiUrl("/dashboard/tenants"), {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
          fetchedForUserRef.current = null;
          setTenants([]);
          setLoaded(false);
          setSelectedTenantId(null);
          setFenceVersion((version) => version + 1);
          setTenantScope(null, false);
          reloadViewerRef.current();
          return;
        }
        if (response.status === 403) {
          if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
          accessDenied = true;
          setTenants([]);
          setLoaded(false);
          setSelectedTenantId(null);
          setFenceVersion((version) => version + 1);
          setTenantScope(null, false);
          return;
        }
        if (!response.ok) throw new Error(`Tenants returned ${response.status}`);
        const nextTenants = normalizeViewerTenants(await response.json());
        if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
        setTenants((current) =>
          current.length === nextTenants.length &&
          current.every((tenant, index) => {
            const next = nextTenants[index];
            return (
              next &&
              tenant.tenant_id === next.tenant_id &&
              tenant.login === next.login &&
              tenant.type === next.type &&
              tenant.role === next.role &&
              tenant.clerk_organization_id === next.clerk_organization_id
            );
          })
            ? current
            : nextTenants,
        );
        // A failed refresh clears the in-memory selection to revoke access immediately. Once
        // discovery succeeds again, restore this viewer's last explicit selection when possible.
        setSelectedTenantId((current) => current ?? readStoredTenantId(viewerUserId));
        setLoaded(true);
      } catch {
        if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
        // 401/403 responses are handled above and fail closed. Keep the last
        // successful workspace across transient API/network failures so a
        // background membership refresh cannot blank the dashboard.
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    };

    const polling = startCompletionPolling(refresh, 30_000);
    return () => {
      polling.stop();
      abortRef.current?.abort();
    };
  }, [authLoading, authenticated, legacyReviewMode, viewerUserId, setTenantScope]);

  const selectTenant = useCallback(
    (tenantId: string) => {
      setTenantScope(tenantId, true);
      setSelectedTenantId(tenantId);
      writeStoredTenantId(viewerUserId, tenantId);
    },
    [viewerUserId, setTenantScope],
  );

  const addTenant = useCallback(
    (tenant: ViewerTenant) => {
      if (viewerUserId == null || fetchedForUserRef.current !== viewerUserId) return;
      // A discovery request started before creation can only contain the old tenant list.
      // Cancel it before applying the authoritative create response so it cannot revert selection.
      abortRef.current?.abort();
      setTenants((current) =>
        sortViewerTenants([
          ...current.filter((candidate) => candidate.tenant_id !== tenant.tenant_id),
          tenant,
        ]),
      );
      setLoaded(true);
      setTenantScope(tenant.tenant_id, true);
      setSelectedTenantId(tenant.tenant_id);
      writeStoredTenantId(viewerUserId, tenant.tenant_id);
    },
    [viewerUserId, setTenantScope],
  );

  const updateTenant = useCallback(
    (tenant: ViewerTenant) => {
      if (viewerUserId == null || fetchedForUserRef.current !== viewerUserId) return;
      // Do not let a tenant discovery request that started before this write
      // restore the old display name after the authoritative response arrives.
      abortRef.current?.abort();
      setTenants((current) =>
        sortViewerTenants(
          current.map((candidate) =>
            candidate.tenant_id === tenant.tenant_id ? tenant : candidate,
          ),
        ),
      );
    },
    [viewerUserId],
  );

  const active = useMemo(
    () => (loaded && tenants.length > 0 ? resolveSelectedTenant(tenants, selectedTenantId) : null),
    [loaded, tenants, selectedTenantId],
  );
  // Resolve a tenant whenever the viewer has one, independent of whether the
  // switcher is visible. This keeps billing and every other tenant surface explicit.
  // Dashboard data refreshes every ten seconds, which also re-renders this
  // provider. Keep the selected workspace referentially stable while its
  // membership data is unchanged; tenant-scoped pages key their loading
  // effects on this object and would otherwise blank and refetch on every
  // unrelated dashboard poll.
  const selected = useMemo<SelectedTenant | null>(
    () =>
      active
        ? {
            tenantId: active.tenant_id,
            login: active.login,
            type: active.type,
            role: active.role,
            ...(active.clerk_organization_id ? { clerkOrganizationId: active.clerk_organization_id } : {}),
          }
        : null,
    [active],
  );

  useEffect(() => {
    if (viewer?.auth.enabled && !legacyReviewMode) {
      setTenantScope(selected?.tenantId ?? null, loaded);
    }
  }, [legacyReviewMode, loaded, selected?.tenantId, setTenantScope, viewer?.auth.enabled]);

  const value = useMemo<TenantContextValue>(() => {
    const switcherVisible = loaded && tenants.length > 0;
    return {
      tenants,
      switcherVisible,
      selected,
      ready: legacyReviewMode || loaded,
      legacyReviewMode,
      selectTenant,
      addTenant,
      updateTenant,
      fenceVersion,
    };
  }, [legacyReviewMode, loaded, tenants, selected, selectTenant, addTenant, updateTenant, fenceVersion]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenant must be used within a TenantProvider");
  }
  return context;
}

/**
 * Fence tenant-scoped async responses (FINDING 3): capture the selected tenant id when a request
 * starts, then call the returned predicate after it resolves — it returns false when the viewer has
 * since switched tenants, so a response initiated under tenant A is never applied to tenant B's view.
 * The predicate stays stable within a viewer/session scope and reads the latest
 * tenant through a ref. A viewer/auth transition changes its identity so effects
 * also reload when both the old and new tenant IDs are null.
 */
export function useTenantFence(): (requestTenantId: string | null) => boolean {
  const { viewer, authLoading } = useDashboard();
  const { selected, fenceVersion } = useTenant();
  const scope = useMemo(
    () => ({
      viewer,
      authLoading,
      fenceVersion,
      tenantId: selected?.tenantId ?? null,
      tenantType: selected?.type ?? null,
      tenantRole: selected?.role ?? null,
    }),
    [viewer, authLoading, fenceVersion, selected?.tenantId, selected?.type, selected?.role],
  );
  const currentRef = useRef({ tenantId: selected?.tenantId ?? null, scope });
  currentRef.current = { tenantId: selected?.tenantId ?? null, scope };
  return useCallback(
    (requestTenantId: string | null) =>
      isResponseForCurrentTenant(requestTenantId, currentRef.current.tenantId, scope, currentRef.current.scope),
    [scope],
  );
}
