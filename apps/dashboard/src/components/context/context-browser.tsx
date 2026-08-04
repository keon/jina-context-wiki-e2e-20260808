"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { contextCitationHref, contextCitationLabel, contextRelevantSourceFiles } from "../../lib/context-citations.ts";
import { isCurrentContextDiff, resolveContextDiffReleaseId } from "../../lib/context-diff.ts";
import { usePoll } from "../../lib/poll.ts";
import type {
  ContextCatalogDocument,
  ContextDiffResponse,
  ContextListResponse,
  ContextReadResponse,
  ContextRelease,
  ContextSearchResponse,
  ContextSourceCitation
} from "../../lib/types.ts";
import { ContextMarkdown } from "./context-markdown.tsx";

type BrowserMode = "document" | "search" | "changes";

export function ContextBrowser({
  release,
  releases,
  apiBasePath
}: {
  readonly release: ContextRelease;
  readonly releases: readonly ContextRelease[];
  readonly apiBasePath: string;
}) {
  const catalog = usePoll<ContextListResponse>(
    `${apiBasePath}/list?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}`,
    10_000
  );
  const currentCatalog =
    catalog.data?.release.id === release.id && catalog.data.release.repository === release.repository
      ? catalog.data
      : undefined;
  const documents = currentCatalog?.documents ?? [];
  const [selectedId, setSelectedId] = useState("");
  const [document, setDocument] = useState<ContextReadResponse["document"] | null>(null);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<BrowserMode>("document");
  const [readError, setReadError] = useState("");

  useEffect(() => {
    setSelectedId("");
    setDocument(null);
    setFilter("");
    setMode("document");
    setReadError("");
  }, [release.id]);

  useEffect(() => {
    if (!documents.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(documents[0]?.id ?? "");
    }
  }, [documents, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDocument(null);
      return;
    }
    const controller = new AbortController();
    setDocument(null);
    setReadError("");
    void fetch(
      `${apiBasePath}/read?repository=${encodeURIComponent(release.repository)}&releaseId=${encodeURIComponent(release.id)}&document=${encodeURIComponent(selectedId)}`,
      {
        credentials: "include",
        headers: { accept: "application/json" },
        signal: controller.signal
      }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`The page could not be loaded (${response.status}).`);
        return (await response.json()) as ContextReadResponse;
      })
      .then((response) => {
        if (response.release.id !== release.id || response.release.repository !== release.repository) {
          throw new Error("The page belongs to a different context release.");
        }
        setDocument(response.document);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setReadError(cause instanceof Error ? cause.message : "The page could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [apiBasePath, release.id, release.repository, selectedId]);

  const visibleDocuments = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((item) =>
      `${item.title}\n${item.summary}\n${item.logicalId}`.toLowerCase().includes(needle)
    );
  }, [documents, filter]);

  function openDocument(id: string) {
    setSelectedId(id);
    setMode("document");
  }

  if (catalog.online === false && !currentCatalog) {
    return (
      <div className="knowledge-placeholder knowledge-placeholder--compact">
        <span className="knowledge-placeholder__icon" aria-hidden="true">
          <DocumentIcon />
        </span>
        <strong>The wiki catalog is unavailable</strong>
        <p>The published release could not be read. Refresh to try again.</p>
      </div>
    );
  }

  return (
    <section className="knowledge-browser" aria-label="Context Wiki browser">
      <aside className="knowledge-index">
        <header className="knowledge-index__header">
          <div>
            <strong>Pages</strong>
            <span>{documents.length}</span>
          </div>
          <label className="knowledge-search">
            <SearchIcon />
            <input
              aria-label="Filter wiki pages"
              placeholder="Filter pages"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
        </header>
        <nav className="knowledge-index__list" aria-label="Wiki pages">
          {visibleDocuments.map((item) => (
            <button
              type="button"
              key={item.id}
              className={item.id === selectedId ? "selected" : undefined}
              onClick={() => openDocument(item.id)}
            >
              <DocumentIcon />
              <span>
                <strong>{item.title}</strong>
                <small>{item.summary}</small>
              </span>
            </button>
          ))}
          {catalog.data === undefined ? <IndexSkeleton /> : null}
          {catalog.data !== undefined && visibleDocuments.length === 0 ? (
            <p className="knowledge-index__empty">{filter ? "No matching pages." : "No pages published."}</p>
          ) : null}
        </nav>
      </aside>

      <main className="knowledge-reader">
        <header className="knowledge-reader__toolbar">
          <div className="knowledge-tabs" role="tablist" aria-label="Wiki tools">
            <ModeButton mode="document" current={mode} onSelect={setMode}>
              Page
            </ModeButton>
            <ModeButton mode="search" current={mode} onSelect={setMode}>
              Search
            </ModeButton>
            <ModeButton mode="changes" current={mode} onSelect={setMode}>
              Changes
            </ModeButton>
          </div>
          <span className="knowledge-reader__commit mono">{release.commitSha.slice(0, 12)}</span>
        </header>

        {mode === "search" ? <ContextSearch release={release} apiBasePath={apiBasePath} onOpen={openDocument} /> : null}
        {mode === "changes" ? (
          <ContextDiff release={release} releases={releases} apiBasePath={apiBasePath} onOpen={openDocument} />
        ) : null}
        {mode === "document" ? (
          document ? (
            <DocumentView document={document} release={release} documents={documents} onOpen={openDocument} />
          ) : readError ? (
            <ReaderState title="This page could not be loaded" detail={readError} />
          ) : selectedId ? (
            <ReaderLoading />
          ) : (
            <ReaderState title="No page selected" detail="Choose a wiki page from the index." />
          )
        ) : null}
      </main>
    </section>
  );
}

function ModeButton({
  mode,
  current,
  onSelect,
  children
}: {
  readonly mode: BrowserMode;
  readonly current: BrowserMode;
  readonly onSelect: (mode: BrowserMode) => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === mode}
      className={current === mode ? "selected" : undefined}
      onClick={() => onSelect(mode)}
    >
      {children}
    </button>
  );
}

function DocumentView({
  document,
  release,
  documents,
  onOpen
}: {
  readonly document: ContextReadResponse["document"];
  readonly release: ContextRelease;
  readonly documents: readonly ContextCatalogDocument[];
  readonly onOpen: (id: string) => void;
}) {
  const sourceFiles = contextRelevantSourceFiles(document.citations);
  return (
    <article className="knowledge-document" id={`context-document-${encodeURIComponent(document.id)}`}>
      <header className="knowledge-document__heading">
        <span>{document.kind ?? "Context page"}</span>
        <h2>{document.title}</h2>
        <p>{document.summary}</p>
        <div>
          <span>
            {sourceFiles.length} source {sourceFiles.length === 1 ? "file" : "files"}
          </span>
          <span>
            {document.citations.length} verified {document.citations.length === 1 ? "citation" : "citations"}
          </span>
        </div>
      </header>
      <ContextMarkdown
        bodyMarkdown={document.bodyMarkdown}
        release={release}
        document={document}
        documents={documents}
        onOpen={onOpen}
      />
      <DocumentEvidence citations={document.citations} />
    </article>
  );
}

function ContextSearch({
  release,
  apiBasePath,
  onOpen
}: {
  readonly release: ContextRelease;
  readonly apiBasePath: string;
  readonly onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<ContextSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await fetch(`${apiBasePath}/search`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ repository: release.repository, releaseId: release.id, query: query.trim() })
      });
      if (!result.ok) throw new Error(`Search failed (${result.status}).`);
      const body = (await result.json()) as ContextSearchResponse;
      if (body.release.id !== release.id || body.release.repository !== release.repository) {
        throw new Error("Search returned a different context release.");
      }
      setResponse(body);
    } catch (cause) {
      setResponse(null);
      setError(cause instanceof Error ? cause.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="knowledge-tool">
      <header>
        <span>Grounded retrieval</span>
        <h2>Search this wiki</h2>
        <p>Find pages and source-backed excerpts without generating an answer.</p>
      </header>
      <form className="knowledge-tool__form" onSubmit={(event) => void search(event)}>
        <label className="knowledge-search knowledge-search--large">
          <SearchIcon />
          <input
            aria-label="Search Context Wiki"
            placeholder="What should I read before changing the webhook flow?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="knowledge-button knowledge-button--primary" disabled={loading || !query.trim()}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      {error ? <p className="knowledge-inline-error">{error}</p> : null}
      {response ? (
        <div className="knowledge-results">
          <div className="knowledge-results__summary">
            <span>
              {response.results.length} {response.results.length === 1 ? "result" : "results"}
            </span>
            <span>{response.retrieval.selector}</span>
          </div>
          {response.results.map((result) => (
            <button type="button" key={result.documentId} onClick={() => onOpen(result.documentId)}>
              <span>
                <strong>{result.title}</strong>
                <small>{result.citations.length} verified citations</small>
              </span>
              <p>{result.excerpts[0]?.slice(0, 360) ?? "Open the page to read more."}</p>
              <ArrowIcon />
            </button>
          ))}
          {response.results.length === 0 ? <ReaderState title="No results" detail="Try a broader search." /> : null}
        </div>
      ) : null}
    </section>
  );
}

function ContextDiff({
  release,
  releases,
  apiBasePath,
  onOpen
}: {
  readonly release: ContextRelease;
  readonly releases: readonly ContextRelease[];
  readonly apiBasePath: string;
  readonly onOpen: (id: string) => void;
}) {
  const candidates = useMemo(
    () =>
      releases
        .filter((item) => item.id !== release.id && item.repository === release.repository && item.ref === release.ref)
        .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt)),
    [release.id, release.ref, release.repository, releases]
  );
  const [fromReleaseId, setFromReleaseId] = useState("");
  const [diff, setDiff] = useState<ContextDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const candidateIdsKey = candidates.map((candidate) => candidate.id).join("\0");

  useEffect(() => {
    const candidateIds = candidateIdsKey ? candidateIdsKey.split("\0") : [];
    setFromReleaseId((current) => resolveContextDiffReleaseId(current, candidateIds));
    setDiff((current) => (isCurrentContextDiff(current, release.id, candidateIds) ? current : null));
    setError("");
  }, [candidateIdsKey, release.id]);

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
      const result = await fetch(`${apiBasePath}/diff?${parameters}`, {
        credentials: "include",
        headers: { accept: "application/json" }
      });
      if (!result.ok) throw new Error(`Comparison failed (${result.status}).`);
      const body = (await result.json()) as ContextDiffResponse;
      if (body.from.id !== fromReleaseId || body.to.id !== release.id) {
        throw new Error("Comparison returned different release identities.");
      }
      setDiff(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Comparison failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="knowledge-tool">
      <header>
        <span>Release history</span>
        <h2>Compare wiki versions</h2>
        <p>See which grounded pages changed between published commits.</p>
      </header>
      {candidates.length ? (
        <form className="knowledge-tool__form" onSubmit={(event) => void compare(event)}>
          <label className="knowledge-select">
            <span className="sr-only">Earlier release</span>
            <select
              value={fromReleaseId}
              onChange={(event) => {
                setFromReleaseId(event.target.value);
                setDiff(null);
                setError("");
              }}
            >
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.commitSha.slice(0, 12)} · {item.publishedAt ?? item.createdAt}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </label>
          <span className="knowledge-tool__to">to {release.commitSha.slice(0, 12)}</span>
          <button className="knowledge-button knowledge-button--primary" disabled={loading || !fromReleaseId}>
            {loading ? "Comparing…" : "Compare"}
          </button>
        </form>
      ) : (
        <ReaderState title="No earlier release" detail="Publish another release before comparing changes." />
      )}
      {error ? <p className="knowledge-inline-error">{error}</p> : null}
      {diff ? <DiffResults diff={diff} onOpen={onOpen} /> : null}
    </section>
  );
}

function DiffResults({ diff, onOpen }: { readonly diff: ContextDiffResponse; readonly onOpen: (id: string) => void }) {
  const rows = [
    ...diff.added.map((document) => ({ status: "Added", document })),
    ...diff.changed.map(({ after }) => ({ status: "Changed", document: after })),
    ...diff.removed.map((document) => ({ status: "Removed", document }))
  ] as const;
  return (
    <div className="knowledge-diff">
      <div className="knowledge-results__summary">
        <span>
          {diff.added.length} added · {diff.changed.length} changed · {diff.removed.length} removed
        </span>
        <span>{diff.unchanged.length} unchanged</span>
      </div>
      {rows.map(({ status, document }) => (
        <button
          type="button"
          key={`${status}:${document.id}`}
          disabled={status === "Removed"}
          onClick={() => status !== "Removed" && onOpen(document.id)}
        >
          <span className={`knowledge-change knowledge-change--${status.toLowerCase()}`}>{status}</span>
          <span>
            <strong>{document.title}</strong>
            <small>{document.summary}</small>
          </span>
          {status !== "Removed" ? <ArrowIcon /> : null}
        </button>
      ))}
      {rows.length === 0 ? (
        <ReaderState title="No page changes" detail="These releases have identical published pages." />
      ) : null}
    </div>
  );
}

function DocumentEvidence({ citations }: { readonly citations: readonly ContextSourceCitation[] }) {
  const files = contextRelevantSourceFiles(citations);
  if (!citations.length) return null;
  return (
    <details className="knowledge-evidence">
      <summary>
        <span>Evidence</span>
        <small>
          {files.length} files · {citations.length} citations
        </small>
        <ChevronIcon />
      </summary>
      {files.length ? (
        <div className="knowledge-evidence__files">
          {files.map((file) => (
            <a key={file.href} href={file.href} target="_blank" rel="noreferrer">
              <DocumentIcon />
              <code>{file.path}</code>
              <span>{file.citationCount}</span>
            </a>
          ))}
        </div>
      ) : null}
      <div className="knowledge-evidence__citations">
        {citations.map((citation, index) => {
          const href = contextCitationHref(citation);
          return (
            <article key={`${citation.anchor.sourceId}:${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{citation.claim}</strong>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {contextCitationLabel(citation)}
                  </a>
                ) : (
                  <small>{contextCitationLabel(citation)}</small>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}

function ReaderState({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="knowledge-reader-state">
      <DocumentIcon />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function ReaderLoading() {
  return (
    <div className="knowledge-reader-loading" aria-label="Loading wiki page" aria-busy="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function IndexSkeleton() {
  return (
    <div className="knowledge-index__skeleton" aria-label="Loading wiki index" aria-busy="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.25 10.25 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2.5h5.75l3.25 3.25v7.75h-9z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
      <path
        d="M9.25 2.75v3h3M5.75 8.25h4.5M5.75 10.5h3.5"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m5 6.25 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8h9m-3-3 3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
