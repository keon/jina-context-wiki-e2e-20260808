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
      className={`run-history-row${selected ? " selected" : ""}`}
      data-history-event-id={event.id}
      aria-pressed={selected}
      onClick={() => onSelect(event.id)}
    >
      <time className="run-history-row__time">
        {new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time>
      <span className="run-history-row__event">
        <HistoryEventCell event={event} />
        <span>{context.task?.title || "Board event"}</span>
      </span>
      <span className="run-history-row__context">
        <span>{context.repository}</span>
        <span className="history-chip">{humanize(context.actor)}</span>
      </span>
      <span className={confidence === undefined ? "run-history-row__confidence muted" : "run-history-row__confidence"}>
        {confidence === undefined ? "—" : confidenceLabel(confidence)}
      </span>
      <span className="run-history-row__arrow" aria-hidden="true">
        ›
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
    <div className="run-history-list" id="history-list">
      {events.length === 0 ? (
        <div className="run-history-empty">
          <strong>No matching events</strong>
          <p>Try changing or clearing one of the filters above.</p>
        </div>
      ) : null}
      {events.map((event) => {
        const group = historyDateGroup(event.at);
        const heading = group !== previousGroup ? <div className="run-history-group">{group}</div> : null;
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
