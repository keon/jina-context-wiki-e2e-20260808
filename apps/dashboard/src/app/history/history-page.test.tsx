import assert from "node:assert/strict";
import { test } from "node:test";
import { screen, waitFor } from "@testing-library/react";
import {
  assertGridContracts,
  jsonResponse,
  renderWithQueryClient,
  stubFetch
} from "../../testing/render.tsx";
import { setTenantState } from "../../testing/stubs/dashboard-providers.tsx";
import HistoryPage from "./page.tsx";

/**
 * REGRESSION: /history hung on "Loading activity…" forever with no workspace
 * selected.
 *
 * With nothing selected there is no endpoint, so `usePoll` is disabled and never
 * issues a request: `data` and `online` both stay `undefined`, and the status
 * ternary (`data !== undefined ? "ready" : online === false ? "unavailable" :
 * "loading"`) reads that as "loading". Nothing would ever change it — the page
 * had no terminal state for the one condition that is terminal by construction.
 */

const WORKSPACE = { tenantId: "ten_1", login: "acme", type: "Organization", role: "admin" } as const;

test("no workspace selected renders a terminal message, not a spinner", () => {
  const { requests } = stubFetch(() => jsonResponse({}));
  setTenantState({ selected: null, ready: true });

  const { container } = renderWithQueryClient(<HistoryPage />);

  const placeholder = container.querySelector(".page-placeholder");
  assert.ok(placeholder, "expected the no-workspace placeholder");
  assert.equal(placeholder.getAttribute("role"), "status");
  assert.match(placeholder.textContent ?? "", /No workspace selected/);
  assert.match(placeholder.textContent ?? "", /Select a workspace/);
  // The failure this guards against: the loading copy standing in for a state
  // that can never resolve.
  assert.equal(screen.queryByText(/Loading activity/), null);
  // And nothing was polled, because there is nothing to poll.
  assert.deepEqual(requests, []);
});

test("a selected workspace does report loading, so the two states are distinguishable", () => {
  stubFetch(() => new Promise<Response>(() => undefined));
  setTenantState({ selected: WORKSPACE, ready: true });

  const { container } = renderWithQueryClient(<HistoryPage />);

  assert.equal(container.querySelector(".page-placeholder"), null);
  assert.match(container.querySelector(".run-history-list-footer")?.textContent ?? "", /Loading activity/);
});

test("a selected workspace with activity renders rows inside the lanes the table cuts", async () => {
  stubFetch(() =>
    jsonResponse({
      board: {
        tasks: [{ id: "task_1", type: "review.final", title: "Retry path", status: "done", attempt: 1 }],
        dependencies: []
      },
      events: [
        {
          id: "event_1",
          taskId: "task_1",
          type: "task.created",
          at: new Date().toISOString(),
          payload: { actor: "review_agent", repository: "acme/payments" }
        }
      ]
    })
  );
  setTenantState({ selected: WORKSPACE, ready: true });

  const { container } = renderWithQueryClient(<HistoryPage />);

  await waitFor(() => {
    assert.equal(container.querySelectorAll(".run-history-row").length, 1);
  });
  assert.match(container.querySelector(".run-history-list-footer")?.textContent ?? "", /1 event/);
  assertGridContracts(container, "HistoryPage");
});
