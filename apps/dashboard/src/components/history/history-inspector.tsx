"use client";

import { eventLabel, formatTime, humanize } from "../../lib/format.ts";
import type { BoardEvent, BoardTask } from "../../lib/types.ts";
import { ConfidenceSection, DetailGrid, EvidenceSection, ExplanationSection } from "../inspector.tsx";
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
      <aside className="side-inspector history-inspector" id="history-details" aria-live="polite">
        <p className="inspector-empty">Select an event to inspect its provenance and changes.</p>
      </aside>
    );
  }
  const context = historyEventContext(event, tasks);
  const confidence = historyEventConfidence(event);
  const payload = event.payload;
  const evidence: readonly string[] = Array.isArray(payload?.evidence) ? payload.evidence.map(String) : [];
  return (
    <aside className="side-inspector history-inspector" id="history-details" aria-live="polite">
      <header className="inspector-heading">
        <div>{eventLabel(event)}</div>
        <span className="event-state">{humanize(event.type.split(".").pop())}</span>
      </header>
      <DetailGrid
        fields={[
          ["Event ID", event.id],
          ["Timestamp", formatTime(event.at)],
          ["Actor", humanize(context.actor)],
          ["Repository", context.repository],
          ["Source task", context.task?.title || "Board event"],
          ["Sequence", String(event.seq)]
        ]}
      />
      {confidence !== undefined ? (
        <ConfidenceSection
          label="Recorded confidence"
          value={confidence}
          note="Confidence supplied by the event producer."
        />
      ) : null}
      <EvidenceSection evidence={evidence} />
      <ExplanationSection value={historyEventExplanation(event, context.task)} />
      {payload && Object.keys(payload).length ? (
        <section className="context-graph-inspector-section">
          <h3>Payload</h3>
          <pre className="inspector-payload">{JSON.stringify(payload, null, 2)}</pre>
        </section>
      ) : null}
    </aside>
  );
}
