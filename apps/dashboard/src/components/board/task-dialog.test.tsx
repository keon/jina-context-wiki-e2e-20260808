import assert from "node:assert/strict";
import { test } from "node:test";
import { screen } from "@testing-library/react";
import { assertGridContracts, assertNoLeakedValues, renderComponent } from "../../testing/render.tsx";
import { TaskDialog } from "./task-dialog.tsx";
import type { BoardEvent, BoardState, BoardTask } from "../../lib/types.ts";

/**
 * REGRESSION: the assignee row rendered the literal string "Undefined".
 *
 * `assigneeRole` is optional, and the fact list called `humanize(task.assigneeRole)`
 * unguarded — `String(undefined)` title-cased. Every sibling field in the same
 * list used "—" for the same condition, so an unassigned task read as though it
 * were assigned to somebody named Undefined.
 */

const NO_EVENTS: readonly BoardEvent[] = [];

/**
 * Overrides accept an explicit `undefined` so a case can spell out that a field
 * is absent — which is the point of these fixtures. The key is then *deleted*
 * rather than set: under `exactOptionalPropertyTypes` an optional key may be
 * omitted but not assigned `undefined`, and a missing key is what the component
 * actually receives for a field the API did not populate.
 */
type TaskOverrides = { [K in keyof BoardTask]?: BoardTask[K] | undefined };

function task(overrides: TaskOverrides = {}): BoardTask {
  const built: Record<string, unknown> = {
    id: "task_01HQ",
    type: "review.final",
    title: "Review the payment retry path",
    status: "in_progress",
    attempt: 1,
    createdAt: "2026-02-01T10:00:00.000Z",
    updatedAt: "2026-02-01T11:30:00.000Z"
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete built[key];
    else built[key] = value;
  }
  return built as unknown as BoardTask;
}

const EMPTY_BOARD: BoardState = { tasks: [], dependencies: [] };

function factValue(label: string): string {
  const term = screen.getByText(label, { selector: "dt" });
  return term.parentElement?.querySelector("dd")?.textContent ?? "";
}

function openDialog(current: BoardTask, board: BoardState = EMPTY_BOARD, events = NO_EVENTS) {
  return renderComponent(
    <TaskDialog task={current} board={board} events={events} onOpenTask={() => undefined} onClose={() => undefined} />
  );
}

test("a task with no assignee reports absence, not a humanized undefined", () => {
  openDialog(task());
  assert.equal(factValue("Assignee"), "—");
  assert.equal(screen.queryByText("Undefined"), null);
});

test("an assigned task still reports its role", () => {
  openDialog(task({ assigneeRole: "review_agent" }));
  assert.equal(factValue("Assignee"), "Review Agent");
});

test("nothing in the dialog leaks a formatter placeholder, however sparse the task", () => {
  // Every optional field absent and both stamps unparseable: the shape a task
  // takes between creation and its first transition, plus a bad clock.
  const { container } = openDialog(
    task({
      assigneeRole: undefined,
      epoch: undefined,
      required: undefined,
      dedupeKey: undefined,
      dispatchTopic: undefined,
      createdAt: "not-a-timestamp",
      updatedAt: undefined,
      metadata: { repository: "acme/payments", summary: "Retry policy changed" }
    }),
    EMPTY_BOARD,
    [
      {
        id: "event_1",
        taskId: "task_01HQ",
        type: "task.created",
        at: "also-not-a-timestamp",
        payload: { actor: "review_agent" }
      }
    ]
  );
  assertNoLeakedValues(container, "TaskDialog");
  // The two stamps above are the ones that used to reach the page as "Invalid Date".
  assert.equal(factValue("Created"), "–");
  assert.equal(factValue("Updated"), "–");
});

test("every fact and relationship fills the lanes its grid cuts for it", () => {
  const board: BoardState = {
    tasks: [task(), task({ id: "task_02HQ", title: "Ship the retry fix" })],
    dependencies: [
      { taskId: "task_01HQ", dependsOnTaskId: "task_02HQ", relationship: "blocks", required: true }
    ]
  };
  const { container } = openDialog(task(), board);
  assertGridContracts(container, "TaskDialog");
});
