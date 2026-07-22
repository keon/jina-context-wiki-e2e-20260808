"use client";

import { Fragment } from "react";
import { confidenceLabel, eventLabel, humanize } from "../../lib/format.ts";
import type { BoardEvent, BoardTask } from "../../lib/types.ts";
import { historyDateGroup, historyEventConfidence, historyEventContext } from "./history-events.tsx";

/** The grouped list of history rows shown in the activity table. */

function HistoryEventCell({ event }: { readonly event: BoardEvent }) {
  const tone = /failed|canceled/i.test(event.type)
    ? " danger"
    : /completed|created/i.test(event.type)
      ? " success"
      : "";
  return (
    <span className="history-event-cell">
      <span className={`event-dot${tone}`} />
      <strong>{eventLabel(event)}</strong>
    </span>
  );
}

function HistoryRow({
  event,
  tasks,
  selected,
  onSelect
}: {
  readonly event: BoardEvent;
  readonly tasks: readonly BoardTask[];
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const context = historyEventContext(event, tasks);
  const confidence = historyEventConfidence(event);
  return (
    <button
      type="button"
      className={`history-row${selected ? " selected" : ""}`}
      data-history-event-id={event.id}
      onClick={() => onSelect(event.id)}
    >
      <time className="history-time">
        {new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time>
      <HistoryEventCell event={event} />
      <span className="history-chip">{humanize(context.actor)}</span>
      <span className="history-muted">{context.repository}</span>
      <span className="history-muted">{context.task?.title || "Board event"}</span>
      <span className={confidence === undefined ? "history-muted" : "history-confidence"}>
        {confidence === undefined ? "—" : confidenceLabel(confidence)}
      </span>
    </button>
  );
}

export function HistoryList({
  events,
  tasks,
  selectedEventId,
  onSelect
}: {
  readonly events: readonly BoardEvent[];
  readonly tasks: readonly BoardTask[];
  readonly selectedEventId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  let previousGroup: string | null = null;
  return (
    <div id="history-list">
      {events.length === 0 ? <p className="empty">No events match these filters.</p> : null}
      {events.map((event) => {
        const group = historyDateGroup(event.at);
        const heading = group !== previousGroup ? <div className="history-group">{group}</div> : null;
        previousGroup = group;
        return (
          <Fragment key={event.id}>
            {heading}
            <HistoryRow event={event} tasks={tasks} selected={event.id === selectedEventId} onSelect={onSelect} />
          </Fragment>
        );
      })}
    </div>
  );
}
