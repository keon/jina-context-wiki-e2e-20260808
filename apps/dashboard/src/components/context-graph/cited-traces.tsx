import { Fragment } from "react";
import { isCausationQuestion, issueTraceSections } from "../../lib/context-graph.ts";
import type {
  CausalPath,
  ContextCitation,
  ContextItemData,
  TraceCommit,
  TraceIssue,
  TraceResolution
} from "../../lib/context-graph.ts";
import { ExternalLink, TraceEvidence, TraceFact } from "./trace.tsx";

export function CausalTraceView({ trace }: { readonly trace: ContextItemData }) {
  const groups: readonly (readonly [string, readonly CausalPath[] | undefined])[] = [
    ["Causes", trace.causes],
    ["Resolutions", trace.resolutions as unknown as readonly CausalPath[] | undefined],
    ["Implementations", trace.implementations],
    ["Affected entities", trace.affectedEntities],
    ["Dependencies", trace.dependencies],
    ["Deployments", trace.deployments],
    ["Documentation", trace.documentation],
    ["Ownership", trace.ownership],
    ["Moved from", trace.movedFrom]
  ];
  return (
    <div className="issue-trace">
      <strong>
        {trace.root?.kind} · {trace.root?.label}
      </strong>
      {groups.map(([label, paths]) =>
        paths?.length ? (
          <div className="trace-explanation" key={label}>
            <span className="trace-fact-label">{label}</span>
            {paths.map((path, index) => (
              <p className="trace-fact-value" key={index}>
                {(path.nodes ?? []).map((node) => node.label).join(" → ") + (path.why ? ` — ${path.why}` : "")}
              </p>
            ))}
          </div>
        ) : null
      )}
    </div>
  );
}

export function IssueTraceView({
  trace,
  citations,
  question
}: {
  readonly trace: ContextItemData;
  readonly citations: readonly ContextCitation[] | undefined;
  readonly question: string | undefined;
}) {
  const issue = trace.issue!;
  const sections = issueTraceSections(trace, question);
  const causalQuestion = isCausationQuestion(question);
  if (!sections.length) {
    return (
      <div className="issue-trace">
        <IssueTraceEntity issue={issue} includeTitle />
        <p className="trace-empty">No verified pull request or commit relationship has been asserted.</p>
        <TraceCitations citations={citations} />
      </div>
    );
  }
  return (
    <div className="issue-trace">
      {sections.map((section, index) =>
        section.kind === "cause" ? (
          <CauseTrace issue={issue} commit={section.value} key={index} />
        ) : (
          <ResolutionTrace issue={issue} resolution={section.value} followsCause={causalQuestion} key={index} />
        )
      )}
      <TraceCitations citations={citations} />
    </div>
  );
}

function IssueTraceEntity({ issue, includeTitle }: { readonly issue: TraceIssue; readonly includeTitle?: boolean }) {
  const identity = issue.number ? `Issue #${issue.number}` : issue.title || issue.displayId || "Derived issue";
  const label = includeTitle && issue.number && issue.title ? `${identity} · ${issue.title}` : identity;
  if (issue.url) return <ExternalLink label={label} url={issue.url} />;
  return <span className="trace-node">{label}</span>;
}

function CauseTrace({ issue, commit }: { readonly issue: TraceIssue; readonly commit: TraceCommit }) {
  const pullRequests = commit.pullRequests ?? [];
  return (
    <div className="trace-chain trace-cause">
      <span className="trace-answer-label trace-answer-label-cause">Cause</span>
      <IssueTraceEntity issue={issue} />
      <span className="trace-arrow">was caused by</span>
      {pullRequests.map((pullRequest, index) => (
        <Fragment key={index}>
          <ExternalLink label={`PR #${pullRequest.number} · ${pullRequest.title}`} url={pullRequest.url} />
          <span className="trace-arrow">containing</span>
        </Fragment>
      ))}
      <ExternalLink label={`commit ${(commit.sha ?? "").slice(0, 12)}`} url={commit.url} />
      <div className="trace-explanation">
        <TraceFact label="Why" value={commit.why || "No causal explanation was recorded."} />
        <TraceEvidence evidence={commit.evidence ?? []} />
      </div>
    </div>
  );
}

function ResolutionTrace({
  issue,
  resolution,
  followsCause
}: {
  readonly issue: TraceIssue;
  readonly resolution: TraceResolution;
  readonly followsCause: boolean;
}) {
  const commits = resolution.commits ?? [];
  return (
    <div className="trace-chain">
      <span className="trace-answer-label">{followsCause ? "Later fix" : "Resolution"}</span>
      <IssueTraceEntity issue={issue} />
      <span className="trace-arrow">→</span>
      <ExternalLink label={`PR #${resolution.pullRequestNumber} · ${resolution.title}`} url={resolution.url} />
      {commits.map((commit, index) => {
        const changes = commit.changes ?? [];
        return (
          <Fragment key={index}>
            <span className="trace-arrow">→</span>
            <ExternalLink
              label={(commit.role === "merge" ? "merge " : "commit ") + (commit.sha ?? "").slice(0, 12)}
              url={commit.url}
            />
            {changes.length ? (
              <div className="trace-changes">
                {`${changes.length} changed file${changes.length === 1 ? "" : "s"}: ` +
                  changes.map((change) => change.path).join(", ")}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function TraceCitations({ citations }: { readonly citations: readonly ContextCitation[] | undefined }) {
  const provenance = citations ?? [];
  if (!provenance.length) return null;
  return (
    <div className="trace-changes">
      {"Citations: " +
        provenance
          .map((citation) =>
            citation.path
              ? citation.path + (citation.startLine ? `:${citation.startLine}` : "")
              : `${citation.kind}:${citation.id}`
          )
          .join(" · ")}
    </div>
  );
}
