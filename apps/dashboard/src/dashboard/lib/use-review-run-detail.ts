"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { getReviewRun } from "./api";
import { startCompletionPolling } from "./completion-polling";
import { localReviewRun } from "./local-fixture";
import { DASHBOARD_STALE_TIME_MS } from "./query-client";
import { tenantQueryKey } from "./query-keys";
import type { DashboardResponse, ReviewRun } from "./types";
import { useDashboard, useTenant, useTenantQueryScope } from "../providers";

/** The run as the already-loaded list knows it, under the same fence as this read. */
function listedRun(data: DashboardResponse | null, reviewRunId: string): ReviewRun | undefined {
  return data?.review_runs.find((run) => run.review_run_id === reviewRunId);
}

export function useReviewRunDetail(reviewRunId: string) {
  const { data: dashboardData } = useDashboard();
  const { ready, localReviewMode } = useTenant();
  const scope = useTenantQueryScope();
  const requestReady = ready && (scope.tenantId !== null || localReviewMode);

  const query = useQuery<ReviewRun | null>({
    queryKey: tenantQueryKey("review-run-detail", scope, reviewRunId),
    queryFn: async ({ signal }) => localReviewRun(reviewRunId) ?? getReviewRun(reviewRunId, scope.tenantId, signal),
    // The scope is the key, so a response is only ever readable under the tenant
    // it was requested for; a switch addresses a different entry entirely.
    enabled: requestReady,
    // The list this page was opened from is cached under the same fence, so the
    // run it already holds is shown immediately instead of after a second round
    // trip. Dated to the epoch: it counts as stale, so the authoritative read
    // still runs at once and replaces it.
    initialData: () => listedRun(dashboardData, reviewRunId),
    initialDataUpdatedAt: 0,
    staleTime: DASHBOARD_STALE_TIME_MS,
    // Refreshed on the completion cadence below rather than as a retry burst.
    retry: false,
  });

  const refetch = query.refetch;
  useEffect(() => {
    if (!requestReady) return;
    // `immediate: false`: the query issues the first read itself; this owns the
    // ten-second cadence and the refresh on becoming visible again.
    const polling = startCompletionPolling(() => refetch(), 10_000, { immediate: false });
    return () => polling.stop();
  }, [refetch, requestReady, reviewRunId, scope.tenantId, scope.fenceVersion, scope.viewerUserId]);

  // `isFetched` is the detail read's own answer: the seeded list entry does not
  // count as one, so a caller can still tell "shown from the list" from "loaded".
  const loaded = query.isFetched;
  const error = query.error ? query.error.message : null;
  // Do not keep either a prior detail response or the list fallback visible when an
  // authenticated tenant read fails (including membership revocation).
  const run = query.isError ? null : (query.data ?? null);
  return useMemo(
    () => ({ run, loading: !requestReady || !loaded, error, loaded }),
    [run, requestReady, loaded, error],
  );
}
