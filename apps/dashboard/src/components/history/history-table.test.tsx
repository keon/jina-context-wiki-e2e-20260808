import assert from "node:assert/strict";
import { test } from "node:test";
import { screen } from "@testing-library/react";
import {
  assertGridContracts,
  assertGridRow,
  assertNoLeakedValues,
  count,
  present,
  renderComponent,
  textOf
} from "../../testing/render.tsx";
import { buildHistoryEventRows } from "./history-events.tsx";
import { HistoryList, type HistoryListStatus } from "./history-table.tsx";
import type { BoardEvent, BoardTask } from "../../lib/types.ts";

/**
 * REGRESSIONS in the activity list:
 *
 *  - An unparseable `event.at` reached the page twice as "Invalid Date": once in
 *    the row's own time cell, and once as the sticky date heading standing over
 *    every row that shared the bad stamp.
 *  - "Nothing to show" was one render. A list that had not loaded, a list whose
 *    read failed, a workspace with no activity, and a filter that matched
 *    nothing all have different next steps for the reader, and only one of them
 *    means "there is nothing here".
 */

const TASK: BoardTask = {
  id: "task_01",
  type: "review.final",
  title: "Review the payment retry path",
  status: "in_progress",
  attempt: 1
};

function events(...at: string[]): readonly BoardEvent[] {
  return at.map((stamp, index) => ({
    id: `event_${index}`,
    taskId: TASK.id,
    type: "task.created",
    at: stamp,
    payload: { actor: "review_agent", repository: "acme/payments" }
  }));
}

function renderList(rows: ReturnType<typeof buildHistoryEventRows>, status: HistoryListStatus, filtered = false) {
  return renderComponent(
    <HistoryList
      rows={rows}
      status={status}
      filtered={filtered}
      selectedEventId={null}
      onSelect={() => undefined}
      onRetry={() => undefined}
    />
  );
}

test("an unparseable timestamp renders the absence sentinel, never Invalid Date", () => {
  const rows = buildHistoryEventRows(events("not-a-timestamp"), [TASK]);
  const { container } = renderList(rows, "ready");

  assertNoLeakedValues(container, "HistoryList");
  assert.equal(textOf(container, ".run-history-row__time"), "—");
});

test("an unparseable timestamp does not become a sticky group heading", () => {
  const rows = buildHistoryEventRows(events("not-a-timestamp"), [TASK]);
  const { container } = renderList(rows, "ready");

  assert.equal(textOf(container, ".run-history-group"), "Unknown date");
  assert.equal(screen.queryAllByText(/Invalid Date/).length, 0);
});

test("a readable timestamp still groups under a real date", () => {
  const rows = buildHistoryEventRows(events(new Date().toISOString()), [TASK]);
  const { container } = renderList(rows, "ready");

  assert.equal(textOf(container, ".run-history-group"), "Today");
  assertNoLeakedValues(container, "HistoryList");
});

test("loading, unavailable, empty and filtered-empty are four different renders", () => {
  const empty = buildHistoryEventRows([], []);
  const seen = new Map<string, string>();

  for (const [name, status, filtered] of [
    ["loading", "loading", false],
    ["unavailable", "unavailable", false],
    ["empty", "ready", false],
    ["filtered", "ready", true]
  ] as const) {
    const { container, unmount } = renderList(empty, status, filtered);
    seen.set(name, textOf(container, ".run-history-empty"));
    unmount();
  }

  assert.match(seen.get("loading")!, /Loading activity/);
  assert.match(seen.get("unavailable")!, /unavailable/i);
  assert.match(seen.get("empty")!, /No activity recorded yet/);
  assert.match(seen.get("filtered")!, /No matching events/);
  assert.equal(new Set(seen.values()).size, 4, "two of the four states render identical copy");
});

test("a failed read offers a retry; an empty workspace does not", () => {
  const empty = buildHistoryEventRows([], []);

  const failed = renderList(empty, "unavailable");
  assert.ok(present(failed.container, "button"), "the unavailable state must offer a retry");
  failed.unmount();

  const nothing = renderList(empty, "ready");
  assert.equal(count(nothing.container, "button"), 0, "an empty workspace has nothing to retry");
});

test("a loaded list never shows a placeholder alongside its rows", () => {
  const rows = buildHistoryEventRows(events(new Date().toISOString()), [TASK]);
  const { container } = renderList(rows, "ready");

  assert.equal(count(container, ".run-history-empty"), 0);
  assert.equal(count(container, ".run-history-row"), 1);
});

test("each activity row fills the five lanes the table cuts for it", () => {
  const rows = buildHistoryEventRows(events(new Date().toISOString(), "not-a-timestamp"), [TASK]);
  const { container } = renderList(rows, "ready");

  assertGridRow(container, "run-history-row", 5);
  assertGridContracts(container, "HistoryList");
});
