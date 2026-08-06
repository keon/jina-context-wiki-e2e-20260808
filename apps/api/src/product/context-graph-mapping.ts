import type { GraphCitation, GraphDetail, GraphEdge, GraphNode, GraphQueryResult, GraphSummary } from "./graph-client.js";

/**
 * Shapes the context engine's responses into the two-plane graph the dashboard
 * already renders. The engine has no node collection: `/wiki/structure`
 * returns an edge list over `from`/`to` strings, and knowledge lives in cited
 * documents. Nodes are therefore synthesized here, files and symbols forming the
 * code plane and documents the knowledge plane, linked to the files they cite.
 */

export interface ContextEvidenceAnchor {
  sourceType: string;
  sourceId: string;
  commitSha?: string;
  pathOrUrl?: string;
  startLine?: number;
  endLine?: number;
}

export interface ContextGeneration {
  id: string;
  repository: string;
  ref: string;
  commitSha: string;
  status: string;
  derivedKnowledge: string;
  createdAt: string;
  publishedAt?: string;
}

export interface ContextStructuralRelation {
  id: string;
  kind: string;
  from: string;
  to: string;
  anchors?: ContextEvidenceAnchor[];
  metadata?: { symbol?: { name?: string; kind?: string }; importedNames?: string[] };
}

export interface ContextKnowledgeSummary {
  id: string;
  logicalId: string;
  kind: string;
  title: string;
  summary: string;
  confidence: number;
  reviewStatus: string;
  commitSha: string;
}

export interface ContextKnowledgeCitation { revisionId: string; ordinal: number; claim: string; anchor: ContextEvidenceAnchor }

interface ContextQueryCitation {
  id: string;
  title: string;
  excerpt: string;
  anchors?: ContextEvidenceAnchor[];
  sourceKind?: string;
  sourceId?: string;
}

export interface ContextQueryResponse {
  answer: string;
  generation: { id: string; ref: string; commitSha: string; derivedKnowledge: string };
  citations?: ContextQueryCitation[];
  conflicts?: { subject: string; description: string }[];
  ambiguities?: string[];
  coverage?: { status: string; missing?: string[] };
}

/** Renders an anchor the way the inspector already displays evidence strings. */
export function formatAnchor(anchor: ContextEvidenceAnchor): string {
  const location = anchor.pathOrUrl ?? `${anchor.sourceType}:${anchor.sourceId}`;
  const lines =
    anchor.startLine !== undefined && anchor.endLine !== undefined ? `:${anchor.startLine}-${anchor.endLine}` : "";
  return anchor.commitSha ? `${location}${lines}@${anchor.commitSha.slice(0, 7)}` : `${location}${lines}`;
}

const symbolSeparator = "#";

/** `src/a.ts#createServer` describes a symbol; anything else is treated as a file. */
function isSymbolReference(reference: string): boolean {
  return reference.includes(symbolSeparator);
}

/** Import specifiers are unresolved, so they are neither files nor symbols. */
function isModuleSpecifier(reference: string): boolean {
  return !isSymbolReference(reference) && !reference.includes("/") && !reference.includes(".");
}

function nodeLabel(reference: string): string {
  if (isSymbolReference(reference)) return reference.slice(reference.indexOf(symbolSeparator) + 1);
  const segments = reference.split("/");
  return segments[segments.length - 1] || reference;
}

function nodeKind(reference: string, relation?: ContextStructuralRelation): string {
  if (isSymbolReference(reference)) {
    const declared = relation?.metadata?.symbol?.kind;
    return declared ? `Symbol:${declared}` : "Symbol";
  }
  if (isModuleSpecifier(reference)) return "Module";
  return "File";
}

function filePathOf(reference: string): string | undefined {
  if (isModuleSpecifier(reference)) return undefined;
  return isSymbolReference(reference) ? reference.slice(0, reference.indexOf(symbolSeparator)) : reference;
}

/** Builds the code plane: file and symbol nodes joined by structural relations. */
export function codePlaneFromRelations(relations: readonly ContextStructuralRelation[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const ensureNode = (reference: string, relation: ContextStructuralRelation) => {
    const existing = nodes.get(reference);
    const evidence = (relation.anchors ?? []).map(formatAnchor);
    if (existing) {
      for (const entry of evidence) if (!existing.evidence.includes(entry)) existing.evidence.push(entry);
      return;
    }
    const path = filePathOf(reference);
    nodes.set(reference, {
      id: reference,
      kind: nodeKind(reference, relation),
      label: nodeLabel(reference),
      description: isSymbolReference(reference) && path ? `Declared in ${path}` : reference,
      ...(path ? { path } : {}),
      evidence
    });
  };

  for (const relation of relations) {
    ensureNode(relation.from, relation);
    ensureNode(relation.to, relation);
    edges.push({
      id: relation.id,
      source: relation.from,
      target: relation.to,
      predicate: relation.kind,
      plane: "code",
      evidence: (relation.anchors ?? []).map(formatAnchor),
      ...(relation.metadata?.importedNames?.length
        ? { qualifiers: { importedNames: relation.metadata.importedNames.join(", ") } }
        : {})
    });
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * Builds the knowledge plane. Each document becomes a node, and every citation
 * anchoring to a path already present in the code plane becomes an edge, which is
 * what lets the renderer colour knowledge links distinctly from code links.
 */
export function knowledgePlaneFromDocuments(
  documents: readonly ContextKnowledgeSummary[],
  citationsByRevision: ReadonlyMap<string, readonly ContextKnowledgeCitation[]>,
  codeNodeIds: ReadonlySet<string>
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const document of documents) {
    const citations = citationsByRevision.get(document.id) ?? [];
    nodes.push({
      id: document.id,
      kind: document.kind,
      label: document.title,
      description: document.summary,
      evidence: citations.map((citation) => formatAnchor(citation.anchor))
    });

    const linked = new Set<string>();
    for (const citation of citations) {
      const target = citation.anchor.pathOrUrl;
      if (!target || linked.has(target) || !codeNodeIds.has(target)) continue;
      linked.add(target);
      edges.push({
        id: `${document.id}:${citation.ordinal}`,
        source: document.id,
        target,
        predicate: "cites",
        plane: "knowledge",
        confidence: document.confidence,
        qualifiers: { reviewStatus: document.reviewStatus, ordinal: citation.ordinal },
        why: citation.claim,
        evidence: [formatAnchor(citation.anchor)]
      });
    }
  }

  return { nodes, edges };
}

export function generationToSummary(
  generation: ContextGeneration,
  counts: { nodeCount: number; edgeCount: number }
): GraphSummary {
  return {
    id: generation.id,
    repository: generation.repository,
    versionLabel: `${generation.ref}@${generation.commitSha.slice(0, 7)}`,
    sourceCommit: generation.commitSha,
    generatedAt: generation.publishedAt ?? generation.createdAt,
    summary: `${generation.status} generation with ${generation.derivedKnowledge} derived knowledge`,
    nodeCount: counts.nodeCount,
    edgeCount: counts.edgeCount
  };
}

/** Assembles both planes into the detail shape the dashboard already renders. */
export function contextGraphDetail(input: {
  generation: ContextGeneration;
  relations: readonly ContextStructuralRelation[];
  documents: readonly ContextKnowledgeSummary[];
  citationsByRevision: ReadonlyMap<string, readonly ContextKnowledgeCitation[]>;
}): GraphDetail {
  const code = codePlaneFromRelations(input.relations);
  const knowledge = knowledgePlaneFromDocuments(
    input.documents,
    input.citationsByRevision,
    new Set(code.nodes.map((node) => node.id))
  );
  const nodes = [...code.nodes, ...knowledge.nodes];
  const edges = [...code.edges, ...knowledge.edges];
  return { ...generationToSummary(input.generation, { nodeCount: nodes.length, edgeCount: edges.length }), nodes, edges };
}

function citationKind(citation: ContextQueryCitation): GraphCitation["kind"] {
  const sourceType = citation.anchors?.[0]?.sourceType;
  if (sourceType === "commit") return "commit_change";
  if (sourceType === "document") return "assertion";
  if (sourceType === "observation") return "observation";
  if (citation.sourceKind === "knowledge") return "assertion";
  return "code";
}

function toGraphCitation(repository: string, citation: ContextQueryCitation): GraphCitation {
  const anchor = citation.anchors?.[0];
  return {
    kind: citationKind(citation),
    id: citation.id,
    repository,
    ...(anchor?.commitSha ? { commitSha: anchor.commitSha } : {}),
    ...(anchor?.pathOrUrl ? { path: anchor.pathOrUrl } : {}),
    ...(anchor?.startLine !== undefined ? { startLine: anchor.startLine } : {}),
    ...(anchor?.endLine !== undefined ? { endLine: anchor.endLine } : {})
  };
}

/**
 * Maps a context query onto the answer shape the dashboard renders. Highlights
 * are derived from citation anchors so the viewport can still emphasise the parts
 * of the graph an answer rests on.
 */
export function contextQueryResult(repository: string, response: ContextQueryResponse): GraphQueryResult {
  const citations = response.citations ?? [];
  const notes = [
    ...(response.ambiguities ?? []),
    ...(response.coverage?.missing ?? []).map((missing) => `Coverage gap: ${missing}`),
    ...(response.conflicts ?? []).map((conflict) => `Conflict on ${conflict.subject}: ${conflict.description}`)
  ];
  const highlightedNodeIds = [
    ...new Set(citations.flatMap((citation) => (citation.anchors ?? []).map((anchor) => anchor.pathOrUrl ?? "")))
  ].filter((value) => value !== "");

  return {
    graphId: response.generation.id,
    answer: response.answer,
    claims: citations.map((citation) => ({
      text: citation.excerpt || citation.title,
      citations: [toGraphCitation(repository, citation)]
    })),
    highlightedNodeIds,
    highlightedEdgeIds: [],
    incomplete: (response.coverage?.status ?? "complete") !== "complete",
    notes
  };
}
