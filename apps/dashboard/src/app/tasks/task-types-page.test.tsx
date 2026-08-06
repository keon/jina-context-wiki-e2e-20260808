import assert from "node:assert/strict";
import { test } from "node:test";
import { screen, waitFor } from "@testing-library/react";
import { attrOf, jsonResponse, present, renderWithQueryClient, stubFetch, textOf } from "../../testing/render.tsx";
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

  assert.ok(present(container, ".page-placeholder"), "expected the no-workspace placeholder");
  assert.equal(attrOf(container, ".page-placeholder", "role"), "status");
  assert.match(textOf(container, ".page-placeholder"), /No workspace selected/);
  assert.equal(screen.queryAllByText(/Loading task types/).length, 0);
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
  const loadingCopy = textOf(pending.container, ".task-types-empty");
  assert.match(loadingCopy, /Loading task types/);
  assert.equal(attrOf(pending.container, ".task-types-empty", "aria-busy"), "true");
  pending.unmount();

  stubFetch((url) => (url.includes("work-overview") ? jsonResponse(EMPTY_OVERVIEW) : jsonResponse({}, 503)));
  const failed = renderWithQueryClient(<TaskTypesPage />);
  await waitFor(() => {
    assert.match(textOf(failed.container, ".task-types-empty"), /could not be loaded/);
  });
  assert.ok(present(failed.container, ".task-types-empty button"), "a failed read must offer a retry");
  const failedCopy = textOf(failed.container, ".task-types-empty");
  failed.unmount();

  stubFetch(respond);
  const empty = renderWithQueryClient(<TaskTypesPage />);
  await waitFor(() => {
    assert.match(textOf(empty.container, ".task-types-empty"), /No task types are defined/);
  });
  const emptyCopy = textOf(empty.container, ".task-types-empty");

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
    assert.ok(present(container, "#task-types-page"), "the page should still render");
  });
  assert.match(container.textContent ?? "", /Task types/);
});
