import type { ContextGraph, ContextGraphAssertion, ContextGraphEdge, ContextGraphNode } from "./types.ts";

/**
 * Pure context-graph page logic ported from the previous vanilla-DOM
 * dashboard client. Everything here is renderer- and framework-agnostic so
 * it can be unit-tested directly.
 */

export interface GraphSelection {
  readonly kind: "node" | "edge";
  readonly id: string;
}

/** The subset of a graph that survives the node-kind / edge-predicate filters. */
export interface VisibleGraph {
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly ContextGraphEdge[];
}

export function filterContextGraph(
  graph: VisibleGraph,
  hiddenNodeKinds: ReadonlySet<string>,
  hiddenEdgePredicates: ReadonlySet<string>
): VisibleGraph {
  const nodes = graph.nodes.filter((node) => !hiddenNodeKinds.has(node.kind));
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) =>
      !hiddenEdgePredicates.has(edge.predicate) && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
  );
  return { nodes, edges };
}

export function selectionIsVisible(selection: GraphSelection | null, graph: VisibleGraph): boolean {
  if (!selection) return true;
  const items: readonly { readonly id: string }[] = selection.kind === "node" ? graph.nodes : graph.edges;
  return items.some((item) => item.id === selection.id);
}

export function contextGraphIdentity(graph: ContextGraph): string {
  return [graph.id || "", graph.repository || "", graph.ref || "", graph.commitSha || "", graph.generatedAt || ""].join(
    "|"
  );
}

export function mergePullRequestsForCommit(node: ContextGraphNode, graph: VisibleGraph): readonly ContextGraphNode[] {
  const pullRequests: ContextGraphNode[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.target !== node.id || edge.predicate !== "MERGED_AS" || seen.has(edge.source)) continue;
    const pullRequest = graph.nodes.find(
      (candidate) => candidate.id === edge.source && candidate.kind === "PullRequest"
    );
    if (!pullRequest) continue;
    seen.add(edge.source);
    pullRequests.push(pullRequest);
  }
  return pullRequests;
}

export function commitShaForNode(node: ContextGraphNode): string | null {
  const labelSha = /^[a-f0-9]{7,40}$/i.exec(String(node.label || ""));
  if (labelSha) return labelSha[0];
  const canonicalSha = /(?:^|:)sha:([a-f0-9]{7,40})(?:$|:)/i.exec(String(node.description || ""));
  return canonicalSha?.[1] ?? null;
}

export function canonicalNodeContext(description: string | undefined): string {
  const value = String(description || "");
  const repositoryEntity = /^repo:([^:]+):(path|moniker):(.+)$/.exec(value);
  if (repositoryEntity) return `${repositoryEntity[1]} · ${repositoryEntity[3]}`;
  const url = /^url:(https?:\/\/.+)$/i.exec(value);
  if (url) return url[1] ?? value;
  return value;
}

export function friendlyNodeLabel(node: ContextGraphNode, graph: VisibleGraph): string {
  if (node.kind === "Commit") {
    const pullRequests = mergePullRequestsForCommit(node, graph);
    if (pullRequests.length === 1) return `Merge commit · ${pullRequests[0]?.label ?? ""}`;
    const sha = commitShaForNode(node);
    if (sha) return `Commit · ${sha.slice(0, 12)}`;
  }
  const technicalLabel = /^(?:entity:|node[_:]|[a-f0-9]{12,40}$)/i.test(node.label);
  if (technicalLabel) {
    const context = canonicalNodeContext(node.description);
    const kind = String(node.kind)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[._-]+/g, " ");
    if (context && context !== node.label) return `${kind} · ${context}`;
  }
  return node.label;
}

export function friendlyNodeLabels(graph: VisibleGraph): Record<string, string> {
  const labels: Record<string, string> = {};
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pullRequestsByCommit = new Map<string, ContextGraphNode[]>();
  for (const edge of graph.edges) {
    if (edge.predicate !== "MERGED_AS") continue;
    const pullRequest = nodesById.get(edge.source);
    if (!pullRequest || pullRequest.kind !== "PullRequest") continue;
    const existing = pullRequestsByCommit.get(edge.target);
    if (existing) existing.push(pullRequest);
    else pullRequestsByCommit.set(edge.target, [pullRequest]);
  }
  for (const node of graph.nodes) {
    const pullRequests = pullRequestsByCommit.get(node.id);
    if (node.kind === "Commit" && pullRequests?.length === 1) {
      labels[node.id] = `Merge commit · ${pullRequests[0]?.label ?? ""}`;
      continue;
    }
    if (node.kind === "Commit") {
      const sha = commitShaForNode(node);
      if (sha) {
        labels[node.id] = `Commit · ${sha.slice(0, 12)}`;
        continue;
      }
    }
    labels[node.id] = friendlyNodeLabel(node, graph);
  }
  return labels;
}

export function friendlyNodeExplanation(node: ContextGraphNode, graph: VisibleGraph): string {
  if (node.kind === "Commit") {
    const pullRequests = mergePullRequestsForCommit(node, graph);
    const first = pullRequests[0];
    if (pullRequests.length === 1 && first)
      return `This commit records the merge of ${friendlyNodeLabel(first, graph)}.`;
    if (pullRequests.length > 1)
      return "Multiple pull requests claim this merge commit. Inspect the visible relationships before attributing it to a pull request.";
  }
  return node.description || "No explanation provided for this node.";
}

export function visibleCount(visible: number, total: number): string {
  return visible === total ? String(total) : `${visible} / ${total}`;
}

export function countGraphTypes<T, K extends keyof T>(items: readonly T[], property: K): readonly [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = String(item[property]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((left, right) => left[0].localeCompare(right[0]));
}

export interface ConfidenceSummary {
  readonly value: number | undefined;
  readonly scoredCount: number;
  readonly totalCount: number;
}

export function connectedConfidenceSummary(edges: readonly ContextGraphEdge[]): ConfidenceSummary {
  const scores = edges
    .map((edge) => edge.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    value: scores.length ? scores.reduce((total, value) => total + value, 0) / scores.length : undefined,
    scoredCount: scores.length,
    totalCount: edges.length
  };
}

/* ------------------------------------------------------------------ */
/* Cited search (/context-graph/ask) response shapes and helpers.      */
/* ------------------------------------------------------------------ */

export interface ContextCitation {
  readonly kind?: string;
  readonly id?: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly commitSha?: string;
}

export interface ContextCitedClaim {
  readonly text?: string;
  readonly citations?: readonly ContextCitation[];
}

export interface TracePullRequest {
  readonly number?: number | string;
  readonly title?: string;
  readonly url?: string;
}

export interface TraceChange {
  readonly path?: string;
}

export interface TraceCommit {
  readonly sha?: string;
  readonly url?: string;
  readonly role?: string;
  readonly committedAt?: string;
  readonly why?: string;
  readonly evidence?: readonly string[];
  readonly changes?: readonly TraceChange[];
  readonly pullRequests?: readonly TracePullRequest[];
}

export interface TraceResolution {
  readonly pullRequestNumber?: number | string;
  readonly title?: string;
  readonly url?: string;
  readonly commits?: readonly TraceCommit[];
}

export interface TraceIssue {
  readonly number?: number | string;
  readonly title?: string;
  readonly displayId?: string;
  readonly url?: string;
}

export interface CausalPathNode {
  readonly kind?: string;
  readonly label?: string;
}

export interface CausalPath {
  readonly nodes?: readonly CausalPathNode[];
  readonly why?: string;
  readonly citations?: readonly ContextCitation[];
}

export interface CausalTraceRoot {
  readonly kind?: string;
  readonly label?: string;
}

export interface ContextItemData {
  readonly excerpt?: string;
  readonly issue?: TraceIssue;
  readonly introducedBy?: readonly TraceCommit[];
  readonly resolutions?: readonly TraceResolution[];
  readonly root?: CausalTraceRoot;
  readonly causes?: readonly CausalPath[];
  readonly implementations?: readonly CausalPath[];
  readonly affectedEntities?: readonly CausalPath[];
  readonly dependencies?: readonly CausalPath[];
  readonly deployments?: readonly CausalPath[];
  readonly documentation?: readonly CausalPath[];
  readonly ownership?: readonly CausalPath[];
  readonly movedFrom?: readonly CausalPath[];
}

export interface ContextCallItem {
  readonly kind?: string;
  readonly title?: string;
  readonly data?: ContextItemData;
  readonly citations?: readonly ContextCitation[];
}

export interface ContextCall {
  readonly template?: string;
  readonly truncated?: boolean;
  readonly items?: readonly ContextCallItem[];
}

export interface ContextCounterfactualEntity {
  readonly kind?: string;
  readonly label?: string;
}

export interface ContextCounterfactual {
  readonly basis?: string;
  readonly intervention?: ContextCounterfactualEntity;
  readonly outcome?: ContextCounterfactualEntity;
  readonly removedPaths?: readonly CausalPath[];
  readonly remainingPaths?: readonly CausalPath[];
}

export interface ContextCoverageGap {
  readonly capability?: string;
  readonly message?: string;
}

export interface ContextAskState {
  readonly error?: string;
  readonly question?: string;
  readonly answer?: string;
  readonly citations?: readonly ContextCitation[];
  readonly citedClaims?: readonly ContextCitedClaim[];
  readonly calls?: readonly ContextCall[];
  readonly counterfactual?: ContextCounterfactual;
  readonly unresolvedAmbiguities?: readonly string[];
  readonly coverageGaps?: readonly ContextCoverageGap[];
}

export function contextGraphMatches(state: ContextAskState | null, graph: VisibleGraph | null): GraphSelection[] {
  if (!state || state.error || !graph) return [];
  const identifiers = new Set<string>();
  const observations = new Set<string>();
  const paths = new Set<string>();
  const pathRanges = new Map<string, { start: number; end: number }[]>();
  const shas = new Set<string>();
  const labels = new Set<string>();
  const predicates = new Set<string>();
  const normalized = (value: string | undefined): string =>
    String(value || "")
      .trim()
      .toLocaleLowerCase();
  const addIdentifier = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) identifiers.add(value.trim());
  };
  const addPath = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) paths.add(value.trim());
  };
  const addSha = (value: unknown): void => {
    if (typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value.trim())) shas.add(value.trim().toLocaleLowerCase());
  };
  const addCitation = (citation: ContextCitation | undefined): void => {
    if (!citation || typeof citation !== "object") return;
    addIdentifier(citation.id);
    if (citation.kind === "observation" && typeof citation.id === "string") observations.add(citation.id);
    addPath(citation.path);
    if (typeof citation.path === "string" && Number.isFinite(citation.startLine)) {
      const ranges = pathRanges.get(citation.path) ?? [];
      if (!pathRanges.has(citation.path)) pathRanges.set(citation.path, ranges);
      ranges.push({
        start: citation.startLine!,
        end: Number.isFinite(citation.endLine) ? citation.endLine! : citation.startLine!
      });
    }
    addSha(citation.commitSha);
  };
  const walk = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (/^(?:entityId|assertionId|assertionIds|observationId|observationIds)$/i.test(key || "")) addIdentifier(value);
      if (/^(?:path|oldPath)$/i.test(key || "")) addPath(value);
      if (/^(?:sha|commitSha|evidenceCommitSha)$/i.test(key || "")) addSha(value);
      if (/^(?:label|name|title|naturalKey)$/i.test(key || "")) labels.add(normalized(value));
      if (/^predicate$/i.test(key || "")) predicates.add(String(value).trim().toUpperCase());
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(value)) walk(entryValue, entryKey);
  };
  for (const citation of state.citations || []) addCitation(citation);
  for (const claim of state.citedClaims || []) for (const citation of claim.citations || []) addCitation(citation);
  for (const call of state.calls || []) {
    for (const item of call.items || []) {
      walk(item.data, "data");
      for (const citation of item.citations || []) addCitation(citation);
    }
  }

  const observationList = Array.from(observations);
  const shaList = Array.from(shas);
  const labelList = Array.from(labels);

  const evidenceMatches = (evidence: readonly string[] | undefined): boolean =>
    (evidence ?? []).some((value) => {
      const text = String(value);
      if (identifiers.has(text) || observationList.some((id) => text === id || text === `observation:${id}`))
        return true;
      const range = /^(.*):([0-9]+)(?:-([0-9]+))?$/.exec(text);
      if (!range || range[1] === undefined || !pathRanges.has(range[1])) return false;
      const start = Number.parseInt(range[2] ?? "", 10);
      const end = Number.parseInt(range[3] ?? range[2] ?? "", 10);
      return (pathRanges.get(range[1]) ?? []).some((citation) => start <= citation.end && end >= citation.start);
    });
  const nodeIds = new Set<string>();
  for (const node of graph.nodes || []) {
    const nodeLabel = normalized(node.label);
    const description = normalized(node.description);
    const pathMatch =
      typeof node.path === "string" && paths.has(node.path) && (node.kind === "File" || node.kind === "Document");
    const shaMatch = shaList.some((sha) =>
      [node.id, node.label, node.description].some((value) => {
        const candidate = normalized(value);
        return candidate.length >= 7 && (candidate.includes(sha) || sha.includes(candidate));
      })
    );
    const semanticMatch = labelList.some(
      (label) =>
        label.length >= 4 &&
        (nodeLabel === label || description === label || (label.length >= 8 && nodeLabel.includes(label)))
    );
    if (identifiers.has(node.id) || pathMatch || shaMatch || semanticMatch || evidenceMatches(node.evidence))
      nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges || []) {
    const endpointsMatch = nodeIds.has(edge.source) && nodeIds.has(edge.target);
    const predicateMatch =
      predicates.has(String(edge.predicate).toUpperCase()) && (nodeIds.has(edge.source) || nodeIds.has(edge.target));
    if (identifiers.has(edge.id) || evidenceMatches(edge.evidence) || endpointsMatch || predicateMatch) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    }
  }
  return [
    ...Array.from(nodeIds, (id): GraphSelection => ({ kind: "node", id })),
    ...Array.from(edgeIds, (id): GraphSelection => ({ kind: "edge", id }))
  ];
}

export function contextIssueTraceItem(state: ContextAskState): ContextCallItem | null {
  for (const call of state.calls || []) {
    for (const item of call.items || []) {
      if (item.kind === "issue_trace" && item.data && item.data.issue) return item;
    }
  }
  return null;
}

export function contextMatchConfidence(
  matches: readonly GraphSelection[],
  graph: VisibleGraph | null
): number | undefined {
  if (!graph) return undefined;
  const edgeIds = new Set(matches.filter((match) => match.kind === "edge").map((match) => match.id));
  const scores = (graph.edges || [])
    .filter((edge) => edgeIds.has(edge.id))
    .map((edge) => edge.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return scores.length ? scores.reduce((total, value) => total + value, 0) / scores.length : undefined;
}

export function citationLabels(citations: readonly ContextCitation[] | undefined): string[] {
  return (citations ?? []).map((citation) =>
    citation.path
      ? citation.path + (citation.startLine ? `:${citation.startLine}` : "")
      : `${citation.kind}:${citation.id}`
  );
}

export function contextPrimaryCitations(
  state: ContextAskState,
  item: ContextCallItem | null,
  trace: ContextItemData | undefined
): string[] {
  const citations: string[] = [];
  const seen = new Set<string>();
  const push = (label: string | undefined): void => {
    if (!label || seen.has(label) || citations.length >= 3) return;
    seen.add(label);
    citations.push(label);
  };
  const cause = trace?.introducedBy?.[0];
  const resolution = trace?.resolutions?.[0];
  if (cause?.sha) push(`commit ${cause.sha.slice(0, 12)}`);
  if (cause?.changes?.[0]) push(cause.changes[0].path);
  if (resolution?.pullRequestNumber) push(`PR #${resolution.pullRequestNumber}`);
  for (const label of citationLabels([...(item?.citations || []), ...(state.citations || [])])) push(label);
  return citations;
}

export function contextDateLabel(value: string | undefined): string {
  if (!value) return "First known change";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "First known change";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function contextPathLabel(path: string | undefined): string {
  if (!path) return "Code changed";
  const parts = String(path).split("/");
  return parts[parts.length - 1] || path;
}

export function isCausationQuestion(question: string | undefined): boolean {
  return /\b(caus(?:e|ed|ation|al)|introduc(?:e|ed|ing)|root cause|first (?:start|begin|appear))\b|when did[\s\S]{0,200}\b(?:start|begin|appear)/i.test(
    String(question || "")
  );
}

export type IssueTraceSection =
  | { readonly kind: "cause"; readonly value: TraceCommit }
  | { readonly kind: "resolution"; readonly value: TraceResolution };

export function issueTraceSections(trace: ContextItemData, question: string | undefined): IssueTraceSection[] {
  const causeSections: IssueTraceSection[] = (trace.introducedBy ?? []).map((commit) => ({
    kind: "cause",
    value: commit
  }));
  const resolutionSections: IssueTraceSection[] = (trace.resolutions ?? []).map((resolution) => ({
    kind: "resolution",
    value: resolution
  }));
  return isCausationQuestion(question)
    ? causeSections.concat(resolutionSections)
    : resolutionSections.concat(causeSections);
}

/**
 * Only https://github.com links may leave the dashboard; anything else is
 * rendered as plain text (matches the old externalLink helper).
 */
export function safeExternalUrl(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(url ?? "");
    if (parsed.protocol === "https:" && parsed.hostname === "github.com") return parsed.href;
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Assertion review helpers.                                           */
/* ------------------------------------------------------------------ */

/**
 * The API serves assertion summaries with flat subject/object fields
 * (subjectLabel, subjectKind, …). The scaffold's ContextGraphAssertion type
 * models the nested shape with an index signature, so this view normalizes
 * either representation for rendering.
 */
export interface AssertionView {
  readonly subjectLabel: string;
  readonly subjectKind: string;
  readonly objectLabel: string;
  readonly objectKind: string;
  readonly generator: string;
  readonly supportingAssertionIds: readonly string[];
  readonly contradictingAssertionIds: readonly string[];
}

function assertionString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assertionStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function assertionView(assertion: ContextGraphAssertion): AssertionView {
  const subject = assertion.subject as { readonly kind?: string; readonly label?: string } | undefined;
  const object = assertion.object as { readonly kind?: string; readonly label?: string } | undefined;
  return {
    subjectLabel: assertionString(assertion.subjectLabel) || subject?.label || "",
    subjectKind: assertionString(assertion.subjectKind) || subject?.kind || "",
    objectLabel: assertionString(assertion.objectLabel) || object?.label || "",
    objectKind: assertionString(assertion.objectKind) || object?.kind || "",
    generator: assertionString(assertion.generator),
    supportingAssertionIds: assertionStringList(assertion.supportingAssertionIds),
    contradictingAssertionIds: assertionStringList(assertion.contradictingAssertionIds)
  };
}

export const ASSERTION_REJECTION_CODES: readonly (readonly [string, string])[] = [
  ["", "Rejection category"],
  ["incorrect_relationship", "Incorrect relationship"],
  ["insufficient_evidence", "Insufficient evidence"],
  ["unsupported_explanation", "Unsupported explanation"],
  ["other", "Other"]
];
