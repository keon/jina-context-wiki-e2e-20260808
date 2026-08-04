import { databaseConfigured, query } from "./db.js";

const BOARD_DASHBOARD_ACTIVE_WORKFLOW_LIMIT = 500;
const BOARD_DASHBOARD_TERMINAL_WORKFLOW_LIMIT = 200;
const BOARD_DASHBOARD_EVENT_LIMIT = 1_000;

interface DashboardBoardTask {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly assigneeRole?: string;
  readonly attempt: number;
  readonly epoch?: number;
  readonly required?: boolean;
  readonly dispatchTopic?: string;
  readonly parentTaskId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface DashboardBoardDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly relationship: string;
  readonly required?: boolean;
}

interface DashboardBoardEvent {
  readonly id: string;
  readonly seq?: number;
  readonly taskId?: string;
  readonly type: string;
  readonly at: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface DashboardWorkOverview {
  readonly board: {
    readonly tasks: readonly DashboardBoardTask[];
    readonly dependencies: readonly DashboardBoardDependency[];
    readonly outbox?: readonly unknown[];
  };
  readonly events: readonly DashboardBoardEvent[];
}

interface WorkflowRow {
  readonly id: string;
  readonly workflow_type: string;
  readonly pipeline_version: string;
  readonly status: string;
  readonly epoch: number;
  readonly trace_id: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly metadata: Record<string, unknown>;
}

interface TaskRow {
  readonly id: string;
  readonly workflow_id: string;
  readonly parent_task_id: string | null;
  readonly task_type: string;
  readonly topic: string | null;
  readonly status: string;
  readonly attempt_count: number;
  readonly required: boolean;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly metadata: Record<string, unknown>;
}

interface DependencyRow {
  readonly task_id: string;
  readonly depends_on_task_id: string;
  readonly relationship: string;
  readonly required: boolean;
}

interface EventRow {
  readonly id: number;
  readonly workflow_id: string;
  readonly task_id: string | null;
  readonly attempt_id: string | null;
  readonly event_type: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly trace_id: string;
  readonly span_id: string | null;
  readonly occurred_at: Date | string;
  readonly payload: Record<string, unknown>;
}

/**
 * Returns every active workflow plus a bounded recent terminal window. Older
 * workflows and their append-only events remain queryable in PostgreSQL; they
 * are deliberately excluded from the live Task Board payload so "Done" cannot
 * grow without bound.
 */
export async function getRelationalBoardDashboardOverview(tenantId: string): Promise<DashboardWorkOverview> {
  if (!databaseConfigured()) return emptyDashboardWorkOverview();
  const workflows = await query<WorkflowRow>(
    `with selected as (
       select id
       from jina_runtime.board_workflows
       where tenant_id=$1 and status in ('shadow','queued','running','superseding')
       order by updated_at desc,id desc
       limit $2
     ), recent_terminal as (
       select id
       from jina_runtime.board_workflows
       where tenant_id=$1 and status in ('succeeded','failed','canceled','superseded')
       order by updated_at desc,id desc
       limit $3
     )
     select workflow.id,workflow.workflow_type,workflow.pipeline_version,workflow.status,
            workflow.epoch,workflow.trace_id,workflow.created_at,workflow.updated_at,workflow.metadata
     from jina_runtime.board_workflows workflow
     where workflow.id in (select id from selected union select id from recent_terminal)
     order by workflow.updated_at desc,workflow.id desc`,
    [tenantId, BOARD_DASHBOARD_ACTIVE_WORKFLOW_LIMIT, BOARD_DASHBOARD_TERMINAL_WORKFLOW_LIMIT],
  );
  if (workflows.length === 0) return emptyDashboardWorkOverview();
  const workflowIds = workflows.map((workflow) => workflow.id);
  const [tasks, dependencies, events] = await Promise.all([
    query<TaskRow>(
      `select id,workflow_id,parent_task_id,task_type,topic,status,attempt_count,required,
              created_at,updated_at,metadata
       from jina_runtime.board_tasks
       where tenant_id=$1 and workflow_id=any($2::text[])
       order by created_at,id`,
      [tenantId, workflowIds],
    ),
    query<DependencyRow>(
      `select task_id,depends_on_task_id,relationship,required
       from jina_runtime.board_dependencies
       where tenant_id=$1 and workflow_id=any($2::text[])
       order by created_at,task_id,depends_on_task_id`,
      [tenantId, workflowIds],
    ),
    query<EventRow>(
      `select id,workflow_id,task_id,attempt_id,event_type,actor_type,actor_id,trace_id,span_id,
              occurred_at,payload
       from jina_runtime.board_events
       where tenant_id=$1 and workflow_id=any($2::text[])
       order by id desc
       limit $3`,
      [tenantId, workflowIds, BOARD_DASHBOARD_EVENT_LIMIT],
    ),
  ]);
  return projectRelationalBoardDashboard({ workflows, tasks, dependencies, events });
}

export function mergeDashboardWorkOverviews(
  legacy: DashboardWorkOverview,
  relational: DashboardWorkOverview,
): DashboardWorkOverview {
  return {
    board: {
      tasks: mergeById(legacy.board.tasks, relational.board.tasks),
      dependencies: mergeByKey(
        legacy.board.dependencies,
        relational.board.dependencies,
        (dependency) => `${dependency.taskId}:${dependency.dependsOnTaskId}`,
      ),
      ...(legacy.board.outbox ? { outbox: legacy.board.outbox } : {}),
    },
    events: mergeById(legacy.events, relational.events).sort((left, right) => right.at.localeCompare(left.at)),
  };
}

export function projectRelationalBoardDashboard(input: {
  readonly workflows: readonly WorkflowRow[];
  readonly tasks: readonly TaskRow[];
  readonly dependencies: readonly DependencyRow[];
  readonly events: readonly EventRow[];
}): DashboardWorkOverview {
  const workflows = new Map(input.workflows.map((workflow) => [workflow.id, workflow]));
  return {
    board: {
      tasks: input.tasks.map((task) => {
        const workflow = workflows.get(task.workflow_id);
        if (!workflow) throw new Error(`dashboard Board task ${task.id} has no selected workflow`);
        return {
          id: task.id,
          type: task.task_type,
          title: humanize(task.task_type),
          status: dashboardTaskStatus(task.status),
          assigneeRole: task.topic?.startsWith("run-context-") ? "context-worker" : "review-agent",
          attempt: task.attempt_count,
          epoch: workflow.epoch,
          required: task.required,
          ...(task.topic ? { dispatchTopic: task.topic } : {}),
          ...(task.parent_task_id ? { parentTaskId: task.parent_task_id } : {}),
          createdAt: iso(task.created_at),
          updatedAt: iso(task.updated_at),
          metadata: {
            ...workflow.metadata,
            ...task.metadata,
            workflowId: workflow.id,
            workflowType: workflow.workflow_type,
            workflowStatus: workflow.status,
            pipelineVersion: workflow.pipeline_version,
            traceId: workflow.trace_id,
            repository: textMetadata(workflow.metadata, "repository"),
            pullRequestNumber: workflow.metadata.pull_request_number,
            headSha: workflow.metadata.head_sha,
          },
        };
      }),
      dependencies: input.dependencies.map((dependency) => ({
        taskId: dependency.task_id,
        dependsOnTaskId: dependency.depends_on_task_id,
        relationship: dependency.relationship,
        required: dependency.required,
      })),
    },
    events: [...input.events].reverse().map((event) => ({
      id: `relational-board-event:${event.id}`,
      seq: event.id,
      ...(event.task_id ? { taskId: event.task_id } : {}),
      type: event.event_type,
      at: iso(event.occurred_at),
      payload: {
        ...event.payload,
        workflowId: event.workflow_id,
        ...(event.attempt_id ? { attemptId: event.attempt_id } : {}),
        actorType: event.actor_type,
        actorId: event.actor_id,
        traceId: event.trace_id,
        ...(event.span_id ? { spanId: event.span_id } : {}),
      },
    })),
  };
}

function emptyDashboardWorkOverview(): DashboardWorkOverview {
  return { board: { tasks: [], dependencies: [] }, events: [] };
}

function dashboardTaskStatus(status: string): string {
  switch (status) {
    case "queued":
    case "retry_wait":
      return "queued";
    case "leased":
      return "in_progress";
    case "succeeded":
      return "done";
    case "blocked":
    case "failed":
    case "canceled":
    case "superseded":
      return status;
    default:
      return "failed";
  }
}

function humanize(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function textMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mergeById<T extends { readonly id: string }>(left: readonly T[], right: readonly T[]): T[] {
  return mergeByKey(left, right, (value) => value.id);
}

function mergeByKey<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): T[] {
  const values = new Map(left.map((value) => [key(value), value]));
  for (const value of right) values.set(key(value), value);
  return [...values.values()];
}
