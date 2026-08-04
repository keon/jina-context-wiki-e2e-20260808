"use client";

import { clampConfidence, eventLabel, formatTime, humanize } from "../../lib/format.ts";
import type { BoardEvent, BoardTask } from "../../lib/types.ts";
import { historyEventConfidence, historyEventContext, historyEventExplanation } from "./history-events.tsx";

/** Side inspector describing the provenance of the selected history event. */

export function HistoryInspector({
  event,
  tasks
}: {
  readonly event: BoardEvent | null;
  readonly tasks: readonly BoardTask[];
}) {
  if (!event) {
    return (
      <aside className="run-history-detail" id="history-details" aria-live="polite">
        <div className="run-history-detail__empty">
          <strong>No event selected</strong>
          <p>Select an event to inspect its provenance and changes.</p>
        </div>
      </aside>
    );
  }
  const context = historyEventContext(event, tasks);
  const confidence = historyEventConfidence(event);
  const confidencePercent = confidence === undefined ? undefined : Math.round(clampConfidence(confidence) * 100);
  const payload = event.payload;
  const evidence: readonly string[] = Array.isArray(payload?.evidence) ? payload.evidence.map(String) : [];
  const tone = /failed|canceled/i.test(event.type)
    ? " danger"
    : /completed|created/i.test(event.type)
      ? " success"
      : "";
  const details: readonly (readonly [string, string])[] = [
    ["Event ID", event.id],
    ["Timestamp", formatTime(event.at)],
    ["Actor", humanize(context.actor)],
    ["Repository", context.repository],
    ["Source task", context.task?.title || "Board event"],
    ["Sequence", String(event.seq)]
  ];
  return (
    <aside className="run-history-detail" id="history-details" aria-live="polite">
      <header className="run-history-detail__header">
        <span className={`event-dot${tone}`} />
        <div>
          <h2>{eventLabel(event)}</h2>
          <span>{humanize(event.type.split(".").pop())}</span>
        </div>
      </header>
      <dl className="run-history-detail__facts">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section className="run-history-detail__section">
        <span className="run-history-detail__label">Explanation</span>
        <p>{historyEventExplanation(event, context.task)}</p>
      </section>
      <section className="run-history-detail__section">
        <div className="run-history-detail__section-heading">
          <span className="run-history-detail__label">Evidence</span>
          <span>{evidence.length}</span>
        </div>
        {evidence.length ? (
          <ul className="run-history-detail__evidence">
            {evidence.map((citation, index) => (
              <li key={`${index}-${citation}`}>{citation}</li>
            ))}
          </ul>
        ) : (
          <p>No evidence citations were provided.</p>
        )}
      </section>
      {confidencePercent !== undefined ? (
        <section className="run-history-detail__section">
          <div className="run-history-detail__section-heading">
            <span className="run-history-detail__label">Recorded confidence</span>
            <strong>{confidencePercent}%</strong>
          </div>
          <div className="run-history-detail__meter" aria-hidden="true">
            <span style={{ width: `${confidencePercent}%` }} />
          </div>
        </section>
      ) : null}
      {payload && Object.keys(payload).length ? (
        <details className="run-history-detail__payload">
          <summary>Event payload</summary>
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        </details>
      ) : null}
    </aside>
  );
}
