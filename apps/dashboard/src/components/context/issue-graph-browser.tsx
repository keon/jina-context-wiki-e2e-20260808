"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTime, humanize, shortId } from "../../lib/format.ts";
import type { ContextBuildSummary, ContextIssue, IssueGraphResponse } from "../../lib/types.ts";

export function IssueGraphBrowser({
  repository,
  ref,
  build
}: {
  readonly repository: string;
  readonly ref: string;
  readonly build?: ContextBuildSummary | undefined;
}) {
  const [graph, setGraph] = useState<IssueGraphResponse>();
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setGraph(undefined);
    void fetch(`/api/causal-graph?repository=${encodeURIComponent(repository)}&ref=${encodeURIComponent(ref)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    })
      .then(async (response) => {
        if (response.status === 404) {
          setStatus("missing");
          return;
        }
        if (!response.ok) throw new Error(`request failed with ${response.status}`);
        const value = (await response.json()) as IssueGraphResponse;
        if (value.release.repository !== repository || value.release.ref !== ref) {
          throw new Error("causal graph response escaped the selected scope");
        }
        setGraph(value);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setStatus("error");
      });
    return () => controller.abort();
  }, [repository, ref, build?.updatedAt]);

  const issues = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (graph?.issues ?? []).filter((issue) => {
      const text = `${issue.title}\n${issue.summary}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [graph, query]);
  useEffect(() => {
    if (!issues.some((issue) => issue.id === selectedId)) setSelectedId(issues[0]?.id ?? "");
  }, [issues, selectedId]);
  const selected = graph?.issues.find((issue) => issue.id === selectedId);
  const causalities = (graph?.causalities ?? []).filter(
    (edge) => edge.subjectIssueId === selectedId || (edge.object.kind === "issue" && edge.object.id === selectedId)
  );

  return (
    <section className="issue-graph-workspace" aria-label="Commit-derived issues and causalities">
      <header className="context-panel-heading">
        <div>
          <span className="context-eyebrow">Commit-derived context</span>
          <h2>Issues and causalities</h2>
        </div>
        {graph ? (
          <span className="context-generation-chip" title={graph.release.id}>
            {shortId(graph.release.id)} · {graph.release.issueCount} issues · {graph.release.causalityCount} links
          </span>
        ) : build ? (
          <span className="context-generation-chip">Build {humanize(build.status)}</span>
        ) : null}
      </header>

      {status === "loading" ? <p className="context-panel-empty">Loading the current issue release…</p> : null}
      {status === "error" ? <p className="context-alert danger">The causal graph could not be loaded.</p> : null}
      {status === "missing" ? (
        <p className="context-panel-empty">
          {build?.status === "active"
            ? "Commit history is being analyzed. The prior release remains live until publication succeeds."
            : "No causal graph has been published for this repository ref yet."}
        </p>
      ) : null}
      {graph ? (
        <>
          <div className="issue-graph-summary">
            <p>{graph.summary}</p>
            <span>
              {graph.coverage.observedCommitCount.toLocaleString()} commits ·{" "}
              {graph.coverage.complete ? "complete history" : "bounded history"} · published{" "}
              {formatTime(graph.release.publishedAt)}
            </span>
          </div>
          <div className="issue-graph-grid">
            <aside className="issue-graph-list">
              <input
                aria-label="Filter issues"
                value={query}
                placeholder="Filter issues"
                onChange={(event) => setQuery(event.target.value)}
              />
              <div>
                {issues.map((issue) => (
                  <button
                    type="button"
                    key={issue.id}
                    className={issue.id === selectedId ? "selected" : ""}
                    onClick={() => setSelectedId(issue.id)}
                  >
                    <span className={`issue-state ${issue.state}`}>{issue.state}</span>
                    <strong>{issue.title}</strong>
                    <small>{issue.evidence.length} commit anchors</small>
                  </button>
                ))}
                {issues.length === 0 ? <p className="context-panel-empty">No matching issues.</p> : null}
              </div>
            </aside>
            <IssueDetail repository={repository} issue={selected} graph={graph} causalities={causalities} />
          </div>
        </>
      ) : null}
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
  if (!issue) return <article className="issue-graph-detail context-panel-empty">Select an issue.</article>;
  const byId = new Map(graph.issues.map((candidate) => [candidate.id, candidate]));
  return (
    <article className="issue-graph-detail">
      <span className={`issue-state ${issue.state}`}>{issue.state}</span>
      <h3>{issue.title}</h3>
      <p>{issue.summary}</p>
      <h4>Causal links</h4>
      {causalities.length === 0 ? <p className="context-panel-empty">No explicit causal link was derived.</p> : null}
      <ul className="issue-causality-list">
        {causalities.map((edge) => {
          const objectLabel =
            edge.object.kind === "commit"
              ? edge.object.id.slice(0, 12)
              : (byId.get(edge.object.id)?.title ?? edge.object.id);
          return (
            <li key={edge.id}>
              <strong>{humanize(edge.predicate)}</strong>
              <span>{objectLabel}</span>
              <p>{edge.why}</p>
            </li>
          );
        })}
      </ul>
      <h4>Commit evidence</h4>
      <ul className="issue-evidence-list">
        {issue.evidence.map((evidence, index) => (
          <li key={`${evidence.commitSha}:${evidence.messageStartLine}:${index}`}>
            <a href={`https://github.com/${repository}/commit/${evidence.commitSha}`} target="_blank" rel="noreferrer">
              {evidence.commitSha.slice(0, 12)}
            </a>
            <span>{evidence.role}</span>
            <blockquote>{evidence.excerpt}</blockquote>
          </li>
        ))}
      </ul>
    </article>
  );
}
