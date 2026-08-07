"use client";

import { useDashboard } from "../providers";
import { EmptyState, List, Panel, Row, ToneDot, Toolbar } from "../components/ui";
import { formatRelative } from "../lib/presentation";
import { issueHref, issueLocation, issueTitle, severityTone } from "../lib/issues";
import type { ReviewIssue } from "../lib/types";

const NO_ISSUES: readonly ReviewIssue[] = [];

export default function IssuesPage() {
  const { data, loading, error } = useDashboard();
  const issues = data?.issues ?? NO_ISSUES;

  return (
    <>
      <h1 className="sr-only">Issues</h1>
      <Toolbar />
      <Panel title="Issues" count={data ? issues.length : undefined}>
        {/* A failed refresh keeps the last good feed visible, so surface the error
            alongside it rather than replacing the list. */}
        {error && issues.length > 0 ? <div className="notice notice--bad">{error}</div> : null}
        {issues.length > 0 ? (
          <List>
            {issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </List>
        ) : error ? (
          <div className="notice notice--bad">Issues could not be loaded. {error}</div>
        ) : loading || !data ? (
          <div className="notice">Loading issues...</div>
        ) : (
          <EmptyState>No issues recorded from final reviews yet.</EmptyState>
        )}
      </Panel>
    </>
  );
}

function IssueRow({ issue }: { issue: ReviewIssue }) {
  const location = issueLocation(issue);
  const meta = [issue.repository, issue.pull_request ? `#${issue.pull_request}` : null, location || null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Row
      href={issueHref(issue)}
      leading={<ToneDot tone={severityTone(issue.severity)} label={issue.severity} />}
      title={issueTitle(issue.body)}
      meta={meta || "—"}
      trailing={formatRelative(issue.created_at)}
    />
  );
}
