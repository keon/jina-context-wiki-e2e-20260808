import { Pool, type PoolConfig } from "pg";

const REQUIRED_RELATIONS = ["jina_board.workflows", "jina_board.tasks", "jina_context_graph.outbox"] as const;

const TERMINAL_WORKFLOW_STATUSES = ["done", "failed", "superseded"] as const;
const TERMINAL_TASK_STATUSES = ["done", "failed", "canceled", "superseded"] as const;

export interface LegacyContextSqlAudit {
  readonly tenantId: string;
  readonly workflowCount: number;
  readonly terminalWorkflowCount: number;
  readonly taskCount: number;
  readonly terminalTaskCount: number;
  readonly outboxCount: number;
  readonly processedOutboxCount: number;
}

interface ActiveWorkflowRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly status: string | null;
}

interface ActiveTaskRow extends ActiveWorkflowRow {
  readonly lease_id: string | null;
  readonly worker_id: string | null;
  readonly lease_expires_at: Date | null;
}

interface PendingOutboxRow {
  readonly id: string;
  readonly tenant_id: string | null;
}

interface AuditCountRow {
  readonly tenant_id: string;
  readonly workflow_count: string;
  readonly terminal_workflow_count: string;
  readonly task_count: string;
  readonly terminal_task_count: string;
  readonly outbox_count: string;
  readonly processed_outbox_count: string;
}

/**
 * One-shot, read-only audit for the retired graph database. This deliberately
 * remains separate from the new context schema so the runtime identity never
 * needs access to archived graph tables.
 */
export class PostgresLegacyContextCutoverAuditor {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,
      application_name: "jina-context-cutover-preflight",
      max: config.max ?? 1,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000
    });
    this.pool.on("error", (error) => {
      console.error("legacy context cutover postgres idle connection error", error);
    });
  }

  async audit(tenantIds: readonly string[]): Promise<LegacyContextSqlAudit[]> {
    const inventory = normalizeInventory(tenantIds);
    const client = await this.pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      for (const relation of REQUIRED_RELATIONS) {
        const result = await client.query<{ relation: string | null }>("select to_regclass($1)::text as relation", [
          relation
        ]);
        if (result.rows[0]?.relation !== relation) {
          throw new Error(`legacy cutover relation is missing: ${relation}`);
        }
      }

      const unknownTenants = await client.query<{ tenant_id: string | null }>(
        `select distinct legacy.tenant_id
         from (
           select tenant_id from jina_board.workflows
           union all
           select tenant_id from jina_board.tasks
           union all
           select tenant_id from jina_context_graph.outbox
         ) legacy
         where legacy.tenant_id is null or not (legacy.tenant_id = any($1::text[]))
         order by legacy.tenant_id nulls first`,
        [inventory]
      );
      if (unknownTenants.rows.length > 0) {
        const ids = unknownTenants.rows.map((row) => row.tenant_id ?? "missing-tenant");
        throw new Error(`legacy cutover tenant inventory is incomplete: ${ids.join(", ")}`);
      }

      const activeWorkflows = await client.query<ActiveWorkflowRow>(
        `select id,tenant_id,status
         from jina_board.workflows
         where status is null or not (status = any($1::text[]))
         order by tenant_id,id
         limit 100`,
        [[...TERMINAL_WORKFLOW_STATUSES]]
      );
      if (activeWorkflows.rows.length > 0) {
        const ids = activeWorkflows.rows.map(
          (row) => `${row.tenant_id ?? "missing-tenant"}/${row.id}/${row.status ?? "missing-status"}`
        );
        throw new Error(`legacy graph workflows are still active after writer shutdown: ${ids.join(", ")}`);
      }

      const activeTasks = await client.query<ActiveTaskRow>(
        `select id,tenant_id,status,lease_id,worker_id,lease_expires_at
         from jina_board.tasks
         where status is null
            or not (status = any($1::text[]))
            or lease_id is not null
            or worker_id is not null
            or lease_expires_at is not null
         order by tenant_id,id
         limit 100`,
        [[...TERMINAL_TASK_STATUSES]]
      );
      if (activeTasks.rows.length > 0) {
        const ids = activeTasks.rows.map(
          (row) => `${row.tenant_id ?? "missing-tenant"}/${row.id}/${row.status ?? "missing-status"}`
        );
        throw new Error(`legacy graph tasks are still active or leased after writer shutdown: ${ids.join(", ")}`);
      }

      const pendingOutbox = await client.query<PendingOutboxRow>(
        `select id,tenant_id
         from jina_context_graph.outbox
         where processed_at is null
         order by tenant_id,id
         limit 100`
      );
      if (pendingOutbox.rows.length > 0) {
        const ids = pendingOutbox.rows.map((row) => `${row.tenant_id ?? "missing-tenant"}/${row.id}`);
        throw new Error(`legacy graph projection outbox is not fully processed: ${ids.join(", ")}`);
      }

      const counts = await client.query<AuditCountRow>(
        `select inventory.tenant_id,
           (select count(*) from jina_board.workflows workflow
             where workflow.tenant_id=inventory.tenant_id)::text as workflow_count,
           (select count(*) from jina_board.workflows workflow
             where workflow.tenant_id=inventory.tenant_id
               and workflow.status=any($2::text[]))::text as terminal_workflow_count,
           (select count(*) from jina_board.tasks task
             where task.tenant_id=inventory.tenant_id)::text as task_count,
           (select count(*) from jina_board.tasks task
             where task.tenant_id=inventory.tenant_id
               and task.status=any($3::text[]))::text as terminal_task_count,
           (select count(*) from jina_context_graph.outbox message
             where message.tenant_id=inventory.tenant_id)::text as outbox_count,
           (select count(*) from jina_context_graph.outbox message
             where message.tenant_id=inventory.tenant_id
               and message.processed_at is not null)::text as processed_outbox_count
         from unnest($1::text[]) as inventory(tenant_id)
         order by inventory.tenant_id`,
        [inventory, [...TERMINAL_WORKFLOW_STATUSES], [...TERMINAL_TASK_STATUSES]]
      );
      await client.query("commit");
      return counts.rows.map((row) => ({
        tenantId: row.tenant_id,
        workflowCount: Number(row.workflow_count),
        terminalWorkflowCount: Number(row.terminal_workflow_count),
        taskCount: Number(row.task_count),
        terminalTaskCount: Number(row.terminal_task_count),
        outboxCount: Number(row.outbox_count),
        processedOutboxCount: Number(row.processed_outbox_count)
      }));
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function normalizeInventory(tenantIds: readonly string[]): string[] {
  const inventory = [...new Set(tenantIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (inventory.length === 0) throw new Error("legacy cutover preflight requires the complete tenant inventory");
  return inventory;
}
