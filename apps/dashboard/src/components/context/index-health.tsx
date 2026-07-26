"use client";

import { useMemo, useState } from "react";
import { projectorRows } from "../../lib/context.ts";
import { formatTime, humanize } from "../../lib/format.ts";
import type { ContextGeneration, ContextMetricsResponse } from "../../lib/types.ts";

export function IndexHealth({
  generation,
  metrics,
  onRefresh
}: {
  readonly generation: ContextGeneration;
  readonly metrics: ContextMetricsResponse | undefined;
  readonly onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const rows = useMemo(() => {
    const byName = new Map(projectorRows(generation).map((projector) => [projector.name, projector]));
    for (const projector of metrics?.projectors ?? [])
      byName.set(projector.name, { ...byName.get(projector.name), ...projector });
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [generation, metrics]);

  const rebuild = async () => {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/context/rebuild", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ repository: generation.repository, ref: generation.ref })
      });
      if (!response.ok) throw new Error(`Rebuild failed with ${response.status}`);
      const payload = (await response.json()) as { generationId?: string; status?: string };
      setMessage(`Rebuild ${payload.status ?? "queued"}${payload.generationId ? ` · ${payload.generationId}` : ""}`);
      onRefresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Rebuild failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="context-operations-panel context-index-health">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Index health</span>
          <h2>Generation projectors</h2>
        </div>
        <button type="button" className="secondary-button" disabled={pending} onClick={() => void rebuild()}>
          {pending ? "Queuing…" : "Rebuild"}
        </button>
      </header>
      <div className="context-health-summary">
        <HealthFact label="Published" value={String(metrics?.publishedGenerationCount ?? "–")} />
        <HealthFact label="Documents" value={String(metrics?.documentCount ?? "–")} />
        <HealthFact label="Fragments" value={String(metrics?.fragmentCount ?? "–")} />
        <HealthFact label="Hierarchy nodes" value={String(metrics?.hierarchyNodeCount ?? "–")} />
        <HealthFact label="Embeddings" value={String(metrics?.embeddingCount ?? "–")} />
        <HealthFact label="Query p95" value={metrics ? `${metrics.query.p95Ms}ms` : "–"} />
      </div>
      {metrics?.oldestPendingAt ? (
        <p className="context-backlog-warning">Oldest pending projection: {formatTime(metrics.oldestPendingAt)}</p>
      ) : null}
      <div className="context-projector-table">
        <div className="context-projector-row heading">
          <span>Consumer</span>
          <span>Status</span>
          <span>Checkpoint</span>
          <span>Backlog</span>
        </div>
        {rows.map((projector) => (
          <div className="context-projector-row" key={projector.name}>
            <strong>{humanize(projector.name)}</strong>
            <span className={`context-status ${projector.status}`}>{projector.status}</span>
            <span title={projector.checkpoint}>{projector.checkpoint?.slice(0, 12) ?? "–"}</span>
            <span>{projector.backlog ?? metrics?.outboxDepthByConsumer[projector.name] ?? 0}</span>
            {projector.error ? <p>{projector.error}</p> : null}
          </div>
        ))}
        {rows.length === 0 ? <p className="context-panel-empty">No projector diagnostics were returned.</p> : null}
      </div>
      {metrics && metrics.query.citationFailureCount > 0 ? (
        <p className="context-alert danger">
          {metrics.query.citationFailureCount} citation verification failures recorded.
        </p>
      ) : null}
      {message ? <p className="context-alert">{message}</p> : null}
    </section>
  );
}

function HealthFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
