import type { EvidenceAnchor, RefManifestEntry, StructuralFactKind } from "./evidence.js";
import type { KnowledgeDocumentKind } from "./knowledge.js";

export const contextProjectionConsumers = [
  "manifest",
  "knowledge-current",
  "lexical",
  "dense",
  "hierarchy",
  "structural",
  "identity",
  "acl",
  "retention"
] as const;

export type ContextProjectionConsumer = (typeof contextProjectionConsumers)[number];
export type ProjectorStatus = "ready" | "disabled" | "skipped" | "failed";

export interface ContextOutboxEvent {
  id: string;
  sequence: number;
  tenantId: string;
  repository: string;
  aggregateType: "evidence" | "knowledge" | "access" | "retention";
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  consumers: ContextProjectionConsumer[];
  occurredAt: string;
}

export interface ContextOutboxDelivery {
  event: ContextOutboxEvent;
  consumer: ContextProjectionConsumer;
  status: "available" | "leased" | "processed";
  attempt: number;
  availableAt: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  processedAt?: string;
}

export interface ProjectionCheckpoint {
  consumer: ContextProjectionConsumer;
  tenantId: string;
  repository: string;
  sequence: number;
  projectorVersion: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  updatedAt: string;
}

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
  projectorName: string;
  projectorVersion: string;
  projectedAt: string;
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
  dense: "available" | "disabled" | "failed";
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
  projectorVersions: Record<ContextProjectionConsumer, string>;
  projectorStatuses: Record<ContextProjectionConsumer, ProjectorStatus>;
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
