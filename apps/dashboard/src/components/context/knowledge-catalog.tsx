"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  citationLocation,
  documentsForScope,
  reviewableDocument,
  safeSourceUrl,
  shortDigest
} from "../../lib/context.ts";
import { confidenceLabel, formatTime, humanize, shortId } from "../../lib/format.ts";
import { usePoll } from "../../lib/poll.ts";
import type {
  ContextDocumentResponse,
  ContextDocumentsResponse,
  KnowledgeDocument,
  KnowledgeDocumentSummary
} from "../../lib/types.ts";

export function KnowledgeCatalog({ repository }: { readonly repository: string }) {
  const resource = usePoll<ContextDocumentsResponse>(
    `/api/context/documents?repository=${encodeURIComponent(repository)}&limit=100`,
    10_000
  );
  const documents = useMemo(
    () => documentsForScope(resource.data?.documents ?? [], repository),
    [repository, resource.data]
  );
  const currentDocumentCount = useMemo(
    () => new Set(documents.map((document) => document.logicalId)).size,
    [documents]
  );
  const [selectedId, setSelectedId] = useState("");
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!documents.some((item) => item.id === selectedId)) setSelectedId(documents[0]?.id ?? "");
  }, [documents, selectedId]);

  const loadDocument = useCallback(async (id: string, signal?: AbortSignal) => {
    if (!id) {
      setDocument(null);
      return;
    }
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch(`/api/context/documents/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {})
      });
      if (!response.ok) throw new Error(`Document read failed with ${response.status}`);
      const payload = (await response.json()) as ContextDocumentResponse;
      setDocument(payload.document);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setDocument(null);
      setDetailError(cause instanceof Error ? cause.message : "Document read failed");
    } finally {
      if (!signal?.aborted) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDocument(selectedId, controller.signal);
    return () => controller.abort();
  }, [loadDocument, selectedId]);

  const review = useCallback(
    async (id: string, action: "accept" | "reject" | "invalidate", reason?: string) => {
      const response = await fetch(`/api/context/knowledge/${encodeURIComponent(id)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) })
      });
      if (!response.ok) throw new Error(`Review failed with ${response.status}`);
      await Promise.all([resource.refresh(), loadDocument(id)]);
    },
    [loadDocument, resource]
  );

  return (
    <section className="context-operations-panel context-knowledge-panel">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Knowledge catalog</span>
          <h2>Agent-organized knowledge</h2>
        </div>
        <span>
          {currentDocumentCount} documents · {documents.length} revisions
        </span>
      </header>
      <div className="context-knowledge-layout">
        <nav className="context-document-list" aria-label="Knowledge document revisions">
          {documents.length === 0 ? (
            <p className="context-panel-empty">No derived knowledge is indexed for this repository.</p>
          ) : (
            documents.map((item) => (
              <DocumentButton
                key={item.id}
                document={item}
                selected={item.id === selectedId}
                onSelect={() => setSelectedId(item.id)}
              />
            ))
          )}
        </nav>
        <div className="context-document-detail" aria-live="polite">
          {detailLoading ? <p className="context-panel-empty">Loading revision…</p> : null}
          {detailError ? (
            <p className="context-alert danger" role="alert">
              {detailError}
            </p>
          ) : null}
          {!detailLoading && document ? <DocumentDetail document={document} onReview={review} /> : null}
        </div>
      </div>
    </section>
  );
}

function DocumentButton({
  document,
  selected,
  onSelect
}: {
  readonly document: KnowledgeDocumentSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button type="button" className={selected ? "selected" : ""} onClick={onSelect}>
      <span className="context-document-kind">{humanize(document.kind)}</span>
      <strong>{document.title}</strong>
      <span>{document.summary}</span>
      <small>
        {document.reviewStatus} · {confidenceLabel(document.confidence)} · {document.model}
      </small>
    </button>
  );
}

function DocumentDetail({
  document,
  onReview
}: {
  readonly document: KnowledgeDocument;
  readonly onReview: (id: string, action: "accept" | "reject" | "invalidate", reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const decide = async (action: "accept" | "reject" | "invalidate") => {
    if ((action === "reject" || action === "invalidate") && !reason.trim()) {
      setError("A reason is required to reject or invalidate a revision.");
      return;
    }
    setPending(action);
    setError("");
    try {
      await onReview(document.id, action, reason.trim() || undefined);
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review failed");
    } finally {
      setPending("");
    }
  };
  return (
    <article>
      <header className="context-document-heading">
        <div>
          <span className="context-eyebrow">{humanize(document.kind)}</span>
          <h3>{document.title}</h3>
        </div>
        <span className={`context-status ${document.reviewStatus}`}>{document.reviewStatus}</span>
      </header>
      <p className="context-document-summary">{document.summary}</p>
      <dl className="context-metadata-grid">
        <div>
          <dt>Logical ID</dt>
          <dd>{document.logicalId}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{shortId(document.id)}</dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd>{document.commitSha.slice(0, 12)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTime(document.createdAt)}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{confidenceLabel(document.confidence)}</dd>
        </div>
        <div>
          <dt>Prior revision</dt>
          <dd>{document.priorRevisionId ? shortId(document.priorRevisionId) : "None"}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{document.generatorName}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{document.model}</dd>
        </div>
        <div>
          <dt>Prompt</dt>
          <dd>{document.promptVersion}</dd>
        </div>
      </dl>
      <StructuredKnowledge summary={document.structuredSummary} />
      <section className="context-document-body">
        <h4>Revision body</h4>
        <div className="context-markdown">{document.bodyMarkdown}</div>
      </section>
      <section className="context-document-evidence">
        <h4>Source anchors</h4>
        {document.citations.length === 0 ? (
          <p className="context-panel-empty">No validated source anchors were returned.</p>
        ) : (
          document.citations.map((citation) => {
            const url = safeSourceUrl(citation.anchor);
            return (
              <div key={citation.id}>
                <strong>{citationLocation(citation.anchor)}</strong>
                <span>
                  {humanize(citation.anchor.sourceType)} · digest {shortDigest(citation.anchor.contentDigest)}
                </span>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    Open ↗
                  </a>
                ) : null}
              </div>
            );
          })
        )}
      </section>
      {document.events.length > 0 ? (
        <details className="context-revision-events">
          <summary>{document.events.length} append-only review events</summary>
          <ol>
            {document.events.map((event, index) => (
              <li key={event.id ?? `${event.action ?? event.type}-${index}`}>
                <strong>{humanize(event.action ?? event.type ?? "event")}</strong>
                <span>{formatTime(event.createdAt ?? event.at)}</span>
                {event.reason ? <p>{event.reason}</p> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <footer className="context-review-actions">
        <label>
          <span>Review reason</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required for reject or invalidate"
          />
        </label>
        {reviewableDocument(document) ? (
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(pending)}
            onClick={() => void decide("accept")}
          >
            {pending === "accept" ? "Accepting…" : "Accept revision"}
          </button>
        ) : null}
        <button
          type="button"
          className="secondary-button"
          disabled={Boolean(pending)}
          onClick={() => void decide("reject")}
        >
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button
          type="button"
          className="secondary-button danger"
          disabled={Boolean(pending)}
          onClick={() => void decide("invalidate")}
        >
          {pending === "invalidate" ? "Invalidating…" : "Invalidate"}
        </button>
      </footer>
      {error ? (
        <p className="context-alert danger" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

interface StructuredStatement {
  readonly text: string;
  readonly citationOrdinals: readonly number[];
  readonly confidence: number;
}

function StructuredKnowledge({ summary }: { readonly summary: Readonly<Record<string, unknown>> }) {
  const facts = statements(summary.facts);
  const questions = statements(summary.questionsAnswered);
  const diagnostics =
    summary.diagnostics && typeof summary.diagnostics === "object"
      ? (summary.diagnostics as Readonly<Record<string, unknown>>)
      : {};
  const groups = [
    ["Facts", facts],
    ["Questions this answers", questions],
    ["Symptoms", statements(diagnostics.symptoms)],
    ["Likely causes", statements(diagnostics.causes)],
    ["Diagnostic checks", statements(diagnostics.checks)],
    ["Evidence-backed fixes", statements(diagnostics.fixes)]
  ] as const;
  if (groups.every(([, values]) => values.length === 0)) return null;
  return (
    <section className="context-document-body context-structured-knowledge">
      <h4>Structured knowledge</h4>
      {groups.map(([label, values]) =>
        values.length > 0 ? (
          <div key={label}>
            <strong>{label}</strong>
            <ul>
              {values.map((statement, index) => (
                <li key={`${label}-${index}`}>
                  {statement.text}{" "}
                  <small>
                    citations {statement.citationOrdinals.join(", ")} · {confidenceLabel(statement.confidence)}
                  </small>
                </li>
              ))}
            </ul>
          </div>
        ) : null
      )}
    </section>
  );
}

function statements(value: unknown): readonly StructuredStatement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Readonly<Record<string, unknown>>;
    if (
      typeof candidate.text !== "string" ||
      !Array.isArray(candidate.citationOrdinals) ||
      candidate.citationOrdinals.some((ordinal) => !Number.isSafeInteger(ordinal) || Number(ordinal) <= 0) ||
      typeof candidate.confidence !== "number"
    ) {
      return [];
    }
    return [
      {
        text: candidate.text,
        citationOrdinals: candidate.citationOrdinals as number[],
        confidence: candidate.confidence
      }
    ];
  });
}
