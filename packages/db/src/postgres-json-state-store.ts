import { Pool, type PoolConfig } from "pg";
import { pingPostgresPool } from "./postgres-health.js";

export interface PostgresJsonStateStoreConfig extends PoolConfig {
  readonly applicationName?: string;
  readonly manageSchema?: boolean;
}

export interface StateUpdate<T, R> {
  readonly state: T;
  readonly result: R;
}

export interface StateUpdateResult<R> {
  readonly committed: boolean;
  readonly result?: R;
}

export interface VersionedState<T> {
  readonly snapshot: T;
  readonly version: number;
}

/**
 * Durable MVP state store. The board snapshot and delivery ledger are written
 * in one Postgres transaction so an acknowledged webhook survives restarts.
 * Domain tables can replace the JSON snapshot behind this interface without
 * changing the HTTP runtime.
 */
export class PostgresJsonStateStore<T> {
  private readonly pool: Pool;
  private readonly manageSchema: boolean;
  private initialized?: Promise<void>;

  constructor(config: PostgresJsonStateStoreConfig) {
    const { manageSchema = true, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.pool = new Pool({
      ...poolConfig,
      application_name: config.applicationName ?? "jina-api",
      max: config.max ?? 5,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000
    });
    this.pool.on("error", (error) => {
      console.error("postgres idle connection error", error);
    });
  }

  async load(): Promise<T | undefined> {
    await this.initialize();
    const result = await this.pool.query<{ snapshot: T }>("select snapshot from jina_runtime.api_state where id = 1");
    return result.rows[0]?.snapshot;
  }

  /**
   * Read-path optimization for pollers: returns "unchanged" without shipping
   * or parsing the snapshot blob when the stored version is still
   * sinceVersion, and undefined when no state has ever been saved. Versions
   * are monotonic (the writer increments on every save), so callers can cache
   * the last version they restored.
   */
  async loadNewer(sinceVersion: number): Promise<VersionedState<T> | "unchanged" | undefined> {
    await this.initialize();
    const result = await this.pool.query<{ snapshot: T; version: string }>(
      "select snapshot, version from jina_runtime.api_state where id = 1 and version > $1",
      [sinceVersion]
    );
    const row = result.rows[0];
    if (row) return { snapshot: row.snapshot, version: Number(row.version) };
    if (sinceVersion > 0) return "unchanged";
    return undefined;
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query("select 1 from jina_runtime.github_deliveries where delivery_id = $1", [
      deliveryId
    ]);
    return result.rowCount === 1;
  }

  async ping(): Promise<void> {
    await pingPostgresPool(this.pool);
  }

  /**
   * Loads, changes, and stores state while holding the cross-instance lock.
   * The callback must keep external side effects idempotent because its database
   * transaction can still be rolled back by a later failure.
   */
  async update<R>(
    operation: (state: T | undefined) => Promise<StateUpdate<T, R>>,
    deliveryId?: string
  ): Promise<StateUpdateResult<R>> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");

      if (deliveryId) {
        const delivery = await client.query(
          `insert into jina_runtime.github_deliveries (delivery_id)
           values ($1)
           on conflict do nothing
           returning delivery_id`,
          [deliveryId]
        );
        if (delivery.rowCount !== 1) {
          await client.query("rollback");
          return { committed: false };
        }
      }

      const current = await client.query<{ snapshot: T }>("select snapshot from jina_runtime.api_state where id = 1");
      const update = await operation(current.rows[0]?.snapshot);
      await client.query(
        `insert into jina_runtime.api_state (id, snapshot)
         values (1, $1::jsonb)
         on conflict (id) do update
           set snapshot = excluded.snapshot,
               version = jina_runtime.api_state.version + 1,
               updated_at = now()`,
        [JSON.stringify(update.state)]
      );
      await client.query("commit");
      return { committed: true, result: update.result };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Returns false when deliveryId was already committed. In that case the
   * snapshot is intentionally left unchanged.
   */
  async save(snapshot: T, deliveryId?: string): Promise<boolean> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('jina_runtime.api_state'))");

      if (deliveryId) {
        const delivery = await client.query(
          `insert into jina_runtime.github_deliveries (delivery_id)
           values ($1)
           on conflict do nothing
           returning delivery_id`,
          [deliveryId]
        );
        if (delivery.rowCount !== 1) {
          await client.query("rollback");
          return false;
        }
      }

      await client.query(
        `insert into jina_runtime.api_state (id, snapshot)
         values (1, $1::jsonb)
         on conflict (id) do update
           set snapshot = excluded.snapshot,
               version = jina_runtime.api_state.version + 1,
               updated_at = now()`,
        [JSON.stringify(snapshot)]
      );
      await client.query("commit");
      return true;
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

  private initialize(): Promise<void> {
    this.initialized ??= this.manageSchema ? this.createSchema() : Promise.resolve();
    return this.initialized;
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      create schema if not exists jina_runtime;

      create table if not exists jina_runtime.api_state (
        id smallint primary key check (id = 1),
        snapshot jsonb not null,
        version bigint not null default 1,
        updated_at timestamptz not null default now()
      );

      create table if not exists jina_runtime.github_deliveries (
        delivery_id text primary key,
        received_at timestamptz not null default now()
      );
    `);
  }
}
