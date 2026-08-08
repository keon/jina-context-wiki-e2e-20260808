"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { normalizeCodexHarnessInfo, type CodexHarnessInfo } from "./lib/codex-harness";
import { startCompletionPolling } from "./lib/completion-polling";
import {
  shouldDiscardDashboardData,
  shouldShowDashboardLoading,
  type DashboardReloadOptions,
} from "./lib/dashboard-refresh";
import { localDashboardFixtureEnabled, localViewerFixture, mergeLocalDashboardFixture } from "./lib/local-fixture";
import {
  DASHBOARD_STALE_TIME_MS,
  DashboardRequestError,
  evictTenantScopedQueries,
  nextSnapshot,
  requestStatus,
  type ResponseSnapshot,
} from "./lib/query-client";
import { isSameTenantScope, tenantQueryKey, type TenantQueryScope } from "./lib/query-keys";
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
import {
  tenantAuthorizationErrorMessage,
  WORKSPACE_DISCOVERY_ERROR_MESSAGE,
  WORKSPACE_SESSION_ERROR_MESSAGE,
} from "./lib/tenant-access-error";

interface DashboardContextValue {
  data: DashboardResponse | null;
  viewer: ViewerResponse | null;
  error: string | null;
  loading: boolean;
  authLoading: boolean;
  authRequired: boolean;
  sessionError: string | null;
  filters: DashboardFilters;
  setFilters: (filters: DashboardFilters) => void;
  reload: () => void;
  reloadViewer: () => void;
  setTenantScope: (tenantId: string | null, ready: boolean) => void;
}

const emptyFilters: DashboardFilters = { project: "", team: "" };
interface DashboardTenantScope { tenantId: string | null; ready: boolean; version: number }
const initialTenantScope: DashboardTenantScope = { tenantId: null, ready: false, version: 0 };
const NO_TENANT_ERROR = "No Jina organization is available for this account.";

type DashboardSnapshot = ResponseSnapshot<DashboardResponse>;

/** An authorization failure, latched against the scope it was answered under. */
interface DashboardAuthFailure { scopeVersion: number; status: number }

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [viewer, setViewer] = useState<ViewerResponse | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [filters, setFilters] = useState<DashboardFilters>(emptyFilters);
  const [tenantScope, setTenantScopeState] = useState<DashboardTenantScope>(initialTenantScope);
  // A foreground reload reports loading; the ten-second refresh does not (see
  // `shouldShowDashboardLoading`) — that is what keeps a visible feed from
  // flickering through a loading state twice a minute.
  const [foregroundReload, setForegroundReload] = useState(false);
  const [authFailure, setAuthFailure] = useState<DashboardAuthFailure | null>(null);

  const viewerAbortRef = useRef<AbortController | null>(null);
  const tenantScopeRef = useRef<DashboardTenantScope>(initialTenantScope);
  // The revocation the cache has already been emptied for ("<scope>:<status>").
  const evictedForRef = useRef<string | null>(null);

  const setTenantScope = useCallback((tenantId: string | null, ready: boolean) => {
    const current = tenantScopeRef.current;
    if (current.tenantId === tenantId && current.ready === ready) return;
    const next = { tenantId, ready, version: current.version + 1 };
    tenantScopeRef.current = next;
    // The version is part of the query key, so the previous scope's response is
    // not discarded on arrival — it is simply not addressable from here any more.
    setFilters(emptyFilters);
    setTenantScopeState(next);
  }, []);

  const reloadViewer = useCallback(async () => {
    viewerAbortRef.current?.abort();
    const controller = new AbortController();
    viewerAbortRef.current = controller;
    setAuthLoading(true);
    const current = () => viewerAbortRef.current === controller && !controller.signal.aborted;
    try {
      const localViewer = localViewerFixture();
      if (localViewer) {
        if (!current()) return;
        setViewer(localViewer);
        setViewerError(null);
        setSessionError(null);
        return;
      }
      const response = await fetch(apiUrl("/dashboard/me"), {
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
        setViewerError(null);
        setSessionError(WORKSPACE_SESSION_ERROR_MESSAGE);
        return;
      }
      if (!response.ok) {
        throw new Error(`Dashboard auth returned ${response.status}`);
      }
      const nextViewer = (await response.json()) as ViewerResponse;
      if (!current()) return;
      setViewer(nextViewer);
      setViewerError(null);
      setSessionError(null);
    } catch (loadError) {
      if (!current()) return;
      const fixture = localViewerFixture();
      if (fixture) {
        setViewer(fixture);
        setViewerError(null);
        setSessionError(null);
        return;
      }
      setViewerError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (viewerAbortRef.current === controller) {
        viewerAbortRef.current = null;
        setAuthLoading(false);
      }
    }
  }, []);

  // Session-identity primitives, never the `viewer` object: the session refresh
  // replaces it with a freshly parsed object on every poll, and keying anything
  // on that reference restarts loads for the very same account.
  const hasViewer = viewer !== null;
  const viewerUserId = viewer?.user?.id ?? null;
  const viewerAuthEnabled = Boolean(viewer?.auth.enabled);
  const authRequired = Boolean(viewer?.auth.enabled && !viewer.authenticated);
  // An authenticated dashboard must never fall back to the legacy viewer-wide feed if tenant
  // discovery unexpectedly returns no workspace.
  const noTenantAvailable =
    tenantScope.ready && !tenantScope.tenantId && viewerAuthEnabled && !localDashboardFixtureEnabled();
  // A 401/403 answered under this scope: the payload it invalidated has been
  // evicted, and the request is not re-armed until the scope changes or the
  // completion poll asks for it again.
  const fencedOut = authFailure !== null && authFailure.scopeVersion === tenantScope.version;

  const dashboardKey = tenantQueryKey(
    "dashboard-review-runs",
    { viewerUserId, fenceVersion: tenantScope.version, tenantId: tenantScope.tenantId },
    filters.project,
    filters.team,
  );

  const dashboardQuery = useQuery<DashboardSnapshot>({
    queryKey: dashboardKey,
    queryFn: async ({ signal }) => {
      // An unchanged poll keeps the cached object, so the ten-second refresh does
      // not re-render every `useDashboard()` consumer for an identical feed.
      const previous = queryClient.getQueryData<DashboardSnapshot>(dashboardKey);
      if (localDashboardFixtureEnabled()) {
        return nextSnapshot(previous, "", () => mergeLocalDashboardFixture(null));
      }
      const params = new URLSearchParams();
      if (filters.project) params.set("project", filters.project);
      if (filters.team) params.set("team", filters.team);
      const path = reviewRunsPath(tenantScope.tenantId);
      // No `cache: "no-store"`: the API answers these with `cache-control: no-cache` + an ETag, so the
      // default cache mode still revalidates on every poll — conditionally, which lets an unchanged
      // dashboard come back as a bodyless 304 instead of the full payload. `no-store` skipped both the
      // cache read and the write, so the browser had no entry to build an `if-none-match` from.
      const response = await fetch(apiUrl(path, params), { credentials: "include", signal });
      if (!response.ok) {
        throw new DashboardRequestError(response.status, `Dashboard API returned ${response.status}`);
      }
      const body = await response.text();
      return nextSnapshot(previous, body, () =>
        mergeLocalDashboardFixture(JSON.parse(body) as DashboardResponse),
      );
    },
    enabled: hasViewer && tenantScope.ready && !authRequired && !noTenantAvailable && !fencedOut,
    staleTime: DASHBOARD_STALE_TIME_MS,
    // The completion poll below is this feed's retry cadence; a burst of retries
    // inside one refresh would only multiply the request rate it is there to bound.
    retry: false,
    placeholderData: (previous, previousQuery) =>
      // Keep the feed on screen while a filter change loads — but never across a
      // scope change, where the previous payload belongs to another tenant.
      previousQuery && isSameTenantScope(previousQuery.queryKey, dashboardKey) ? previous : undefined,
  });

  const failureStatus = requestStatus(dashboardQuery.error);
  const discardStatus =
    failureStatus !== null && shouldDiscardDashboardData(failureStatus) ? failureStatus : null;

  useEffect(() => {
    if (discardStatus === null) return;
    const scopeVersion = tenantScopeRef.current.version;
    const episode = `${scopeVersion}:${discardStatus}`;
    // Once per revocation: the retries that follow have nothing left to remove,
    // and each eviction makes every other page's read start over. Cleared again
    // by the success below, so a later revocation evicts what it cached.
    if (evictedForRef.current !== episode) {
      evictedForRef.current = episode;
      // SECURITY: fail closed. An authorization failure invalidates the last
      // successful response, and `invalidateQueries` would only mark it stale —
      // the payload would stay readable through the cache (and through any
      // observer that mounts before a refetch resolves). It has to be removed.
      evictTenantScopedQueries(queryClient);
    }
    // Removing an active query makes its observer rebuild and refetch on the next
    // render, so latch this scope off; the completion poll still retries on its
    // ten-second cadence, which is the pre-migration behaviour.
    setAuthFailure((current) =>
      current && current.scopeVersion === scopeVersion && current.status === discardStatus
        ? current
        : { scopeVersion, status: discardStatus },
    );
    if (discardStatus === 401) {
      setViewer((currentViewer) => invalidateViewerSession(currentViewer, viewerUserId ?? undefined));
    }
  }, [discardStatus, queryClient, viewerUserId]);

  useEffect(() => {
    // Access restored (or granted for a different scope): drop the latch.
    if (!dashboardQuery.isSuccess) return;
    evictedForRef.current = null;
    setAuthFailure(null);
  }, [dashboardQuery.isSuccess]);

  const refetchDashboard = dashboardQuery.refetch;
  const reload = useCallback(
    async ({ background = false }: DashboardReloadOptions = {}) => {
      if (shouldShowDashboardLoading({ background })) setForegroundReload(true);
      try {
        await refetchDashboard();
      } finally {
        setForegroundReload(false);
      }
    },
    [refetchDashboard],
  );

  // The status a discard is in force for: the failure just observed — read in the
  // same render, so the feed is dropped without a frame of the raw error first —
  // or the one latched for this scope once its payload was evicted.
  const discardedStatus = discardStatus ?? (fencedOut ? authFailure.status : null);
  const data =
    discardedStatus !== null || noTenantAvailable ? null : (dashboardQuery.data?.value ?? null);
  const error = noTenantAvailable
    ? NO_TENANT_ERROR
    : discardedStatus !== null
      ? // A 401 is a session transition the shell already reports by requiring
        // sign-in; anything else discarded is a genuine failure to surface.
        (discardedStatus === 401 ? null : `Dashboard API returned ${discardedStatus}`)
      : dashboardQuery.error
        ? dashboardQuery.error.message
        : viewerError;
  // "The first answer for this scope has not arrived yet" — which is also true
  // before the scope is ready, while the query is disabled. Placeholder data
  // carried across a filter change counts as an answer, so the visible feed does
  // not flicker back through a loading state.
  const loading = !authRequired && !noTenantAvailable && (foregroundReload || dashboardQuery.isPending);

  useEffect(() => {
    void reloadViewer();
  }, [reloadViewer]);

  useEffect(() => {
    return () => {
      viewerAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!hasViewer || !tenantScope.ready || authRequired || noTenantAvailable) return;
    // `immediate: false`: the query issues the first request itself when the key
    // changes, so the poll only owns the ten-second cadence and the refresh on
    // becoming visible again. Restarting it on a key change is what makes a
    // filter or workspace change reload at once instead of on the next tick.
    const polling = startCompletionPolling(() => reload({ background: true }), 10_000, {
      immediate: false,
    });
    return () => polling.stop();
  }, [
    reload,
    tenantScope.ready,
    tenantScope.version,
    tenantScope.tenantId,
    filters.project,
    filters.team,
    authRequired,
    noTenantAvailable,
    hasViewer,
  ]);

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
      authRequired,
      sessionError,
      filters,
      setFilters,
      reload: () => void reload(),
      reloadViewer: () => void reloadViewer(),
      setTenantScope,
    }),
    [
      data,
      viewer,
      error,
      loading,
      authLoading,
      authRequired,
      sessionError,
      filters,
      reload,
      reloadViewer,
      setTenantScope,
    ],
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

interface TenantContextValue {
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
  // Actionable reason tenant discovery was denied. This remains separate from
  // `ready` so authenticated pages stay fail-closed while the shell explains
  // how to recover instead of rendering an empty dashboard.
  accessError: string | null;
  retryDiscovery: () => void;
  selectTenant: (tenantId: string) => void;
  addTenant: (tenant: ViewerTenant) => void;
  updateTenant: (tenant: ViewerTenant) => void;
  // Increments when tenant authorization is lost, invalidating in-flight page requests even if both
  // the old and new selections use the legacy null scope.
  fenceVersion: number;
}

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
 * selection. Periodic refreshes, plus one when the tab becomes visible again,
 * surface new installations and org memberships without requiring a reload or
 * re-login. Mounted at shell level, inside DashboardProvider.
 */
export function TenantProvider({ children }: { children: ReactNode }) {
  const { viewer, authRequired, authLoading, reloadViewer, setTenantScope } = useDashboard();
  const queryClient = useQueryClient();
  const [tenants, setTenants] = useState<ViewerTenant[]>([]);
  // False until a successful fetch. Authenticated review reads stay blocked on failure;
  // only explicit auth-disabled/local-fixture mode may use the legacy viewer-wide feed.
  const [loaded, setLoaded] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [fenceVersion, setFenceVersion] = useState(0);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  // The viewer id the current tenants/selection belong to; null before any fetch or after sign-out.
  const fetchedForUserRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reloadViewerRef = useRef(reloadViewer);
  reloadViewerRef.current = reloadViewer;

  const authenticated = Boolean(viewer && !authRequired);
  const viewerUserId = viewer?.user?.id ?? null;
  const viewerAuthMode = viewer?.auth.mode ?? "disabled";
  const legacyReviewMode = Boolean(viewer && (!viewer.auth.enabled || localDashboardFixtureEnabled()));

  useEffect(() => {
    if (authLoading) return;

    if (legacyReviewMode) {
      setAccessError(null);
      setTenantScope(null, true);
      return;
    }

    // Sign-out / unauthenticated: drop the previous viewer's tenants and selection so a different
    // account signing in later can never read or write against them (FINDING 2).
    if (!authenticated || viewerUserId == null) {
      setAccessError(null);
      setTenantScope(null, false);
      if (fetchedForUserRef.current !== null) {
        fetchedForUserRef.current = null;
        abortRef.current?.abort();
        // Every cached tenant payload belonged to the session that just ended.
        evictTenantScopedQueries(queryClient);
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
      evictTenantScopedQueries(queryClient);
      setTenants([]);
      setLoaded(false);
      setSelectedTenantId(readStoredTenantId(viewerUserId));
      setAccessError(null);
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
          credentials: "include",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
          const authorizationError = tenantAuthorizationErrorMessage(401, viewerAuthMode);
          if (authorizationError) {
            accessDenied = true;
            // Clerk still owns navigation, but its API session is temporarily
            // inconsistent. Fail closed and give the user explicit recovery
            // controls instead of replacing the viewer and loading forever.
            evictTenantScopedQueries(queryClient);
            setTenants([]);
            setLoaded(false);
            setSelectedTenantId(null);
            setAccessError(authorizationError);
            setFenceVersion((version) => version + 1);
            setTenantScope(null, false);
            return;
          }
          fetchedForUserRef.current = null;
          // SECURITY: the session is gone. Remove the cached tenant payloads rather
          // than invalidating them — invalidation leaves them readable until a
          // refetch resolves, and there is no longer a session entitled to read them.
          evictTenantScopedQueries(queryClient);
          setTenants([]);
          setLoaded(false);
          setSelectedTenantId(null);
          setAccessError(null);
          setFenceVersion((version) => version + 1);
          setTenantScope(null, false);
          reloadViewerRef.current();
          return;
        }
        if (response.status === 403) {
          if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
          const payload = (await response.json().catch(() => undefined)) as unknown;
          if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
          accessDenied = true;
          // SECURITY: tenant authorization was revoked; the data read under it must
          // not remain in the cache. See the 401 branch above.
          evictTenantScopedQueries(queryClient);
          setTenants([]);
          setLoaded(false);
          setSelectedTenantId(null);
          setAccessError(tenantAuthorizationErrorMessage(403, viewerAuthMode, payload));
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
        setAccessError(null);
      } catch {
        if (controller.signal.aborted || fetchedForUserRef.current !== viewerUserId) return;
        // 401/403 responses are handled above and fail closed. Keep the last
        // successful workspace across transient API/network failures so a
        // background membership refresh cannot blank the dashboard.
        if (!loadedRef.current) setAccessError(WORKSPACE_DISCOVERY_ERROR_MESSAGE);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    };

    const polling = startCompletionPolling(refresh, 30_000);
    return () => {
      polling.stop();
      abortRef.current?.abort();
    };
  }, [
    authLoading,
    authenticated,
    legacyReviewMode,
    viewerUserId,
    viewerAuthMode,
    setTenantScope,
    queryClient,
    refreshVersion,
  ]);

  const retryDiscovery = useCallback(() => {
    setAccessError(null);
    setRefreshVersion((version) => version + 1);
  }, []);

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
      accessError,
      retryDiscovery,
      selectTenant,
      addTenant,
      updateTenant,
      fenceVersion,
    };
  }, [
    legacyReviewMode,
    loaded,
    tenants,
    selected,
    accessError,
    retryDiscovery,
    selectTenant,
    addTenant,
    updateTenant,
    fenceVersion,
  ]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenant must be used within a TenantProvider");
  }
  return context;
}

/* ----------------------------------------------------------- codex harness --- */

interface CodexHarnessContextValue {
  // The viewer's Codex (ChatGPT subscription) connection status.
  harness: CodexHarnessInfo;
  // True once the status has settled: the read finished, failed (degraded to "not configured"), or
  // there is no session to read one for. Consumers that must not flash "not connected" wait on this.
  ready: boolean;
  // Adopt the authoritative status returned by a connect/disconnect write.
  setHarness: (info: CodexHarnessInfo) => void;
  // Re-read from the API (the Models page Retry button).
  reload: () => void;
}

const DISCONNECTED_HARNESS: CodexHarnessInfo = { configured: false };

const CodexHarnessContext = createContext<CodexHarnessContextValue | null>(null);

/**
 * Owns the single read of the viewer's Codex harness status from `/dashboard/integrations`.
 * The shell's reconnect banner and the Models page's credential card both need it, and on /models
 * they used to issue the identical request in the same tick. The endpoint is user-scoped, so the
 * answer does not change with the selected workspace and only needs re-reading per viewer.
 *
 * This status is optional context: a failed read degrades to "not configured" and is never surfaced
 * as an error, exactly as the two call sites did on their own.
 */
export function CodexHarnessProvider({ children }: { children: ReactNode }) {
  const { viewer } = useDashboard();
  const [harness, setHarness] = useState<CodexHarnessInfo>(DISCONNECTED_HARNESS);
  const [ready, setReady] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const authenticated = Boolean(viewer?.authenticated);
  const viewerUserId = viewer?.user?.id ?? null;

  useEffect(() => {
    if (!authenticated) {
      // No session means no connection to report; that is a settled answer, not a pending one.
      setHarness(DISCONNECTED_HARNESS);
      setReady(true);
      return;
    }
    const controller = new AbortController();
    setReady(false);
    fetch(apiUrl("/dashboard/integrations"), {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as Record<string, unknown> | undefined) : undefined,
      )
      .then((body) => {
        if (controller.signal.aborted) return;
        setHarness(body ? normalizeCodexHarnessInfo(body.codex_harness) : DISCONNECTED_HARNESS);
        setReady(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHarness(DISCONNECTED_HARNESS);
        setReady(true);
      });
    return () => controller.abort();
  }, [authenticated, viewerUserId, reloadVersion]);

  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);
  const value = useMemo<CodexHarnessContextValue>(
    () => ({ harness, ready, setHarness, reload }),
    [harness, ready, reload],
  );

  return <CodexHarnessContext.Provider value={value}>{children}</CodexHarnessContext.Provider>;
}

export function useCodexHarness(): CodexHarnessContextValue {
  const context = useContext(CodexHarnessContext);
  if (!context) {
    throw new Error("useCodexHarness must be used within a CodexHarnessProvider");
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
  // The scope is keyed on the session identity it represents, not on the
  // `viewer` object's reference. The session refresh below replaces `viewer`
  // with a freshly parsed object on every poll and whenever the tab becomes
  // visible again, so
  // keying on the reference made the fence reject responses for the very same
  // account: in-flight mutations were dropped before their busy flag cleared,
  // and tenant-scoped load effects re-ran and blanked half-filled forms.
  const viewerUserId = viewer?.user?.id ?? null;
  const viewerAuthEnabled = viewer?.auth.enabled ?? null;
  const viewerAuthenticated = viewer?.authenticated ?? null;
  const tenantId = selected?.tenantId ?? null;
  const tenantType = selected?.type ?? null;
  const tenantRole = selected?.role ?? null;
  const scope = useMemo(
    () => ({
      viewerUserId,
      viewerAuthEnabled,
      viewerAuthenticated,
      authLoading,
      fenceVersion,
      tenantId,
      tenantType,
      tenantRole,
    }),
    [
      viewerUserId,
      viewerAuthEnabled,
      viewerAuthenticated,
      authLoading,
      fenceVersion,
      tenantId,
      tenantType,
      tenantRole,
    ],
  );
  const currentRef = useRef({ tenantId, scope });
  currentRef.current = { tenantId, scope };
  return useCallback(
    (requestTenantId: string | null) =>
      isResponseForCurrentTenant(requestTenantId, currentRef.current.tenantId, scope, currentRef.current.scope),
    [scope],
  );
}

/**
 * The same fence as `useTenantFence`, in the form a query key takes: cached
 * reads address a scope instead of checking one after the fact, so a response
 * issued under tenant A is never even readable from tenant B's view.
 */
export function useTenantQueryScope(): TenantQueryScope {
  const { viewer } = useDashboard();
  const { selected, fenceVersion } = useTenant();
  const viewerUserId = viewer?.user?.id ?? null;
  const tenantId = selected?.tenantId ?? null;
  return useMemo(
    () => ({ viewerUserId, fenceVersion, tenantId }),
    [viewerUserId, fenceVersion, tenantId],
  );
}
