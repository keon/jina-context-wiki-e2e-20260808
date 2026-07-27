import { stableId } from "../domain/fingerprint.js";
import type { ContextDocument, HierarchyNode } from "../domain/projection.js";
import type {
  HierarchyBuildDocument,
  HierarchyBuildInput,
  HierarchyBuildNode,
  HierarchyBuildResult,
  HierarchyIndexer,
  PageIndexClient
} from "../ports/hierarchy.js";

export const FALLBACK_HIERARCHY_VERSION = "heading-tree-v1";

function headingNodes(document: HierarchyBuildDocument): HierarchyBuildNode[] {
  const headings: { title: string; depth: number; line: number }[] = [];
  for (const [offset, line] of document.body.split(/\r?\n/).entries()) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match !== null) headings.push({ title: match[2]!, depth: match[1]!.length, line: offset + 1 });
  }
  if (headings.length === 0) headings.push({ title: document.title, depth: 1, line: 1 });
  const nodes: HierarchyBuildNode[] = [];
  const parents: { depth: number; id: string }[] = [];
  headings.forEach((heading, index) => {
    while (parents.length > 0 && parents[parents.length - 1]!.depth >= heading.depth) parents.pop();
    const externalId = stableId("hnx", { documentId: document.id, index, heading });
    nodes.push({
      externalId,
      documentId: document.id,
      ...(parents.at(-1)?.id === undefined ? {} : { parentExternalId: parents.at(-1)!.id }),
      title: heading.title,
      summary: heading.title,
      depth: heading.depth,
      preorderStart: index + 1,
      preorderEnd: index + 1,
      anchors: document.anchors
    });
    parents.push({ depth: heading.depth, id: externalId });
  });
  for (const node of nodes) {
    let parentId = node.parentExternalId;
    while (parentId !== undefined) {
      const parent = nodes.find((candidate) => candidate.externalId === parentId);
      if (parent === undefined) break;
      parent.preorderEnd = Math.max(parent.preorderEnd, node.preorderEnd);
      parentId = parent.parentExternalId;
    }
  }
  return nodes;
}

function validateHierarchyResult(input: HierarchyBuildInput, result: HierarchyBuildResult): void {
  if (result.nodes.length > input.limits.maxNodes) throw new Error("Hierarchy node limit exceeded");
  const documents = new Map(input.documents.map((document) => [document.id, document]));
  const externalIds = new Set(result.nodes.map((node) => node.externalId));
  if (externalIds.size !== result.nodes.length) throw new Error("Hierarchy returned duplicate node IDs");
  for (const node of result.nodes) {
    const document = documents.get(node.documentId);
    if (document === undefined) throw new Error("Hierarchy node references an unknown document");
    if (node.parentExternalId !== undefined && !externalIds.has(node.parentExternalId)) {
      throw new Error("Hierarchy node references an unknown parent");
    }
    if (node.preorderEnd < node.preorderStart || node.depth < 1) throw new Error("Hierarchy node interval is invalid");
    if (node.anchors.length === 0) throw new Error("Hierarchy leaf has no source anchor");
    for (const anchor of node.anchors) {
      if (
        !document.anchors.some(
          (allowed) =>
            allowed.tenantId === anchor.tenantId &&
            allowed.repository === anchor.repository &&
            allowed.sourceType === anchor.sourceType &&
            allowed.sourceId === anchor.sourceId &&
            allowed.contentDigest === anchor.contentDigest
        )
      ) {
        throw new Error("Hierarchy node anchor is outside the supplied source");
      }
    }
  }
}

export class FallbackHierarchyIndexer implements HierarchyIndexer {
  async probe(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async build(input: HierarchyBuildInput): Promise<HierarchyBuildResult> {
    const nodes = input.documents.flatMap(headingNodes);
    const result = {
      adapterName: "fallback-heading-tree",
      adapterVersion: FALLBACK_HIERARCHY_VERSION,
      nodes,
      diagnostics: []
    };
    validateHierarchyResult(input, result);
    return result;
  }
}

export class PageIndexHierarchyAdapter implements HierarchyIndexer {
  constructor(private readonly client: PageIndexClient) {}

  probe(): Promise<{ available: boolean; reason?: string }> {
    return this.client.probe();
  }

  async build(input: HierarchyBuildInput): Promise<HierarchyBuildResult> {
    const oversized = input.documents.find((document) => document.body.length > input.limits.maxDocumentCharacters);
    if (oversized !== undefined) throw new Error(`Hierarchy document exceeds size limit: ${oversized.id}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.limits.timeoutMs);
    try {
      const result = await this.client.build(input, controller.signal);
      validateHierarchyResult(input, result);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function materializeHierarchyNodes(generationId: string, result: HierarchyBuildResult): HierarchyNode[] {
  const idMap = new Map(
    result.nodes.map((node) => [
      node.externalId,
      stableId("hn", { generationId, adapterName: result.adapterName, externalId: node.externalId })
    ])
  );
  return result.nodes.map((node) => ({
    id: idMap.get(node.externalId)!,
    generationId,
    documentId: node.documentId,
    ...(node.parentExternalId === undefined ? {} : { parentId: idMap.get(node.parentExternalId)! }),
    title: node.title,
    summary: node.summary,
    depth: node.depth,
    preorderStart: node.preorderStart,
    preorderEnd: node.preorderEnd,
    anchors: node.anchors,
    adapterName: result.adapterName,
    adapterVersion: result.adapterVersion
  }));
}

export function hierarchyEligibleDocuments(documents: ContextDocument[]): ContextDocument[] {
  return documents.filter(
    (document) =>
      document.sourceKind === "knowledge" ||
      document.body.length >= 4_000 ||
      /(?:readme|adr|rfc|runbook|incident|manual|architecture)/i.test(document.title)
  );
}
