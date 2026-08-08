import { severityTone } from "./issues";
import type { ReviewEvent, ReviewRun, Tone } from "./types";

export interface ReviewWork {
  changeSummary: ReviewWorkChangeSummary;
  runtimeReview?: RuntimeReviewWork | undefined;
  findings: ReviewWorkFinding[];
  notices: ReviewWorkNotice[];
}

interface ReviewWorkChangeSummary {
  repository?: string | undefined;
  pullRequestNumber?: number | undefined;
  pullRequestTitle?: string | undefined;
  headRef?: string | undefined;
  baseRef?: string | undefined;
  headSha?: string | undefined;
  commit?: string | undefined;
  changedFiles: string[];
  diffStat?: string | undefined;
}

interface ReviewWorkNotice {
  status: string;
  tone: Tone;
  title: string;
  message?: string | undefined;
  recordedAt?: string | undefined;
}

interface ReviewWorkReview {
  status?: string | undefined;
  summary?: string | undefined;
  commit?: string | undefined;
  changedFiles: string[];
  diffStat?: string | undefined;
  findingsCount: number;
  publishableFindingsCount?: number | undefined;
  inlineCommentCount?: number | undefined;
  fileCommentCount?: number | undefined;
  unanchoredFindingsCount?: number | undefined;
  lowConfidenceFindingsHeldBack?: number | undefined;
  detailsAvailable: boolean;
  publishState?: "published" | "skipped" | "failed" | undefined;
  publishMessage?: string | undefined;
  githubReviewUrl?: string | undefined;
  error?: string | undefined;
}

export type RuntimeReviewWork = ReviewWorkReview & {
  publishAcceptedLowConfidence: boolean;
  intentMarkdown?: string | undefined;
  readinessScore?: number | undefined;
  readinessRationale?: string | undefined;
  reviewSummary?: string | undefined;
  areasCount: number;
  tasksCount: number;
  nonIssuesCount: number;
  areas: ReviewWorkArea[];
  tasks: ReviewWorkTask[];
  nonIssues: ReviewWorkNonIssue[];
  findings: ReviewWorkFinding[];
};

interface ReviewWorkArea {
  id?: string | undefined;
  title: string;
  status?: string | undefined;
  summary?: string | undefined;
  tasks: ReviewWorkTask[];
  findings: ReviewWorkFinding[];
  nonIssues: ReviewWorkNonIssue[];
}

export interface ReviewWorkTask {
  id?: string | undefined;
  areaId?: string | undefined;
  areaTitle?: string | undefined;
  title: string;
  goal?: string | undefined;
  hypothesis?: string | undefined;
  whyChosen?: string | undefined;
  purpose?: string | undefined;
  method?: string | undefined;
  actionsTaken: string[];
  whatWasLearned?: string | undefined;
  verdict?: string | undefined;
  confidence?: string | undefined;
  auditTrail: ReviewWorkAuditEntry[];
  issuesFound: number;
}

export interface ReviewWorkAuditEntry {
  type?: string | undefined;
  detail: string;
  evidence: string[];
}

interface ReviewWorkNonIssue {
  areaId?: string | undefined;
  areaTitle?: string | undefined;
  hypothesis?: string | undefined;
  whyDismissed?: string | undefined;
  evidence: string[];
}

export interface ReviewWorkFinding {
  fingerprint?: string | undefined;
  title: string;
  description: string;
  risk?: string | undefined;
  severity: string;
  confidence?: string | undefined;
  likelihood?: string | undefined;
  category?: string | undefined;
  filePath?: string | undefined;
  lineNumber?: number | undefined;
  rootCause?: string | undefined;
  impact?: string | undefined;
  reproductionOrTrace?: string | undefined;
  /** Execution grounding captured by the investigation agent. */
  failureScenario?: string | undefined;
  reproductionCommand?: string | undefined;
  observedOutput?: string | undefined;
  suggestedFix?: string | undefined;
  evidence: string[];
  auditTrail: ReviewWorkAuditEntry[];
  validationMethod?: string | undefined;
  heldBack: boolean;
}

type JsonRecord = Record<string, unknown>;

export function buildReviewWork(run: ReviewRun): ReviewWork {
  const runtimeEvent = latestEvent(run.events, (event) => event.status === "runtime_review_completed");
  const runtimePublishEvent = latestEvent(run.events, (event) => event.status.startsWith("github_runtime_review_publish"));

  const runtimeReview = normalizeRuntimeReview(runtimeEvent, runtimePublishEvent);
  const findings = runtimeReview?.findings ?? [];

  return {
    changeSummary: normalizeChangeSummary(run, runtimeReview),
    runtimeReview,
    findings,
    notices: reviewNotices(run.events, runtimeReview),
  };
}

export function reviewWorkStatusSummary(work: ReviewWork): string | undefined {
  return runtimeSummaryPart(work.runtimeReview);
}

function normalizeChangeSummary(
  run: ReviewRun,
  runtimeReview: RuntimeReviewWork | undefined,
): ReviewWorkChangeSummary {
  return {
    repository: run.repository.full_name,
    pullRequestNumber: run.pull_request.number,
    pullRequestTitle: run.pull_request.title,
    headRef: run.pull_request.head_ref,
    baseRef: run.pull_request.base_ref,
    headSha: run.pull_request.head_sha,
    commit: runtimeReview?.commit ?? run.pull_request.head_sha,
    changedFiles: runtimeReview?.changedFiles ?? [],
    diffStat: runtimeReview?.diffStat,
  };
}

function normalizeRuntimeReview(
  event: ReviewEvent | undefined,
  publishEvent: ReviewEvent | undefined,
): RuntimeReviewWork | undefined {
  const payload = objectPayload(event?.payload);
  const review = objectPayload(payload?.runtime_review);
  if (!payload || !review) {
    return undefined;
  }

  const publishAcceptedLowConfidence = true;
  const rawFindings = arrayField(review, "findings");
  const findings = rawFindings
    .map((finding) => normalizeRuntimeFinding(finding, publishAcceptedLowConfidence))
    .filter(isFinding);
  const rawAreas = arrayField(review, "areas");
  const areas = rawAreas
    .map((area) => normalizeRuntimeArea(area, findings, publishAcceptedLowConfidence))
    .filter(isArea);
  const tasks = areas.flatMap((area) => area.tasks);
  const nonIssues = areas.flatMap((area) => area.nonIssues);
  const publish = publishInfo(publishEvent);

  return {
    publishAcceptedLowConfidence,
    status: stringField(review, "status"),
    summary: stringField(review, "summary"),
    commit: stringField(review, "commit"),
    changedFiles: stringList(review.changedFiles),
    diffStat: stringField(review, "diffStat"),
    findings,
    findingsCount: numberField(review, "findingsCount") ?? findings.length,
    publishableFindingsCount: numberField(review, "publishableFindingsCount"),
    inlineCommentCount: numberField(review, "inlineCommentCount"),
    fileCommentCount: numberField(review, "fileCommentCount"),
    unanchoredFindingsCount: numberField(review, "unanchoredFindingsCount"),
    lowConfidenceFindingsHeldBack: numberField(review, "lowConfidenceFindingsHeldBack"),
    detailsAvailable: true,
    publishState: publish.state,
    publishMessage: publish.message,
    githubReviewUrl: publish.githubReviewUrl,
    error: stringField(review, "error") ?? stringField(payload, "error"),
    areasCount: numberField(review, "areasCount") ?? areas.length,
    tasksCount: numberField(review, "tasksCount") ?? tasks.length,
    nonIssuesCount: numberField(review, "nonIssuesCount") ?? nonIssues.length,
    intentMarkdown: runtimeIntentMarkdown(review),
    readinessScore: numberField(objectPayload(review?.readiness), "score"),
    readinessRationale: stringField(objectPayload(review?.readiness), "rationale"),
    reviewSummary: stringField(review, "summary"),
    areas,
    tasks,
    nonIssues,
  };
}

function normalizeRuntimeArea(
  value: unknown,
  allFindings: ReviewWorkFinding[],
  publishAcceptedLowConfidence: boolean,
): ReviewWorkArea | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const areaId = stringField(record, "areaId");
  const title = stringField(record, "title") ?? areaId ?? "Runtime area";
  const areaFindings = arrayField(record, "issues")
    .map((finding) => normalizeRuntimeFinding(finding, publishAcceptedLowConfidence))
    .filter(isFinding);
  const findings = areaFindings.length > 0
    ? areaFindings
    : allFindings.filter((finding) => finding.evidence.some((item) => areaId !== undefined && item.includes(areaId)));
  const tasks = arrayField(record, "tasks")
    .map((task) => normalizeRuntimeTask(task, areaId, title, findings.length))
    .filter(isTask);
  return {
    id: areaId,
    title,
    status: stringField(record, "status"),
    summary: stringField(record, "summary"),
    tasks,
    findings,
    nonIssues: arrayField(record, "nonIssues").map((item) => normalizeNonIssue(item, areaId, title)).filter(isNonIssue),
  };
}

function runtimeIntentMarkdown(review: JsonRecord | undefined): string | undefined {
  return stringField(objectPayload(review?.plan), "intentSummary");
}

function normalizeRuntimeTask(
  value: unknown,
  areaId?: string,
  areaTitle?: string,
  areaIssuesFound = 0,
): ReviewWorkTask | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const title = stringField(record, "title") ?? "Runtime task";
  return {
    id: stringField(record, "id"),
    areaId: areaId ?? stringField(record, "areaId"),
    areaTitle: areaTitle ?? stringField(record, "areaTitle"),
    title,
    goal: stringField(record, "goal"),
    hypothesis: stringField(record, "hypothesis"),
    whyChosen: stringField(record, "whyChosen"),
    purpose: stringField(record, "purpose"),
    method: stringField(record, "method"),
    actionsTaken: stringList(record.actionsTaken),
    whatWasLearned: stringField(record, "whatWasLearned"),
    verdict: stringField(record, "verdict"),
    confidence: stringField(record, "confidence"),
    auditTrail: arrayField(record, "auditTrail").map(normalizeAuditEntry).filter(isAuditEntry),
    issuesFound: numberField(record, "issuesFound") ?? (stringField(record, "verdict") === "issue_found" ? Math.max(1, areaIssuesFound) : 0),
  };
}

function normalizeNonIssue(value: unknown, areaId?: string, areaTitle?: string): ReviewWorkNonIssue | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  return {
    areaId: areaId ?? stringField(record, "areaId"),
    areaTitle: areaTitle ?? stringField(record, "areaTitle"),
    hypothesis: stringField(record, "hypothesis"),
    whyDismissed: stringField(record, "whyDismissed"),
    evidence: stringList(record.evidence),
  };
}

/** Runtime findings are every issue the investigation agents found. */
function normalizeRuntimeFinding(
  value: unknown,
  publishAcceptedLowConfidence = true,
): ReviewWorkFinding | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const title = stringField(record, "title") ?? titleFromBody(stringField(record, "body") ?? "");
  const confidence = stringField(record, "confidence");
  const severity = stringField(record, "severity") ?? stringField(record, "risk") ?? "medium";
  return {
    fingerprint: stringField(record, "fingerprint"),
    title,
    description: stringField(record, "body") ?? title,
    risk: stringField(record, "risk"),
    severity,
    confidence,
    likelihood: stringField(record, "likelihood"),
    category: stringField(record, "category"),
    filePath: stringField(record, "file_path"),
    lineNumber: numberField(record, "line_number"),
    rootCause: stringField(record, "root_cause"),
    impact: stringField(record, "why_it_matters"),
    reproductionOrTrace: stringField(record, "reproduction_or_trace"),
    failureScenario: stringField(record, "failure_scenario"),
    reproductionCommand: stringField(record, "reproduction_command"),
    observedOutput: stringField(record, "observed_output"),
    suggestedFix: stringField(record, "suggested_fix"),
    evidence: stringList(record.evidence),
    auditTrail: stringList(record.audit_trail).map((detail) => ({ detail, evidence: [] })),
    validationMethod: stringField(record, "validation_method"),
    heldBack: confidence === "low" && !publishAcceptedLowConfidence,
  };
}

function normalizeAuditEntry(value: unknown): ReviewWorkAuditEntry | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const detail = stringField(record, "detail");
  if (!detail) {
    return undefined;
  }
  return {
    type: stringField(record, "type"),
    detail,
    evidence: stringList(record.evidence),
  };
}

function reviewNotices(events: ReviewEvent[], runtimeReview: RuntimeReviewWork | undefined): ReviewWorkNotice[] {
  const notices: ReviewWorkNotice[] = [];
  if (runtimeReview?.publishState && runtimeReview.publishState !== "published") {
    notices.push({
      status: runtimeReview.publishState,
      tone: runtimeReview.publishState === "failed" ? "bad" : "warn",
      title: `Runtime review publish ${runtimeReview.publishState}`,
      message: runtimeReview.publishMessage,
    });
  }

  for (const event of events) {
    if (!isFailureLikeEvent(event.status)) {
      continue;
    }
    if (event.status.startsWith("github_runtime_review_publish")) {
      continue;
    }
    const payload = objectPayload(event.payload);
    notices.push({
      status: event.status,
      tone: event.status.includes("warning") || event.status.includes("unavailable") ? "warn" : "bad",
      title: event.status.replaceAll("_", " "),
      message: stringField(payload, "error", "reason"),
      recordedAt: event.recorded_at,
    });
  }
  return dedupeNotices(notices);
}

function publishInfo(event: ReviewEvent | undefined): {
  state?: ReviewWorkReview["publishState"];
  message?: string | undefined;
  githubReviewUrl?: string | undefined;
} {
  if (!event) {
    return {};
  }
  const payload = objectPayload(event.payload);
  const state = event.status.endsWith("_published")
    ? "published"
    : event.status.endsWith("_skipped")
      ? "skipped"
      : event.status.endsWith("_failed")
        ? "failed"
        : undefined;
  return {
    state,
    message: stringField(payload, "reason", "error"),
    githubReviewUrl: stringField(payload, "github_review_url"),
  };
}

function latestEvent(events: ReviewEvent[], predicate: (event: ReviewEvent) => boolean): ReviewEvent | undefined {
  let latest: ReviewEvent | undefined;
  for (const event of events) {
    if (!predicate(event)) {
      continue;
    }
    if (!latest || eventTime(event) >= eventTime(latest)) {
      latest = event;
    }
  }
  return latest;
}

function isFailureLikeEvent(status: string): boolean {
  return status.endsWith("_failed") || status.endsWith("_error") || status.includes("_warning") || status.endsWith("_unavailable");
}

function eventTime(event: ReviewEvent): number {
  const time = new Date(event.recorded_at).getTime();
  return Number.isFinite(time) ? time : 0;
}

function dedupeNotices(notices: ReviewWorkNotice[]): ReviewWorkNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = [notice.status, notice.message].filter(Boolean).join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function runtimeSummaryPart(review: RuntimeReviewWork | undefined): string | undefined {
  if (!review) {
    return undefined;
  }
  const issueCount = review.publishableFindingsCount ?? review.findingsCount;
  return `runtime ${review.status ?? "unknown"} (${review.tasksCount} task${review.tasksCount === 1 ? "" : "s"}, ${issueCount} issue${issueCount === 1 ? "" : "s"})`;
}

function titleFromBody(body: string): string {
  const firstLine = body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const cleaned = firstLine.replace(/^#+\s*/, "");
  if (!cleaned) {
    return "Untitled issue";
  }
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function arrayField(record: JsonRecord | undefined, ...keys: string[]): unknown[] {
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function stringField(record: JsonRecord | undefined, ...keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numberField(record: JsonRecord | undefined, ...keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

function objectPayload(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function isFinding(value: ReviewWorkFinding | undefined): value is ReviewWorkFinding {
  return value !== undefined;
}

function isArea(value: ReviewWorkArea | undefined): value is ReviewWorkArea {
  return value !== undefined;
}

function isTask(value: ReviewWorkTask | undefined): value is ReviewWorkTask {
  return value !== undefined;
}

function isNonIssue(value: ReviewWorkNonIssue | undefined): value is ReviewWorkNonIssue {
  return value !== undefined;
}

function isAuditEntry(value: ReviewWorkAuditEntry | undefined): value is ReviewWorkAuditEntry {
  return value !== undefined;
}

export function reviewFindingTone(finding: Pick<ReviewWorkFinding, "severity">): Tone {
  return severityTone(finding.severity);
}
