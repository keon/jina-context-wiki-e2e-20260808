"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, BackLink, DetailHeader, ExternalLink, Section } from "./ui";
import { useDashboard } from "../providers";
import { formatDate } from "../lib/presentation";
import { issueLocation, issueTitle, severityTone } from "../lib/issues";
import type { ReviewIssue } from "../lib/types";

function reviewRunHref(issue: ReviewIssue): string {
  return `/reviews/${encodeURIComponent(issue.review_run_id)}`;
}

export function IssueDetail({ id }: { id: string }) {
  const { data, loading } = useDashboard();
  const issue = (data?.issues ?? []).find((item) => item.id === id);

  if (!issue) {
    return (
      <div className="detail">
        <BackLink href="/issues">Issues</BackLink>
        {loading && !data ? (
          <div className="notice">Loading issue…</div>
        ) : (
          <div className="notice notice--bad">Issue not found.</div>
        )}
      </div>
    );
  }

  const location = issueLocation(issue);
  const runHref = reviewRunHref(issue);

  // Build a specific GitHub code link from the generating run's head SHA.
  const run = (data?.review_runs ?? []).find((item) => item.review_run_id === issue.review_run_id);
  const repo = issue.repository ?? run?.repository.full_name;
  const sha = run?.pull_request.head_sha;
  const codeHref =
    repo && issue.file_path && sha
      ? `https://github.com/${repo}/blob/${sha}/${issue.file_path}${issue.line_number ? `#L${issue.line_number}` : ""}`
      : undefined;

  return (
    <article className="detail">
      <BackLink href="/issues">Issues</BackLink>

      <DetailHeader
        kicker="Issue"
        title={issueTitle(issue.body)}
        badges={
          <>
            <Badge tone={severityTone(issue.severity)}>{issue.severity}</Badge>
            <Badge>{issue.category}</Badge>
            {location ? (
              codeHref ? (
                <ExternalLink className="cell-mono link" href={codeHref}>
                  {location}
                </ExternalLink>
              ) : (
                <span className="cell-mono">{location}</span>
              )
            ) : null}
          </>
        }
        actions={
          <>
            <Link className="btn btn--sm" href={runHref}>
              Review run
            </Link>
            {issue.pull_request_url ? (
              <ExternalLink className="btn btn--sm" href={issue.pull_request_url}>
                GitHub PR
              </ExternalLink>
            ) : null}
          </>
        }
      />

      <Section title="Details">
        <pre className="code-block">{issue.body}</pre>
      </Section>

      <section className="section">
        <div className="section__title">Context</div>
        <dl className="dl">
          <Item label="Repository" value={issue.repository ?? "—"} />
          <Item
            label="Pull request"
            value={
              issue.pull_request_url ? (
                <ExternalLink className="link" href={issue.pull_request_url}>
                  #{issue.pull_request ?? "—"} {issue.pull_request_title ?? ""}
                </ExternalLink>
              ) : (
                `#${issue.pull_request ?? "—"} ${issue.pull_request_title ?? ""}`.trim()
              )
            }
          />
          <Item
            label="Scenario run"
            value={
              <Link className="link" href={runHref}>
                {issue.review_run_id}
              </Link>
            }
          />
          <Item
            label="Code path"
            value={
              codeHref ? (
                <ExternalLink className="link cell-mono" href={codeHref}>
                  {location}
                </ExternalLink>
              ) : (
                location || "—"
              )
            }
          />
          <Item label="Severity" value={issue.severity} />
          <Item label="Category" value={issue.category} />
          <Item label="Fingerprint" value={issue.fingerprint} />
          <Item label="Recorded" value={formatDate(issue.created_at)} />
        </dl>
      </section>
    </article>
  );
}

function Item({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
