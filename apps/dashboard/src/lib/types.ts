/**
 * Shapes of the API payloads the dashboard reads. These mirror what the API
 * serves today; fields the UI does not consume are intentionally omitted and
 * unknown metadata stays loosely typed.
 */

export interface BoardTask {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly assigneeRole?: string;
  readonly attempt: number;
  readonly epoch?: number | null;
  readonly required?: boolean;
  readonly dedupeKey?: string;
  readonly dispatchTopic?: string;
  readonly parentTaskId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface BoardDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly relationship: string;
  readonly required?: boolean;
}

export interface BoardState {
  readonly tasks: readonly BoardTask[];
  readonly dependencies: readonly BoardDependency[];
  readonly publications: readonly Readonly<Record<string, unknown>>[];
}

export interface BoardEvent {
  readonly id: string;
  readonly seq?: number;
  readonly taskId?: string;
  readonly type: string;
  readonly at: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** GET /api/overview — board and event history in one request. */
export interface OverviewResponse {
  readonly board: BoardState;
  readonly events: readonly BoardEvent[];
}

export interface TaskTypeDependency {
  readonly taskType: string;
  readonly workflows?: readonly string[];
  readonly relationships?: readonly string[];
  readonly required?: boolean;
  readonly conditions?: readonly string[];
}

export interface TaskTypeTrigger {
  readonly source: string;
  readonly description: string;
  readonly conditions?: readonly string[];
}

export interface TaskTypeDefinition {
  readonly type: string;
  readonly kind: string;
  readonly description: string;
  readonly defaultAssigneeRole?: string;
  readonly dispatchTopic?: string;
  readonly dependsOn?: readonly TaskTypeDependency[];
  readonly requiredBy?: readonly TaskTypeDependency[];
  readonly triggeredBy?: readonly TaskTypeTrigger[];
}

type KnowledgeDocumentKind =
  | "architecture"
  | "component"
  | "feature"
  | "decision"
  | "change_summary"
  | "incident"
  | "issue_explanation"
  | "ownership"
  | "runbook"
  | "glossary"
  // A flow is a path through the system, a pattern a recurring shape worth
  // recognising, and a topic a document whose folder the repository chose rather
  // than this taxonomy — which is most of them once a repository organises its
  // own wiki.
  | "flow"
  | "pattern"
  | "topic";

export interface ContextCitation {
  readonly id?: string;
  readonly tenantId?: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly repository: string;
  readonly commitSha?: string;
  readonly pathOrUrl?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly jsonPointer?: string;
  readonly observedAt?: string;
  readonly contentDigest?: string;
  readonly excerpt?: string;
  readonly url?: string;
}

export interface ContextGeneration {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly status: string;
  readonly derivedKnowledge: "available" | "partial" | "unavailable";
  readonly projectors: Readonly<Record<string, string>> | readonly ContextProjector[];
  readonly createdAt: string;
  readonly publishedAt?: string;
}

export interface ContextProjector {
  readonly name: string;
  readonly status: string;
  readonly checkpoint?: string;
  readonly backlog?: number;
  readonly version?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface ContextGenerationsResponse {
  readonly generations: readonly ContextGeneration[];
  readonly nextCursor?: string;
}

export interface KnowledgeDocumentSummary {
  readonly id: string;
  readonly logicalId: string;
  readonly repository: string;
  readonly kind: KnowledgeDocumentKind;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly reviewStatus: string;
  readonly commitSha: string;
  readonly generatorName: string;
  readonly generatorVersion: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: string;
}

interface KnowledgeRevisionEvent {
  readonly id?: string;
  readonly action?: string;
  readonly type?: string;
  readonly reason?: string;
  readonly actorId?: string;
  readonly createdAt?: string;
  readonly at?: string;
}

export interface KnowledgeDocument extends KnowledgeDocumentSummary {
  readonly bodyMarkdown: string;
  readonly structuredSummary: Readonly<Record<string, unknown>>;
  readonly scope: {
    readonly ref?: string;
    readonly commitSha?: string;
    readonly paths?: readonly string[];
    readonly symbols?: readonly string[];
    readonly pullRequests?: readonly string[];
    readonly issues?: readonly string[];
  };
  readonly citations: readonly KnowledgeCitation[];
  readonly events: readonly KnowledgeRevisionEvent[];
  readonly priorRevisionId?: string;
  readonly validation?: Readonly<Record<string, unknown>>;
}

interface KnowledgeCitation {
  readonly id: string;
  readonly revisionId: string;
  readonly ordinal: number;
  readonly claim: string;
  readonly anchor: ContextCitation;
}

export interface ContextDocumentsResponse {
  readonly documents: readonly KnowledgeDocumentSummary[];
  readonly nextCursor?: string;
}

export interface ContextDocumentResponse {
  readonly document: KnowledgeDocument;
}

interface ContextConflict {
  readonly subject: string;
  readonly description: string;
  readonly citationIds: readonly string[];
}

export interface ContextQueryResponse {
  readonly answer: string;
  readonly generation: {
    readonly id: string;
    readonly ref: string;
    readonly commitSha: string;
    readonly derivedKnowledge: "available" | "partial" | "unavailable";
  };
  readonly citations: readonly QueryCitation[];
  readonly conflicts: readonly ContextConflict[];
  readonly ambiguities: readonly string[];
  readonly coverage: {
    readonly status: "complete" | "partial" | "insufficient";
    readonly missing: readonly string[];
    readonly retrieversUsed: readonly string[];
  };
  readonly traceId: string;
}

export interface QueryCitation {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly anchors: readonly ContextCitation[];
  readonly authorityClass: string;
  readonly sourceKind: "code" | "provider" | "knowledge";
  readonly sourceId: string;
  readonly sourceRevisionId?: string;
}

export interface ContextMetricsResponse {
  readonly outboxDepthByConsumer: Readonly<Record<string, number>>;
  readonly oldestPendingAt?: string;
  readonly publishedGenerationCount: number;
  readonly documentCount: number;
  readonly fragmentCount: number;
  readonly hierarchyNodeCount: number;
  readonly embeddingCount: number;
  readonly query: {
    readonly count: number;
    readonly p95Ms: number;
    readonly citationFailureCount: number;
    readonly conflictCount: number;
  };
  readonly projectors: readonly ContextProjector[];
}

export interface StructuralRelation {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly anchors: readonly ContextCitation[];
}

export interface ContextStructureResponse {
  readonly relations: readonly StructuralRelation[];
}
