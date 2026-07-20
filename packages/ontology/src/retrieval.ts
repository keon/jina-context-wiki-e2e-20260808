export const retrievalTemplateNames = ["issue_trace", "structure", "change", "intent", "ownership"] as const;
export type RetrievalTemplateName = (typeof retrievalTemplateNames)[number];

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
  readonly issueNumber?: number;
  /** Exact phrase used to resolve an issue by its ingested title or body. */
  readonly issueText?: string;
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

/** Materialized issue-centric read model. Canonical assertions remain the source of truth. */
export interface IssueTraceProjection {
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly url: string;
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
  readonly question: string;
  readonly calls: readonly RetrievalResult[];
  readonly citations: readonly RetrievalCitation[];
  readonly truncated: boolean;
}

/** Thin classifier/composer; it can choose tools, but never emits or executes a free-form query. */
export class RepositoryContextOrchestrator {
  constructor(private readonly executor: RetrievalExecutor) {}

  async answer(input: Omit<RetrievalRequest, "template"> & { readonly question: string; readonly tokenBudget?: number }): Promise<OrchestratedContext> {
    const templates = classifyTemplates(input.question);
    const perCallLimit = Math.max(1, Math.min(input.limit ?? 50, Math.floor((input.tokenBudget ?? 4_000) / Math.max(80, templates.length * 80))));
    const calls: RetrievalResult[] = [];
    const issueNumber = input.issueNumber ?? extractIssueNumber(input.question);
    const issueText = issueNumber ? undefined : input.issueText ?? extractIssueText(input.question);
    const pullRequestNumber = input.pullRequestNumber ?? extractPullRequestNumber(input.question);
    const commitSha = input.commitSha ?? extractCommitSha(input.question);
    for (const template of templates) {
      calls.push(await this.executor.retrieve({
        ...input,
        template,
        query: input.query ?? input.question,
        ...(issueNumber ? { issueNumber } : {}),
        ...(issueText ? { issueText } : {}),
        ...(pullRequestNumber ? { pullRequestNumber } : {}),
        ...(commitSha ? { commitSha } : {}),
        limit: perCallLimit
      }));
    }
    const citations = dedupeCitations(calls.flatMap((call) => call.items.flatMap((item) => item.citations)));
    return { question: input.question, calls, citations, truncated: calls.some((call) => call.truncated) };
  }
}

export function classifyTemplates(question: string): readonly RetrievalTemplateName[] {
  const value = question.toLowerCase();
  const issueNumber = extractIssueNumber(question);
  const issueText = extractIssueText(question);
  const pullRequestNumber = extractPullRequestNumber(question);
  const commitSha = extractCommitSha(question);
  if ((issueNumber || issueText || pullRequestNumber || commitSha) && /resolv|fix|clos|caus|introduc|root cause|pull request|\bpr\b|commit/.test(value)) return ["issue_trace"];
  const selected: RetrievalTemplateName[] = [];
  if (issueNumber || issueText) selected.push("issue_trace");
  if (/depend|call|import|structure|where|symbol/.test(value)) selected.push("structure");
  if (/change|break|impact|diff|pull request|\bpr\b/.test(value)) selected.push("change");
  if (/why|intent|issue|introduced|history|exist/.test(value)) selected.push("intent");
  if (/who|owner|own|maintain|worked|author/.test(value)) selected.push("ownership");
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
  const match = /\b(?:issue|bug|ticket)\s*#?\s*(\d+)\b/i.exec(question) ?? /(?:^|\s)#(\d+)\b/.exec(question);
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
  const match = /["“]([^"”\n]{2,500})["”]/.exec(question);
  const value = match?.[1]?.trim().replace(/\s+/g, " ");
  return value || undefined;
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
