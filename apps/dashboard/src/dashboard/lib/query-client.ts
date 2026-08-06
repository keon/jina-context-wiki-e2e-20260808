import { QueryClient } from "@tanstack/react-query";

import { isTenantScopedQueryKey } from "./query-keys";

/** An HTTP failure that carries its status, so retry and discard policy can read it. */
export class DashboardRequestError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Request failed with ${status}`);
    this.name = "DashboardRequestError";
    this.status = status;
  }
}

/** The HTTP status behind a query failure, or null for a transport/parse error. */
export function requestStatus(error: unknown): number | null {
  return error instanceof DashboardRequestError ? error.status : null;
}

/**
 * 4xx statuses that describe a temporary condition rather than a verdict about
 * the request itself, so they are still worth retrying.
 */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

export const MAX_QUERY_RETRIES = 2;

/**
 * A 401/403 (and any other client error) is a settled answer, not a transient
 * fault: retrying cannot change it, and each retry keeps a revoked payload on
 * screen and the request in flight for longer. Everything else — 5xx, network,
 * parse — retries a bounded number of times.
 */
export function shouldRetryDashboardQuery(failureCount: number, error: unknown): boolean {
  const status = requestStatus(error);
  if (status !== null && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status)) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}

/**
 * Cadence of the review-run feed: the completion poll refreshes it every ten
 * seconds, so anything read within that window is still current.
 */
export const DASHBOARD_STALE_TIME_MS = 10_000;

/**
 * Workspace configuration (billing, usage, model routing, provider keys) is not
 * polled at all today — it is read when a page mounts and re-read when the
 * viewer changes it. A minute of staleness keeps a back-navigation instant
 * while still re-reading a page left open.
 */
export const CONFIG_STALE_TIME_MS = 60_000;

const MAX_RETRY_DELAY_MS = 30_000;

/** Longest gap a polled resource backs off to after consecutive failures. */
export const MAX_POLL_BACKOFF_MS = 30_000;

/**
 * Consecutive failures back off exponentially, capped, so one unreachable
 * endpoint cannot hold a tab at the base cadence indefinitely. The count resets
 * on the first success, restoring the base interval.
 */
export function pollBackoffInterval(intervalMs: number, consecutiveFailures: number): number {
  return consecutiveFailures > 0
    ? Math.min(intervalMs * 2 ** consecutiveFailures, MAX_POLL_BACKOFF_MS)
    : intervalMs;
}

/** A cached payload alongside the exact bytes it was parsed from. */
export interface ResponseSnapshot<T> {
  readonly body: string;
  readonly value: T;
}

/**
 * The cache entry to keep for a response that has just arrived.
 *
 * A poll that returns the same bytes hands back the *identical* object already
 * cached rather than an equal one. Object identity is what every consumer's memo
 * and every observer's change check keys on, so an unchanged payload — the
 * common case at these cadences — costs no re-render at all. Comparing the raw
 * bytes is also strictly cheaper than a deep comparison of the parsed value, and
 * is only meaningful because these payloads carry no per-request field.
 */
export function nextSnapshot<T>(
  previous: ResponseSnapshot<T> | undefined,
  body: string,
  parse: () => T,
): ResponseSnapshot<T> {
  if (previous && previous.body === body) return previous;
  return { body, value: parse() };
}

/**
 * One client per browser session.
 *
 * `refetchOnWindowFocus` is off: the app does its own visibility handling (the
 * completion poll and `usePoll` both refresh on `visibilitychange`), and a
 * blanket focus refetch was a documented stampede source — every mounted
 * resource re-requesting on a single alt-tab. `usePoll` opts back in per query,
 * where an immediate refresh on becoming visible is the documented behaviour.
 */
export function createDashboardQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        staleTime: DASHBOARD_STALE_TIME_MS,
        gcTime: 5 * 60_000,
        retry: shouldRetryDashboardQuery,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS)
      },
      mutations: { retry: false }
    }
  });
}

/**
 * Fail closed after a 401/403: drop every cached tenant payload.
 *
 * `removeQueries`, never `invalidateQueries` — invalidation only marks an entry
 * stale, and the payload stays readable through `getQueryData` and through any
 * observer that mounts before the refetch resolves. After authorization is lost
 * that data must not be reachable at all, which is what removal guarantees.
 *
 * Callers must stop the failing query from re-issuing itself immediately;
 * removing an active query makes its observer rebuild and refetch on the next
 * render.
 */
export function evictTenantScopedQueries(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => isTenantScopedQueryKey(query.queryKey) });
}
