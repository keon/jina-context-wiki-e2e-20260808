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

export interface ContextRelease {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly completeness: "complete" | "partial";
  readonly contextStatus: "available" | "partial" | "unavailable";
}

export interface ContextSourceCitation {
  readonly claim: string;
  readonly citationId?: string;
  readonly claimSpan?: string;
  readonly anchor: {
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
  };
}

export interface ContextCatalogDocument {
  readonly id: string;
  readonly logicalId: string;
  readonly revisionId: string;
  readonly kind?: string;
  readonly title: string;
  readonly summary: string;
  readonly citations: readonly ContextSourceCitation[];
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

export interface ContextListResponse {
  readonly release: ContextRelease;
  readonly documents: readonly ContextCatalogDocument[];
  readonly tree: readonly ContextTreeNode[];
}

export interface ContextReadResponse {
  readonly release: ContextRelease;
  readonly document: ContextCatalogDocument & { readonly bodyMarkdown: string };
}

export interface ContextSearchResponse {
  readonly release: ContextRelease;
  readonly query: string;
  readonly results: readonly {
    readonly documentId: string;
    readonly logicalId: string;
    readonly revisionId: string;
    readonly title: string;
    readonly score: number;
    readonly selectedNodeIds: readonly string[];
    readonly excerpts: readonly string[];
    readonly citations: readonly ContextSourceCitation[];
  }[];
  readonly retrieval: {
    readonly method: "lexical_tree";
    readonly selector: string;
    readonly degradedReason?: string;
  };
}

export interface ContextDiffResponse {
  readonly from: ContextRelease;
  readonly to: ContextRelease;
  readonly added: readonly ContextCatalogDocument[];
  readonly removed: readonly ContextCatalogDocument[];
  readonly changed: readonly {
    readonly before: ContextCatalogDocument;
    readonly after: ContextCatalogDocument;
  }[];
  readonly unchanged: readonly string[];
}

interface ContextBuildStage {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly attempt: number;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly startedAt?: string;
  readonly modelInputTokens?: number;
  readonly modelCachedInputTokens?: number;
  readonly modelOutputTokens?: number;
  readonly modelTotalTokens?: number;
  readonly lastRetryAt?: string;
  readonly lastRetryFailureCode?: string;
  readonly lastRetryFailureReason?: string;
  readonly updatedAt: string;
}

export interface ContextBuildSummary {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha?: string;
  readonly trigger?: string;
  readonly derivationBudgetSeconds?: number;
  readonly derivationDeadlineAt?: string;
  readonly derivationTokenBudget?: number;
  readonly consumedModelTokens?: number;
  readonly activeModelReservedTokens?: number;
  readonly remainingModelTokens?: number;
  readonly status: "active" | "completed" | "failed";
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly stages: readonly ContextBuildStage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextBuildListResponse {
  readonly builds: readonly ContextBuildSummary[];
}

export interface ContextBuildProgressResponse {
  readonly buildId: string;
  readonly repository: string;
  readonly ref: string;
  readonly status: ContextBuildSummary["status"];
  readonly derivationBudgetSeconds?: number;
  readonly derivationDeadlineAt?: string;
  readonly derivationTokenBudget?: number;
  readonly consumedModelTokens?: number;
  readonly activeModelReservedTokens?: number;
  readonly remainingModelTokens?: number;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly stages: readonly ContextBuildStage[];
  readonly pages: readonly {
    readonly documentPath: string;
    readonly title: string;
    readonly bytes: number;
    readonly validationStatus: "pending" | "valid" | "invalid";
    readonly diagnostics: readonly string[];
    readonly checkpointSequence: number;
    readonly updatedAt: string;
  }[];
  readonly updatedAt: string;
}
