"use client";

import { useEffect, useMemo, useState } from "react";
import { contextScopes, generationForScope, projectorRows, publishedGenerations } from "../../lib/context.ts";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import { useCursorPoll, usePoll } from "../../lib/poll.ts";
import type { ContextGeneration, ContextGenerationsResponse, ContextMetricsResponse } from "../../lib/types.ts";
import { IndexHealth } from "./index-health.tsx";
import { KnowledgeCatalog } from "./knowledge-catalog.tsx";
import { QueryWorkspace } from "./query-workspace.tsx";
import { StructureBrowser } from "./structure-browser.tsx";

export function ContextPage() {
  const generationsResource = useCursorPoll<ContextGenerationsResponse>(
    "/api/context/generations?limit=100",
    "generations",
    10_000
  );
  const metricsResource = usePoll<ContextMetricsResponse>("/api/context/metrics", 10_000);
  const generations = useMemo(
    () => publishedGenerations(generationsResource.data?.generations ?? []),
    [generationsResource.data]
  );
  const scopes = useMemo(() => contextScopes(generations), [generations]);
  const [scopeKey, setScopeKey] = useState("");

  useEffect(() => {
    const stillExists = scopes.some((scope) => `${scope.repository}\0${scope.ref}` === scopeKey);
    if (!stillExists) {
      const first = scopes[0];
      setScopeKey(first ? `${first.repository}\0${first.ref}` : "");
    }
  }, [scopeKey, scopes]);

  const [repository = "", ref = ""] = scopeKey.split("\0");
  const generation = generationForScope(generations, repository, ref);

  return (
    <section id="context-page" className="context-page">
      <header className="context-page-header">
        <div>
          <span className="context-eyebrow">Repository context</span>
          <h1>Evidence-backed workspace</h1>
          <p>Answers, source support, generated knowledge, and index state for one immutable repository view.</p>
        </div>
        <label className="context-scope-picker">
          <span>Repository and ref</span>
          <select value={scopeKey} disabled={scopes.length === 0} onChange={(event) => setScopeKey(event.target.value)}>
            {scopes.length === 0 ? <option value="">No published context</option> : null}
            {scopes.map((scope) => {
              const value = `${scope.repository}\0${scope.ref}`;
              return (
                <option key={value} value={value}>
                  {scope.repository} @ {scope.ref}
                </option>
              );
            })}
          </select>
        </label>
      </header>

      {generation ? (
        <>
          <GenerationStrip generation={generation} />
          <QueryWorkspace generation={generation} />
          <section className="context-operations-grid">
            <KnowledgeCatalog repository={repository} />
            <IndexHealth
              generation={generation}
              metrics={metricsResource.data}
              onRefresh={() => {
                void Promise.all([generationsResource.refresh(), metricsResource.refresh()]);
              }}
            />
            <StructureBrowser repository={repository} refName={ref} />
          </section>
        </>
      ) : (
        <section className="context-empty-state" aria-live="polite">
          <strong>No published context generation</strong>
          <p>
            Run <code>ingest-evidence</code> and the baseline <code>index-context</code> stage for a repository.
            Generated knowledge is optional and will enrich a later generation.
          </p>
        </section>
      )}
    </section>
  );
}

function GenerationStrip({ generation }: { readonly generation: ContextGeneration }) {
  const projectors = projectorRows(generation);
  const degraded = projectors.filter((projector) => projector.status === "failed");
  return (
    <section className="context-generation-strip" aria-label="Selected generation">
      <GenerationFact label="Generation" value={shortId(generation.id)} />
      <GenerationFact label="Commit" value={generation.commitSha.slice(0, 12)} mono />
      <GenerationFact label="Published" value={formatTime(generation.publishedAt ?? generation.createdAt)} />
      <GenerationFact label="Knowledge" value={humanize(generation.derivedKnowledge)} />
      <GenerationFact
        label="Index state"
        value={degraded.length === 0 ? `${projectors.length} projectors ready` : `${degraded.length} degraded`}
        tone={degraded.length === 0 ? "good" : "warning"}
      />
    </section>
  );
}

function GenerationFact({
  label,
  value,
  mono = false,
  tone
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly tone?: "good" | "warning";
}) {
  return (
    <div className="context-generation-fact">
      <span>{label}</span>
      <strong className={`${mono ? "mono" : ""}${tone ? ` ${tone}` : ""}`}>{value}</strong>
    </div>
  );
}
