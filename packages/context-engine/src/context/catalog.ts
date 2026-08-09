import type { EvidenceAnchor } from "../domain/evidence.js";
import type { KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import type {
  ContextDocument,
  ContextFragment,
  GenerationProjection,
  HierarchyNode,
  IndexGeneration
} from "../domain/projection.js";
import { tokenizeContext } from "../index/lexical.js";
import type { ContextEngineStore } from "../ports/context-engine-store.js";

export interface ContextReleaseRef {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly completeness: "complete" | "partial";
  readonly contextStatus: "available" | "partial" | "unavailable";
}

export interface ContextCitation {
  readonly claim: string;
  readonly citationId?: string;
  readonly claimSpan?: string;
  readonly anchor: EvidenceAnchor;
}

export interface ContextDocumentSummary {
  readonly id: string;
  readonly logicalId: string;
  readonly revisionId: string;
  readonly kind?: string;
  readonly title: string;
  readonly summary: string;
  readonly citations: readonly ContextCitation[];
}

export interface ContextTreeNode {
  readonly id: string;
  readonly documentId: string;
  readonly parentId?: string;
  readonly title: string;
  readonly summary: string;
  readonly depth: number;
  readonly children: readonly ContextTreeNode[];
}

export interface ContextSearchSelectionInput {
  readonly repository: string;
  readonly release: ContextReleaseRef;
  readonly query: string;
  readonly tree: readonly {
    readonly id: string;
    readonly documentId: string;
    readonly parentId?: string;
    readonly title: string;
    readonly summary: string;
    readonly depth: number;
  }[];
  readonly limit: number;
}

export interface ContextSearchSelection {
  readonly nodeIds: readonly string[];
  readonly rationale?: string;
}

export interface ContextSearchResult {
  readonly documentId: string;
  readonly logicalId: string;
  readonly revisionId: string;
  readonly title: string;
  readonly score: number;
  readonly selectedNodeIds: readonly string[];
  readonly excerpts: readonly string[];
  readonly citations: readonly ContextCitation[];
}

export interface ContextSearchResponse {
  readonly release: ContextReleaseRef;
  readonly query: string;
  readonly results: readonly ContextSearchResult[];
  readonly retrieval: {
    readonly method: "lexical_tree";
    readonly selector: string;
    readonly degradedReason?: string;
  };
}

export interface ContextSearchExecution {
  readonly context: ContextSearchResponse;
  readonly selector: {
    readonly configured: boolean;
    readonly attempted: boolean;
    readonly modelUsageObserved: boolean;
  };
}

interface AccessInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly repository: string;
  readonly ref?: string;
  readonly releaseId?: string;
  readonly tenantAdmin?: boolean;
}

function publicRelease(generation: IndexGeneration): ContextReleaseRef {
  return {
    id: generation.id,
    repository: generation.repository,
    ref: generation.ref,
    commitSha: generation.commitSha,
    createdAt: generation.createdAt,
    ...(generation.publishedAt === undefined ? {} : { publishedAt: generation.publishedAt }),
    completeness: generation.capabilities.sourceCompleteness,
    contextStatus: generation.capabilities.derivedKnowledge
  };
}

function derivedDocuments(projection: GenerationProjection): ContextDocument[] {
  return projection.documents.filter(
    (document): document is ContextDocument & { sourceRevisionId: string } =>
      document.sourceKind === "knowledge" && document.sourceRevisionId !== undefined
  );
}

function documentSummary(document: ContextDocument): string {
  const contextualSummary = document.contextualText.split(/\r?\n/, 1)[0]?.trim();
  return (
    contextualSummary ||
    document.body
      .split(/\n\s*\n/, 1)[0]
      ?.replace(/^#+\s*/, "")
      .trim() ||
    document.title
  );
}

function treeNodes(projection: GenerationProjection, documents: readonly ContextDocument[]): ContextTreeNode[] {
  const allowed = new Set(documents.map((document) => document.id));
  const flat = projection.hierarchyNodes
    .filter((node) => allowed.has(node.documentId))
    .sort((left, right) => left.preorderStart - right.preorderStart || left.id.localeCompare(right.id));
  const byParent = new Map<string | undefined, HierarchyNode[]>();
  for (const node of flat) {
    const parentId =
      node.parentId && flat.some((candidate) => candidate.id === node.parentId) ? node.parentId : undefined;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }
  const materialize = (node: HierarchyNode): ContextTreeNode => ({
    id: node.id,
    documentId: node.documentId,
    ...(node.parentId && flat.some((candidate) => candidate.id === node.parentId) ? { parentId: node.parentId } : {}),
    title: node.title,
    summary: node.summary,
    depth: node.depth,
    children: (byParent.get(node.id) ?? []).map(materialize)
  });
  return (byParent.get(undefined) ?? []).map(materialize);
}

function flattenTree(nodes: readonly ContextTreeNode[]): ContextSearchSelectionInput["tree"] {
  return nodes.flatMap((node) => [
    {
      id: node.id,
      documentId: node.documentId,
      ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
      title: node.title,
      summary: node.summary,
      depth: node.depth
    },
    ...flattenTree(node.children)
  ]);
}

function tokenScore(queryTokens: readonly string[], value: string): number {
  if (queryTokens.length === 0) return 0;
  const terms = new Set(tokenizeContext(value));
  return queryTokens.reduce((score, token) => score + (terms.has(token) ? 1 : 0), 0) / queryTokens.length;
}

export function selectContextTreeLexically(
  query: string,
  tree: ContextSearchSelectionInput["tree"],
  documents: readonly ContextDocument[],
  limit: number
): ContextSearchSelection {
  const queryTokens = tokenizeContext(query);
  const documentById = new Map(documents.map((document) => [document.id, document]));
  return {
    nodeIds: tree
      .map((node) => {
        const document = documentById.get(node.documentId);
        return {
          id: node.id,
          score: tokenScore(
            queryTokens,
            `${node.title}\n${node.summary}\n${document?.title ?? ""}\n${document?.contextualText ?? ""}`
          )
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((candidate) => candidate.id)
  };
}

function bestExcerpts(
  query: string,
  document: ContextDocument,
  fragments: readonly ContextFragment[],
  limit = 3
): { excerpts: string[]; score: number } {
  const tokens = tokenizeContext(query);
  const candidates = fragments
    .filter((fragment) => fragment.documentId === document.id)
    .map((fragment) => ({
      text: fragment.sourceText,
      score: tokenScore(tokens, `${fragment.sourceText}\n${fragment.contextualText}`)
    }))
    .sort((left, right) => right.score - left.score);
  const selected = candidates.slice(0, limit);
  return {
    excerpts: selected.map((candidate) => candidate.text),
    score: selected[0]?.score ?? tokenScore(tokens, `${document.title}\n${document.contextualText}`)
  };
}

export class ContextCatalogService {
  constructor(private readonly store: ContextEngineStore) {}

  async listReleases(input: Omit<AccessInput, "ref" | "releaseId">): Promise<ContextReleaseRef[]> {
    const generations = await this.store.listGenerations(input.tenantId, input.repository);
    const published = generations.filter((candidate) => candidate.status === "published");
    // Release cards contain generation metadata only. Hydrating every document,
    // fragment, hierarchy node, and citation merely to authorize that metadata
    // made the dashboard cost grow with the entire release history.
    const authorized =
      input.tenantAdmin ||
      (await this.store.aclFingerprintsForPrincipal(input.tenantId, input.principalId, input.repository)).length > 0;
    if (!authorized) return [];
    // Preserve store order. PostgreSQL places the highest sequence for each ref
    // before its history; re-sorting by preparation time could make an older
    // release look current to API clients that select the first release.
    return published.map(publicRelease);
  }

  async listContext(input: AccessInput): Promise<{
    release: ContextReleaseRef;
    documents: ContextDocumentSummary[];
    tree: ContextTreeNode[];
  }> {
    const projection = await this.resolveProjection(input);
    const documents = derivedDocuments(projection);
    return {
      release: publicRelease(projection.generation),
      documents: await this.summaries(documents),
      tree: treeNodes(projection, documents)
    };
  }

  async readContext(
    input: AccessInput & { readonly document: string }
  ): Promise<{ release: ContextReleaseRef; document: ContextDocumentSummary & { bodyMarkdown: string } }> {
    const projection = await this.resolveProjection(input);
    const document = derivedDocuments(projection).find(
      (candidate) =>
        candidate.id === input.document ||
        candidate.sourceId === input.document ||
        candidate.sourceRevisionId === input.document
    );
    if (!document) throw new Error("context document not found");
    return {
      release: publicRelease(projection.generation),
      document: { ...(await this.summary(document)), bodyMarkdown: document.body }
    };
  }

  async searchContext(
    input: AccessInput & { readonly query: string; readonly limit?: number }
  ): Promise<ContextSearchResponse> {
    return (await this.searchContextExecution(input)).context;
  }

  async searchContextExecution(
    input: AccessInput & { readonly query: string; readonly limit?: number }
  ): Promise<ContextSearchExecution> {
    const projection = await this.resolveProjection(input);
    const documents = derivedDocuments(projection);
    const roots = treeNodes(projection, documents);
    const tree = flattenTree(roots);
    const limit = Math.max(1, Math.min(input.limit ?? 8, 25));
    const selection = selectContextTreeLexically(input.query, tree, documents, limit);
    const selectorExecution: ContextSearchExecution["selector"] = {
      configured: false,
      attempted: false,
      modelUsageObserved: false
    };
    const validNodes = new Map(tree.map((node) => [node.id, node]));
    // PageIndex titles and summaries are intentionally concise, so selecting
    // solely from the tree can miss the exact page whose body answers a
    // natural-language query. Rank bounded document fragments as a second
    // deterministic signal, then project those matches back onto their
    // PageIndex nodes. This preserves the hierarchy/ACL boundary while making
    // Search and deterministic Ask use the content the wiki actually wrote.
    const bodyMatchedNodeIds = documents
      .map((document) => ({
        document,
        score: bestExcerpts(input.query, document, projection.fragments, 1).score
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.document.sourceId.localeCompare(right.document.sourceId))
      .map(({ document }) => tree.find((node) => node.documentId === document.id)?.id)
      .filter((id): id is string => id !== undefined);
    const selectedNodeIds = [...new Set([...selection.nodeIds, ...bodyMatchedNodeIds])].filter((id) =>
      validNodes.has(id)
    );
    const selectedByDocument = new Map<string, string[]>();
    for (const nodeId of selectedNodeIds) {
      const documentId = validNodes.get(nodeId)!.documentId;
      selectedByDocument.set(documentId, [...(selectedByDocument.get(documentId) ?? []), nodeId]);
    }
    const selected = [...selectedByDocument.entries()].map(([documentId, nodeIds]) => ({
      document: documents.find((candidate) => candidate.id === documentId)!,
      nodeIds
    }));
    const summaries = await this.summaries(selected.map(({ document }) => document));
    const results = selected.map(({ document, nodeIds }, index) => {
      const excerpt = bestExcerpts(input.query, document, projection.fragments);
      return {
        documentId: document.id,
        logicalId: document.sourceId,
        revisionId: document.sourceRevisionId!,
        title: document.title,
        score: excerpt.score,
        selectedNodeIds: nodeIds,
        excerpts: excerpt.excerpts,
        citations: summaries[index]!.citations
      };
    });
    results.sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId));
    return {
      context: {
        release: publicRelease(projection.generation),
        query: input.query,
        results: results.slice(0, limit),
        retrieval: {
          method: "lexical_tree",
          selector: "pageindex-lexical-tree-v1"
        }
      },
      selector: selectorExecution
    };
  }

  async diffContext(
    input: Omit<AccessInput, "releaseId"> & { readonly fromReleaseId: string; readonly toReleaseId: string }
  ): Promise<{
    from: ContextReleaseRef;
    to: ContextReleaseRef;
    added: ContextDocumentSummary[];
    removed: ContextDocumentSummary[];
    changed: { before: ContextDocumentSummary; after: ContextDocumentSummary }[];
    unchanged: string[];
  }> {
    const [from, to] = await Promise.all([
      this.resolveProjection({ ...input, releaseId: input.fromReleaseId }),
      this.resolveProjection({ ...input, releaseId: input.toReleaseId })
    ]);
    const before = new Map(derivedDocuments(from).map((document) => [document.sourceId, document]));
    const after = new Map(derivedDocuments(to).map((document) => [document.sourceId, document]));
    const addedDocuments = [...after.entries()].filter(([id]) => !before.has(id)).map(([, document]) => document);
    const removedDocuments = [...before.entries()].filter(([id]) => !after.has(id)).map(([, document]) => document);
    const changedDocuments = [...after.entries()]
      .filter(([id, document]) => {
        const prior = before.get(id);
        return prior !== undefined && prior.sourceFingerprint !== document.sourceFingerprint;
      })
      .map(([id, document]) => ({ before: before.get(id)!, after: document }));
    const allSummaries = await this.summaries([
      ...addedDocuments,
      ...removedDocuments,
      ...changedDocuments.flatMap((documents) => [documents.before, documents.after])
    ]);
    const added = allSummaries.slice(0, addedDocuments.length);
    const removedOffset = addedDocuments.length;
    const removed = allSummaries.slice(removedOffset, removedOffset + removedDocuments.length);
    const changedOffset = removedOffset + removedDocuments.length;
    const changed = changedDocuments.map((_, index) => ({
      before: allSummaries[changedOffset + index * 2]!,
      after: allSummaries[changedOffset + index * 2 + 1]!
    }));
    const unchanged = [...after.entries()]
      .filter(([id, document]) => before.get(id)?.sourceFingerprint === document.sourceFingerprint)
      .map(([id]) => id)
      .sort();
    return {
      from: publicRelease(from.generation),
      to: publicRelease(to.generation),
      added,
      removed,
      changed,
      unchanged
    };
  }

  private async summary(document: ContextDocument & { sourceRevisionId?: string }): Promise<ContextDocumentSummary> {
    return (await this.summaries([document]))[0]!;
  }

  private async summaries(
    documents: readonly (ContextDocument & { sourceRevisionId?: string })[]
  ): Promise<ContextDocumentSummary[]> {
    const revisionIds = documents.map((document) => {
      if (!document.sourceRevisionId) throw new Error("derived context document is missing its revision");
      return document.sourceRevisionId;
    });
    const citationsByRevision = await this.store.listCitationsForRevisions(revisionIds);
    return documents.map((document, index) =>
      contextDocumentSummary(document, citationsByRevision.get(revisionIds[index]!) ?? [])
    );
  }

  private async resolveProjection(input: AccessInput): Promise<GenerationProjection> {
    if (input.releaseId) {
      const projection = await this.authorizedProjection(input, input.releaseId);
      if (
        !projection ||
        projection.generation.tenantId !== input.tenantId ||
        projection.generation.repository !== input.repository ||
        projection.generation.status !== "published"
      ) {
        throw new Error("published context release not found");
      }
      return projection;
    }
    const ref = input.ref ?? "main";
    const generations = await this.store.listGenerations(input.tenantId, input.repository);
    for (const generation of generations) {
      if (generation.status !== "published" || generation.ref !== ref) continue;
      const projection = await this.authorizedProjection(input, generation.id);
      if (projection) return projection;
    }
    throw new Error("published context release not found");
  }

  private authorizedProjection(input: AccessInput, generationId: string): Promise<GenerationProjection | undefined> {
    return input.tenantAdmin
      ? this.store.getGeneration(generationId)
      : this.store.getAuthorizedGeneration(generationId, input.principalId);
  }
}

function contextDocumentSummary(
  document: ContextDocument & { sourceRevisionId?: string },
  citations: readonly KnowledgeEvidenceCitation[]
): ContextDocumentSummary {
  if (!document.sourceRevisionId) throw new Error("derived context document is missing its revision");
  return {
    id: document.id,
    logicalId: document.sourceId,
    revisionId: document.sourceRevisionId,
    ...(document.knowledgeKind === undefined ? {} : { kind: document.knowledgeKind }),
    title: document.title,
    summary: documentSummary(document),
    citations: citations.map((citation) => ({
      claim: citation.claim,
      ...(citation.citationId === undefined ? {} : { citationId: citation.citationId }),
      ...(citation.claimSpan === undefined ? {} : { claimSpan: citation.claimSpan }),
      anchor: citation.anchor
    }))
  };
}
