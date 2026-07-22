"use client";

import { useState } from "react";
import { HistoryInspector } from "../../components/history/history-inspector.tsx";
import { HistoryList } from "../../components/history/history-table.tsx";
import { filteredHistoryEvents, historyEventContext } from "../../components/history/history-events.tsx";
import { uniqueValues } from "../../lib/board.ts";
import { humanize } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import type { OverviewResponse } from "../../lib/types.ts";

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
  const { data } = usePoll<OverviewResponse>("/api/overview");
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
    <section id="history-page">
      <header className="page-heading">
        <div>
          <h1>History</h1>
          <p>A complete record of task activity.</p>
        </div>
      </header>
      <div className="page-filters history-filters">
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
      <div className="history-layout">
        <section className="history-table" aria-label="Activity history">
          <div className="history-table-head">
            <span>Time</span>
            <span>Event</span>
            <span>Actor</span>
            <span>Repository</span>
            <span>Task</span>
            <span>Evidence / confidence</span>
          </div>
          <HistoryList
            events={events}
            tasks={tasks}
            selectedEventId={effectiveSelectedId}
            onSelect={setSelectedEventId}
          />
        </section>
        <HistoryInspector event={selectedEvent} tasks={tasks} />
      </div>
    </section>
  );
}
