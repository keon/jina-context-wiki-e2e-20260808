"use client";

import { useDashboard } from "../providers";
import { EmptyState, List, Panel, Row, ToneDot, Toolbar } from "../components/ui";
import { formatRelative } from "../lib/presentation";
import { issueHref, issueLocation, issueTitle, severityTone } from "../lib/issues";
import type { ReviewIssue } from "../lib/types";

export default function IssuesPage() {
  const { data } = useDashboard();
  const issues = data?.issues ?? [];

  return (
    <>
      <h1 className="sr-only">Issues</h1>
      <Toolbar />
      <Panel title="Issues" count={issues.length}>
        {issues.length === 0 ? (
          <EmptyState>No issues recorded from final reviews yet.</EmptyState>
        ) : (
          <List>
            {issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </List>
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
