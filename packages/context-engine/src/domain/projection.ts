import type { EvidenceAnchor, RefManifestEntry, StructuralFactKind } from "./evidence.js";
import type { KnowledgeDocumentKind } from "./knowledge.js";

export interface ContextDocument {
  id: string;
  generationId: string;
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  sourceKind: "code" | "provider" | "knowledge";
  sourceId: string;
  sourceRevisionId?: string;
  knowledgeKind?: KnowledgeDocumentKind;
  title: string;
  body: string;
  contextualText: string;
  metadata: Record<string, unknown>;
  authorityClass: string;
  effectiveAclFingerprint: string;
  sourceFingerprint: string;
  anchors: EvidenceAnchor[];
}

export interface ContextFragment {
  id: string;
  generationId: string;
  documentId: string;
  ordinal: number;
  sourceText: string;
  contextualText: string;
  startOffset: number;
  endOffset: number;
  anchors: EvidenceAnchor[];
  tokenFingerprint: string;
}

export interface ExactIndexEntry {
  generationId: string;
  term: string;
  documentId: string;
  field: "title" | "body" | "metadata";
}

export interface CurrentKnowledgeRevision {
  generationId: string;
  tenantId: string;
  repository: string;
  logicalId: string;
  revisionId: string;
  selectionReason: string;
}

export interface HierarchyNode {
  id: string;
  generationId: string;
  documentId: string;
  parentId?: string;
  title: string;
  summary: string;
  depth: number;
  preorderStart: number;
  preorderEnd: number;
  anchors: EvidenceAnchor[];
  adapterName: string;
  adapterVersion: string;
}

export interface StructuralRelation {
  id: string;
  generationId: string;
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  kind: StructuralFactKind;
  from: string;
  to: string;
  anchors: EvidenceAnchor[];
  metadata: Record<string, unknown>;
}

export interface GenerationCapabilities {
  sourceCompleteness: "complete" | "partial";
  derivedKnowledge: "available" | "partial" | "unavailable";
  hierarchy: "available" | "disabled" | "failed";
}

export interface IndexGeneration {
  id: string;
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  checkpointId: string;
  status: "building" | "published" | "failed";
  capabilities: GenerationCapabilities;
  fingerprint: string;
  createdAt: string;
  publishedAt?: string;
}

export interface GenerationProjection {
  generation: IndexGeneration;
  manifest: RefManifestEntry[];
  currentKnowledge: CurrentKnowledgeRevision[];
  documents: ContextDocument[];
  fragments: ContextFragment[];
  exactIndex: ExactIndexEntry[];
  hierarchyNodes: HierarchyNode[];
  structuralRelations: StructuralRelation[];
}
