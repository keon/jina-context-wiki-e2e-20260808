import { eventLabel, formatValue } from "../../lib/format.ts";
import type { BoardEvent, BoardTask } from "../../lib/types.ts";

/** Derived context and filtering helpers for the history page. */

export interface HistoryEventContext {
  readonly task: BoardTask | null;
  readonly actor: string;
  readonly repository: string;
}

function asText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? "";
}

export function historyEventContext(event: BoardEvent, tasks: readonly BoardTask[]): HistoryEventContext {
  const task = event.taskId ? (tasks.find((candidate) => candidate.id === event.taskId) ?? null) : null;
  return {
    task,
    actor: asText(event.payload?.actor) || asText(event.payload?.assigneeRole) || task?.assigneeRole || "System",
    repository: asText(event.payload?.repository) || asText(task?.metadata?.repository) || "—"
  };
}

export function historyDateGroup(value: string): string {
  const date = new Date(value);
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

export interface HistoryFilters {
  readonly query: string;
  readonly type: string;
  readonly actor: string;
  readonly repository: string;
  readonly date: string;
}

export function filteredHistoryEvents(
  events: readonly BoardEvent[],
  tasks: readonly BoardTask[],
  filters: HistoryFilters
): readonly BoardEvent[] {
  const query = filters.query.trim().toLowerCase();
  const now = Date.now();
  return events
    .slice()
    .reverse()
    .filter((event) => {
      const context = historyEventContext(event, tasks);
      const haystack = [
        eventLabel(event),
        context.task?.title,
        context.actor,
        context.repository,
        formatValue(event.payload || {})
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const age = now - new Date(event.at).getTime();
      return (
        (!query || haystack.includes(query)) &&
        (!filters.type || event.type === filters.type) &&
        (!filters.actor || context.actor === filters.actor) &&
        (!filters.repository || context.repository === filters.repository) &&
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
