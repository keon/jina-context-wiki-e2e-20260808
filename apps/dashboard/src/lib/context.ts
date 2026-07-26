import type {
  ContextCitation,
  ContextGeneration,
  ContextProjector,
  KnowledgeDocumentSummary,
  QueryCitation,
  StructuralRelation
} from "./types.ts";

export interface ContextScope {
  readonly repository: string;
  readonly ref: string;
}

export interface StructureEntry {
  readonly id: string;
  readonly depth: number;
  readonly label: string;
  readonly path: string;
  readonly kind: "directory" | "file" | "symbol" | "relation";
  readonly detail?: string;
}

export function publishedGenerations(generations: readonly ContextGeneration[]): readonly ContextGeneration[] {
  return [...generations]
    .filter((generation) => generation.status === "published" || Boolean(generation.publishedAt))
    .sort((left, right) => (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt));
}

export function contextScopes(generations: readonly ContextGeneration[]): readonly ContextScope[] {
  const seen = new Set<string>();
  const scopes: ContextScope[] = [];
  for (const generation of publishedGenerations(generations)) {
    const key = `${generation.repository}\0${generation.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ repository: generation.repository, ref: generation.ref });
  }
  return scopes;
}

export function generationForScope(
  generations: readonly ContextGeneration[],
  repository: string,
  ref: string
): ContextGeneration | undefined {
  return publishedGenerations(generations).find(
    (generation) => generation.repository === repository && generation.ref === ref
  );
}

export function projectorRows(generation: ContextGeneration | undefined): readonly ContextProjector[] {
  if (!generation) return [];
  const projectors = generation.projectors;
  if (Array.isArray(projectors)) return projectors as readonly ContextProjector[];
  return Object.entries(projectors as Readonly<Record<string, string>>).map(([name, status]) => ({ name, status }));
}

export function citationLocation(citation: ContextCitation): string {
  const anchor = citation.pathOrUrl ?? citation.sourceId;
  if (citation.startLine === undefined) return anchor;
  return `${anchor}:${citation.startLine}${citation.endLine === undefined ? "" : `-${citation.endLine}`}`;
}

export function safeSourceUrl(citation: ContextCitation): string | undefined {
  const candidate = citation.url ?? (citation.pathOrUrl?.startsWith("https://") ? citation.pathOrUrl : undefined);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function queryCitationAnchors(
  citations: readonly QueryCitation[]
): readonly (ContextCitation & { readonly sourceKind: QueryCitation["sourceKind"] })[] {
  return citations.flatMap((citation) =>
    citation.anchors.map((anchor, anchorIndex) => ({
      ...anchor,
      id: `${citation.id}:${anchorIndex}`,
      excerpt: citation.excerpt,
      sourceKind: citation.sourceKind
    }))
  );
}

export function shortDigest(value: string | undefined): string {
  if (!value) return "not supplied";
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function documentsForScope(
  documents: readonly KnowledgeDocumentSummary[],
  repository: string
): readonly KnowledgeDocumentSummary[] {
  return documents
    .filter((document) => !repository || document.repository === repository)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function reviewableDocument(document: KnowledgeDocumentSummary): boolean {
  return !["reviewed", "accepted", "rejected", "invalidated", "redacted"].includes(document.reviewStatus.toLowerCase());
}

export function structureEntries(
  relations: readonly StructuralRelation[],
  citations: readonly ContextCitation[] = []
): readonly StructureEntry[] {
  const paths = new Set<string>();
  for (const citation of citations) {
    if (citation.pathOrUrl && !citation.pathOrUrl.includes("://")) paths.add(citation.pathOrUrl);
  }
  for (const relation of relations) {
    for (const candidate of [relation.from, relation.to]) {
      if (candidate.includes("/") && !candidate.includes("://")) paths.add(candidate);
    }
    for (const citation of relation.anchors) {
      if (citation.pathOrUrl && !citation.pathOrUrl.includes("://")) paths.add(citation.pathOrUrl);
    }
  }

  const entries = new Map<string, StructureEntry>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const current = parts.slice(0, index + 1).join("/");
      const isLeaf = index === parts.length - 1 && /\.[a-z0-9]+$/i.test(parts[index]!);
      entries.set(`path:${current}`, {
        id: `path:${current}`,
        depth: index,
        label: parts[index]!,
        path: current,
        kind: isLeaf ? "file" : "directory"
      });
    }
  }
  for (const relation of relations) {
    const id = `relation:${relation.kind}:${relation.from}:${relation.to}`;
    entries.set(id, {
      id,
      depth: 0,
      label: relation.from,
      path: relation.from,
      kind: "relation",
      detail: `${relation.kind} → ${relation.to}`
    });
  }
  return [...entries.values()].sort((left, right) => {
    if (left.kind === "relation" && right.kind !== "relation") return 1;
    if (left.kind !== "relation" && right.kind === "relation") return -1;
    return left.path.localeCompare(right.path) || left.depth - right.depth;
  });
}

export function matchesStructure(entry: StructureEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${entry.path} ${entry.detail ?? ""}`.toLowerCase().includes(needle);
}
