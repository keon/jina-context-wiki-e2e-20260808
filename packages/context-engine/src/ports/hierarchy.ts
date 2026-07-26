import type { EvidenceAnchor } from "../domain/evidence.js";

export interface HierarchyBuildDocument {
  id: string;
  title: string;
  body: string;
  anchors: EvidenceAnchor[];
  aclFingerprint: string;
}

export interface HierarchyBuildInput {
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  generationId: string;
  documents: HierarchyBuildDocument[];
  adapterVersion: string;
  limits: {
    timeoutMs: number;
    maxDocumentCharacters: number;
    maxNodes: number;
  };
}

export interface HierarchyBuildNode {
  externalId: string;
  documentId: string;
  parentExternalId?: string;
  title: string;
  summary: string;
  depth: number;
  preorderStart: number;
  preorderEnd: number;
  anchors: EvidenceAnchor[];
}

export interface HierarchyBuildResult {
  adapterName: string;
  adapterVersion: string;
  nodes: HierarchyBuildNode[];
  diagnostics: string[];
}

export interface HierarchySearchInput {
  tenantId: string;
  repository: string;
  generationId: string;
  question: string;
  allowedAclFingerprints: ReadonlySet<string>;
  limit: number;
}

export interface HierarchyCandidate {
  nodeId: string;
  documentId: string;
  score: number;
  explanation: string;
}

export interface HierarchyIndexer {
  probe(): Promise<{ available: boolean; reason?: string }>;
  build(input: HierarchyBuildInput): Promise<HierarchyBuildResult>;
}

export interface HierarchyRetriever {
  search(input: HierarchySearchInput): Promise<HierarchyCandidate[]>;
}

export interface PageIndexClient {
  probe(): Promise<{ available: boolean; reason?: string }>;
  build(input: HierarchyBuildInput, signal: AbortSignal): Promise<HierarchyBuildResult>;
}
