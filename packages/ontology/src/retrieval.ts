export const retrievalTemplateNames = ["structure", "change", "intent", "ownership"] as const;
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
  readonly limit?: number;
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
    for (const template of templates) {
      calls.push(await this.executor.retrieve({ ...input, template, query: input.query ?? input.question, limit: perCallLimit }));
    }
    const citations = dedupeCitations(calls.flatMap((call) => call.items.flatMap((item) => item.citations)));
    return { question: input.question, calls, citations, truncated: calls.some((call) => call.truncated) };
  }
}

export function classifyTemplates(question: string): readonly RetrievalTemplateName[] {
  const value = question.toLowerCase();
  const selected: RetrievalTemplateName[] = [];
  if (/depend|call|import|structure|where|symbol/.test(value)) selected.push("structure");
  if (/change|break|impact|diff|pull request|\bpr\b/.test(value)) selected.push("change");
  if (/why|intent|issue|introduced|history|exist/.test(value)) selected.push("intent");
  if (/who|owner|own|maintain|worked|author/.test(value)) selected.push("ownership");
  return selected.length > 0 ? [...new Set(selected)] : ["structure", "intent"];
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
