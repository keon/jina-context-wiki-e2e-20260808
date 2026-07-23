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

export interface ContextGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly path?: string;
  readonly evidence: readonly string[];
}

export interface ContextGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly predicate: string;
  readonly plane: "code" | "knowledge";
  readonly confidence?: number;
  readonly why?: string;
  readonly qualifiers?: Readonly<Record<string, unknown>>;
  readonly evidence: readonly string[];
}

export interface ContextGraph {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly generatedAt: string;
  readonly generator: {
    readonly executor: string;
    readonly model: string;
    readonly sandboxId?: string;
  };
  readonly summary: string;
  readonly nodes: readonly ContextGraphNode[];
  readonly edges: readonly ContextGraphEdge[];
}

export interface ContextGraphAssertion {
  readonly id: string;
  readonly status: string;
  readonly predicate: string;
  readonly subject: { readonly kind: string; readonly label: string; readonly naturalKey?: string };
  readonly object: { readonly kind: string; readonly label: string; readonly naturalKey?: string };
  readonly explanation?: string;
  readonly confidence?: number;
  readonly evidence?: readonly string[];
  readonly [key: string]: unknown;
}

/** GET /api/context-graph?include=assertions — graph state plus review queue. */
export interface ContextGraphResponse {
  readonly latest: ContextGraph | null;
  readonly graphs: readonly Readonly<Record<string, unknown>>[];
  readonly assertions?: readonly ContextGraphAssertion[];
}
