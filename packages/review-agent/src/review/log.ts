import type { CodegraphReviewContextResult } from "./codex-review.js";
import type { RuntimeReviewFinding, RuntimeReviewResult } from "../runtime-review/index.js";

const MAX_FINDINGS = 20;
const MAX_FILES = 20;
const TEXT_PREVIEW_CHARS = 240;
const LONG_PREVIEW_CHARS = 1_000;

type LogFinding = {
  fingerprint?: string;
  risk?: string;
  severity?: string;
  confidence?: string;
  likelihood?: string;
  category?: string;
  file_path?: string;
  line_number?: number;
  title?: string;
  body?: string;
  root_cause?: string;
  suggested_fix?: string;
  suggested_change?: string;
  evidence?: string[];
  evidence_files?: string[];
};

export type FindingLogSummary = {
  total_count: number;
  omitted_count: number;
  findings: Array<Record<string, unknown>>;
};

export function reviewContextLogSummary(context: CodegraphReviewContextResult): Record<string, unknown> {
  return {
    commit: context.commit,
    changed_file_count: context.changedFiles.length,
    changed_files: cappedList(context.changedFiles, MAX_FILES),
    diff_stat_preview: previewText(context.diffStat, LONG_PREVIEW_CHARS),
    codegraph_preview: previewText(context.codegraphMarkdown, LONG_PREVIEW_CHARS)
  };
}

export function runtimeReviewLogSummary(
  result: RuntimeReviewResult,
  reviewRequest?: {
    publishableFindings?: RuntimeReviewFinding[];
    unanchoredFindings?: RuntimeReviewFinding[];
    lowConfidenceFindings?: RuntimeReviewFinding[];
    comments?: unknown[];
  }
): Record<string, unknown> {
  return {
    status: result.status,
    summary: previewText(result.summary, TEXT_PREVIEW_CHARS),
    commit: result.commit,
    changed_file_count: result.changedFiles.length,
    areas_count: result.areas.length,
    tasks_count: result.areas.reduce((sum, area) => sum + area.tasks.length, 0),
    blocked_count: result.areas.reduce((sum, area) => sum + area.blocked.length, 0),
    findings_count: result.findings.length,
    publishable_findings_count: reviewRequest?.publishableFindings?.length ?? 0,
    inline_comment_count: reviewRequest?.comments?.length ?? 0,
    unanchored_findings_count: reviewRequest?.unanchoredFindings?.length ?? 0,
    low_confidence_findings_held_back: reviewRequest?.lowConfidenceFindings?.length ?? 0,
    merge_score: result.readiness?.score ?? result.finalReview?.readiness.score,
    merge_recommendation: previewOptional(
      result.readiness?.recommendation ?? result.finalReview?.readiness.recommendation,
      TEXT_PREVIEW_CHARS
    ),
    merge_rationale: previewOptional(
      result.readiness?.rationale ?? result.finalReview?.readiness.rationale,
      TEXT_PREVIEW_CHARS
    ),
    publication_area_count: result.publication?.areaSummaries.length ?? 0,
    publication_issue_count: result.publication?.issues.length ?? 0,
    publication_issue_severity_counts: countBy(result.publication?.issues ?? [], (issue) => issue.severity),
    dismissed_candidate_count: result.publication?.dismissedCandidates?.length ?? 0,
    model_calls_attempted: result.model_call_summary?.attempted,
    model_calls_succeeded: result.model_call_summary?.succeeded,
    context_graph_stages_expected: result.model_call_summary?.contextGraphStagesExpected,
    context_graph_stages_observed: result.model_call_summary?.contextGraphStagesObserved,
    context_graph_queries_attempted: result.model_call_summary?.contextGraphQueriesAttempted,
    context_graph_queries_succeeded: result.model_call_summary?.contextGraphQueriesSucceeded,
    context_graph_queries_failed: result.model_call_summary?.contextGraphQueriesFailed,
    ...jinaConfigurationLogSummary(result),
    findings: summarizeFindingsForLog(result.findings, reviewRequest),
    error: previewOptional(result.error, TEXT_PREVIEW_CHARS)
  };
}

/** The structured artifacts produced by planner, investigation agents, and the
 * neutral summarizer. Kept bounded so Trigger logs stay useful on large PRs. */
export function runtimeReviewArtifactLogSummary(result: RuntimeReviewResult): Record<string, unknown> {
  const areas = result.areas.slice(0, MAX_FILES).map((area) => ({
    area_id: area.areaId,
    title: previewText(area.title, TEXT_PREVIEW_CHARS),
    status: area.status,
    summary: previewText(area.summary, TEXT_PREVIEW_CHARS),
    task_count: area.tasks.length,
    issue_count: area.issues.length,
    non_issue_count: area.nonIssues.length,
    blocked_count: area.blocked.length,
    tool_call_count: area.toolCalls.length,
    error: previewOptional(area.error, TEXT_PREVIEW_CHARS)
  }));
  const publicationIssues = (result.publication?.issues ?? []).slice(0, MAX_FINDINGS).map((issue) => ({
    title: previewText(issue.title, TEXT_PREVIEW_CHARS),
    severity: issue.severity,
    severity_description: previewText(issue.severityDescription, TEXT_PREVIEW_CHARS),
    body_preview: previewText(issue.body, TEXT_PREVIEW_CHARS),
    source_fingerprint_count: issue.sourceFingerprints.length,
    source_fingerprints: cappedList(issue.sourceFingerprints, MAX_FILES)
  }));

  return {
    plan: {
      scope_decision: result.plan.scopeDecision ?? "investigate",
      scope_rationale: previewOptional(result.plan.scopeRationale, TEXT_PREVIEW_CHARS),
      intent_summary: previewOptional(result.plan.intentSummary, TEXT_PREVIEW_CHARS),
      planned_area_count: result.plan.areas.length,
      investigation_rounds: [...new Set(result.plan.areas.map((area) => area.round).filter(Boolean))]
    },
    investigations: {
      total_count: result.areas.length,
      omitted_count: Math.max(0, result.areas.length - areas.length),
      areas
    },
    summarizer: {
      completed: Boolean(result.finalReview || result.publication || result.readiness),
      summary: previewOptional(result.finalReviewSummary ?? result.finalReview?.summary, TEXT_PREVIEW_CHARS),
      merge_score: result.readiness?.score ?? result.finalReview?.readiness.score,
      merge_recommendation: previewOptional(
        result.readiness?.recommendation ?? result.finalReview?.readiness.recommendation,
        TEXT_PREVIEW_CHARS
      ),
      merge_rationale: previewOptional(
        result.readiness?.rationale ?? result.finalReview?.readiness.rationale,
        TEXT_PREVIEW_CHARS
      ),
      area_summary_count: result.publication?.areaSummaries.length ?? 0,
      issue_count: result.publication?.issues.length ?? 0,
      issue_severity_counts: countBy(result.publication?.issues ?? [], (issue) => issue.severity),
      dismissed_candidate_count: result.publication?.dismissedCandidates?.length ?? 0,
      issues_omitted_count: Math.max(0, (result.publication?.issues.length ?? 0) - publicationIssues.length),
      issues: publicationIssues,
      error: previewOptional(result.finalReview?.error ?? result.error, TEXT_PREVIEW_CHARS)
    }
  };
}

function jinaConfigurationLogSummary(result: RuntimeReviewResult): Record<string, unknown> {
  const configuration = result.jinaConfiguration;
  if (!configuration) return {};
  const change = configuration.proposedConfigChange;
  return {
    jina_config_depth: configuration.appliedConfig.depth,
    jina_config_source: configuration.configSource,
    jina_config_file_present: configuration.configFilePresent,
    jina_instruction_sources: configuration.instructionSources,
    jina_instruction_steps: configuration.instructionSteps,
    jina_instruction_warning_count: configuration.warnings.length,
    jina_instruction_warnings: configuration.warnings.map((warning) => previewText(warning, TEXT_PREVIEW_CHARS)),
    jina_config_changed_in_pr: change.changedInPullRequest,
    jina_config_change_kind: change.changeKind,
    jina_config_changed_keys: change.changedKeys,
    jina_proposed_config_file_present: change.proposedConfigFilePresent,
    jina_proposed_config_depth: change.proposedConfig?.depth,
    jina_proposed_config_source: change.proposedConfig?.source ?? "defaults",
    jina_proposed_config_warning_count: change.proposedWarnings.length,
    jina_proposed_config_warnings: change.proposedWarnings.map((warning) => previewText(warning, TEXT_PREVIEW_CHARS)),
    jina_proposed_config_applied_to_current_review: change.appliesToCurrentReview
  };
}

export function summarizeFindingsForLog<T extends LogFinding>(
  findings: readonly T[],
  publishability: {
    publishableFindings?: readonly T[];
    unanchoredFindings?: readonly T[];
    lowConfidenceFindings?: readonly T[];
  } = {}
): FindingLogSummary {
  const publishable = new Set(publishability.publishableFindings ?? []);
  const unanchored = new Set(publishability.unanchoredFindings ?? []);
  const lowConfidence = new Set(publishability.lowConfidenceFindings ?? []);
  const visible = findings.slice(0, MAX_FINDINGS);

  return {
    total_count: findings.length,
    omitted_count: Math.max(0, findings.length - visible.length),
    findings: visible.map((finding) => findingLogEntry(finding, { publishable, unanchored, lowConfidence }))
  };
}

function findingLogEntry<T extends LogFinding>(
  finding: T,
  publishability: {
    publishable: Set<T>;
    unanchored: Set<T>;
    lowConfidence: Set<T>;
  }
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    fingerprint: finding.fingerprint,
    risk: finding.risk,
    severity: finding.severity,
    confidence: finding.confidence,
    likelihood: finding.likelihood,
    category: finding.category,
    file_path: finding.file_path,
    line_number: finding.line_number,
    title: previewOptional(finding.title, TEXT_PREVIEW_CHARS),
    body_preview: previewOptional(finding.body, TEXT_PREVIEW_CHARS),
    root_cause_preview: previewOptional(finding.root_cause, TEXT_PREVIEW_CHARS),
    suggested_fix_preview: previewOptional(finding.suggested_fix ?? finding.suggested_change, TEXT_PREVIEW_CHARS),
    evidence_preview: evidencePreview(finding),
    publishable: publishability.publishable.has(finding),
    unanchored: publishability.unanchored.has(finding),
    low_confidence_held_back: publishability.lowConfidence.has(finding)
  };

  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) {
      delete entry[key];
    }
  }
  return entry;
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const bucket = key(value);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    return counts;
  }, {});
}

function evidencePreview(finding: LogFinding): string | undefined {
  const evidence = finding.evidence ?? finding.evidence_files;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return undefined;
  }
  return previewText(evidence.map(String).join("; "), TEXT_PREVIEW_CHARS);
}

function cappedList(values: readonly string[], max: number): { values: string[]; omitted_count: number } {
  return {
    values: values.slice(0, max),
    omitted_count: Math.max(0, values.length - max)
  };
}

function previewOptional(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : previewText(value, maxChars);
}

function previewText(value: string, maxChars: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 3)}...` : cleaned;
}
