import assert from "node:assert/strict";
import { test } from "node:test";
import { screen, waitFor } from "@testing-library/react";
import { jsonResponse, renderWithQueryClient, stubFetch } from "../../testing/render.tsx";
import { setTenantState } from "../../testing/stubs/dashboard-providers.tsx";
import TaskTypesPage from "./page.tsx";

/**
 * REGRESSION: /tasks hung on "Loading task types…" forever with no workspace
 * selected — the same disabled-poll trap as /history, on two endpoints instead
 * of one.
 */

const WORKSPACE = { tenantId: "ten_1", login: "acme", type: "Organization", role: "admin" } as const;

test("no workspace selected renders a terminal message, not a spinner", () => {
  const { requests } = stubFetch(() => jsonResponse([]));
  setTenantState({ selected: null, ready: true });

  const { container } = renderWithQueryClient(<TaskTypesPage />);

  const placeholder = container.querySelector(".page-placeholder");
  assert.ok(placeholder, "expected the no-workspace placeholder");
  assert.equal(placeholder.getAttribute("role"), "status");
  assert.match(placeholder.textContent ?? "", /No workspace selected/);
  assert.equal(screen.queryByText(/Loading task types/), null);
  assert.deepEqual(requests, []);
});

const EMPTY_OVERVIEW = { board: { tasks: [], dependencies: [] }, events: [] };

function respond(url: string): Response {
  return url.includes("work-overview") ? jsonResponse(EMPTY_OVERVIEW) : jsonResponse([]);
}

test("loading, unavailable and empty are three different renders for a real workspace", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });

  stubFetch(() => new Promise<Response>(() => undefined));
  const pending = renderWithQueryClient(<TaskTypesPage />);
  const loadingCopy = pending.container.querySelector(".task-types-empty")?.textContent ?? "";
  assert.match(loadingCopy, /Loading task types/);
  assert.equal(pending.container.querySelector(".task-types-empty")?.getAttribute("aria-busy"), "true");
  pending.unmount();

  stubFetch((url) => (url.includes("work-overview") ? jsonResponse(EMPTY_OVERVIEW) : jsonResponse({}, 503)));
  const failed = renderWithQueryClient(<TaskTypesPage />);
  await waitFor(() => {
    assert.match(failed.container.querySelector(".task-types-empty")?.textContent ?? "", /could not be loaded/);
  });
  assert.ok(failed.container.querySelector(".task-types-empty button"), "a failed read must offer a retry");
  const failedCopy = failed.container.querySelector(".task-types-empty")?.textContent ?? "";
  failed.unmount();

  stubFetch(respond);
  const empty = renderWithQueryClient(<TaskTypesPage />);
  await waitFor(() => {
    assert.match(empty.container.querySelector(".task-types-empty")?.textContent ?? "", /No task types are defined/);
  });
  const emptyCopy = empty.container.querySelector(".task-types-empty")?.textContent ?? "";

  assert.equal(new Set([loadingCopy, failedCopy, emptyCopy]).size, 3);
});

/**
 * Found while writing the tests above, not on the original list: the page read
 * `overview?.board.tasks`, so a 200 whose body carried no `board` threw inside
 * render and took the whole route down — a blank page rather than any of the
 * four states above. /board already guarded the same payload.
 */
test("a response without a board renders the page rather than throwing", async () => {
  setTenantState({ selected: WORKSPACE, ready: true });
  stubFetch((url) =>
    url.includes("work-overview")
      ? jsonResponse({ events: [] })
      : jsonResponse([{ type: "review.final", kind: "review", description: "Final review" }])
  );

  const { container } = renderWithQueryClient(<TaskTypesPage />);

  await waitFor(() => {
    assert.ok(container.querySelector("#task-types-page"), "the page should still render");
  });
  assert.match(container.textContent ?? "", /Task types/);
});
