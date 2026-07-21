export const retrievalTemplateNames = ["issue_trace", "feature_trace", "structure", "change", "intent", "ownership"] as const;
export type RetrievalTemplateName = (typeof retrievalTemplateNames)[number];
export type RepositoryContextOperation = "lookup" | "counterfactual";

export interface RetrievalCitation {
  readonly kind: "code" | "commit_change" | "assertion" | "observation" | "entity";
  readonly id: string;
  readonly repository: string;
  readonly commitSha?: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface RetrievalItem {
  readonly kind: string;
  readonly title: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly citations: readonly RetrievalCitation[];
  readonly score: number;
}

export interface RetrievalRequest {
  readonly tenantId: string;
  /** Repositories already authorized by the command/API boundary. */
  readonly allowedRepositories: readonly string[];
  readonly repository: string;
  readonly ref?: string;
  readonly template: RetrievalTemplateName;
  readonly query?: string;
  readonly symbol?: string;
  readonly path?: string;
  readonly pullRequestNumber?: number;
  readonly issueEntityId?: string;
  readonly issueNumber?: number;
  /** Exact phrase used to resolve an issue by its ingested title or body. */
  readonly issueText?: string;
  /** Exact phrase used to resolve an inferred Feature by label or natural key. */
  readonly featureText?: string;
  readonly commitSha?: string;
  readonly limit?: number;
}

export interface IssueTraceChange {
  readonly commitSha: string;
  readonly path: string;
  readonly change: string;
  readonly oldPath?: string;
}

export interface IssueTraceCommit {
  readonly sha: string;
  readonly url: string;
  readonly role: "merge" | "included" | "introduced";
  readonly changes: readonly IssueTraceChange[];
  readonly why?: string;
  readonly evidence?: readonly string[];
  readonly evidenceCommitSha?: string;
  readonly assertionIds?: readonly string[];
  readonly pullRequests?: readonly {
    readonly number: number;
    readonly title: string;
    readonly url: string;
  }[];
}

export interface IssueTraceResolution {
  readonly pullRequestNumber: number;
  readonly title: string;
  readonly url: string;
  readonly commits: readonly IssueTraceCommit[];
  readonly assertionIds: readonly string[];
  readonly observationIds: readonly string[];
}

/** Issue-centric result assembled from the projected graph and canonical provenance. */
export interface IssueTraceProjection {
  readonly issue: {
    readonly entityId: string;
    readonly origin: string;
    readonly title: string;
    readonly description?: string;
    readonly displayId?: string;
    readonly number?: number;
    readonly url?: string;
    readonly state?: string;
  };
  readonly resolutions: readonly IssueTraceResolution[];
  readonly introducedBy: readonly IssueTraceCommit[];
  readonly citations: readonly RetrievalCitation[];
}

export interface RetrievalResult {
  readonly template: RetrievalTemplateName;
  readonly repository: string;
  readonly ref: string;
  readonly items: readonly RetrievalItem[];
  readonly truncated: boolean;
  readonly totalBeforeLimit: number;
  readonly limit: number;
}

export interface RetrievalExecutor {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

export interface OrchestratedContext {
  readonly operation: RepositoryContextOperation;
  readonly question: string;
  readonly answer: string;
  readonly citedClaims: readonly {
    readonly text: string;
    readonly citations: readonly RetrievalCitation[];
  }[];
  readonly calls: readonly RetrievalResult[];
  readonly citations: readonly RetrievalCitation[];
  readonly unresolvedAmbiguities: readonly string[];
  readonly coverageGaps: readonly {
    readonly capability: RetrievalTemplateName | "query";
    readonly message: string;
  }[];
  readonly truncated: boolean;
}

/** Thin classifier/composer; it can choose tools, but never emits or executes a free-form query. */
export class RepositoryContextOrchestrator {
  constructor(private readonly executor: RetrievalExecutor) {}

  async answer(input: Omit<RetrievalRequest, "template"> & {
    readonly question: string;
    readonly operation?: RepositoryContextOperation;
    readonly tokenBudget?: number;
  }): Promise<OrchestratedContext> {
    const issueEntityId = input.issueEntityId;
    const issueNumber = input.issueNumber ?? extractIssueNumber(input.question);
    const issueText = issueNumber ? undefined : input.issueText ?? extractIssueText(input.question);
    const featureText = input.featureText ?? extractFeatureText(input.question);
    const pullRequestNumber = input.pullRequestNumber ?? extractPullRequestNumber(input.question);
    const commitSha = input.commitSha ?? extractCommitSha(input.question);
    const path = input.path ?? extractRepositoryPath(input.question);
    const symbol = input.symbol ?? extractSymbol(input.question);
    const operation = input.operation ?? (isCounterfactualQuestion(input.question) ? "counterfactual" : "lookup");
    const extracted = {
      ...(issueEntityId ? { issueEntityId } : {}),
      ...(issueNumber ? { issueNumber } : {}),
      ...(issueText ? { issueText } : {}),
      ...(featureText ? { featureText } : {}),
      ...(pullRequestNumber ? { pullRequestNumber } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(path ? { path } : {}),
      ...(symbol ? { symbol } : {})
    };
    const templates = operation === "counterfactual"
      ? counterfactualTemplates(extracted)
      : issueEntityId ? ["issue_trace" as const] : classifyTemplates(input.question);
    const perCallLimit = Math.max(1, Math.min(input.limit ?? 50, Math.floor((input.tokenBudget ?? 4_000) / Math.max(80, templates.length * 80))));
    const calls: RetrievalResult[] = [];
    for (const template of templates) {
      calls.push(await this.executor.retrieve({
        ...input,
        template,
        ...(template === "intent" ? { query: input.query ?? input.question } : {}),
        ...(issueNumber ? { issueNumber } : {}),
        ...(issueText ? { issueText } : {}),
        ...(featureText ? { featureText } : {}),
        ...(pullRequestNumber ? { pullRequestNumber } : {}),
        ...(commitSha ? { commitSha } : {}),
        ...(path ? { path } : {}),
        ...(symbol ? { symbol } : {}),
        limit: perCallLimit
      }));
    }
    const citations = dedupeCitations(calls.flatMap((call) => call.items.flatMap((item) => item.citations)));
    const synthesis = synthesizeContextAnswer(input.question, calls, extracted, operation);
    return {
      operation,
      question: input.question,
      ...synthesis,
      calls,
      citations,
      truncated: calls.some((call) => call.truncated)
    };
  }
}

export function isCounterfactualQuestion(question: string): boolean {
  return /\b(?:if|without|counterfactual|had\s+not|hadn't|did\s+not|didn't|never\s+(?:merged|landed|happened)|revert(?:ed|ing)?|remove(?:d|ing)?|omit(?:ted|ting)?)\b/i.test(question) &&
    /\b(?:would|could|might|still|exist|happen|break|fail|remain|work|affect|impact|merged|landed|revert(?:ed|ing)?|remove(?:d|ing)?|omit(?:ted|ting)?)\b/i.test(question);
}

function counterfactualTemplates(extracted: {
  readonly issueEntityId?: string;
  readonly issueNumber?: number;
  readonly issueText?: string;
  readonly featureText?: string;
  readonly pullRequestNumber?: number;
  readonly commitSha?: string;
}): readonly RetrievalTemplateName[] {
  if (extracted.featureText) return ["feature_trace"];
  if (extracted.issueEntityId || extracted.issueNumber || extracted.issueText || extracted.pullRequestNumber || extracted.commitSha) {
    return ["issue_trace"];
  }
  return [];
}

export function classifyTemplates(question: string): readonly RetrievalTemplateName[] {
  const value = question.toLowerCase();
  const issueNumber = extractIssueNumber(question);
  const issueText = extractIssueText(question);
  const featureText = extractFeatureText(question);
  const pullRequestNumber = extractPullRequestNumber(question);
  const commitSha = extractCommitSha(question);
  const causal = /caus|introduc|root cause/.test(value);
  const resolution = /resolv|fix(?:ed|es|ing)?|clos(?:e|ed|es|ing)/.test(value);
  if ((issueNumber || issueText) && (causal || resolution)) return ["issue_trace"];
  if ((pullRequestNumber || commitSha) && causal) return ["issue_trace"];
  if ((pullRequestNumber || commitSha) && resolution && /\b(?:which|what)\s+(?:issue|bug|ticket)\b/.test(value)) return ["issue_trace"];
  if (featureText) return ["feature_trace"];
  const selected: RetrievalTemplateName[] = [];
  if (issueNumber || issueText) selected.push("issue_trace");
  if (/depend|call|import|structure|where|symbol|implement|define|test(?:s|ed|ing)? cover/.test(value)) selected.push("structure");
  if (/change|break|impact|diff/.test(value) || pullRequestNumber || commitSha) selected.push("change");
  if (/why|intent|issue|introduced|history|exist/.test(value)) selected.push("intent");
  if (/\b(?:who|owner|owners|owned|owns|maintain|maintainer|maintainers|worked|author|authors)\b/.test(value)) selected.push("ownership");
  return selected.length > 0 ? [...new Set(selected)] : ["structure", "intent"];
}

export function extractPullRequestNumber(question: string): number | undefined {
  const match = /\b(?:pull request|pr)\s*#?\s*(\d+)\b/i.exec(question);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function extractCommitSha(question: string): string | undefined {
  const labeled = /\b(?:commit|sha)\s*[:#]?\s*([a-f0-9]{7,40})\b/i.exec(question)?.[1];
  const value = labeled ?? /\b[a-f0-9]{40}\b/i.exec(question)?.[0];
  return value?.toLowerCase();
}

export function extractIssueNumber(question: string): number | undefined {
  const labeled = /\b(?:issue|bug|ticket)\s*#?\s*(\d+)\b/i.exec(question);
  const match = labeled ?? (/\b(?:pull request|pr)\s*#?\s*\d+\b/i.test(question) ? null : /(?:^|\s)#(\d+)\b/.exec(question));
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Pulls the user-supplied issue phrase from quotes. The phrase is only an
 * identifier candidate; retrieval still resolves it inside the authorized
 * repository and returns canonical, cited issue traces.
 */
export function extractIssueText(question: string): string | undefined {
  if (!/issue|bug|ticket|caus|introduc|root cause|resolv|fix|clos/i.test(question)) return undefined;
  const quoted = /["“]([^"”\n]{2,500})["”]/.exec(question)?.[1];
  const unquoted = /\b(?:what|which\s+(?:pr|pull request|commit))?\s*(?:caused|causes|introduced|introduces|root cause of)\s+(.+?)(?:,\s*(?:and\s+)?why\b|\?|$)/i.exec(question)?.[1];
  const value = (quoted ?? unquoted)?.trim().replace(/["”]$/g, "").replace(/\s+/g, " ");
  return value || undefined;
}

export function extractFeatureText(question: string): string | undefined {
  if (!/feature|capabilit|implement|affect|impact|break|document/i.test(question)) return undefined;
  const quoted = /["“]([^"”\n]{2,200})["”]/.exec(question)?.[1];
  const named = /\b(?:feature|capabilit(?:y|ies))\s+(?:called\s+|named\s+)(.+?)(?:\?|$)/i.exec(question)?.[1];
  const beforeKind = /(.+?)\s+(?:feature|capability)\b/i.exec(question)?.[1]
    ?.replace(/^.*\b(?:implements?|affects?|impacts?|breaks?|documents?)\s+(?:the\s+)?/i, "")
    .replace(/^(?:what|which|where|how|could|would|might|does|do|is|are|show|describe)\s+(?:the\s+)?/i, "");
  const value = (quoted ?? named ?? beforeKind)?.trim().replace(/[?.!,]+$/g, "").replace(/\s+/g, " ");
  return value || undefined;
}

export function extractRepositoryPath(question: string): string | undefined {
  const candidates = question.match(/(?:\.\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/g) ?? [];
  const rootFiles = /^(?:Dockerfile|Makefile|LICENSE|NOTICE|CODEOWNERS|Jenkinsfile|Procfile)$/i;
  for (const candidate of candidates) {
    const value = candidate.replace(/^\.\//, "");
    if (value.startsWith("../")) continue;
    if (value.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(value) || rootFiles.test(value)) return value;
  }
  return undefined;
}

export function extractSymbol(question: string): string | undefined {
  const backticked = /`([A-Za-z_$][A-Za-z0-9_$.#:-]{1,200})`/.exec(question)?.[1];
  if (backticked) return backticked;
  const patterns = [
    /\bwhere\s+is\s+([A-Za-z_$][A-Za-z0-9_$.#:-]*)\s+(?:implemented|defined|declared)\b/i,
    /\bwhat\s+calls\s+([A-Za-z_$][A-Za-z0-9_$.#:-]*)\b/i,
    /\bcallers?\s+(?:of|for)\s+([A-Za-z_$][A-Za-z0-9_$.#:-]*)\b/i,
    /\b(?:symbol|function|class|method)\s+([A-Za-z_$][A-Za-z0-9_$.#:-]*)\b/i,
    /\bif\s+([A-Za-z_$][A-Za-z0-9_$.#:-]*)\s+changes?\b/i,
    /\bdoes\s+([A-Za-z_$][A-Za-z0-9_$.#:-]*)\s+depend\b/i
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(question)?.[1];
    if (value) return value;
  }
  return undefined;
}

function synthesizeContextAnswer(
  question: string,
  calls: readonly RetrievalResult[],
  extracted: {
    readonly issueEntityId?: string;
    readonly issueNumber?: number;
    readonly issueText?: string;
    readonly featureText?: string;
    readonly pullRequestNumber?: number;
    readonly commitSha?: string;
    readonly path?: string;
    readonly symbol?: string;
  },
  operation: RepositoryContextOperation
): Pick<OrchestratedContext, "answer" | "citedClaims" | "unresolvedAmbiguities" | "coverageGaps"> {
  if (operation === "counterfactual") return synthesizeCounterfactualContext(calls, extracted);
  const unresolvedAmbiguities: string[] = [];
  const coverageGaps: { capability: RetrievalTemplateName | "query"; message: string }[] = [];
  const citedClaims: { text: string; citations: readonly RetrievalCitation[] }[] = [];
  const answers: string[] = [];
  const templates = new Set(calls.map((call) => call.template));

  if (templates.has("structure") && !extracted.symbol && !extracted.path) {
    unresolvedAmbiguities.push("No exact symbol or repository path could be extracted from the structural question.");
  }
  if (templates.has("ownership") && !extracted.symbol && !extracted.path) {
    unresolvedAmbiguities.push("No exact repository path or symbol could be extracted for ownership lookup.");
  }
  if (templates.has("issue_trace") && !extracted.issueEntityId && !extracted.issueNumber && !extracted.issueText && !extracted.pullRequestNumber && !extracted.commitSha) {
    unresolvedAmbiguities.push("No issue, pull request, commit, or issue description could be resolved from the question.");
  }
  if (templates.has("feature_trace") && !extracted.featureText) {
    unresolvedAmbiguities.push("No exact feature description could be resolved from the question.");
  }

  for (const call of calls) {
    if (call.items.length === 0) {
      coverageGaps.push({
        capability: call.template,
        message: call.template === "structure"
          ? `No cited structural facts matched${extracted.symbol ? ` symbol ${extracted.symbol}` : extracted.path ? ` path ${extracted.path}` : " the question"}. The repository may have degraded or missing language coverage.`
          : `No cited ${call.template.replace("_", " ")} facts matched the validated query parameters.`
      });
      continue;
    }
    if (call.template === "issue_trace") {
      const selection = selectIssueTrace(call.items, extracted);
      if (!selection.item) {
        const message = selection.ambiguity ?? "No single issue trace could be selected safely.";
        unresolvedAmbiguities.push(message);
        answers.push(message);
        continue;
      }
      const issueAnswer = synthesizeIssueTrace(question, selection.item, extracted);
      answers.push(issueAnswer.answer);
      citedClaims.push(...issueAnswer.claims);
      if (issueAnswer.coverageGap) coverageGaps.push({ capability: "issue_trace", message: issueAnswer.coverageGap });
      continue;
    }
    if (call.template === "feature_trace") {
      const featureAnswer = synthesizeFeatureTrace(question, call.items);
      if (featureAnswer.ambiguity) {
        unresolvedAmbiguities.push(featureAnswer.ambiguity);
        answers.push(featureAnswer.ambiguity);
      } else {
        answers.push(featureAnswer.answer);
        citedClaims.push(...featureAnswer.claims);
      }
      continue;
    }
    const answerItems = consolidateAnswerItems(call.template, call.items);
    const selected = answerItems.slice(0, 6);
    const resultCount = call.truncated ? call.totalBeforeLimit : answerItems.length;
    citedClaims.push(...selected.map((item) => ({ text: item.title, citations: item.citations })));
    if (call.template === "structure") {
      answers.push(`Found ${resultCount} cited structural fact${resultCount === 1 ? "" : "s"}${extracted.symbol ? ` for ${extracted.symbol}` : extracted.path ? ` in ${extracted.path}` : ""}: ${selected.map((item) => item.title).join("; ")}.`);
    } else if (call.template === "change") {
      answers.push(`The cited change set contains ${resultCount} result${resultCount === 1 ? "" : "s"}: ${selected.map((item) => item.title).join("; ")}.`);
    } else if (call.template === "ownership") {
      answers.push(`Ownership evidence: ${selected.map((item) => item.title).join("; ")}.`);
    } else {
      answers.push(`Repository intent/history evidence: ${selected.map((item) => item.title).join("; ")}.`);
    }
  }

  const answer = answers.length
    ? answers.join(" ")
    : "I could not produce a supported answer from the currently indexed repository evidence.";
  return { answer, citedClaims: dedupeClaims(citedClaims), unresolvedAmbiguities: [...new Set(unresolvedAmbiguities)], coverageGaps };
}

function consolidateAnswerItems(template: RetrievalTemplateName, items: readonly RetrievalItem[]): readonly RetrievalItem[] {
  const consolidated = new Map<string, RetrievalItem>();
  for (const item of items) {
    const key = item.title;
    const existing = consolidated.get(key);
    if (!existing) {
      consolidated.set(key, item);
      continue;
    }
    consolidated.set(key, {
      ...existing,
      score: Math.max(existing.score, item.score),
      citations: dedupeCitations([...existing.citations, ...item.citations])
    });
  }
  return [...consolidated.values()];
}

function synthesizeCounterfactualContext(
  calls: readonly RetrievalResult[],
  extracted: {
    readonly issueEntityId?: string;
    readonly issueNumber?: number;
    readonly issueText?: string;
    readonly featureText?: string;
    readonly pullRequestNumber?: number;
    readonly commitSha?: string;
  }
): Pick<OrchestratedContext, "answer" | "citedClaims" | "unresolvedAmbiguities" | "coverageGaps"> {
  const citedClaims: { text: string; citations: readonly RetrievalCitation[] }[] = [];
  const unresolvedAmbiguities: string[] = [];
  const coverageGaps: { capability: RetrievalTemplateName | "query"; message: string }[] = [];
  const answers: string[] = [];

  if (calls.length === 0) {
    return {
      answer: "I could not identify an issue, feature, pull request, or commit for this counterfactual.",
      citedClaims,
      unresolvedAmbiguities: ["Counterfactual lookup requires a resolvable issue, feature, pull request, or commit."],
      coverageGaps: [{ capability: "query", message: "No fixed projection lookup could be selected safely." }]
    };
  }

  for (const call of calls) {
    if (call.items.length === 0) {
      coverageGaps.push({
        capability: call.template,
        message: `No active reviewed ${call.template.replace("_", " ")} relationship supports this counterfactual.`
      });
      continue;
    }
    if (call.template === "issue_trace") {
      const items = extracted.issueEntityId || extracted.issueNumber || extracted.issueText
        ? (() => {
            const selection = selectIssueTrace(call.items, extracted);
            if (!selection.item) {
              const ambiguity = selection.ambiguity ?? "No single issue trace could be selected safely.";
              unresolvedAmbiguities.push(ambiguity);
              return [];
            }
            return [selection.item];
          })()
        : call.items;
      for (const item of items) {
        const result = synthesizeIssueCounterfactual(item, extracted);
        if (result.answer) answers.push(result.answer);
        citedClaims.push(...result.claims);
        if (result.coverageGap) coverageGaps.push({ capability: "issue_trace", message: result.coverageGap });
      }
      continue;
    }
    if (call.template === "feature_trace") {
      const result = synthesizeFeatureCounterfactual(call.items, extracted);
      if (result.answer) answers.push(result.answer);
      citedClaims.push(...result.claims);
      if (result.coverageGap) coverageGaps.push({ capability: "feature_trace", message: result.coverageGap });
    }
  }

  return {
    answer: answers.length > 0
      ? answers.join(" ")
      : "The current reviewed graph does not contain a causal or impact relationship that can support this counterfactual.",
    citedClaims: dedupeClaims(citedClaims),
    unresolvedAmbiguities: [...new Set(unresolvedAmbiguities)],
    coverageGaps
  };
}

function synthesizeIssueCounterfactual(
  item: RetrievalItem,
  extracted: { readonly pullRequestNumber?: number; readonly commitSha?: string }
): {
  readonly answer?: string;
  readonly claims: readonly { readonly text: string; readonly citations: readonly RetrievalCitation[] }[];
  readonly coverageGap?: string;
} {
  const trace = issueTraceData(item);
  const issueLabel = trace.issue.displayId
    ? `Issue ${trace.issue.displayId}${trace.issue.title ? ` (${trace.issue.title})` : ""}`
    : trace.issue.title || "The issue";
  const cause = extracted.commitSha
    ? trace.introducedBy.find((candidate) => candidate.sha.startsWith(extracted.commitSha!))
    : extracted.pullRequestNumber
      ? trace.introducedBy.find((candidate) => candidate.pullRequests?.some((pullRequest) => pullRequest.number === extracted.pullRequestNumber))
      : trace.introducedBy[0];
  if (cause) {
    const pullRequest = cause.pullRequests?.find((candidate) =>
      !extracted.pullRequestNumber || candidate.number === extracted.pullRequestNumber
    ) ?? cause.pullRequests?.[0];
    const target = pullRequest ? `PR #${pullRequest.number}` : `commit ${cause.sha.slice(0, 12)}`;
    const conclusion = `Without ${target}, the active reviewed causal model says ${issueLabel} would likely not have been introduced by that change; independent causes are not ruled out.`;
    const why = cause.why ? `Why: ${cause.why}` : undefined;
    const citations = citationsForCause(item, cause);
    if (citations.length === 0) {
      return {
        claims: [],
        coverageGap: `${issueLabel} has an active reviewed cause, but its causal evidence is unavailable at this ref.`
      };
    }
    return {
      answer: `${conclusion}${why ? ` ${why.endsWith(".") ? why : `${why}.`}` : ""}`,
      claims: [{ text: conclusion, citations }, ...(why ? [{ text: why, citations }] : [])]
    };
  }
  const resolution = extracted.pullRequestNumber
    ? trace.resolutions.find((candidate) => candidate.pullRequestNumber === extracted.pullRequestNumber)
    : extracted.commitSha
      ? trace.resolutions.find((candidate) => candidate.commits.some((commit) => commit.sha.startsWith(extracted.commitSha!)))
      : trace.resolutions[0];
  if (resolution) {
    const target = extracted.pullRequestNumber
      ? `PR #${resolution.pullRequestNumber}`
      : extracted.commitSha ? `commit ${extracted.commitSha.slice(0, 12)}` : `PR #${resolution.pullRequestNumber}`;
    const conclusion = `Without ${target}, the recorded resolution for ${issueLabel} would be absent, so the issue would remain unresolved at this ref unless another fix replaced it.`;
    const citations = citationsForResolution(item, resolution);
    if (citations.length === 0) {
      return {
        claims: [],
        coverageGap: `${issueLabel} has a recorded resolution, but its evidence is unavailable at this ref.`
      };
    }
    return { answer: conclusion, claims: [{ text: conclusion, citations }] };
  }
  return {
    claims: [],
    coverageGap: `${issueLabel} has no active reviewed causal or resolution role for the referenced change.`
  };
}

function synthesizeFeatureCounterfactual(
  items: readonly RetrievalItem[],
  extracted: { readonly pullRequestNumber?: number; readonly commitSha?: string }
): {
  readonly answer?: string;
  readonly claims: readonly { readonly text: string; readonly citations: readonly RetrievalCitation[] }[];
  readonly coverageGap?: string;
} {
  const impacts = items.filter((item) => {
    if (item.data.predicate !== "LIKELY_AFFECTS" || !isRecord(item.data.related)) return false;
    const naturalKey = typeof item.data.related.naturalKey === "string" ? item.data.related.naturalKey : "";
    if (extracted.pullRequestNumber) return naturalKey.endsWith(`#${extracted.pullRequestNumber}`);
    if (extracted.commitSha) return naturalKey.toLowerCase().endsWith(`:sha:${extracted.commitSha.toLowerCase()}`);
    return true;
  });
  if (impacts.length === 0) {
    return {
      claims: [],
      coverageGap: "Feature implementation or documentation alone does not establish a counterfactual; an active reviewed LIKELY_AFFECTS relationship is required."
    };
  }
  const feature = impacts.map((item) => item.data.feature).find(isRecord);
  const label = typeof feature?.label === "string" ? feature.label : "the feature";
  const target = extracted.pullRequestNumber
    ? `PR #${extracted.pullRequestNumber}`
    : extracted.commitSha ? `commit ${extracted.commitSha.slice(0, 12)}` : "the referenced change";
  const conclusion = `Without ${target}, the reviewed graph supports removing a likely impact on ${label}, but it does not prove that the feature would disappear or behave differently.`;
  const citations = dedupeCitations(impacts.flatMap((item) => item.citations));
  if (citations.length === 0) {
    return {
      claims: [],
      coverageGap: `The reviewed LIKELY_AFFECTS relationship for ${label} has no available citation at this ref.`
    };
  }
  return {
    answer: conclusion,
    claims: [{ text: conclusion, citations }]
  };
}

function synthesizeFeatureTrace(
  question: string,
  items: readonly RetrievalItem[]
): {
  readonly answer: string;
  readonly claims: readonly { readonly text: string; readonly citations: readonly RetrievalCitation[] }[];
  readonly ambiguity?: string;
} {
  const featureKeys = new Set(items.flatMap((item) => {
    const feature = item.data.feature;
    return isRecord(feature) && typeof feature.naturalKey === "string" ? [feature.naturalKey] : [];
  }));
  if (featureKeys.size > 1) {
    const labels = [...new Set(items.flatMap((item) => {
      const feature = item.data.feature;
      return isRecord(feature) && typeof feature.label === "string" ? [feature.label] : [];
    }))];
    return {
      answer: "",
      claims: [],
      ambiguity: `Multiple features matched this question: ${labels.join("; ")}. Refine the feature description before treating the result as fact.`
    };
  }
  const feature = items.map((item) => item.data.feature).find(isRecord);
  const featureLabel = typeof feature?.label === "string" ? feature.label : "The feature";
  const implementations = items.filter((item) => item.data.predicate === "IMPLEMENTS");
  const impacts = items.filter((item) => item.data.predicate === "LIKELY_AFFECTS");
  const documents = items.filter((item) => item.data.predicate === "DOCUMENTED_BY");
  const references = items.filter((item) => item.data.predicate === "REFERENCES");
  const selected = /affect|impact|break/i.test(question)
    ? impacts
    : /document|docs?/i.test(question)
      ? documents
      : /implement|where|code|symbol|file/i.test(question)
        ? implementations
        : [...implementations, ...documents, ...impacts, ...references];
  const relationships = selected.length > 0 ? selected : items;
  const claims = relationships.slice(0, 8).map((item) => ({ text: item.title, citations: item.citations }));
  const answer = claims.length > 0
    ? `${featureLabel}: ${claims.map((claim) => claim.text).join("; ")}.`
    : `${featureLabel} has no active reviewed relationship matching this question.`;
  return { answer, claims };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function synthesizeIssueTrace(
  question: string,
  item: RetrievalItem,
  extracted: {
    readonly pullRequestNumber?: number;
    readonly commitSha?: string;
  }
): { readonly answer: string; readonly claims: readonly { text: string; citations: readonly RetrievalCitation[] }[]; readonly coverageGap?: string } {
  const trace = item.data as unknown as IssueTraceProjection;
  const issue = trace.issue;
  const causal = /caus|introduc|root cause/i.test(question);
  const introduced = extracted.commitSha
    ? trace.introducedBy?.find((cause) => cause.sha?.startsWith(extracted.commitSha!))
    : extracted.pullRequestNumber
      ? trace.introducedBy?.find((cause) => cause.pullRequests?.some((pullRequest) => pullRequest.number === extracted.pullRequestNumber))
      : trace.introducedBy?.[0];
  const resolution = extracted.pullRequestNumber
    ? trace.resolutions?.find((candidate) => candidate.pullRequestNumber === extracted.pullRequestNumber)
    : extracted.commitSha
      ? trace.resolutions?.find((candidate) => candidate.commits?.some((commit) => commit.sha?.startsWith(extracted.commitSha!)))
      : trace.resolutions?.[0];
  const issueLabel = issue?.displayId
    ? `Issue ${issue.displayId}${issue.title ? ` (${issue.title})` : ""}`
    : issue?.title || "The issue";
  if (causal && introduced?.sha) {
    const pr = introduced.pullRequests?.[0]?.number;
    const cause = `${issueLabel} was introduced${pr ? ` by PR #${pr}` : ""} in commit ${introduced.sha.slice(0, 12)}`;
    const why = introduced.why ? ` because ${introduced.why}` : ".";
    return {
      answer: `${cause}${why.endsWith(".") ? why : `${why}.`}`,
      claims: [
        { text: cause, citations: citationsForCause(item, introduced) },
        ...(introduced.why ? [{ text: `Why: ${introduced.why}`, citations: citationsForCause(item, introduced) }] : [])
      ]
    };
  }
  if (causal) {
    const laterFix = resolution?.pullRequestNumber ? ` A later resolution is recorded in PR #${resolution.pullRequestNumber}.` : "";
    return {
      answer: `No active reviewed causal assertion identifies which change introduced ${issueLabel}.${laterFix}`,
      claims: resolution?.pullRequestNumber ? [{ text: `${issueLabel} was later resolved by PR #${resolution.pullRequestNumber}.`, citations: citationsForResolution(item, resolution) }] : [],
      coverageGap: "Causality requires an active reviewed INTRODUCED_BY assertion; proposed or missing claims are not presented as fact."
    };
  }
  if (resolution?.pullRequestNumber) {
    const commit = resolution.commits?.[0]?.sha;
    const text = `${issueLabel} was resolved by PR #${resolution.pullRequestNumber}${commit ? ` with commit ${commit.slice(0, 12)}` : ""}.`;
    return { answer: text, claims: [{ text, citations: citationsForResolution(item, resolution) }] };
  }
  return {
    answer: `${issueLabel} has no verified resolving pull request or commit relationship.`,
    claims: [],
    coverageGap: "No active deterministic resolution relationship is available for this issue."
  };
}

function selectIssueTrace(
  items: readonly RetrievalItem[],
  extracted: {
    readonly issueEntityId?: string;
    readonly issueNumber?: number;
    readonly issueText?: string;
    readonly pullRequestNumber?: number;
    readonly commitSha?: string;
  }
): { readonly item?: RetrievalItem; readonly ambiguity?: string } {
  if (items.length === 0) return {};
  if (items.length === 1) return { item: items[0]! };
  const issueEntityMatches = extracted.issueEntityId
    ? items.filter((item) => issueTraceData(item).issue.entityId === extracted.issueEntityId)
    : [];
  if (issueEntityMatches.length === 1) return { item: issueEntityMatches[0]! };
  const issueNumberMatches = extracted.issueNumber
    ? items.filter((item) => issueTraceData(item).issue?.number === extracted.issueNumber)
    : [];
  if (issueNumberMatches.length === 1) return { item: issueNumberMatches[0]! };
  if (extracted.issueText) {
    const normalized = extracted.issueText.trim().toLowerCase();
    const exact = items.filter((item) => issueTraceData(item).issue?.title?.trim().toLowerCase() === normalized);
    if (exact.length === 1) return { item: exact[0]! };
  }
  const identifiers = items.map((item) => {
    const issue = issueTraceData(item).issue;
    return issue?.number ? `#${issue.number}${issue.title ? ` ${issue.title}` : ""}` : item.title;
  });
  return { ambiguity: `Multiple issues matched this question: ${identifiers.join("; ")}. Refine the issue description before treating a causal result as fact.` };
}

function issueTraceData(item: RetrievalItem): IssueTraceProjection {
  return item.data as unknown as IssueTraceProjection;
}

function citationsForCause(
  item: RetrievalItem,
  cause: { readonly evidence?: readonly string[]; readonly evidenceCommitSha?: string; readonly assertionIds?: readonly string[] }
): readonly RetrievalCitation[] {
  const assertionIds = new Set(cause.assertionIds ?? []);
  return dedupeCitations(item.citations.filter((citation) =>
    (citation.kind === "assertion" && assertionIds.has(citation.id)) ||
    (citation.kind === "code" && Boolean(cause.evidenceCommitSha) && citation.commitSha === cause.evidenceCommitSha &&
      (cause.evidence ?? []).some((value) => evidenceMatchesCitation(value, citation)))
  ));
}

function evidenceMatchesCitation(value: string, citation: RetrievalCitation): boolean {
  const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
  if (!match?.[1] || !match[2] || citation.path !== match[1]) return false;
  const startLine = Number.parseInt(match[2], 10);
  const endLine = match[3] ? Number.parseInt(match[3], 10) : startLine;
  return citation.startLine === startLine && citation.endLine === endLine;
}

function citationsForResolution(
  item: RetrievalItem,
  resolution: {
    readonly assertionIds?: readonly string[];
    readonly observationIds?: readonly string[];
    readonly commits?: readonly { readonly sha?: string }[];
  }
): readonly RetrievalCitation[] {
  const assertionIds = new Set(resolution.assertionIds ?? []);
  const observationIds = new Set(resolution.observationIds ?? []);
  const commitShas = new Set((resolution.commits ?? []).flatMap((commit) => commit.sha ? [commit.sha] : []));
  return dedupeCitations(item.citations.filter((citation) =>
    (citation.kind === "assertion" && assertionIds.has(citation.id)) ||
    (citation.kind === "observation" && observationIds.has(citation.id)) ||
    (citation.kind === "commit_change" && Boolean(citation.commitSha) && commitShas.has(citation.commitSha!))
  ));
}

function dedupeClaims<T extends { readonly text: string }>(claims: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    if (seen.has(claim.text)) return false;
    seen.add(claim.text);
    return true;
  });
}

function dedupeCitations(citations: readonly RetrievalCitation[]): readonly RetrievalCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = JSON.stringify(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
