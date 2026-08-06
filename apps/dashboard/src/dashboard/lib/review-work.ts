import { severityTone } from "./issues";
import { runResult } from "./run-result";
import { scenariosFromResult } from "./historical-scenarios";
import type { ReviewEvent, ReviewRun, Tone } from "./types";

type ReviewWorkSource = "static" | "runtime";

export interface ReviewWork {
  changeSummary: ReviewWorkChangeSummary;
  staticReview?: StaticReviewWork | undefined;
  runtimeReview?: RuntimeReviewWork | undefined;
  findings: ReviewWorkFinding[];
  notices: ReviewWorkNotice[];
  hasScenarioHistory: boolean;
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
  codegraphContext?: string | undefined;
}

interface ReviewWorkNotice {
  source?: ReviewWorkSource | undefined;
  status: string;
  tone: Tone;
  title: string;
  message?: string | undefined;
  recordedAt?: string | undefined;
}

interface ReviewWorkReview {
  source: ReviewWorkSource;
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

type StaticReviewWork = ReviewWorkReview & {
  source: "static";
  findings: ReviewWorkFinding[];
};

export type RuntimeReviewWork = ReviewWorkReview & {
  source: "runtime";
  publishAcceptedLowConfidence: boolean;
  intentMarkdown?: string | undefined;
  readinessScore?: number | undefined;
  readinessRationale?: string | undefined;
  finalReviewSummary?: string | undefined;
  areasCount: number;
  tasksCount: number;
  blockedCount: number;
  nonIssuesCount: number;
  areas: ReviewWorkArea[];
  tasks: ReviewWorkTask[];
  blocked: ReviewWorkBlocked[];
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
  blocked: ReviewWorkBlocked[];
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

interface ReviewWorkBlocked {
  areaId?: string | undefined;
  areaTitle?: string | undefined;
  task?: string | undefined;
  reason?: string | undefined;
  fallbackUsed?: string | undefined;
}

interface ReviewWorkNonIssue {
  areaId?: string | undefined;
  areaTitle?: string | undefined;
  hypothesis?: string | undefined;
  whyDismissed?: string | undefined;
  evidence: string[];
}

export interface ReviewWorkFinding {
  source: ReviewWorkSource;
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
  suggestedCodeChange?: string | undefined;
  evidence: string[];
  auditTrail: ReviewWorkAuditEntry[];
  validationMethod?: string | undefined;
  heldBack: boolean;
}

type JsonRecord = Record<string, unknown>;

export function buildReviewWork(run: ReviewRun): ReviewWork {
  const result = objectPayload(runResult(run)) ?? {};
  const staticEvent = latestEvent(run.events, (event) => event.status === "static_review_completed");
  const runtimeEvent = latestEvent(run.events, (event) => event.status === "runtime_review_completed");
  const staticPublishEvent = latestEvent(run.events, (event) => event.status.startsWith("github_static_review_publish"));
  const runtimePublishEvent = latestEvent(run.events, (event) => event.status.startsWith("github_runtime_review_publish"));

  const staticReview = normalizeStaticReview(staticEvent, result, staticPublishEvent);
  const runtimeReview = normalizeRuntimeReview(runtimeEvent, result, runtimePublishEvent);
  const findings = dedupeFindings([
    ...(staticReview?.findings ?? []),
    ...(runtimeReview?.findings ?? []),
  ]);

  return {
    changeSummary: normalizeChangeSummary(run, result, staticReview, runtimeReview),
    staticReview,
    runtimeReview,
    findings,
    notices: reviewNotices(run.events, staticReview, runtimeReview),
    hasScenarioHistory: hasScenarioReviewWork(run),
  };
}

export function hasScenarioReviewWork(run: ReviewRun): boolean {
  const result = runResult(run);
  const resultRecord = objectPayload(result);
  if (!resultRecord) {
    return false;
  }
  if (scenariosFromResult(result).length > 0) {
    return true;
  }
  const simulation = objectPayload(resultRecord.simulation);
  if (Array.isArray(simulation?.scenarios) && simulation.scenarios.length > 0) {
    return true;
  }
  return Boolean(objectPayload(resultRecord.final_review));
}

export function reviewWorkStatusSummary(work: ReviewWork): string | undefined {
  const parts = [
    reviewSummaryPart(work.staticReview),
    runtimeSummaryPart(work.runtimeReview),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function normalizeChangeSummary(
  run: ReviewRun,
  result: JsonRecord,
  staticReview: StaticReviewWork | undefined,
  runtimeReview: RuntimeReviewWork | undefined,
): ReviewWorkChangeSummary {
  return {
    repository: run.repository.full_name,
    pullRequestNumber: run.pull_request.number,
    pullRequestTitle: run.pull_request.title,
    headRef: run.pull_request.head_ref,
    baseRef: run.pull_request.base_ref,
    headSha: run.pull_request.head_sha,
    commit: stringField(result, "commit", "head_sha") ?? staticReview?.commit ?? runtimeReview?.commit ?? run.pull_request.head_sha,
    changedFiles: firstStringList(result.changed_files, staticReview?.changedFiles, runtimeReview?.changedFiles),
    diffStat: stringField(result, "diff_stat") ?? staticReview?.diffStat ?? runtimeReview?.diffStat,
    codegraphContext: stringField(result, "codegraph_context"),
  };
}

function normalizeStaticReview(
  event: ReviewEvent | undefined,
  result: JsonRecord,
  publishEvent: ReviewEvent | undefined,
): StaticReviewWork | undefined {
  const payload = objectPayload(event?.payload);
  const resultReview = objectPayload(result.static_review);
  const review = objectPayload(payload?.static_review) ?? resultReview;
  const source = review ?? payload;
  if (!source) {
    return undefined;
  }

  const rawFindings = arrayField(review, "findings");
  const fallbackFindings = rawFindings.length > 0 ? [] : arrayField(payload, "findings");
  const findings = rawFindings.length > 0
    ? rawFindings.map(normalizeStaticFinding).filter(isFinding)
    : fallbackFindings.map((finding) => normalizeGenericFinding(finding, "static")).filter(isFinding);
  const publish = publishInfo(publishEvent);

  return {
    source: "static",
    status: stringField(source, "status"),
    summary: stringField(source, "summary"),
    commit: stringField(source, "commit") ?? stringField(payload, "head_sha") ?? stringField(result, "head_sha"),
    changedFiles: firstStringList(source.changedFiles, payload?.changed_files, result.changed_files),
    diffStat: stringField(source, "diffStat") ?? stringField(payload, "diff_stat") ?? stringField(result, "diff_stat"),
    findings,
    findingsCount: numberField(source, "findingsCount", "findings_count") ?? findings.length,
    publishableFindingsCount: numberField(source, "publishableFindingsCount", "publishable_findings_count"),
    inlineCommentCount: numberField(source, "inlineCommentCount", "inline_comment_count"),
    fileCommentCount: numberField(source, "fileCommentCount", "file_comment_count"),
    unanchoredFindingsCount: numberField(source, "unanchoredFindingsCount", "unanchored_findings_count"),
    lowConfidenceFindingsHeldBack: numberField(source, "lowConfidenceFindingsHeldBack", "low_confidence_findings_held_back"),
    detailsAvailable: Boolean(review && Array.isArray(review.findings)),
    publishState: publish.state,
    publishMessage: publish.message,
    githubReviewUrl: publish.githubReviewUrl ?? stringField(source, "githubReviewUrl", "github_review_url"),
    error: stringField(source, "error") ?? stringField(payload, "error"),
  };
}

function normalizeRuntimeReview(
  event: ReviewEvent | undefined,
  result: JsonRecord,
  publishEvent: ReviewEvent | undefined,
): RuntimeReviewWork | undefined {
  const payload = objectPayload(event?.payload);
  const resultReview = objectPayload(result.runtime_review);
  const review = objectPayload(payload?.runtime_review) ?? resultReview;
  const source = review ?? payload;
  if (!source) {
    return undefined;
  }

  const finalReview = objectPayload(review?.finalReview ?? review?.final_review);
  // Nothing is held back from the PR any more: every issue the investigation finds is
  // published. Runs made under the old adjudicating reviewer always persisted this flag
  // explicitly, so its ABSENCE identifies a new run and means "publish everything";
  // when it is present we honor it so historical runs still render as they were made.
  const publishAcceptedLowConfidence =
    booleanField(review, "publishAcceptedLowConfidence", "publish_accepted_low_confidence") ??
    booleanField(finalReview, "publishAcceptedLowConfidence", "publish_accepted_low_confidence") ??
    true;
  const context = objectPayload(review?.context);
  const rawFindings = arrayField(review, "findings");
  const finalAcceptedFindings = arrayField(finalReview, "acceptedIssues", "accepted_issues", "findings");
  const fallbackFindings = rawFindings.length > 0 ? [] : arrayField(payload, "findings");
  const findings = rawFindings.length > 0
    ? rawFindings.map((finding) => normalizeRuntimeFinding(finding, publishAcceptedLowConfidence)).filter(isFinding)
    : finalAcceptedFindings.length > 0
      ? finalAcceptedFindings.map((finding) => normalizeRuntimeFinding(finding, publishAcceptedLowConfidence)).filter(isFinding)
    : fallbackFindings.map((finding) => normalizeGenericFinding(finding, "runtime")).filter(isFinding);
  const rawAreas = arrayField(review, "investigations").length > 0 ? arrayField(review, "investigations") : arrayField(review, "areas");
  const areas = rawAreas
    .map((area) => normalizeRuntimeArea(area, findings, publishAcceptedLowConfidence))
    .filter(isArea);
  const effectiveFindings = findings.length > 0 ? findings : dedupeFindings(areas.flatMap((area) => area.findings));
  const tasksFromAreas = areas.flatMap((area) => area.tasks);
  const tasks = tasksFromAreas.length > 0
    ? tasksFromAreas
    : arrayField(review, "tasks").map((task) => normalizeRuntimeTask(task)).filter(isTask);
  const blocked = areas.length > 0
    ? areas.flatMap((area) => area.blocked)
    : arrayField(review, "blocked").map((item) => normalizeBlocked(item)).filter(isBlocked);
  const nonIssues = areas.length > 0
    ? areas.flatMap((area) => area.nonIssues)
    : arrayField(review, "nonIssues", "non_issues").map((item) => normalizeNonIssue(item)).filter(isNonIssue);
  const publish = publishInfo(publishEvent);

  return {
    source: "runtime",
    publishAcceptedLowConfidence,
    status: stringField(source, "status"),
    summary: stringField(source, "summary"),
    commit: stringField(source, "commit") ?? stringField(context, "commit") ?? stringField(payload, "head_sha") ?? stringField(result, "head_sha"),
    changedFiles: firstStringList(source.changedFiles, context?.changedFiles, context?.changed_files, payload?.changed_files, result.changed_files),
    diffStat: stringField(source, "diffStat") ?? stringField(context, "diffStat", "diff_stat") ?? stringField(payload, "diff_stat") ?? stringField(result, "diff_stat"),
    findings: effectiveFindings,
    findingsCount: numberField(source, "findingsCount", "findings_count") ?? effectiveFindings.length,
    publishableFindingsCount: numberField(source, "publishableFindingsCount", "publishable_findings_count"),
    inlineCommentCount: numberField(source, "inlineCommentCount", "inline_comment_count"),
    fileCommentCount: numberField(source, "fileCommentCount", "file_comment_count"),
    unanchoredFindingsCount: numberField(source, "unanchoredFindingsCount", "unanchored_findings_count"),
    lowConfidenceFindingsHeldBack: numberField(source, "lowConfidenceFindingsHeldBack", "low_confidence_findings_held_back"),
    detailsAvailable: Boolean(review && (Array.isArray(review.areas) || Array.isArray(review.investigations) || Array.isArray(review.findings) || finalAcceptedFindings.length > 0)),
    publishState: publish.state,
    publishMessage: publish.message,
    githubReviewUrl: publish.githubReviewUrl ?? stringField(source, "githubReviewUrl", "github_review_url"),
    error: stringField(source, "error") ?? stringField(payload, "error"),
    areasCount: numberField(source, "areasCount", "areas_count") ?? areas.length,
    tasksCount: numberField(source, "tasksCount", "tasks_count") ?? tasks.length,
    blockedCount: numberField(source, "blockedCount", "blocked_count") ?? blocked.length,
    nonIssuesCount: numberField(source, "nonIssuesCount", "non_issues_count") ?? nonIssues.length,
    intentMarkdown: runtimeIntentMarkdown(review),
    readinessScore: numberField(objectPayload(finalReview?.readiness), "score"),
    readinessRationale: stringField(objectPayload(finalReview?.readiness), "rationale"),
    finalReviewSummary: stringField(finalReview, "summary"),
    areas,
    tasks,
    blocked,
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
  const areaId = stringField(record, "areaId", "area_id");
  const title = stringField(record, "title") ?? areaId ?? "Runtime area";
  const areaFindings = arrayField(record, "issues", "findings")
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
    blocked: arrayField(record, "blocked").map((item) => normalizeBlocked(item, areaId, title)).filter(isBlocked),
    nonIssues: arrayField(record, "nonIssues", "non_issues").map((item) => normalizeNonIssue(item, areaId, title)).filter(isNonIssue),
  };
}

function runtimeIntentMarkdown(review: JsonRecord | undefined): string | undefined {
  const intent = objectPayload(review?.intent);
  return stringField(intent, "markdown") ?? stringField(review, "intentMarkdown", "intent_markdown");
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
  const title = stringField(record, "title", "name") ?? "Runtime task";
  return {
    id: stringField(record, "id"),
    areaId: areaId ?? stringField(record, "areaId", "area_id"),
    areaTitle: areaTitle ?? stringField(record, "areaTitle", "area_title"),
    title,
    goal: stringField(record, "goal", "taskGoal", "task_goal"),
    hypothesis: stringField(record, "hypothesis"),
    whyChosen: stringField(record, "whyChosen", "why_chosen"),
    purpose: stringField(record, "purpose", "hypothesis"),
    method: stringField(record, "method"),
    actionsTaken: stringList(record.actionsTaken ?? record.actions_taken),
    whatWasLearned: stringField(record, "whatWasLearned", "what_was_learned"),
    verdict: stringField(record, "verdict"),
    confidence: stringField(record, "confidence"),
    auditTrail: arrayField(record, "auditTrail", "audit_trail").map(normalizeAuditEntry).filter(isAuditEntry),
    issuesFound: numberField(record, "issuesFound", "issues_found") ?? (stringField(record, "verdict") === "issue_found" ? Math.max(1, areaIssuesFound) : 0),
  };
}

function normalizeBlocked(value: unknown, areaId?: string, areaTitle?: string): ReviewWorkBlocked | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  return {
    areaId: areaId ?? stringField(record, "areaId", "area_id"),
    areaTitle: areaTitle ?? stringField(record, "areaTitle", "area_title"),
    task: stringField(record, "task"),
    reason: stringField(record, "reason"),
    fallbackUsed: stringField(record, "fallbackUsed", "fallback_used"),
  };
}

function normalizeNonIssue(value: unknown, areaId?: string, areaTitle?: string): ReviewWorkNonIssue | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  return {
    areaId: areaId ?? stringField(record, "areaId", "area_id"),
    areaTitle: areaTitle ?? stringField(record, "areaTitle", "area_title"),
    hypothesis: stringField(record, "hypothesis"),
    whyDismissed: stringField(record, "whyDismissed", "why_dismissed"),
    evidence: stringList(record.evidence),
  };
}

function normalizeStaticFinding(value: unknown): ReviewWorkFinding | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const title = stringField(record, "title") ?? titleFromBody(stringField(record, "body") ?? "");
  const confidence = stringField(record, "confidence");
  const severity = stringField(record, "severity") ?? stringField(record, "risk") ?? "medium";
  return {
    source: "static",
    fingerprint: stringField(record, "fingerprint"),
    title,
    description: stringField(record, "body") ?? title,
    risk: stringField(record, "risk"),
    severity,
    confidence,
    likelihood: stringField(record, "likelihood"),
    category: stringField(record, "category"),
    filePath: stringField(record, "file_path", "filePath"),
    lineNumber: numberField(record, "line_number", "lineNumber"),
    rootCause: stringField(record, "root_cause", "rootCause"),
    impact: stringField(record, "why_it_matters", "impact"),
    reproductionOrTrace: stringField(record, "reproduction_or_trace", "reproductionOrTrace"),
    suggestedFix: stringField(record, "suggested_fix", "suggestedFix"),
    suggestedCodeChange: stringField(record, "suggested_change", "suggestedCodeChange"),
    evidence: [...stringList(record.evidence_files), ...stringList(record.evidence_symbols)],
    auditTrail: [],
    heldBack: confidence === "low",
  };
}

/** Runtime findings are every issue the investigation agents found; no stage filters
 *  them, so nothing is held back from the PR any more. `publishAcceptedLowConfidence`
 *  is only still read so older persisted runs render as they did when they were made. */
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
    source: "runtime",
    fingerprint: stringField(record, "fingerprint"),
    title,
    description: stringField(record, "body") ?? title,
    risk: stringField(record, "risk"),
    severity,
    confidence,
    likelihood: stringField(record, "likelihood"),
    category: stringField(record, "category"),
    filePath: stringField(record, "file_path", "filePath"),
    lineNumber: numberField(record, "line_number", "lineNumber"),
    rootCause: stringField(record, "root_cause", "rootCause"),
    impact: stringField(record, "why_it_matters", "impact"),
    reproductionOrTrace: stringField(record, "reproduction_or_trace", "reproductionOrTrace"),
    failureScenario: stringField(record, "failure_scenario", "failureScenario"),
    reproductionCommand: stringField(record, "reproduction_command", "reproductionCommand"),
    observedOutput: stringField(record, "observed_output", "observedOutput"),
    suggestedFix: stringField(record, "suggested_fix", "suggestedFix"),
    suggestedCodeChange: stringField(record, "suggested_change", "suggestedCodeChange"),
    evidence: stringList(record.evidence),
    auditTrail: stringList(record.audit_trail).map((detail) => ({ detail, evidence: [] })),
    validationMethod: stringField(record, "validation_method", "validationMethod"),
    heldBack: confidence === "low" && !publishAcceptedLowConfidence,
  };
}

function normalizeGenericFinding(value: unknown, source: ReviewWorkSource): ReviewWorkFinding | undefined {
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const body = stringField(record, "body") ?? "";
  if (!body) {
    return undefined;
  }
  const severity = stringField(record, "severity") ?? "medium";
  return {
    source,
    fingerprint: stringField(record, "fingerprint"),
    title: titleFromBody(body),
    description: body,
    risk: stringField(record, "risk"),
    severity,
    confidence: stringField(record, "confidence"),
    likelihood: stringField(record, "likelihood"),
    category: stringField(record, "category"),
    filePath: stringField(record, "file_path", "filePath"),
    lineNumber: numberField(record, "line_number", "lineNumber"),
    evidence: [],
    auditTrail: [],
    heldBack: severity.toLowerCase() === "info",
  };
}

function normalizeAuditEntry(value: unknown): ReviewWorkAuditEntry | undefined {
  if (typeof value === "string" && value.trim()) {
    return { detail: value.trim(), evidence: [] };
  }
  const record = objectPayload(value);
  if (!record) {
    return undefined;
  }
  const detail = stringField(record, "detail", "message", "text");
  if (!detail) {
    return undefined;
  }
  return {
    type: stringField(record, "type"),
    detail,
    evidence: stringList(record.evidence),
  };
}

function reviewNotices(
  events: ReviewEvent[],
  staticReview: StaticReviewWork | undefined,
  runtimeReview: RuntimeReviewWork | undefined,
): ReviewWorkNotice[] {
  const notices: ReviewWorkNotice[] = [];
  for (const review of [staticReview, runtimeReview]) {
    if (!review?.publishState || review.publishState === "published") {
      continue;
    }
    notices.push({
      source: review.source,
      status: review.publishState,
      tone: review.publishState === "failed" ? "bad" : "warn",
      title: `${labelForSource(review.source)} publish ${review.publishState}`,
      message: review.publishMessage,
    });
  }

  for (const event of events) {
    if (!isFailureLikeEvent(event.status)) {
      continue;
    }
    if (event.status.startsWith("github_static_review_publish") || event.status.startsWith("github_runtime_review_publish")) {
      continue;
    }
    const payload = objectPayload(event.payload);
    notices.push({
      source: event.status.includes("runtime") ? "runtime" : event.status.includes("static") ? "static" : undefined,
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
    githubReviewUrl: stringField(payload, "github_review_url", "githubReviewUrl"),
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

function dedupeFindings(findings: ReviewWorkFinding[]): ReviewWorkFinding[] {
  const seen = new Set<string>();
  const output: ReviewWorkFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.source,
      finding.fingerprint,
      finding.filePath,
      finding.lineNumber,
      finding.title,
    ].filter(Boolean).join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(finding);
  }
  return output;
}

function dedupeNotices(notices: ReviewWorkNotice[]): ReviewWorkNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = [notice.source, notice.status, notice.message].filter(Boolean).join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function reviewSummaryPart(review: ReviewWorkReview | undefined): string | undefined {
  if (!review) {
    return undefined;
  }
  const issueCount = review.publishableFindingsCount ?? review.findingsCount;
  return `${labelForSource(review.source).toLowerCase()} ${review.status ?? "unknown"} (${issueCount} issue${issueCount === 1 ? "" : "s"})`;
}

function runtimeSummaryPart(review: RuntimeReviewWork | undefined): string | undefined {
  if (!review) {
    return undefined;
  }
  const issueCount = review.publishableFindingsCount ?? review.findingsCount;
  return `runtime ${review.status ?? "unknown"} (${review.tasksCount} task${review.tasksCount === 1 ? "" : "s"}, ${issueCount} issue${issueCount === 1 ? "" : "s"})`;
}

function labelForSource(source: ReviewWorkSource): string {
  return source === "static" ? "Static review" : "Runtime review";
}

function titleFromBody(body: string): string {
  const firstLine = body.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const cleaned = firstLine.replace(/^#+\s*/, "");
  if (!cleaned) {
    return "Untitled issue";
  }
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

function firstStringList(...values: unknown[]): string[] {
  for (const value of values) {
    const list = stringList(value);
    if (list.length > 0) {
      return list;
    }
  }
  return [];
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

function booleanField(record: JsonRecord | undefined, ...keys: string[]): boolean | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
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

function isBlocked(value: ReviewWorkBlocked | undefined): value is ReviewWorkBlocked {
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
