"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { citationLocation, safeSourceUrl, shortDigest } from "../../lib/context.ts";
import { humanize, shortId } from "../../lib/format.ts";
import type { ContextCitation, ContextGeneration, ContextQueryResponse, ContextTraceStep } from "../../lib/types.ts";

const TASK_KINDS = ["lookup", "structure", "change", "intent", "overview", "status"] as const;

export function QueryWorkspace({ generation }: { readonly generation: ContextGeneration }) {
  const [question, setQuestion] = useState("");
  const [taskKind, setTaskKind] = useState<(typeof TASK_KINDS)[number] | "">("");
  const [result, setResult] = useState<ContextQueryResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setQuestion("");
    setTaskKind("");
    setResult(null);
    setError("");
    setLoading(false);
  }, [generation.id]);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = question.trim();
      if (!trimmed || loading) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/context/query", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            repository: generation.repository,
            ref: generation.ref,
            question: trimmed,
            ...(taskKind ? { taskKind } : {})
          })
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(typeof detail?.error === "string" ? detail.error : `Query failed with ${response.status}`);
        }
        setResult((await response.json()) as ContextQueryResponse);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setResult(null);
        setError(cause instanceof Error ? cause.message : "Context query failed");
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [generation, loading, question, taskKind]
  );

  return (
    <section className="context-query-workspace">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Query context</span>
          <h2>Ask against the selected generation</h2>
        </div>
        <span className="context-generation-chip" title={generation.id}>
          {generation.ref} · {generation.commitSha.slice(0, 8)}
        </span>
      </header>
      <form className="context-query-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span className="sr-only">Question</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="How does this repository handle a failed payment, and what evidence supports that answer?"
            required
            rows={3}
          />
        </label>
        <div className="context-query-actions">
          <label>
            <span>Route hint</span>
            <select value={taskKind} onChange={(event) => setTaskKind(event.target.value as typeof taskKind)}>
              <option value="">Automatic</option>
              {TASK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {humanize(kind)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-button" disabled={loading || !question.trim()}>
            {loading ? "Reading evidence…" : "Query context"}
          </button>
        </div>
      </form>
      {error ? (
        <p className="context-alert danger" role="alert">
          {error}
        </p>
      ) : null}
      {result ? <QueryResult result={result} /> : <QueryEmpty />}
    </section>
  );
}

function QueryEmpty() {
  return (
    <section className="context-query-empty">
      <span aria-hidden="true">⌕</span>
      <div>
        <strong>No query yet</strong>
        <p>The answer will show citations, conflicts, coverage, and the retrieval routes that contributed.</p>
      </div>
    </section>
  );
}

function QueryResult({ result }: { readonly result: ContextQueryResponse }) {
  const citationsById = useMemo(
    () => new Map(result.citations.map((citation) => [citation.id, citation] as const)),
    [result.citations]
  );
  return (
    <div className="context-query-result">
      <article className="context-answer-panel">
        <header>
          <div>
            <span className="context-eyebrow">Cited answer</span>
            <h3>{humanize(result.coverage.status)} coverage</h3>
          </div>
          <span className={`context-status ${result.coverage.status}`}>{result.coverage.status}</span>
        </header>
        <p className="context-answer-copy">{result.answer || "No answer was returned."}</p>
        {result.ambiguities.length > 0 ? (
          <div className="context-ambiguities">
            <strong>Ambiguities</strong>
            <ul>
              {result.ambiguities.map((ambiguity) => (
                <li key={ambiguity}>{ambiguity}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {result.coverage.missing.length > 0 ? (
          <div className="context-coverage-gap">
            <strong>Missing coverage</strong>
            <ul>
              {result.coverage.missing.map((missing) => (
                <li key={missing}>{missing}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <footer>
          <span>Generation {shortId(result.generation.id)}</span>
          <span>{result.generation.commitSha.slice(0, 12)}</span>
          <span>{humanize(result.generation.derivedKnowledge)} knowledge</span>
        </footer>
      </article>
      <CitationPanel citations={result.citations} />
      <ConflictPanel conflicts={result.conflicts} citationsById={citationsById} />
      <RetrievalTrace
        steps={result.trace.plan}
        traceId={result.trace.id}
        durationMs={result.trace.durationMs}
        retrieversUsed={result.coverage.retrieversUsed}
      />
    </div>
  );
}

function CitationPanel({ citations }: { readonly citations: readonly ContextCitation[] }) {
  return (
    <section className="context-result-panel">
      <header>
        <h3>Citations</h3>
        <span>{citations.length} source anchors</span>
      </header>
      <div className="context-citation-list">
        {citations.length === 0 ? (
          <p className="context-panel-empty">No source anchors were returned.</p>
        ) : (
          citations.map((citation, index) => {
            const url = safeSourceUrl(citation);
            return (
              <article className="context-citation" key={citation.id}>
                <div className="context-citation-heading">
                  <span className="context-citation-number">{index + 1}</span>
                  <div>
                    <strong>{citationLocation(citation)}</strong>
                    <span>
                      {humanize(citation.sourceType)} · digest {shortDigest(citation.contentDigest)}
                    </span>
                  </div>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      Open source ↗
                    </a>
                  ) : null}
                </div>
                {citation.excerpt ? <blockquote>{citation.excerpt}</blockquote> : null}
                <dl>
                  <div>
                    <dt>Source ID</dt>
                    <dd>{shortId(citation.sourceId)}</dd>
                  </div>
                  <div>
                    <dt>Commit</dt>
                    <dd>{citation.commitSha?.slice(0, 12) ?? "Provider evidence"}</dd>
                  </div>
                </dl>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

function ConflictPanel({
  conflicts,
  citationsById
}: {
  readonly conflicts: ContextQueryResponse["conflicts"];
  readonly citationsById: ReadonlyMap<string, ContextCitation>;
}) {
  return (
    <section className="context-result-panel">
      <header>
        <h3>Conflicts</h3>
        <span>{conflicts.length === 0 ? "No material disagreement" : `${conflicts.length} visible`}</span>
      </header>
      {conflicts.length === 0 ? (
        <p className="context-panel-empty">Retrieved sources did not make competing claims.</p>
      ) : (
        <div className="context-conflict-list">
          {conflicts.map((conflict) => (
            <article className="context-conflict" key={`${conflict.subject}-${conflict.description}`}>
              <strong>{conflict.subject}</strong>
              <p>{conflict.description}</p>
              <div>
                {conflict.citationIds.map((id) => (
                  <span key={id}>{citationsById.has(id) ? citationLocation(citationsById.get(id)!) : id}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RetrievalTrace({
  steps,
  traceId,
  durationMs,
  retrieversUsed
}: {
  readonly steps: readonly ContextTraceStep[];
  readonly traceId: string;
  readonly durationMs: number;
  readonly retrieversUsed: readonly string[];
}) {
  return (
    <section className="context-result-panel context-trace">
      <header>
        <h3>Retrieval trace</h3>
        <span>
          {durationMs}ms · {shortId(traceId)}
        </span>
      </header>
      <div className="context-route-summary">
        {retrieversUsed.map((retriever) => (
          <span key={retriever}>{humanize(retriever)}</span>
        ))}
      </div>
      {steps.length === 0 ? (
        <p className="context-panel-empty">No route diagnostics were returned.</p>
      ) : (
        <ol className="context-trace-list">
          {steps.map((step) => (
            <li key={`${step.retriever}-${step.reason}`}>
              <span className={`context-route-dot ${step.status}`} aria-hidden="true" />
              <div>
                <strong>{humanize(step.retriever)}</strong>
                <p>{step.reason}</p>
              </div>
              <span>
                {step.candidateCount} candidates · {step.durationMs}ms
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
