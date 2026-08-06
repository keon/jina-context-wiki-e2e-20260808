"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  DashboardRequestError,
  isAccessRevoked,
  nextSnapshot,
  pollBackoffInterval,
  type ResponseSnapshot
} from "../dashboard/lib/query-client.ts";
import { pollQueryKey } from "../dashboard/lib/query-keys.ts";

const POLL_INTERVAL_MS = 2500;

/**
 * Polls a same-origin JSON endpoint. The API tags these responses with ETags,
 * so the browser HTTP cache turns unchanged polls into 304 revalidations; a
 * state update only happens when the serialized payload actually changed.
 * Polling pauses while the tab is hidden and resumes (with an immediate
 * fetch) when it becomes visible again.
 *
 * The path is the cache key, so a poll is only ever readable under the path it
 * was issued for: switching paths addresses a different entry (the previous
 * payload is not shown for the new path) and cancels the request in flight,
 * because a response that arrives after the switch describes a resource the
 * caller is no longer displaying. Consecutive failures back off so one
 * unreachable endpoint cannot hold a tab at the base cadence indefinitely.
 *
 * Because the key is the path, every component polling the same endpoint shares
 * one request and one scheduler — /board, /history and /tasks read one
 * `work-overview`, and /context's four resources run off a single timer.
 */
export function usePoll<T>(path: string, intervalMs: number = POLL_INTERVAL_MS) {
  const queryClient = useQueryClient();
  const queryKey = pollQueryKey(path);

  const { data, status, error, refetch } = useQuery<ResponseSnapshot<T>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await fetch(path, {
        credentials: "include",
        headers: { accept: "application/json" },
        signal
      });
      if (!response.ok) {
        throw new DashboardRequestError(response.status, `request failed with ${response.status}`);
      }
      const body = await response.text();
      return nextSnapshot(queryClient.getQueryData<ResponseSnapshot<T>>(queryKey), body, () => JSON.parse(body) as T);
    },
    // An empty path means the caller has nothing to poll yet (no workspace selected).
    enabled: path.length > 0,
    staleTime: intervalMs,
    refetchInterval: (query) => pollBackoffInterval(intervalMs, query.state.fetchFailureCount),
    // Hidden tabs keep the timer but skip the request, exactly as the hand-rolled
    // scheduler did; `"always"` then refreshes the moment the tab is visible again.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    // Failures are surfaced through `online` and retried on the (backed off)
    // interval, rather than as a burst of retries inside one poll.
    retry: false
  });

  const refresh = useCallback(async () => {
    if (!path) return;
    await refetch();
  }, [path, refetch]);

  // A 401/403 withdraws access to what is already cached. TanStack keeps the
  // last successful `data` when a query errors, so without this the previous
  // payload stays on screen after access is revoked — board, history, tasks and
  // context would all keep rendering it for the lifetime of the cache entry.
  //
  // Withheld here rather than evicted: `removeQueries` on a live observer
  // triggers an immediate refetch, which fails the same way and would spin. The
  // entry is still cleared by `evictTenantScopedQueries` when the session-level
  // 401/403 lands (`poll` is a tenant-scoped resource), and every reader of this
  // key goes through this hook, so withholding covers all of them.
  const revoked = isAccessRevoked(error);

  return {
    data: revoked ? undefined : data?.value,
    online: status === "success" ? true : status === "error" ? false : undefined,
    refresh
  };
}
