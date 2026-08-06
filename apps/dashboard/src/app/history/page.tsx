"use client";

import { useCallback, useMemo, useState } from "react";
import { HistoryInspector } from "../../components/history/history-inspector.tsx";
import { HISTORY_RENDER_LIMIT, HistoryList } from "../../components/history/history-table.tsx";
import { buildHistoryEventRows, filterHistoryEventRows } from "../../components/history/history-events.tsx";
import { uniqueValues } from "../../lib/board.ts";
import { humanize } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import { tenantDashboardApiUrl } from "../../lib/operations-api.ts";
import type { BoardEvent, BoardTask, OverviewResponse } from "../../lib/types.ts";

import { useTenant } from "../../dashboard/providers.tsx";

const NO_EVENTS: readonly BoardEvent[] = [];
const NO_TASKS: readonly BoardTask[] = [];

function FilterSelect({
  id,
  ariaLabel,
  allLabel,
  values,
  value,
  onChange
}: {
  readonly id: string;
  readonly ariaLabel: string;
  readonly allLabel: string;
  readonly values: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={values.includes(value) ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{allLabel}</option>
      {values.map((candidate) => (
        <option key={candidate} value={candidate}>
          {humanize(candidate)}
        </option>
      ))}
    </select>
  );
}

export default function HistoryPage() {
  const { selected } = useTenant();
  const { data, online, refresh } = usePoll<OverviewResponse>(
    selected ? tenantDashboardApiUrl(selected.tenantId, "work-overview") : ""
  );
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [repository, setRepository] = useState("");
  const [date, setDate] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const boardEvents = data?.events ?? NO_EVENTS;
  const tasks = data?.board.tasks ?? NO_TASKS;

  // One O(events) derivation shared by the filter options, the filter pass, and
  // the rendered rows. `usePoll` only replaces `data` when the payload actually
  // changed, so this survives the 24 polls a minute and every keystroke.
  const rows = useMemo(() => buildHistoryEventRows(boardEvents, tasks), [boardEvents, tasks]);
  const typeOptions = useMemo(() => uniqueValues(rows.map((row) => row.event.type)), [rows]);
  const actorOptions = useMemo(() => uniqueValues(rows.map((row) => row.context.actor)), [rows]);
  const repositoryOptions = useMemo(() => uniqueValues(rows.map((row) => row.context.repository)), [rows]);

  const effectiveType = typeOptions.includes(type) ? type : "";
  const effectiveActor = actorOptions.includes(actor) ? actor : "";
  const effectiveRepository = repositoryOptions.includes(repository) ? repository : "";
  const filtered = Boolean(query.trim() || effectiveType || effectiveActor || effectiveRepository || date);

  const visibleRows = useMemo(
    () =>
      filterHistoryEventRows(rows, {
        query,
        type: effectiveType,
        actor: effectiveActor,
        repository: effectiveRepository,
        date
      }),
    [rows, query, effectiveType, effectiveActor, effectiveRepository, date]
  );

  const effectiveSelectedId = visibleRows.some((row) => row.event.id === selectedEventId)
    ? selectedEventId
    : (visibleRows[0]?.event.id ?? null);
  const selectedRow = visibleRows.find((row) => row.event.id === effectiveSelectedId) ?? null;

  // `data === undefined` with no completed request yet is "not loaded", not "empty";
  // `online === false` with nothing loaded is a failed endpoint, not "empty".
  const status = data !== undefined ? "ready" : online === false ? "unavailable" : "loading";
  const truncated = visibleRows.length > HISTORY_RENDER_LIMIT;
  const retry = useCallback(() => void refresh(), [refresh]);

  // With no workspace resolved there is no endpoint to poll, so the request is
  // never issued and `data`/`online` both stay undefined — which the status
  // ternary above would read as "loading" forever.
  if (!selected) {
    return (
      <div className="page-placeholder" role="status">
        <h1 className="sr-only">Run history</h1>
        <strong>No workspace selected</strong>
        <p>Select a workspace from the sidebar to read its activity.</p>
      </div>
    );
  }

  return (
    <section className="run-history-page" id="history-page">
      <header className="page-heading">
        <div>
          <h1>Run history</h1>
          <p>Every task event, actor, and repository in one chronological record.</p>
        </div>
      </header>
      <div className="history-toolbar">
        <label className="search-control">
          <span aria-hidden="true">⌕</span>
          <input
            id="history-search"
            placeholder="Search events…"
            aria-label="Search events"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <FilterSelect
          id="history-event-type"
          ariaLabel="Filter by event type"
          allLabel="Event type: All"
          values={typeOptions}
          value={type}
          onChange={setType}
        />
        <FilterSelect
          id="history-actor"
          ariaLabel="Filter by actor"
          allLabel="Actor: All"
          values={actorOptions}
          value={actor}
          onChange={setActor}
        />
        <FilterSelect
          id="history-repository"
          ariaLabel="Filter by repository"
          allLabel="Repository: All"
          values={repositoryOptions}
          value={repository}
          onChange={setRepository}
        />
        <select
          id="history-date"
          aria-label="Filter by date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        >
          <option value="">Date: All time</option>
          <option value="today">Today</option>
          <option value="week">Last 7 days</option>
        </select>
      </div>
      <div className="run-history-layout">
        <section className="run-history-list-panel" aria-label="Activity history">
          <div className="run-history-table-head" aria-hidden="true">
            <span>Time</span>
            <span>Event</span>
            <span>Context</span>
            <span>Confidence</span>
            <span />
          </div>
          <HistoryList
            rows={visibleRows}
            status={status}
            filtered={filtered}
            selectedEventId={effectiveSelectedId}
            onSelect={setSelectedEventId}
            onRetry={retry}
          />
          <footer className="run-history-list-footer">
            {status === "loading"
              ? "Loading activity…"
              : status === "unavailable"
                ? "Activity history could not be loaded."
                : truncated
                  ? `Showing the ${HISTORY_RENDER_LIMIT} most recent of ${visibleRows.length} events — narrow the filters to reach older activity.`
                  : `${visibleRows.length} ${visibleRows.length === 1 ? "event" : "events"}`}
          </footer>
        </section>
        <HistoryInspector row={selectedRow} />
      </div>
    </section>
  );
}
