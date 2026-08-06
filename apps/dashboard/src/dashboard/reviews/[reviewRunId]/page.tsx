"use client";

import { use, useMemo } from "react";
import {
  Badge,
  BackLink,
  DetailHeader,
  EmptyState,
  ExternalLink,
  List,
  Row,
  Section,
  SectionFlush,
  StatusDot,
  ToneDot,
} from "../../components/ui";
import { useDashboard } from "../../providers";
import { scenarioPath, scenariosFromRun } from "../../lib/historical-scenarios";
import {
  buildReviewWork,
  reviewFindingTone,
  type ReviewWork,
  type ReviewWorkAuditEntry,
  type ReviewWorkFinding,
  type ReviewWorkTask,
  type RuntimeReviewWork,
} from "../../lib/review-work";
import {
  formatDate,
  formatDuration,
  formatJson,
  riskTone,
  scenarioDisplayStatus,
  scenarioRiskLabel,
  scenarioSimulation,
  scenarioStatusLabel,
  shortSha,
  simulationStatusTone,
  statusTone,
} from "../../lib/presentation";
import { runResult } from "../../lib/run-result";
import { runTitle } from "../../lib/runs";
import { reviewMcpTelemetry } from "../../lib/mcp";
import { useReviewRunDetail } from "../../lib/use-review-run-detail";
import type { ReviewEvent, ReviewRun, Tone } from "../../lib/types";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

export default function ReviewRunPage({ params }: { params: Promise<{ reviewRunId: string }> }) {
  const { reviewRunId } = use(params);
  const decodedReviewRunId = decodeURIComponent(reviewRunId);
  const { data, loading } = useDashboard();
  // The run from the list is seeded into the detail read itself (see useReviewRunDetail).
  const { run, loading: detailLoading, error: detailError } = useReviewRunDetail(decodedReviewRunId);

  if (!run) {
    return (
      <div className="detail">
        <BackLink href="/reviews">Reviews</BackLink>
        {(loading && !data) || detailLoading ? (
          <div className="notice">Loading review run...</div>
        ) : detailError ? (
          <div className="notice notice--bad">{detailError}</div>
        ) : (
          <div className="notice notice--bad">Review run not found.</div>
        )}
      </div>
    );
  }

  return <ReviewRunDetail run={run} detailError={detailError} />;
}

function ReviewRunDetail({ run, detailError }: { run: ReviewRun; detailError: string | null | undefined }) {
  // Deep normalization over every review event — recompute only when the run changes,
  // not on each dashboard poll that re-renders this page.
  const work = useMemo(() => buildReviewWork(run), [run]);

  return (
    <article className="detail">
      <BackLink href="/reviews">Reviews</BackLink>

      <DetailHeader
        kicker="Review run"
        title={runTitle(run)}
        badges={
          <>
            <StatusDot status={run.status} />
            <span className="cell-meta">{run.repository.full_name ?? "unknown repository"}</span>
            {run.pull_request.head_ref ? <span className="cell-meta">{run.pull_request.head_ref}</span> : null}
            <span className="cell-mono">{shortSha(run.pull_request.head_sha)}</span>
          </>
        }
        actions={<RunActions run={run} work={work} />}
      />

      <div className="review-detail-surface">
        <ChangeSummary work={work} />
        {detailError ? <div className="notice notice--bad">{detailError}</div> : null}
        <RuntimeIntent review={work.runtimeReview} />
        <RuntimeTasks review={work.runtimeReview} />
        <IssuesSection findings={work.findings} />
        <ReviewAppendix run={run} work={work} />

        {work.hasScenarioHistory ? <HistoricalReviewSummary run={run} /> : null}
        {work.hasScenarioHistory ? <Scenarios run={run} /> : null}

        <CodexOutput run={run} />
      </div>
    </article>
  );
}

function ReviewAppendix({ run, work }: { run: ReviewRun; work: ReviewWork }) {
  return (
    <details className="section review-appendix">
      <summary className="section__title review-appendix__summary">
        <span>Appendix</span>
        <span className="review-appendix__chevron" aria-hidden="true" />
      </summary>
      <div className="review-appendix__body">
        <McpActivity events={run.events} />
        <EventHistory events={run.events} />
        <RuntimeInvestigationNotes review={work.runtimeReview} />
        <ReviewNotices work={work} />
        <CreditsSection run={run} />
      </div>
    </details>
  );
}

function McpActivity({ events }: { events: ReviewEvent[] }) {
  const telemetry = reviewMcpTelemetry(events);
  const emptyMessage = telemetry.availability === "unavailable"
    ? "MCP access was unavailable for this run."
    : telemetry.availability === "disabled"
      ? "No MCPs were attached to this run."
      : "No MCP enablement was recorded for this run.";
  return (
    <Section title="MCP Activity">
      <h3 className="section__subtitle">Enabled for this run</h3>
      {telemetry.enabled.length > 0 ? (
        <List>
          {telemetry.enabled.map((mcp) => (
            <Row
              key={mcp.server}
              title={<span className="cell-mono">{mcp.server}</span>}
              meta={mcp.tools.length > 0 ? `Tools: ${mcp.tools.join(", ")}` : "No tool allowlist recorded"}
              trailing={<Badge tone="ok">Enabled</Badge>}
            />
          ))}
        </List>
      ) : <EmptyState>{emptyMessage}</EmptyState>}

      <h3 className="section__subtitle">Usage events</h3>
      {telemetry.usage.length > 0 ? (
        <List>
          {telemetry.usage.map((event) => (
            <Row
              key={`${event.stage}:${event.id}`}
              leading={<StatusDot status={event.status} />}
              title={<><span className="cell-mono">{event.server}.{event.tool}</span> <Badge>{titleCase(event.stage)}</Badge></>}
              meta={event.error ?? formatDate(event.recordedAt)}
              trailing={<Badge tone={statusTone(event.status)}>{titleCase(event.status)}</Badge>}
            />
          ))}
        </List>
      ) : <EmptyState>No MCP tool calls were recorded.</EmptyState>}
    </Section>
  );
}

function RunActions({ run, work }: { run: ReviewRun; work: ReviewWork }) {
  const result = runResult(run);
  const links: { href: string | undefined; label: string }[] = [];
  links.push({ href: run.pull_request.html_url, label: "GitHub PR" });
  links.push({ href: result?.github_comment_url, label: "PR context" });
  links.push({ href: result?.github_check_run_url, label: "Check run" });
  links.push({ href: work.staticReview?.githubReviewUrl, label: "Static review" });
  links.push({ href: work.runtimeReview?.githubReviewUrl, label: "Runtime review" });
  return (
    <>
      {links
        .filter((link) => Boolean(link.href))
        .map((link) => (
          <ExternalLink key={link.label} className="btn btn--sm" href={link.href}>
            {link.label}
          </ExternalLink>
        ))}
    </>
  );
}

const KEY_SOURCE_LABEL: Record<string, string> = {
  managed: "Jina-managed models",
  harness: "Your own harness (subscription)",
  user: "Your own API key",
};

// Infra settlement lifecycle (review_run_billing.infra_billing_status). pending/tracking = not yet
// settled; waived/shadow_computed/not_billable = computed but NOT actually charged; billed = charged.
const BILLING_STATUS_LABEL: Record<string, string> = {
  pending: "Pending settlement",
  tracking: "Settling…",
  billed: "Billed",
  waived: "Waived (not charged)",
  shadow_computed: "Computed (not charged)",
  not_billable: "Not billed",
};
const UNSETTLED_STATUSES = new Set(["pending", "tracking"]);

function creditsText(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("en-US")} credits`;
}

/** Per-run credit breakdown: what this review cost, its settlement state, and — only when it's actually
 *  true — why AI compute is 0 (own harness/key) or billed (Jina-managed). Never asserts a billing source
 *  for null/unknown key_source, never claims "AI is 0" while a non-zero AI charge is shown, and shows a
 *  total only once infra has settled. */
function CreditsSection({ run }: { run: ReviewRun }) {
  const billing = run.billing;
  if (!billing) {
    return null;
  }
  const keySource = billing.key_source;
  const sourceLabel = keySource ? KEY_SOURCE_LABEL[keySource] ?? titleCase(keySource) : "—";
  const status = billing.infra_status;
  const statusLabel = status ? BILLING_STATUS_LABEL[status] ?? titleCase(status) : undefined;
  const unsettled = status !== undefined && UNSETTLED_STATUSES.has(status);
  const ownComputeZeroAi = (keySource === "harness" || keySource === "user") && billing.ai_credits === 0;

  // Total is null until infra settles; show that explicitly rather than a misleading "0"/"—".
  const totalText = billing.total_credits !== null ? creditsText(billing.total_credits) : unsettled ? "Pending settlement" : "—";

  // Explanatory copy ONLY when it's unambiguously correct: own-compute with a real 0 AI charge, or a
  // Jina-managed run. Null/unknown sources (waived/fallback rows) get no billing-source assertion.
  let explanation: string | null = null;
  if (ownComputeZeroAi) {
    explanation = "AI compute is 0 — this review ran on your own account, so only the per-review infrastructure fee applies.";
  } else if (keySource === "managed") {
    explanation = "AI compute is billed on the Jina-managed model at the plan's subsidized rate, plus the per-review infrastructure fee.";
  }

  return (
    <Section title="Credits">
      <dl className="review-context">
        <Item label="Total credits" value={totalText} />
        <Item label="Infrastructure" value={creditsText(billing.infra_credits)} />
        <Item label="AI compute" value={creditsText(billing.ai_credits)} />
        <Item label="Billed to" value={sourceLabel} />
        {billing.rate_mode ? <Item label="Rate" value={titleCase(billing.rate_mode)} /> : null}
        {statusLabel ? <Item label="Status" value={statusLabel} /> : null}
      </dl>
      {explanation ? <p className="cell-meta">{explanation}</p> : null}
    </Section>
  );
}

function ChangeSummary({ work }: { work: ReviewWork }) {
  const change = work.changeSummary;
  const branch = [change.baseRef, change.headRef].filter(Boolean).join(" -> ");
  return (
    <Section title="Change Summary">
      <dl className="review-context">
        <Item label="Repository" value={change.repository ?? "unknown"} />
        <Item label="Pull request" value={change.pullRequestNumber ? `#${change.pullRequestNumber}` : "unknown"} />
        <Item label="Branch" value={branch || "unknown"} />
        <Item label="Head SHA" value={change.headSha ?? "unknown"} mono />
        <Item label="Changed files" value={change.changedFiles.length ? change.changedFiles.join(", ") : "No changed files recorded."} />
      </dl>
      {change.diffStat ? (
        <details className="disclosure">
          <summary>Diff stat</summary>
          <pre className="code-block code-block--sm">{change.diffStat}</pre>
        </details>
      ) : null}
    </Section>
  );
}

function Metric({ label, value, tone = "", sub }: { label: string; value: string | number; tone?: Tone; sub?: string }) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className={`metric__value${tone ? ` metric__value--${tone}` : ""}`}>{value}</span>
      {sub ? <span className="metric__sub">{sub}</span> : null}
    </div>
  );
}

function ReviewNotices({ work }: { work: ReviewWork }) {
  if (work.notices.length === 0) {
    return null;
  }
  return (
    <Section title="Review Warnings">
      <div className="review-notices">
        {work.notices.map((notice, index) => (
          <div className={`review-notice review-notice--${notice.tone || "info"}`} key={`${notice.status}:${index}`}>
            <ToneDot tone={notice.tone} label={notice.status} />
            <div>
              <strong>{titleCase(notice.title)}</strong>
              {notice.message ? <p>{notice.message}</p> : null}
              {notice.recordedAt ? <span className="cell-meta">{formatDate(notice.recordedAt)}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function RuntimeTasks({ review }: { review: RuntimeReviewWork | undefined }) {
  if (!review) {
    return null;
  }
  const areas = review.areas.length > 0 ? review.areas : [{ title: "Runtime review", tasks: review.tasks, findings: [], blocked: [], nonIssues: [] }];
  return (
    <section id="runtime-tasks" className="section">
      <div className="section__title section__title--row">
        <span>Runtime Tasks</span>
        <span className="panel__count">{review.tasksCount}</span>
      </div>
      <div className="section__body">
        {review.tasks.length === 0 ? (
          <EmptyState>No runtime tasks were recorded.</EmptyState>
        ) : (
          <div className="review-area-stack">
            {areas.map((area, areaIndex) => (
              <div className="review-area" key={`${area.title}:${areaIndex}`}>
                <div className="review-area__head">
                  <h3>{area.title}</h3>
                  {"status" in area && area.status && area.status.toLowerCase() !== "completed" ? (
                    <Badge tone={statusTone(area.status)}>{area.status}</Badge>
                  ) : null}
                </div>
                {"summary" in area && area.summary ? <p>{area.summary}</p> : null}
                <div className="review-task-stack">
                  {area.tasks.map((task, index) => (
                    <RuntimeTaskRow key={task.id ?? `${task.title}:${index}`} task={task} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function RuntimeIntent({ review }: { review: RuntimeReviewWork | undefined }) {
  if (!review?.intentMarkdown && !review?.finalReviewSummary && review?.readinessScore === undefined) {
    return null;
  }
  return (
    <Section title="Merge Readiness">
      <div className="review-field-grid">
        {review.readinessScore !== undefined ? (
          <FieldBlock
            label="Merge score"
            value={`${review.readinessScore}/5${review.readinessRationale ? ` - ${review.readinessRationale}` : ""}`}
          />
        ) : null}
        {review.finalReviewSummary ? <FieldBlock label="Review summary" value={review.finalReviewSummary} /> : null}
      </div>
      {review.intentMarkdown ? <pre className="code-block code-block--sm">{review.intentMarkdown}</pre> : null}
    </Section>
  );
}

function RuntimeInvestigationNotes({ review }: { review: RuntimeReviewWork | undefined }) {
  if (!review || (review.blocked.length === 0 && review.nonIssues.length === 0)) {
    return null;
  }
  return (
    <Section title="Runtime Investigation Notes">
      {review.blocked.length > 0 ? (
        <DisclosureListBlock
          label="Blocked work"
          items={review.blocked.map((item) => ({
            title: item.task ?? item.areaTitle ?? "Blocked investigation",
            details: [
              item.areaTitle && item.areaTitle !== item.task ? `Area: ${item.areaTitle}` : undefined,
              item.reason ? `Reason: ${item.reason}` : undefined,
              item.fallbackUsed ? `Fallback: ${item.fallbackUsed}` : undefined,
            ].filter((detail): detail is string => Boolean(detail)),
          }))}
        />
      ) : null}
      {review.nonIssues.length > 0 ? (
        <DisclosureListBlock
          label="Non-issues"
          items={review.nonIssues.map((item) => ({
            title: item.hypothesis ?? item.areaTitle ?? "Non-issue",
            details: [
              item.areaTitle && item.areaTitle !== item.hypothesis ? `Area: ${item.areaTitle}` : undefined,
              item.whyDismissed ? `Why dismissed: ${item.whyDismissed}` : undefined,
              ...item.evidence.map((evidence) => `Evidence: ${evidence}`),
            ].filter((detail): detail is string => Boolean(detail)),
          }))}
        />
      ) : null}
    </Section>
  );
}

function RuntimeTaskRow({ task }: { task: ReviewWorkTask }) {
  return (
    <details className="review-row review-row--task">
      <summary className="review-row__summary">
        <span className="review-row__chevron" aria-hidden="true" />
        <span className="review-row__title">{task.title}</span>
        <span className="review-row__badges row__badges">
          <Badge tone={task.issuesFound > 0 ? "bad" : "ok"}>
            {task.issuesFound} issue{task.issuesFound === 1 ? "" : "s"} found
          </Badge>
        </span>
      </summary>
      <div className="review-row__details">
        {task.goal ? <FieldBlock label="Goal" value={task.goal} /> : null}
        {task.purpose ? <FieldBlock label="Purpose / hypothesis" value={task.purpose} /> : null}
        {task.whyChosen ? <FieldBlock label="Why chosen" value={task.whyChosen} /> : null}
        {task.actionsTaken.length > 0 ? <ListBlock label="Actions taken" items={task.actionsTaken} /> : null}
        {task.whatWasLearned ? <FieldBlock label="What Jina learned" value={task.whatWasLearned} /> : null}
        {task.auditTrail.length > 0 ? <AuditTrailDetails entries={task.auditTrail} /> : null}
      </div>
    </details>
  );
}

function IssuesSection({ findings }: { findings: ReviewWorkFinding[] }) {
  return (
    <section id="issues" className="section">
      <div className="section__title section__title--row">
        <span>Issues</span>
        <span className="panel__count">{findings.length}</span>
      </div>
      <div className="section__body">
        {findings.length === 0 ? (
          <EmptyState>No static or runtime issues were recorded.</EmptyState>
        ) : (
          <div className="review-issue-stack">
            {findings.map((finding, index) => (
              <IssueRow key={issueRowKey(finding, index)} finding={finding} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function issueRowKey(finding: ReviewWorkFinding, index: number): string {
  return [
    finding.source,
    finding.fingerprint,
    finding.filePath,
    finding.lineNumber,
    finding.title,
    index,
  ].filter(Boolean).join(":");
}

function IssueRow({ finding }: { finding: ReviewWorkFinding }) {
  const location = [finding.filePath, finding.lineNumber ? `:${finding.lineNumber}` : ""].filter(Boolean).join("");
  const risk = finding.risk ?? finding.severity ?? "unknown";
  const confidence = finding.confidence ?? "unknown";
  const likelihood = finding.likelihood ?? "unknown";
  return (
    <details className="review-row review-row--issue">
      <summary className="review-row__summary">
        <span className="review-row__chevron" aria-hidden="true" />
        <span className="review-row__title">{finding.title}</span>
        <span className="review-row__badges row__badges">
          <Badge tone={reviewFindingTone({ severity: risk })}>Risk: {titleCase(risk)}</Badge>
          <Badge>Confidence: {titleCase(confidence)}</Badge>
          <Badge>Likelihood: {titleCase(likelihood)}</Badge>
        </span>
        {location ? <span className="review-row__location cell-mono">{location}</span> : null}
      </summary>
      <div className="review-row__details">
        <FieldBlock label="What happens" value={finding.description} />
        <div className="review-field-grid">
          {location ? <FieldBlock label="Location" value={location} mono /> : null}
          {finding.rootCause ? <FieldBlock label="Root cause" value={finding.rootCause} /> : null}
          {finding.impact ? <FieldBlock label="Product / business impact" value={finding.impact} /> : null}
          {finding.suggestedFix ? <FieldBlock label="Recommended fix" value={finding.suggestedFix} /> : null}
          {finding.failureScenario ? <FieldBlock label="Failure scenario" value={finding.failureScenario} /> : null}
          {finding.reproductionOrTrace ? <FieldBlock label="Reproduction / trace" value={finding.reproductionOrTrace} /> : null}
          {finding.validationMethod ? <FieldBlock label="Validation method" value={finding.validationMethod} /> : null}
        </div>
        {finding.reproductionCommand ? (
          <div className="review-block">
            <span className="review-block__label">Reproduction command</span>
            <pre className="code-block code-block--sm">{finding.reproductionCommand}</pre>
          </div>
        ) : null}
        {finding.observedOutput ? (
          <div className="review-block">
            <span className="review-block__label">Observed output</span>
            <pre className="code-block code-block--sm">{finding.observedOutput}</pre>
          </div>
        ) : null}
        {finding.evidence.length > 0 ? <ListBlock label="Evidence" items={finding.evidence} /> : null}
        {finding.suggestedCodeChange ? (
          <div className="review-block">
            <span className="review-block__label">Suggested code change</span>
            <pre className="code-block code-block--sm">{finding.suggestedCodeChange}</pre>
          </div>
        ) : null}
        {finding.auditTrail.length > 0 ? <AuditTrailDetails entries={finding.auditTrail} /> : null}
      </div>
    </details>
  );
}

function HistoricalReviewSummary({ run }: { run: ReviewRun }) {
  const result = runResult(run);
  const simulation = result?.simulation;
  const finalReview = result?.final_review;
  const error = result?.error ?? run.error ?? result?.publish_error ?? simulation?.error;
  const providerConfig = simulation?.provider_config;
  if (!simulation && !finalReview && !error) {
    return null;
  }

  const simTone: Tone =
    simulation?.status === "passed" ? "ok" : simulation?.status === "failed" ? "bad" : "warn";
  const finalTone: Tone = finalReview
    ? finalReview.findings.length > 0
      ? "bad"
      : finalReview.status === "warned"
        ? "warn"
        : "ok"
    : "";

  const configBits = [
    providerConfig ? `Codex ${providerConfig.codex_model ?? "default"}` : null,
    providerConfig ? `Claude ${providerConfig.claude_model ?? "default"}` : null,
    providerConfig ? `judge ${providerConfig.judge_provider ?? "codex"}` : null,
    simulation?.concurrency !== undefined ? `concurrency ${simulation.concurrency}` : null,
    simulation?.model_concurrency !== undefined ? `model concurrency ${simulation.model_concurrency}` : null,
  ].filter(Boolean);

  return (
    <Section title="Historical Scenario Review">
      <div className="review-summary">
        <div className="summary-bar">
          {simulation ? (
            <>
              <Metric label="Simulation" value={titleCase(simulation.status)} tone={simTone} />
              <Metric label="Scenarios" value={simulation.counts.total} sub={`${simulation.counts.pass} pass, ${simulation.counts.fail} fail, ${simulation.counts.warn} warn`} />
              <Metric label="Duration" value={formatDuration(simulation.duration_ms)} />
            </>
          ) : null}
          {finalReview ? (
            <Metric
              label="Final review"
              value={titleCase(finalReview.status)}
              tone={finalTone}
              sub={`${finalReview.findings.length} issue${finalReview.findings.length === 1 ? "" : "s"}`}
            />
          ) : null}
        </div>
        {configBits.length > 0 ? <p className="cell-meta">{configBits.join(" · ")}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </Section>
  );
}

function Scenarios({ run }: { run: ReviewRun }) {
  const scenarios = scenariosFromRun(run);
  if (scenarios.length === 0) {
    return null;
  }

  return (
    <SectionFlush title="Scenarios" count={scenarios.length}>
      <List>
        {scenarios.map((scenario) => {
          const status = scenarioDisplayStatus(scenario, run);
          const simulation = scenarioSimulation(scenario, run);
          const tone = simulationStatusTone(simulation?.status);
          return (
            <Row
              key={scenario.id}
              href={scenarioPath(run.review_run_id, scenario.id)}
              leading={<span className={`dot s-${status}`} aria-hidden="true" />}
              title={`${scenario.index}. ${scenario.title}`}
              meta={scenario.expectedResult || scenario.steps[0] || scenario.title}
              trailing={
                <span className="row__badges">
                  <Badge tone={tone}>{simulation?.status ?? scenarioStatusLabel(status)}</Badge>
                  {simulation?.duration_ms !== undefined ? <Badge>{formatDuration(simulation.duration_ms)}</Badge> : null}
                  <Badge tone={riskTone(scenario.risk)}>{scenarioRiskLabel(scenario.risk)} risk</Badge>
                </span>
              }
            />
          );
        })}
      </List>
    </SectionFlush>
  );
}

function CodexOutput({ run }: { run: ReviewRun }) {
  const markdown = runResult(run)?.review_markdown;
  if (!markdown) {
    return null;
  }
  return (
    <Section title="Codex output">
      <details className="disclosure">
        <summary>View raw review markdown</summary>
        <pre className="code-block">{markdown}</pre>
      </details>
    </Section>
  );
}

function EventHistory({ events }: { events: ReviewEvent[] }) {
  return (
    <details className="section disclosure event-history">
      <summary className="section__title event-history__summary">Event History</summary>
      <EventTimeline events={events} />
    </details>
  );
}

function EventTimeline({ events }: { events: ReviewEvent[] }) {
  if (events.length === 0) {
    return <EmptyState>No events recorded.</EmptyState>;
  }
  return (
    <ol className="timeline">
      {events.map((event, index) => (
        <li className="timeline__item" key={`${event.recorded_at}:${event.status}:${index}`}>
          <div className="timeline__head">
            <span className="timeline__status">{event.status}</span>
            <time className="timeline__time">{formatDate(event.recorded_at)}</time>
          </div>
          {event.payload ? (
            <details className="disclosure timeline__payload">
              <summary>Raw payload</summary>
              <pre className="code-block code-block--sm">{formatJson(event.payload)}</pre>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function AuditTrailDetails({ entries }: { entries: ReviewWorkAuditEntry[] }) {
  return (
    <details className="disclosure">
      <summary>Audit trail ({entries.length})</summary>
      <ul className="review-audit-list">
        {entries.map((entry, index) => (
          <li key={`${entry.type ?? "entry"}:${index}`}>
            <strong>{entry.type ?? "step"}</strong>
            <span>{entry.detail}</span>
            {entry.evidence.length > 0 ? <code>{entry.evidence.join(" | ")}</code> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function FieldBlock({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="review-block">
      <span className="review-block__label">{label}</span>
      <span className={mono ? "cell-mono" : undefined}>{value}</span>
    </div>
  );
}

function ListBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="review-block">
      <span className="review-block__label">{label}</span>
      <ul className="review-bullet-list">
        {items.map((item, index) => (
          <li key={`${item}:${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DisclosureListBlock({
  label,
  items,
}: {
  label: string;
  items: { title: string; details: string[] }[];
}) {
  return (
    <div className="review-block">
      <span className="review-block__label">{label}</span>
      <ul className="review-disclosure-list">
        {items.map((item, index) => (
          <li key={`${item.title}:${index}`}>
            <details className="review-note">
              <summary>
                <span className="review-note__chevron" aria-hidden="true" />
                <span>{item.title}</span>
              </summary>
              <div className="review-note__details">
                {(item.details.length > 0 ? item.details : ["No additional details recorded."]).map((detail, detailIndex) => (
                  <p key={`${detail}:${detailIndex}`}>{detail}</p>
                ))}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Item({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "cell-mono" : undefined}>{value}</dd>
    </>
  );
}
