import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextDatabaseTelemetry } from "@jina/context-engine";
import { MetricsRegistry } from "@jina/observability";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { applySchema } from "../apply-schema.js";
import { CONTEXT_ROLES_SQL } from "./roles.js";
import type { ContextDatabaseRole } from "./roles.js";
import { CONTEXT_SCHEMA_SQL } from "./schema.js";

export interface PostgresContextDatabaseConfig extends PoolConfig {
  readonly manageSchema?: boolean;
  readonly manageRoles?: boolean;
}

export const CONTEXT_DATABASE_CONNECTION_TIMEOUT_MS = 10_000;

export type ContextDatabaseScope = { readonly tenantIds: readonly string[] } | { readonly system: true };

export const contextSystemScope: ContextDatabaseScope = { system: true };

export function contextTenantScope(tenantId: string): ContextDatabaseScope {
  if (!tenantId.trim()) throw new Error("Context database tenant scope must not be empty");
  return { tenantIds: [tenantId] };
}

export class ContextDatabase {
  readonly pool: Pool;
  private readonly manageSchema: boolean;
  private readonly manageRoles: boolean;
  private readonly ambientTenantScope = new AsyncLocalStorage<ContextDatabaseScope>();
  private readonly metrics = new MetricsRegistry();
  private initialized?: Promise<void>;

  constructor(config: PostgresContextDatabaseConfig) {
    const { manageSchema = true, manageRoles = false, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.manageRoles = manageRoles;
    this.pool = new Pool({
      ...poolConfig,
      application_name: "jina-context",
      max: poolConfig.max ?? 10,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis ?? CONTEXT_DATABASE_CONNECTION_TIMEOUT_MS
    });
  }

  initialize(): Promise<void> {
    return (this.initialized ??= this.initializeOnce());
  }

  runInTenantScope<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    return this.ambientTenantScope.run(contextTenantScope(tenantId), operation);
  }

  telemetry(): ContextDatabaseTelemetry {
    return {
      pool: {
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
        max: this.pool.options.max ?? 10
      },
      metrics: this.metrics.snapshot()
    };
  }

  async observeOperation<T>(
    role: ContextDatabaseRole,
    databaseOperation: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const labels = { operation: normalizeDatabaseOperation(databaseOperation), role };
    const startedAt = performance.now();
    let outcome: "ok" | "error" = "error";
    try {
      const result = await operation();
      outcome = "ok";
      return result;
    } finally {
      this.metrics.count("context.db.operations", { ...labels, outcome });
      this.metrics.observe("context.db.operation.duration_ms", performance.now() - startedAt, labels);
    }
  }

  async transactionAs<T>(
    role: ContextDatabaseRole,
    scope: ContextDatabaseScope,
    operation: (client: PoolClient) => Promise<T>,
    databaseOperation = "unspecified"
  ): Promise<T> {
    await this.initialize();
    const ambientScope = this.ambientTenantScope.getStore();
    const effectiveScope = "system" in scope && ambientScope ? ambientScope : scope;
    const effectiveRole =
      role === "jina_context_admin" && "tenantIds" in effectiveScope ? "jina_context_tenant_admin" : role;
    const labels = { operation: normalizeDatabaseOperation(databaseOperation), role: effectiveRole };
    const totalStartedAt = performance.now();
    const checkoutStartedAt = totalStartedAt;
    const queued = this.pool.idleCount === 0 && this.pool.totalCount >= (this.pool.options.max ?? 10);
    if (queued) this.metrics.count("context.db.pool.queued_checkouts", labels);
    let client: PoolClient | undefined;
    let phase: "checkout" | "setup" | "operation" | "commit" = "checkout";
    let outcome: "ok" | "error" = "error";
    try {
      try {
        client = await this.pool.connect();
      } finally {
        this.metrics.observe("context.db.pool.checkout_wait_ms", performance.now() - checkoutStartedAt, labels);
      }
      phase = "setup";
      const setupStartedAt = performance.now();
      try {
        await client.query("begin");
        await client.query(`set local role ${effectiveRole}`);
        await client.query("select set_config('jina.tenant_id',$1,true)", [
          "tenantIds" in effectiveScope ? effectiveScope.tenantIds.join("\u001f") : "*"
        ]);
      } finally {
        this.metrics.observe("context.db.transaction.setup_ms", performance.now() - setupStartedAt, labels);
      }
      phase = "operation";
      const operationStartedAt = performance.now();
      let result: T;
      try {
        result = await operation(client);
      } finally {
        this.metrics.observe("context.db.transaction.operation_ms", performance.now() - operationStartedAt, labels);
      }
      phase = "commit";
      const commitStartedAt = performance.now();
      try {
        await client.query("commit");
      } finally {
        this.metrics.observe("context.db.transaction.commit_ms", performance.now() - commitStartedAt, labels);
      }
      outcome = "ok";
      return result;
    } catch (error) {
      this.metrics.count("context.db.transaction.errors", { ...labels, phase });
      await client?.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      this.metrics.count("context.db.transactions", { ...labels, outcome });
      this.metrics.observe("context.db.transaction.total_ms", performance.now() - totalStartedAt, labels);
    }
  }

  async queryAs<T extends QueryResultRow = QueryResultRow>(
    role: ContextDatabaseRole,
    scope: ContextDatabaseScope,
    text: string,
    values?: readonly unknown[],
    databaseOperation = "unspecified"
  ) {
    return this.transactionAs(
      role,
      scope,
      (client) => client.query<T>(text, values ? [...values] : undefined),
      databaseOperation
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async initializeOnce(): Promise<void> {
    if (this.manageSchema) {
      await applySchema(this.pool, "jina_context.schema", CONTEXT_SCHEMA_SQL);
    }
    if (this.manageRoles) {
      await applySchema(this.pool, "jina_context.roles", CONTEXT_ROLES_SQL);
    }
  }
}

function normalizeDatabaseOperation(operation: string): string {
  const normalized = operation.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : "other";
}

export function dateString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
