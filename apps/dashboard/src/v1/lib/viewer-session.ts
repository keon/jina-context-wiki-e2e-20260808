import type { ViewerResponse } from "./types";

type ViewerState = ViewerResponse | null;

function isExpectedViewer(current: ViewerState, expectedUserId: number | undefined): current is ViewerResponse {
  return Boolean(current && current.user?.id === expectedUserId);
}

/**
 * Applies a deferred session refresh only to the viewer that initiated it.
 *
 * An anonymous response is an authoritative transition for that viewer, while
 * authenticated responses must retain the same identity. Both cases reject a
 * stale response after an account switch.
 */
export function reconcileSessionRefresh(
  current: ViewerState,
  expectedUserId: number,
  refreshed: ViewerResponse,
): ViewerState {
  if (!isExpectedViewer(current, expectedUserId)) return current;
  if (!refreshed.authenticated) return refreshed;
  return refreshed.user?.id === expectedUserId ? refreshed : current;
}

/**
 * Converts an authenticated viewer to its anonymous state when an API request
 * proves the initiating session is no longer valid. The identity fence keeps a
 * late 401 from signing out a newer viewer.
 */
export function invalidateViewerSession(
  current: ViewerState,
  expectedUserId: number | undefined,
): ViewerState {
  if (!isExpectedViewer(current, expectedUserId)) return current;
  return {
    auth: current.auth,
    github_app: current.github_app,
    authenticated: false,
    organizations: [],
    teams: [],
    projects: [],
  };
}
