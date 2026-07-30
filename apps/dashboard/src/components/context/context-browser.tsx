"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { contextCitationHref, contextCitationLabel, contextRelevantSourceFiles } from "../../lib/context-citations.ts";
import { usePoll } from "../../lib/poll.ts";
import type {
  ContextCatalogDocument,
  ContextDiffResponse,
  ContextListResponse,
  ContextReadResponse,
  ContextRelease,
  ContextSearchResponse,
  ContextSourceCitation,
  ContextTreeNode
} from "../../lib/types.ts";
import { ContextMarkdown } from "./context-markdown.tsx";

export function ContextBrowser({
  release,
  releases
}: {
  readonly release: ContextRelease;
  readonly releases: readonly ContextRelease[];
}) {
  const catalog = usePoll<ContextListResponse>(
    `/api/context/list?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}`,
    10_000
  );
  const [selectedId, setSelectedId] = useState("");
  const [document, setDocument] = useState<ContextReadResponse["document"] | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ContextSearchResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const currentCatalog =
    catalog.data?.release.id === release.id && catalog.data.release.repository === release.repository
      ? catalog.data
      : undefined;
  const documents = currentCatalog?.documents ?? [];
  useEffect(() => {
    setSelectedId("");
    setDocument(null);
    setSearch(null);
    setError("");
  }, [release.id]);

  useEffect(() => {
    if (!documents.some((candidate) => candidate.id === selectedId)) setSelectedId(documents[0]?.id ?? "");
  }, [documents, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDocument(null);
      return;
    }
    const controller = new AbortController();
    setDocument(null);
    setError("");
    void fetch(
      `/api/context/read?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}&document=${encodeURIComponent(selectedId)}`,
      { headers: { accept: "application/json" }, signal: controller.signal }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Document read failed with ${response.status}`);
        return (await response.json()) as ContextReadResponse;
      })
      .then((response) => {
        if (response.release.id !== release.id || response.release.repository !== release.repository) {
          throw new Error("Document read returned a different Context release");
        }
        setDocument(response.document);
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(String(cause));
      });
    return () => controller.abort();
  }, [release.id, release.repository, selectedId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/context/search", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          repository: release.repository,
          releaseId: release.id,
          query: query.trim()
        })
      });
      if (!response.ok) throw new Error(`Context search failed with ${response.status}`);
      const searched = (await response.json()) as ContextSearchResponse;
      if (searched.release.id !== release.id || searched.release.repository !== release.repository) {
        throw new Error("Context search returned a different release");
      }
      setSearch(searched);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Context search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section className="context-tool-contract" aria-label="Context tool contract">
        <div>
          <span className="context-eyebrow">Agent interface</span>
          <strong>Four grounded Context operations</strong>
        </div>
        <code>list_context</code>
        <code>read_context</code>
        <code>search_context</code>
        <code>diff_context</code>
        <span>No answer synthesis</span>
      </section>

      <section className="context-query-workspace">
        <header className="context-panel-heading">
          <div>
            <span className="context-eyebrow">Context retrieval</span>
            <h2>Find relevant context</h2>
          </div>
          <span className="context-generation-chip">Returns context, not an answer</span>
        </header>
        <form className="context-query-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span className="sr-only">Search context</span>
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="What should an agent read before changing the webhook build flow?"
              rows={2}
            />
          </label>
          <div className="context-query-actions">
            <span>{search ? `${search.results.length} documents selected` : "Model-guided tree search"}</span>
            <button type="submit" className="primary-button" disabled={loading || !query.trim()}>
              {loading ? "Selecting context…" : "Search context"}
            </button>
          </div>
        </form>
        {search ? <SearchResults response={search} onOpen={setSelectedId} /> : null}
        {error ? <p className="context-alert danger">{error}</p> : null}
      </section>

      <ContextDiff release={release} releases={releases} onOpen={setSelectedId} />

      <section className="context-browser-grid">
        <nav className="context-operations-panel context-document-list" aria-label="Context tree">
          <header className="context-panel-heading">
            <div>
              <span className="context-eyebrow">Context tree</span>
              <h2>{documents.length} grounded documents</h2>
            </div>
          </header>
          {currentCatalog?.tree.map((node) => (
            <TreeBranch
              key={node.id}
              node={node}
              documents={documents}
              selectedId={selectedId}
              onOpen={setSelectedId}
            />
          ))}
          {documents.length === 0 ? <p className="context-panel-empty">No derived context is published.</p> : null}
        </nav>
        <article
          id={document ? `context-document-${encodeURIComponent(document.id)}` : undefined}
          className="context-operations-panel context-document-detail"
        >
          {document ? (
            <>
              <header className="context-document-heading">
                <div>
                  <span className="context-eyebrow">{document.kind ?? "context"}</span>
                  <h2>{document.title}</h2>
                </div>
              </header>
              <p className="context-document-summary">{document.summary}</p>
              <RelevantSourceFiles citations={document.citations} />
              <ContextMarkdown
                bodyMarkdown={document.bodyMarkdown}
                release={release}
                document={document}
                documents={documents}
                onOpen={setSelectedId}
              />
              <CitationList citations={document.citations} />
            </>
          ) : (
            <p className="context-panel-empty">Select a context document.</p>
          )}
        </article>
      </section>
    </>
  );
}

function ContextDiff({
  release,
  releases,
  onOpen
}: {
  readonly release: ContextRelease;
  readonly releases: readonly ContextRelease[];
  readonly onOpen: (id: string) => void;
}) {
  const candidates = useMemo(
    () =>
      releases
        .filter(
          (candidate) =>
            candidate.id !== release.id && candidate.repository === release.repository && candidate.ref === release.ref
        )
        .sort((left, right) =>
          (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt)
        ),
    [release.id, release.ref, release.repository, releases]
  );
  const [fromReleaseId, setFromReleaseId] = useState("");
  const [diff, setDiff] = useState<ContextDiffResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFromReleaseId(candidates[0]?.id ?? "");
    setDiff(null);
    setError("");
  }, [candidates, release.id]);

  async function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fromReleaseId || loading) return;
    setLoading(true);
    setDiff(null);
    setError("");
    try {
      const parameters = new URLSearchParams({
        repository: release.repository,
        fromReleaseId,
        toReleaseId: release.id
      });
      const response = await fetch(`/api/context/diff?${parameters.toString()}`, {
        headers: { accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Context diff failed with ${response.status}`);
      const compared = (await response.json()) as ContextDiffResponse;
      if (
        compared.from.id !== fromReleaseId ||
        compared.to.id !== release.id ||
        compared.to.repository !== release.repository
      ) {
        throw new Error("Context diff returned different release identities");
      }
      setDiff(compared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Context diff failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="context-operations-panel context-diff-panel">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Release changes · diff_context</span>
          <h2>Compare grounded documents</h2>
        </div>
        <span>To {release.commitSha.slice(0, 12)}</span>
      </header>
      {candidates.length === 0 ? (
        <p className="context-panel-empty">A prior release on this ref is required before Context can show a diff.</p>
      ) : (
        <form className="context-diff-form" onSubmit={(event) => void compare(event)}>
          <label>
            <span>From release</span>
            <select value={fromReleaseId} onChange={(event) => setFromReleaseId(event.target.value)}>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.commitSha.slice(0, 12)} · {candidate.publishedAt ?? candidate.createdAt}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-button" disabled={loading || !fromReleaseId}>
            {loading ? "Comparing…" : "Compare context"}
          </button>
        </form>
      )}
      {diff ? <ContextDiffResults diff={diff} onOpen={onOpen} /> : null}
      {error ? <p className="context-alert danger">{error}</p> : null}
    </section>
  );
}

function ContextDiffResults({
  diff,
  onOpen
}: {
  readonly diff: ContextDiffResponse;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <div className="context-diff-results">
      <p className="context-structure-note">
        {diff.added.length} added · {diff.changed.length} changed · {diff.removed.length} removed ·{" "}
        {diff.unchanged.length} unchanged
      </p>
      {diff.added.map((document) => (
        <DiffDocument key={`added:${document.id}`} label="Added" document={document} onOpen={onOpen} />
      ))}
      {diff.changed.map(({ after }) => (
        <DiffDocument key={`changed:${after.id}`} label="Changed" document={after} onOpen={onOpen} />
      ))}
      {diff.removed.map((document) => (
        <DiffDocument key={`removed:${document.id}`} label="Removed" document={document} />
      ))}
    </div>
  );
}

function DiffDocument({
  label,
  document,
  onOpen
}: {
  readonly label: "Added" | "Changed" | "Removed";
  readonly document: ContextCatalogDocument;
  readonly onOpen?: (id: string) => void;
}) {
  return (
    <article>
      <span className={`context-status ${label.toLowerCase()}`}>{label}</span>
      {onOpen ? (
        <button onClick={() => onOpen(document.id)}>{document.title}</button>
      ) : (
        <strong>{document.title}</strong>
      )}
      <p>{document.summary}</p>
    </article>
  );
}

function TreeBranch({
  node,
  documents,
  selectedId,
  onOpen
}: {
  readonly node: ContextTreeNode;
  readonly documents: readonly ContextCatalogDocument[];
  readonly selectedId: string;
  readonly onOpen: (id: string) => void;
}) {
  const document = documents.find((candidate) => candidate.id === node.documentId);
  return (
    <div className="context-tree-branch" style={{ paddingLeft: `${Math.max(0, node.depth - 1) * 14}px` }}>
      <button className={selectedId === node.documentId ? "active" : ""} onClick={() => onOpen(node.documentId)}>
        <strong>{node.title}</strong>
        <small>{document?.summary ?? node.summary}</small>
      </button>
      {node.children.map((child) => (
        <TreeBranch key={child.id} node={child} documents={documents} selectedId={selectedId} onOpen={onOpen} />
      ))}
    </div>
  );
}

function SearchResults({
  response,
  onOpen
}: {
  readonly response: ContextSearchResponse;
  readonly onOpen: (id: string) => void;
}) {
  const note = useMemo(() => `Deterministic PageIndex tree retrieval by ${response.retrieval.selector}`, [response]);
  return (
    <section className="context-search-results">
      <p className="context-structure-note">{note}</p>
      {response.results.map((result) => (
        <article key={result.documentId}>
          <button onClick={() => onOpen(result.documentId)}>{result.title}</button>
          {result.excerpts.slice(0, 1).map((excerpt) => (
            <p key={excerpt}>{excerpt.slice(0, 500)}</p>
          ))}
          <span>{result.citations.length} verified citations</span>
        </article>
      ))}
    </section>
  );
}

function RelevantSourceFiles({ citations }: { readonly citations: readonly ContextSourceCitation[] }) {
  const files = contextRelevantSourceFiles(citations);
  if (files.length === 0) return null;
  return (
    <section className="context-relevant-sources" aria-labelledby="context-relevant-sources-heading">
      <h3 id="context-relevant-sources-heading">Relevant source files</h3>
      <ul>
        {files.map((file) => (
          <li key={file.href}>
            <a href={file.href} target="_blank" rel="noreferrer">
              <code>{file.path}</code>
            </a>
            <span>
              {file.citationCount} {file.citationCount === 1 ? "citation" : "citations"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CitationList({ citations }: { readonly citations: readonly ContextSourceCitation[] }) {
  return (
    <section className="context-document-evidence">
      <h3>Verified source citations</h3>
      {citations.map((citation, index) => {
        const href = contextCitationHref(citation);
        return (
          <article className="context-citation" key={`${citation.anchor.sourceId}-${index}`}>
            <strong>{citation.claim}</strong>
            <p>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {contextCitationLabel(citation)}
                </a>
              ) : (
                contextCitationLabel(citation)
              )}
            </p>
          </article>
        );
      })}
    </section>
  );
}
