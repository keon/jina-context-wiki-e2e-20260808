"use client";

import { useState } from "react";
import { HistoryInspector } from "../../components/history/history-inspector.tsx";
import { HistoryList } from "../../components/history/history-table.tsx";
import { filteredHistoryEvents, historyEventContext } from "../../components/history/history-events.tsx";
import { uniqueValues } from "../../lib/board.ts";
import { humanize } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import { tenantDashboardApiUrl } from "../../lib/operations-api.ts";
import type { OverviewResponse } from "../../lib/types.ts";
import { useTenant } from "../../dashboard/providers.tsx";

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
  const { data } = usePoll<OverviewResponse>(selected ? tenantDashboardApiUrl(selected.tenantId, "work-overview") : "");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [repository, setRepository] = useState("");
  const [date, setDate] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const boardEvents = data?.events ?? [];
  const tasks = data?.board.tasks ?? [];
  const typeOptions = uniqueValues(boardEvents.map((event) => event.type));
  const actorOptions = uniqueValues(boardEvents.map((event) => historyEventContext(event, tasks).actor));
  const repositoryOptions = uniqueValues(boardEvents.map((event) => historyEventContext(event, tasks).repository));
  const events = filteredHistoryEvents(boardEvents, tasks, {
    query,
    type: typeOptions.includes(type) ? type : "",
    actor: actorOptions.includes(actor) ? actor : "",
    repository: repositoryOptions.includes(repository) ? repository : "",
    date
  });
  const effectiveSelectedId = events.some((event) => event.id === selectedEventId)
    ? selectedEventId
    : (events[0]?.id ?? null);
  const selectedEvent = events.find((event) => event.id === effectiveSelectedId) ?? null;

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
            events={events}
            tasks={tasks}
            selectedEventId={effectiveSelectedId}
            onSelect={setSelectedEventId}
          />
          <footer className="run-history-list-footer">
            {`${events.length} ${events.length === 1 ? "event" : "events"}`}
          </footer>
        </section>
        <HistoryInspector event={selectedEvent} tasks={tasks} />
      </div>
    </section>
  );
}
