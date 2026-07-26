import { createHash } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { applySchema } from "../apply-schema.js";
import { CONTEXT_ROLES_SQL } from "./roles.js";
import { CONTEXT_SCHEMA_SQL } from "./schema.js";

export interface PostgresContextDatabaseConfig extends PoolConfig {
  readonly manageSchema?: boolean;
  readonly manageRoles?: boolean;
}

export class ContextDatabase {
  readonly pool: Pool;
  private readonly manageSchema: boolean;
  private readonly manageRoles: boolean;
  private initialized?: Promise<void>;

  constructor(config: PostgresContextDatabaseConfig) {
    const { manageSchema = true, manageRoles = false, ...poolConfig } = config;
    this.manageSchema = manageSchema;
    this.manageRoles = manageRoles;
    this.pool = new Pool({
      ...poolConfig,
      application_name: "jina-context",
      max: poolConfig.max ?? 10
    });
  }

  initialize(): Promise<void> {
    return (this.initialized ??= this.initializeOnce());
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
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

  private async initializeOnce(): Promise<void> {
    if (this.manageSchema) {
      await applySchema(this.pool, "jina_context.schema", CONTEXT_SCHEMA_SQL);
    }
    if (this.manageRoles) {
      await applySchema(this.pool, "jina_context.roles", CONTEXT_ROLES_SQL);
    }
  }
}

export function contextDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function contextStableId(prefix: string, value: unknown): string {
  return `${prefix}_${contextDigest(value).slice(0, 32)}`;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function dateString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
