import assert from "node:assert/strict";
import { test } from "node:test";

import type { ViewerResponse } from "./types";
import { invalidateViewerSession, reconcileSessionRefresh } from "./viewer-session";

function viewer(id: number, login = `viewer-${id}`): ViewerResponse {
  return {
    auth: { mode: "github", enabled: true },
    github_app: { installed: true },
    authenticated: true,
    user: { id, login },
    organizations: [{ id: 100 + id, login: `org-${id}` }],
    teams: [],
    projects: [],
  };
}

const anonymous: ViewerResponse = {
  auth: { mode: "github", enabled: true },
  github_app: { installed: true },
  authenticated: false,
  organizations: [],
  teams: [],
  projects: [],
};

test("an anonymous refresh invalidates the viewer that initiated it", () => {
  assert.deepEqual(reconcileSessionRefresh(viewer(1), 1, anonymous), anonymous);
});

test("a stale anonymous refresh cannot sign out a newer viewer", () => {
  const current = viewer(2);
  assert.equal(reconcileSessionRefresh(current, 1, anonymous), current);
});

test("an authenticated refresh applies only when its identity remains current", () => {
  const current = viewer(1);
  const refreshed = viewer(1, "refreshed");
  assert.equal(reconcileSessionRefresh(current, 1, refreshed), refreshed);
  assert.equal(reconcileSessionRefresh(current, 1, viewer(2)), current);
});

test("a 401 invalidates only the session that initiated the request", () => {
  const current = viewer(1);
  assert.deepEqual(invalidateViewerSession(current, 1), anonymous);

  const newer = viewer(2);
  assert.equal(invalidateViewerSession(newer, 1), newer);
});
