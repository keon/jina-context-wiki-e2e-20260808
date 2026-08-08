import type { BoardState, BoardTask } from "./types.ts";

export interface TaskRelationship {
  readonly direction: string;
  readonly taskId: string;
  readonly relationship: string;
  readonly required?: boolean | undefined;
}

/** Returns every parent, child, and dependency edge touching a task. */
export function taskRelationships(task: BoardTask, board: BoardState): readonly TaskRelationship[] {
  const relationships: TaskRelationship[] = [];
  if (task.parentTaskId) relationships.push({ direction: "Parent", taskId: task.parentTaskId, relationship: "parent" });
  for (const child of board.tasks.filter((item) => item.parentTaskId === task.id)) {
    relationships.push({ direction: "Child", taskId: child.id, relationship: "child" });
  }
  for (const dependency of board.dependencies) {
    if (dependency.taskId === task.id) {
      relationships.push({
        direction: "Depends on",
        taskId: dependency.dependsOnTaskId,
        relationship: dependency.relationship,
        required: dependency.required
      });
    }
    if (dependency.dependsOnTaskId === task.id) {
      relationships.push({
        direction: "Required by",
        taskId: dependency.taskId,
        relationship: dependency.relationship,
        required: dependency.required
      });
    }
  }
  return relationships;
}

function metadataText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function boardBuildScope(metadata: Readonly<Record<string, unknown>>, workflow: "context" | "causal-graph"): string {
  return `${workflow}:${metadataText(metadata.tenantId)}:${metadataText(metadata.repository)}:${metadataText(metadata.ref)}`;
}

const causalGraphTaskTypes = new Set([
  "build-causal-graph",
  "snapshot-causal-graph-history",
  "derive-causal-graph",
  "publish-causal-graph"
]);

const contextTaskTypes = new Set([
  "build-context",
  "context-build-graph",
  "snapshot-context-input",
  "plan-context-pages",
  "build-context-page",
  "publish-context-release",
  ...causalGraphTaskTypes
]);

/**
 * Splits tasks into the operational board and its history: superseded work,
 * and context-engine tasks that no longer belong to the latest build request
 * for their repository/ref scope.
 */
export function partitionBoardTasks(tasks: readonly BoardTask[]): {
  readonly current: readonly BoardTask[];
  readonly history: readonly BoardTask[];
} {
  const latestRequestByScope = new Map<string, { requestKey: unknown; createdAt: string; id: string }>();
  for (const task of tasks) {
    if (task.type !== "build-context" && task.type !== "build-causal-graph") continue;
    const metadata = task.metadata ?? {};
    if (!metadata.repository || !metadata.ref || !metadata.requestKey) continue;
    const scope = boardBuildScope(metadata, causalGraphTaskTypes.has(task.type) ? "causal-graph" : "context");
    const existing = latestRequestByScope.get(scope);
    const createdAt = String(task.createdAt);
    if (!existing || createdAt > existing.createdAt || (createdAt === existing.createdAt && task.id > existing.id)) {
      latestRequestByScope.set(scope, { requestKey: metadata.requestKey, createdAt, id: task.id });
    }
  }
  const current: BoardTask[] = [];
  const history: BoardTask[] = [];
  for (const task of tasks) {
    const metadata = task.metadata ?? {};
    const contextTask = contextTaskTypes.has(task.type) && metadata.repository && metadata.ref && metadata.requestKey;
    if (contextTask) {
      const scope = boardBuildScope(metadata, causalGraphTaskTypes.has(task.type) ? "causal-graph" : "context");
      const latest = latestRequestByScope.get(scope);
      if (!latest) {
        // No root build task is visible for this scope: it may be absent from
        // the page, or its metadata may not agree with the stage's (the scope
        // key spans tenantId, which the root is not required to carry). Nothing
        // establishes supersession here, so fall back to the task's own status
        // rather than filing work that is still executing as history.
        (task.status === "superseded" ? history : current).push(task);
      } else {
        (latest.requestKey === metadata.requestKey ? current : history).push(task);
      }
    } else {
      (task.status === "superseded" ? history : current).push(task);
    }
  }
  return { current, history };
}

export interface BoardFilters {
  readonly query: string;
  readonly repository: string;
  readonly owner: string;
  readonly type: string;
  readonly status: string;
}

export const EMPTY_BOARD_FILTERS: BoardFilters = { query: "", repository: "", owner: "", type: "", status: "" };

export function filterBoardTasks(tasks: readonly BoardTask[], filters: BoardFilters): readonly BoardTask[] {
  const query = filters.query.trim().toLowerCase();
  return tasks.filter((task) => {
    const haystack = [
      task.title,
      task.type,
      task.assigneeRole,
      task.metadata?.repository,
      task.metadata?.workspaceLabel,
      task.metadata?.authorLogin
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      (!query || haystack.includes(query)) &&
      (!filters.repository || task.metadata?.repository === filters.repository) &&
      (!filters.owner || task.assigneeRole === filters.owner) &&
      (!filters.type || task.type === filters.type) &&
      (!filters.status || task.status === filters.status)
    );
  });
}

export function uniqueValues(values: readonly unknown[]): readonly string[] {
  return Array.from(new Set(values.filter(Boolean).map(String))).sort((left, right) => left.localeCompare(right));
}

export const BOARD_COLUMN_STATUSES = [
  "triage",
  "blocked",
  "queued",
  "in_progress",
  "done",
  "superseded",
  "failed",
  "canceled"
] as const;

export const ALWAYS_VISIBLE_COLUMNS: readonly string[] = ["triage", "queued", "in_progress", "done"];
