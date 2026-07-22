export interface AdminGraphCitation {
  readonly kind?: string;
  readonly id?: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly commitSha?: string;
}

export interface AdminGraphCitedClaim {
  readonly text?: string;
  readonly citations?: readonly AdminGraphCitation[];
}

export interface AdminGraphQueryCallItem {
  readonly data?: unknown;
  readonly citations?: readonly AdminGraphCitation[];
}

export interface AdminGraphQueryCall {
  readonly items?: readonly AdminGraphQueryCallItem[];
}

export interface AdminGraphCoverageGap {
  readonly capability?: string;
  readonly message?: string;
}

export interface AdminGraphQueryResult {
  readonly error?: string;
  readonly question?: string;
  readonly answer?: string;
  readonly citations?: readonly AdminGraphCitation[];
  readonly citedClaims?: readonly AdminGraphCitedClaim[];
  readonly calls?: readonly AdminGraphQueryCall[];
  readonly counterfactual?: unknown;
  readonly unresolvedAmbiguities?: readonly string[];
  readonly coverageGaps?: readonly AdminGraphCoverageGap[];
}

interface QueryNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly description?: string;
  readonly path?: string;
  readonly evidence?: readonly string[];
}

interface QueryEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly predicate: string;
  readonly evidence?: readonly string[];
}

export interface GraphQueryMatch {
  readonly kind: "node" | "edge";
  readonly id: string;
}

export function parseGraphQuestion(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("question must be a string");
  const question = value.trim();
  if (!question) throw new TypeError("question is required");
  if (question.length > 4_000) throw new TypeError("question must be at most 4000 characters");
  return question;
}

export function graphQueryMatches(
  result: AdminGraphQueryResult | null,
  graph: { readonly nodes: readonly QueryNode[]; readonly edges: readonly QueryEdge[] }
): GraphQueryMatch[] {
  if (!result || result.error) return [];
  const identifiers = new Set<string>();
  const paths = new Set<string>();
  const shas = new Set<string>();
  const labels = new Set<string>();
  const predicates = new Set<string>();
  const normalize = (value: string | undefined): string =>
    String(value ?? "")
      .trim()
      .toLocaleLowerCase();
  const addCitation = (citation: AdminGraphCitation | undefined): void => {
    if (!citation) return;
    if (citation.id?.trim()) identifiers.add(citation.id.trim());
    if (citation.path?.trim()) paths.add(citation.path.trim());
    if (citation.commitSha && /^[a-f0-9]{7,40}$/i.test(citation.commitSha.trim())) {
      shas.add(citation.commitSha.trim().toLocaleLowerCase());
    }
  };
  const walk = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (/^(?:entityId|assertionId|assertionIds|observationId|observationIds)$/i.test(key)) {
        identifiers.add(value.trim());
      }
      if (/^(?:path|oldPath)$/i.test(key)) paths.add(value.trim());
      if (/^(?:sha|commitSha|evidenceCommitSha)$/i.test(key) && /^[a-f0-9]{7,40}$/i.test(value.trim())) {
        shas.add(value.trim().toLocaleLowerCase());
      }
      if (/^(?:label|name|title|naturalKey)$/i.test(key)) labels.add(normalize(value));
      if (/^predicate$/i.test(key)) predicates.add(value.trim().toUpperCase());
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(value)) walk(entryValue, entryKey);
  };

  for (const citation of result.citations ?? []) addCitation(citation);
  for (const claim of result.citedClaims ?? []) {
    for (const citation of claim.citations ?? []) addCitation(citation);
  }
  for (const call of result.calls ?? []) {
    for (const item of call.items ?? []) {
      walk(item.data, "data");
      for (const citation of item.citations ?? []) addCitation(citation);
    }
  }

  const evidenceMatches = (evidence: readonly string[] | undefined): boolean =>
    (evidence ?? []).some((item) =>
      [...identifiers, ...paths].some((candidate) => item === candidate || item.includes(candidate))
    );
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    const nodeLabel = normalize(node.label);
    const description = normalize(node.description);
    const pathMatch = Boolean(node.path && paths.has(node.path));
    const shaMatch = [...shas].some((sha) =>
      [node.id, node.label, node.description].some((value) => {
        const candidate = normalize(value);
        return candidate.length >= 7 && (candidate.includes(sha) || sha.includes(candidate));
      })
    );
    const semanticMatch = [...labels].some(
      (label) =>
        label.length >= 4 &&
        (nodeLabel === label || description === label || (label.length >= 8 && nodeLabel.includes(label)))
    );
    if (identifiers.has(node.id) || pathMatch || shaMatch || semanticMatch || evidenceMatches(node.evidence)) {
      nodeIds.add(node.id);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    const endpointsMatch = nodeIds.has(edge.source) && nodeIds.has(edge.target);
    const predicateMatch =
      predicates.has(edge.predicate.toUpperCase()) && (nodeIds.has(edge.source) || nodeIds.has(edge.target));
    if (identifiers.has(edge.id) || evidenceMatches(edge.evidence) || endpointsMatch || predicateMatch) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    }
  }
  return [
    ...graph.nodes
      .filter((node) => nodeIds.has(node.id))
      .map((node): GraphQueryMatch => ({ kind: "node", id: node.id })),
    ...graph.edges
      .filter((edge) => edgeIds.has(edge.id))
      .map((edge): GraphQueryMatch => ({ kind: "edge", id: edge.id }))
  ];
}

export function graphCitationLabel(citation: AdminGraphCitation): string {
  if (citation.path) {
    const line = citation.startLine
      ? `:${citation.startLine}${citation.endLine && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}`
      : "";
    return `${citation.path}${line}`;
  }
  if (citation.id) return citation.id;
  if (citation.commitSha) return citation.commitSha.slice(0, 12);
  return citation.kind || "cited evidence";
}
