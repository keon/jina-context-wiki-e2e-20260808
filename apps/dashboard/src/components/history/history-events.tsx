import { eventLabel, formatValue } from "../../lib/format.ts";
import type { BoardEvent, BoardTask } from "../../lib/types.ts";

/** Derived context and filtering helpers for the history page. */

interface HistoryEventContext {
  readonly task: BoardTask | null;
  readonly actor: string;
  readonly repository: string;
}

/**
 * An event paired with everything derived from it. The derivation is O(events)
 * once — filter options, filtering, and row rendering all read the same rows
 * instead of re-deriving context (and re-serializing payloads) per pass.
 */
export interface HistoryEventRow {
  readonly event: BoardEvent;
  readonly context: HistoryEventContext;
  /** Lowercased search text, including the serialized payload. Computed once. */
  readonly haystack: string;
  /** `Date.parse(event.at)`, precomputed for the date filter. */
  readonly timestamp: number;
}

function asText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? "";
}

function historyEventContext(event: BoardEvent, tasksById: ReadonlyMap<string, BoardTask>): HistoryEventContext {
  const task = (event.taskId ? tasksById.get(event.taskId) : undefined) ?? null;
  return {
    task,
    actor: asText(event.payload?.actor) || asText(event.payload?.assigneeRole) || task?.assigneeRole || "System",
    repository: asText(event.payload?.repository) || asText(task?.metadata?.repository) || "—"
  };
}

/**
 * Builds the newest-first row list. One task index and one pass over the
 * events; every downstream derivation reuses the result.
 */
export function buildHistoryEventRows(
  events: readonly BoardEvent[],
  tasks: readonly BoardTask[]
): readonly HistoryEventRow[] {
  const tasksById = new Map<string, BoardTask>();
  for (const task of tasks) tasksById.set(task.id, task);

  const rows: HistoryEventRow[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const context = historyEventContext(event, tasksById);
    rows.push({
      event,
      context,
      haystack: [
        eventLabel(event),
        context.task?.title,
        context.actor,
        context.repository,
        formatValue(event.payload || {})
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
      timestamp: new Date(event.at).getTime()
    });
  }
  return rows;
}

/** Clock time for a row, or the absence sentinel when the stamp is unparseable. */
export function eventClockTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function historyDateGroup(value: string): string {
  const date = new Date(value);
  // An unparseable timestamp otherwise renders "Invalid Date" as a sticky group
  // heading over the rows it collects.
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const eventStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (eventStart === start) return "Today";
  if (eventStart === start - 86400000) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const })
  });
}

export function historyEventConfidence(event: BoardEvent): number | undefined {
  const value = event.payload?.confidence;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface HistoryFilters {
  readonly query: string;
  readonly type: string;
  readonly actor: string;
  readonly repository: string;
  readonly date: string;
}

export function filterHistoryEventRows(
  rows: readonly HistoryEventRow[],
  filters: HistoryFilters
): readonly HistoryEventRow[] {
  const query = filters.query.trim().toLowerCase();
  if (!query && !filters.type && !filters.actor && !filters.repository && !filters.date) return rows;
  const now = Date.now();
  return rows.filter((row) => {
    const age = now - row.timestamp;
    return (
      (!query || row.haystack.includes(query)) &&
      (!filters.type || row.event.type === filters.type) &&
      (!filters.actor || row.context.actor === filters.actor) &&
      (!filters.repository || row.context.repository === filters.repository) &&
      (!filters.date || (filters.date === "today" ? age <= 86400000 : age <= 604800000))
    );
  });
}

export function historyEventExplanation(event: BoardEvent, task: BoardTask | null): string {
  if (event.type === "task.transitioned")
    return `${task?.title || "The task"} changed workflow status based on the recorded run result.`;
  if (event.type === "task.created")
    return `${task?.title || "A task"} entered the operational board from its configured workflow trigger.`;
  if (event.type === "task.queued") return `${task?.title || "The task"} became ready for its assigned worker.`;
  return `${task?.title || "This board item"} recorded “${eventLabel(event)}” in the immutable activity stream.`;
}
