import type { PullRequestReviewCommentInput } from "../shared/github.js";
import { reviewRunUrl } from "../review/workflow.js";
import type {
  RuntimeReviewFinding,
  RuntimeReviewPublishedIssue,
  RuntimeReviewPublication,
  RuntimeReviewResult
} from "./index.js";
import { parseDiffAnchors } from "../review/diff-anchors.js";

export type RuntimeReviewInlineComment = PullRequestReviewCommentInput;

export type RuntimeReviewFileComment = {
  path: string;
  body: string;
  fingerprint?: string;
  fallback?: boolean;
};

type DiffAnchor = {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
};

export function runtimeReviewMarker(headSha: string, reviewRunId?: string): string {
  return `<!-- jina-runtime-review:${headSha}${reviewRunId ? `:${reviewRunId}` : ""} -->`;
}

export function runtimeReviewMarkers(headSha: string, reviewRunId?: string): string[] {
  return [runtimeReviewMarker(headSha, reviewRunId)];
}

export function buildRuntimeReviewRequest(input: {
  result: RuntimeReviewResult;
  headSha: string;
  reviewRunId?: string;
  fallbackFilePath?: string;
  issueMarkers?: boolean;
  publishFileComments?: boolean;
}): {
  body: string;
  comments: RuntimeReviewInlineComment[];
  fileComments: RuntimeReviewFileComment[];
  publishableFindings: RuntimeReviewFinding[];
  unanchoredFindings: RuntimeReviewFinding[];
  lowConfidenceFindings: RuntimeReviewFinding[];
} {
  const anchors = parseDiffAnchors(input.result.diffPatch);
  const comments: RuntimeReviewInlineComment[] = [];
  const fileComments: RuntimeReviewFileComment[] = [];
  const unanchoredFindings: RuntimeReviewFinding[] = [];
  const unanchoredIssues: RuntimeReviewPublishedIssue[] = [];
  const publishableFindings = input.result.findings;
  const lowConfidenceFindings: RuntimeReviewFinding[] = [];
  const findingsByFingerprint = new Map(publishableFindings.map((finding) => [finding.fingerprint, finding]));
  const publication = input.result.publication;
  if (!publication) {
    throw new Error("runtime review result is missing its publication artifact");
  }

  for (const issue of publication.issues) {
    const finding = issue.sourceFingerprints.map((fingerprint) => findingsByFingerprint.get(fingerprint)).find(Boolean);
    if (!finding) continue;
    const marker = input.issueMarkers
      ? reviewIssueMarker({
          reviewRunId: input.reviewRunId,
          headSha: input.headSha,
          stage: "runtime",
          fingerprint: issue.sourceFingerprints[0] ?? finding.fingerprint
        })
      : undefined;
    const anchor = bestAnchorForFinding(finding, anchors);
    if (!anchor) {
      unanchoredFindings.push(finding);
      unanchoredIssues.push(issue);
      continue;
    }
    comments.push({
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
      body: renderPublishedIssueComment(issue, reviewRunUrl(input.reviewRunId), marker)
    });
  }

  return {
    body: renderRuntimeReviewBody({
      marker: runtimeReviewMarker(input.headSha, input.reviewRunId),
      result: input.result,
      publication,
      unanchoredIssues,
      dashboardUrl: reviewRunUrl(input.reviewRunId)
    }),
    comments,
    fileComments,
    publishableFindings,
    unanchoredFindings,
    lowConfidenceFindings
  };
}

function bestAnchorForFinding(finding: RuntimeReviewFinding, anchors: Set<string>): DiffAnchor | undefined {
  if (!finding.file_path || !finding.line_number) {
    return undefined;
  }

  const preferred: DiffAnchor = { path: finding.file_path, line: finding.line_number, side: "RIGHT" };
  if (anchors.has(anchorKey(preferred))) {
    return preferred;
  }

  return undefined;
}

function renderPublishedIssueComment(
  issue: RuntimeReviewPublishedIssue,
  dashboardUrl?: string,
  marker?: string
): string {
  const lines = [
    ...(marker ? [marker, ""] : []),
    `### ${issue.title}`,
    "",
    severityLabel(issue.severity, issue.severityDescription),
    "",
    truncateText(issue.body, 1_200)
  ];
  if (dashboardUrl) {
    lines.push("", `[View full runtime review audit trail](${dashboardUrl})`);
  }
  return lines.join("\n").trim();
}

function renderRuntimeReviewBody(input: {
  marker: string;
  result: RuntimeReviewResult;
  publication: RuntimeReviewPublication;
  unanchoredIssues: RuntimeReviewPublishedIssue[];
  dashboardUrl?: string;
}): string {
  const publishableCount = input.publication.issues.length;
  const readiness = input.result.readiness;
  const readinessHeading = readiness ? `Merge Readiness ${readiness.score}/5` : "Merge Readiness unavailable";
  const recommendation = cleanInlineText(readiness?.recommendation || readinessRecommendation(readiness?.score));
  const rationaleLines = paragraphLines(
    readableParagraphs(readiness?.rationale || input.result.summary || defaultSummary(input.result))
  );
  const lines: Array<string | undefined> = [
    input.marker,
    `## Runtime Review — ${readinessHeading}`,
    "",
    `### ${issueCountLabel(publishableCount)} - ${recommendation}`,
    "",
    ...rationaleLines,
    ""
  ];
  if (publishableCount === 0) {
    lines.push("No qualifying runtime issues were reported.", "");
  }
  lines.push("### Areas Investigated", "");
  for (const area of input.publication.areaSummaries) {
    lines.push(`- **${area.title}** — ${area.summary}`);
  }
  if (input.publication.areaSummaries.length === 0) {
    lines.push("- No investigation areas were produced.");
  }
  if (input.unanchoredIssues.length > 0) {
    lines.push("", "### Issues", "");
    for (const issue of input.unanchoredIssues) {
      lines.push(
        `#### ${issue.title}`,
        "",
        severityLabel(issue.severity, issue.severityDescription),
        "",
        truncateText(issue.body, 1_200),
        ""
      );
    }
  }
  lines.push(
    "",
    input.dashboardUrl ? `[View the full investigation report on the Jina dashboard](${input.dashboardUrl})` : undefined
  );

  return lines
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trim();
}

function severityLabel(severity: RuntimeReviewPublishedIssue["severity"], description: string): string {
  return `**${severity}** · ${cleanInlineText(description)}`;
}

function readinessRecommendation(score: number | undefined): string {
  switch (score) {
    case 1:
      return "Merge blocking";
    case 2:
      return "Merge blocking";
    case 3:
      return "Merge is okay, fixes recommended";
    case 4:
      return "Merge is probably fine";
    case 5:
      return "Merge ready";
    default:
      return "Recommendation unavailable";
  }
}

function issueCountLabel(count: number): string {
  return `${count} issue${count === 1 ? "" : "s"} found`;
}

function readableParagraphs(value: string, maxLength = 1_200): string[] {
  const text = truncateText(cleanInlineText(value), maxLength);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences : [text];
}

function paragraphLines(paragraphs: string[]): string[] {
  return paragraphs.flatMap((paragraph, index) => (index === paragraphs.length - 1 ? [paragraph] : [paragraph, ""]));
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function anchorKey(anchor: DiffAnchor): string {
  return `${anchor.path}:${anchor.side}:${anchor.line}`;
}

function defaultSummary(result: RuntimeReviewResult): string {
  return result.findings.length > 0
    ? `${result.findings.length} runtime finding(s) reported.`
    : "No runtime issues were reported.";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 20))}... [truncated]`;
}

function reviewIssueMarker(input: {
  reviewRunId?: string;
  headSha: string;
  stage: "runtime";
  fingerprint?: string;
}): string {
  return `<!-- jina:issue ${JSON.stringify({
    reviewRunId: input.reviewRunId,
    headSha: input.headSha,
    stage: input.stage,
    fingerprint: input.fingerprint,
    blocking: true
  })} -->`;
}
