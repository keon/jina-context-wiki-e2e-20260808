"use client";

import { Fragment, memo } from "react";
import { confidenceLabel, eventLabel, humanize } from "../../lib/format.ts";
import type { BoardEvent } from "../../lib/types.ts";
import { eventClockTime, historyDateGroup, historyEventConfidence, type HistoryEventRow } from "./history-events.tsx";

/** The grouped list of history rows shown in the activity table. */

/**
 * Upper bound on rendered rows. The activity stream is unbounded, and each row
 * is a focusable button with several formatted cells; past a few hundred nodes
 * the keystroke-by-keystroke filter re-render becomes the bottleneck. Anything
 * beyond this is reported in the footer rather than silently dropped.
 */
export const HISTORY_RENDER_LIMIT = 200;

/** What the list should say when it has no rows to show. */
export type HistoryListStatus = "loading" | "unavailable" | "ready";

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

const HistoryRow = memo(function HistoryRow({
  row,
  selected,
  onSelect
}: {
  readonly row: HistoryEventRow;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const { event, context } = row;
  const confidence = historyEventConfidence(event);
  return (
    <button
      type="button"
      className={`run-history-row${selected ? " selected" : ""}`}
      data-history-event-id={event.id}
      aria-pressed={selected}
      onClick={() => onSelect(event.id)}
    >
      <time className="run-history-row__time" dateTime={event.at}>
        {eventClockTime(event.at)}
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
});

function HistoryListPlaceholder({
  status,
  filtered,
  onRetry
}: {
  readonly status: HistoryListStatus;
  readonly filtered: boolean;
  readonly onRetry: () => void;
}) {
  if (status === "loading") {
    return (
      <div className="run-history-empty" aria-busy="true">
        <strong>Loading activity…</strong>
        <p>Reading this workspace&rsquo;s event history.</p>
      </div>
    );
  }
  if (status === "unavailable") {
    return (
      <div className="run-history-empty" role="status">
        <strong>Activity history is unavailable</strong>
        <p>The workspace service could not be reached, so no events could be read.</p>
        <button type="button" className="knowledge-button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (filtered) {
    return (
      <div className="run-history-empty">
        <strong>No matching events</strong>
        <p>Try changing or clearing one of the filters above.</p>
      </div>
    );
  }
  return (
    <div className="run-history-empty">
      <strong>No activity recorded yet</strong>
      <p>Events appear here as tasks are created, queued, and completed.</p>
    </div>
  );
}

export function HistoryList({
  rows,
  status,
  filtered,
  selectedEventId,
  onSelect,
  onRetry
}: {
  readonly rows: readonly HistoryEventRow[];
  readonly status: HistoryListStatus;
  readonly filtered: boolean;
  readonly selectedEventId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onRetry: () => void;
}) {
  const visible = rows.length > HISTORY_RENDER_LIMIT ? rows.slice(0, HISTORY_RENDER_LIMIT) : rows;
  let previousGroup: string | null = null;
  return (
    <div className="run-history-list" id="history-list">
      {visible.length === 0 ? <HistoryListPlaceholder status={status} filtered={filtered} onRetry={onRetry} /> : null}
      {visible.map((row) => {
        const group = historyDateGroup(row.event.at);
        const heading = group !== previousGroup ? <div className="run-history-group">{group}</div> : null;
        previousGroup = group;
        return (
          <Fragment key={row.event.id}>
            {heading}
            <HistoryRow row={row} selected={row.event.id === selectedEventId} onSelect={onSelect} />
          </Fragment>
        );
      })}
    </div>
  );
}
