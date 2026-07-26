import type { EvidenceAnchor } from "./evidence.js";
import type { GenerationCapabilities } from "./projection.js";

export type QueryTaskKind = "lookup" | "structure" | "change" | "intent" | "overview" | "status";

export interface QueryContextRequest {
  tenantId: string;
  principalId: string;
  repository: string;
  ref?: string;
  question: string;
  taskKind?: QueryTaskKind;
  targets?: {
    paths?: string[];
    symbols?: string[];
    pullRequests?: string[];
    issues?: string[];
  };
  timeWindow?: { from?: string; to?: string };
}

export interface QueryCitation {
  id: string;
  title: string;
  excerpt: string;
  anchors: EvidenceAnchor[];
  authorityClass: string;
  sourceKind: "code" | "provider" | "knowledge";
  sourceId: string;
  sourceRevisionId?: string;
}

export interface SourceConflict {
  subject: string;
  description: string;
  citationIds: string[];
  resolution: "unresolved" | "authority_preferred" | "newer_source_preferred";
}

export interface QueryContextResponse {
  answer: string;
  generation: {
    id: string;
    ref: string;
    commitSha: string;
    derivedKnowledge: GenerationCapabilities["derivedKnowledge"];
  };
  citations: QueryCitation[];
  conflicts: SourceConflict[];
  ambiguities: string[];
  coverage: {
    status: "complete" | "partial" | "insufficient";
    missing: string[];
    retrieversUsed: string[];
  };
  traceId: string;
}

export const queryRoutes = [
  "exact",
  "structured",
  "structural",
  "lexical",
  "dense",
  "hierarchy",
  "knowledge",
  "temporal",
  "long_context"
] as const;

export type QueryRoute = (typeof queryRoutes)[number];

export interface QueryPlanRoute {
  route: QueryRoute;
  reason: string;
  limit: number;
  timeoutMs: number;
}

export interface QueryPlan {
  normalizedQuestion: string;
  taskKind: QueryTaskKind;
  routes: QueryPlanRoute[];
  targets: NonNullable<QueryContextRequest["targets"]>;
  timeWindow?: { from?: string; to?: string };
  plannerVersion: string;
}

export interface RetrievalCandidate {
  id: string;
  retriever: QueryRoute;
  documentId?: string;
  sourceKind: "code" | "provider" | "knowledge" | "structure";
  sourceId: string;
  sourceRevisionId?: string;
  title: string;
  excerpt: string;
  contextualText: string;
  anchors: EvidenceAnchor[];
  rawScore: number;
  scoreSemantics: string;
  exactMatch: boolean;
  authorityClass: string;
  effectiveAclFingerprint: string;
  contentFingerprint: string;
  explanation: string;
  metadata: Record<string, unknown>;
}

export interface EvidencePackItem {
  citationId: string;
  title: string;
  sourceText: string;
  contextualText: string;
  candidate: RetrievalCandidate;
}

export interface EvidencePack {
  items: EvidencePackItem[];
  omittedCandidateIds: string[];
  characterCount: number;
}

export interface SynthesizedClaim {
  text: string;
  citationIds: string[];
}

export interface SynthesisOutput {
  answer: string;
  claims: SynthesizedClaim[];
  ambiguities: string[];
  missing: string[];
}
