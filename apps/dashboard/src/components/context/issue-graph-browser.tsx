"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import type { ContextBuildSummary, ContextIssue, IssueGraphResponse } from "../../lib/types.ts";

type GraphStatus = "loading" | "ready" | "missing" | "error";

/**
 * Upper bound on rendered issue buttons. A published graph can hold thousands
 * of commit-derived issues; the remainder is reported in the header count and
 * the list footer rather than dropped silently.
 */
const ISSUE_RENDER_LIMIT = 200;

export function IssueGraphBrowser({
  repository,
  ref,
  build,
  apiBasePath
}: {
  readonly repository: string;
  readonly ref: string;
  readonly build?: ContextBuildSummary | undefined;
  readonly apiBasePath: string;
}) {
  const [graph, setGraph] = useState<IssueGraphResponse>();
  const [status, setStatus] = useState<GraphStatus>("loading");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  // An active build re-runs this effect every poll tick (`build.updatedAt`). It must
  // therefore refresh the graph *in place*: resetting status/graph/query here would
  // wipe the reader's filter text and selection every few seconds. The parent keys
  // this component on the viewed scope, so a genuine repository/ref change remounts
  // it with fresh state instead.
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBasePath}?repository=${encodeURIComponent(repository)}&ref=${encodeURIComponent(ref)}`, {
      credentials: "include",
      headers: { accept: "application/json" },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          setStatus(response.status === 401 || response.status === 403 ? "error" : "missing");
          return;
        }
        const value = (await response.json()) as IssueGraphResponse;
        if (value.release.repository !== repository || value.release.ref !== ref) {
          throw new Error("The graph belongs to a different repository scope.");
        }
        setGraph(value);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setStatus("error");
      });
    return () => controller.abort();
  }, [apiBasePath, build?.updatedAt, ref, reloadVersion, repository]);

  const issues = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (graph?.issues ?? []).filter((issue) => {
      const text = `${issue.title}\n${issue.summary}\n${issue.state}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [graph, query]);

  useEffect(() => {
    if (!issues.some((issue) => issue.id === selectedId)) setSelectedId(issues[0]?.id ?? "");
  }, [issues, selectedId]);

  if (status === "loading") return <GraphLoading />;
  if (status === "error") {
    return (
      <GraphPlaceholder
        title="Causal graph unavailable"
        description="The published graph could not be reached. No data was changed."
        action={
          <button
            className="knowledge-button"
            onClick={() => {
              setStatus("loading");
              setReloadVersion((value) => value + 1);
            }}
          >
            Retry
          </button>
        }
      />
    );
  }
  if (status === "missing") {
    return (
      <GraphPlaceholder
        title={build?.status === "active" ? "Graph build in progress" : "No causal graph published"}
        description={
          build?.status === "active"
            ? "Commit history is being analyzed. The graph will appear after the release publishes."
            : `Build the graph to trace issues and causal links for ${repository} / ${ref}.`
        }
      />
    );
  }
  if (!graph || graph.issues.length === 0) {
    return (
      <GraphPlaceholder
        title="No issues or causal links"
        description="The published graph contains no commit-derived issues for this repository ref."
      />
    );
  }

  const selected = graph.issues.find((issue) => issue.id === selectedId);
  const visibleIssues = issues.length > ISSUE_RENDER_LIMIT ? issues.slice(0, ISSUE_RENDER_LIMIT) : issues;
  const causalities = graph.causalities.filter(
    (edge) => edge.subjectIssueId === selectedId || (edge.object.kind === "issue" && edge.object.id === selectedId)
  );

  return (
    <section className="knowledge-graph" aria-label="Commit-derived issues and causal links">
      <header className="knowledge-graph__summary">
        <div>
          <strong>{graph.summary}</strong>
          <span>
            {graph.coverage.observedCommitCount.toLocaleString()} commits ·{" "}
            {graph.coverage.complete ? "complete history" : "bounded history"}
          </span>
        </div>
        <div>
          <span>{graph.release.issueCount} issues</span>
          <span>{graph.release.causalityCount} links</span>
          <span title={graph.release.id}>{shortId(graph.release.id)}</span>
          <span>{formatTime(graph.release.publishedAt)}</span>
        </div>
      </header>

      <div className="knowledge-graph__layout">
        <aside className="knowledge-issues">
          <header>
            <div>
              <strong>Issues</strong>
              <span>
                {issues.length === graph.issues.length ? issues.length : `${issues.length} of ${graph.issues.length}`}
              </span>
            </div>
            <label className="knowledge-search">
              <SearchIcon />
              <input
                aria-label="Filter causal graph issues"
                placeholder="Filter issues"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </header>
          <div className="knowledge-issues__list">
            {visibleIssues.map((issue) => (
              <button
                type="button"
                key={issue.id}
                className={issue.id === selectedId ? "selected" : undefined}
                onClick={() => setSelectedId(issue.id)}
              >
                <span className={`knowledge-issue-state knowledge-issue-state--${issue.state}`}>{issue.state}</span>
                <strong>{issue.title}</strong>
                <small>
                  {issue.evidence.length} commit {issue.evidence.length === 1 ? "anchor" : "anchors"}
                </small>
              </button>
            ))}
            {issues.length === 0 ? <p>No matching issues.</p> : null}
            {visibleIssues.length < issues.length ? (
              <p>{`Showing ${visibleIssues.length} of ${issues.length} issues — filter to reach the rest.`}</p>
            ) : null}
          </div>
        </aside>

        <main className="knowledge-graph__main">
          <GraphCanvas graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
          <IssueDetail repository={repository} issue={selected} graph={graph} causalities={causalities} />
        </main>
      </div>
    </section>
  );
}

function GraphCanvas({
  graph,
  selectedId,
  onSelect
}: {
  readonly graph: IssueGraphResponse;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  const issueNodes = graph.issues.slice(0, 12);
  const commitIds = [
    ...new Set(graph.causalities.filter((edge) => edge.object.kind === "commit").map((edge) => edge.object.id))
  ].slice(0, 10);
  const positions = new Map<string, { x: number; y: number }>();
  issueNodes.forEach((issue, index) => {
    positions.set(`issue:${issue.id}`, {
      x: index % 2 === 0 ? 52 : 330,
      y: 54 + Math.floor(index / 2) * 78
    });
  });
  commitIds.forEach((id, index) => {
    positions.set(`commit:${id}`, { x: 660, y: 54 + index * 62 });
  });
  const height = Math.max(360, 112 + Math.max(Math.ceil(issueNodes.length / 2) * 78, commitIds.length * 62));
  const visibleEdges = graph.causalities.filter((edge) => {
    const subject = positions.has(`issue:${edge.subjectIssueId}`);
    const object = positions.has(`${edge.object.kind}:${edge.object.id}`);
    return subject && object;
  });

  return (
    <section className="knowledge-graph-map" aria-label="Causal relationship map">
      <header>
        <div>
          <strong>Relationship map</strong>
          <span>Issues → causes and resolutions</span>
        </div>
        <span>Showing {issueNodes.length + commitIds.length} nodes</span>
      </header>
      <div className="knowledge-graph-map__viewport">
        <svg viewBox={`0 0 940 ${height}`} role="img" aria-label="Causal graph nodes and relationships">
          <defs>
            <marker
              id="knowledge-graph-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <g className="knowledge-graph-map__edges">
            {visibleEdges.map((edge) => {
              const from = positions.get(`issue:${edge.subjectIssueId}`)!;
              const to = positions.get(`${edge.object.kind}:${edge.object.id}`)!;
              return (
                <path
                  key={edge.id}
                  d={`M ${from.x + 218} ${from.y + 25} C ${from.x + 260} ${from.y + 25}, ${to.x - 42} ${to.y + 21}, ${to.x} ${to.y + 21}`}
                  className={edge.subjectIssueId === selectedId ? "selected" : undefined}
                  markerEnd="url(#knowledge-graph-arrow)"
                />
              );
            })}
          </g>
          <g className="knowledge-graph-map__nodes">
            {issueNodes.map((issue) => {
              const position = positions.get(`issue:${issue.id}`)!;
              return (
                <g
                  key={issue.id}
                  transform={`translate(${position.x} ${position.y})`}
                  className={issue.id === selectedId ? "selected" : undefined}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select issue: ${issue.title}`}
                  onClick={() => onSelect(issue.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onSelect(issue.id);
                  }}
                >
                  <rect width="218" height="50" rx="9" />
                  <circle cx="17" cy="17" r="4" className={issue.state} />
                  <text x="29" y="20">
                    {truncate(issue.title, 28)}
                  </text>
                  <text x="16" y="38" className="meta">
                    {issue.evidence.length} commits · {issue.state}
                  </text>
                </g>
              );
            })}
            {commitIds.map((id) => {
              const position = positions.get(`commit:${id}`)!;
              return (
                <g key={id} transform={`translate(${position.x} ${position.y})`} className="commit">
                  <rect width="210" height="42" rx="9" />
                  <circle cx="17" cy="21" r="4" />
                  <text x="30" y="18">
                    Commit
                  </text>
                  <text x="30" y="32" className="meta">
                    {id.slice(0, 12)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </section>
  );
}

function IssueDetail({
  repository,
  issue,
  graph,
  causalities
}: {
  readonly repository: string;
  readonly issue?: ContextIssue | undefined;
  readonly graph: IssueGraphResponse;
  readonly causalities: IssueGraphResponse["causalities"];
}) {
  if (!issue) {
    return (
      <div className="knowledge-reader-state">
        <strong>Select an issue</strong>
        <p>Choose an issue to inspect its evidence.</p>
      </div>
    );
  }
  const byId = new Map(graph.issues.map((candidate) => [candidate.id, candidate]));
  return (
    <article className="knowledge-issue-detail">
      <header>
        <span className={`knowledge-issue-state knowledge-issue-state--${issue.state}`}>{issue.state}</span>
        <h2>{issue.title}</h2>
        <p>{issue.summary}</p>
      </header>

      <section>
        <div className="knowledge-section-title">
          <h3>Causal links</h3>
          <span>{causalities.length}</span>
        </div>
        <div className="knowledge-causal-list">
          {causalities.map((edge) => {
            const objectLabel =
              edge.object.kind === "commit"
                ? edge.object.id.slice(0, 12)
                : (byId.get(edge.object.id)?.title ?? edge.object.id);
            return (
              <article key={edge.id}>
                <span>{humanize(edge.predicate)}</span>
                <strong>{objectLabel}</strong>
                <p>{edge.why}</p>
                <small>{edge.confidence}</small>
              </article>
            );
          })}
          {causalities.length === 0 ? (
            <p className="knowledge-empty-row">No explicit causal link was derived.</p>
          ) : null}
        </div>
      </section>

      <section>
        <div className="knowledge-section-title">
          <h3>Commit evidence</h3>
          <span>{issue.evidence.length}</span>
        </div>
        <div className="knowledge-commit-list">
          {issue.evidence.map((evidence, index) => (
            <article key={`${evidence.commitSha}:${evidence.messageStartLine}:${index}`}>
              <a
                href={`https://github.com/${repository}/commit/${evidence.commitSha}`}
                target="_blank"
                rel="noreferrer"
              >
                {evidence.commitSha.slice(0, 12)}
              </a>
              <span>{evidence.role}</span>
              <blockquote>{evidence.excerpt}</blockquote>
            </article>
          ))}
        </div>
      </section>
    </article>
  );
}

function GraphPlaceholder({
  title,
  description,
  action
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="knowledge-placeholder knowledge-placeholder--compact">
      <span className="knowledge-placeholder__icon" aria-hidden="true">
        <GraphIcon />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

function GraphLoading() {
  return (
    <div className="knowledge-graph-loading" aria-label="Loading causal graph" aria-busy="true">
      <aside>
        <span />
        <span />
        <span />
      </aside>
      <main>
        <span />
        <span />
        <span />
        <span />
      </main>
    </div>
  );
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.25 10.25 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="6" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="15.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12.5" cy="15.5" r="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="m6.4 5.75 7.15-.9M5.6 7.7l5.75 6.2m3.55-7.5-1.8 7.15" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}
