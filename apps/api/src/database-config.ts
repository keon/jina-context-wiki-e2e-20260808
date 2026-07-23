import type { PostgresJsonStateStoreConfig } from "@jina/db";

export interface DatabaseConfigs {
  readonly primary?: PostgresJsonStateStoreConfig;
  readonly graph?: PostgresJsonStateStoreConfig;
  readonly graphIsDedicated: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

const GRAPH_DATABASE_KEYS = [
  "GRAPH_DATABASE_URL",
  "GRAPH_INSTANCE_UNIX_SOCKET",
  "GRAPH_DB_HOST",
  "GRAPH_DB_PORT",
  "GRAPH_DB_USER",
  "GRAPH_DB_PASS",
  "GRAPH_DB_NAME"
] as const;

/**
 * Resolve the control-plane and graph data-plane connections independently.
 *
 * Deployments opt into physical graph isolation with GRAPH_DB_* variables.
 * Local and rollback environments that omit every graph-specific variable keep
 * the historical single-database behavior.
 */
export function resolveDatabaseConfigs(environment: Environment): DatabaseConfigs {
  const primary = resolveDatabaseConfig(environment, "");
  const graphIsDedicated = GRAPH_DATABASE_KEYS.some((key) => Boolean(environment[key]?.trim()));
  const graph = graphIsDedicated ? resolveDatabaseConfig(environment, "GRAPH_") : primary;
  return {
    ...(primary ? { primary } : {}),
    ...(graph ? { graph } : {}),
    graphIsDedicated
  };
}

function resolveDatabaseConfig(
  environment: Environment,
  prefix: "" | "GRAPH_"
): PostgresJsonStateStoreConfig | undefined {
  const connectionString = environment[`${prefix}DATABASE_URL`]?.trim();
  const host = environment[`${prefix}INSTANCE_UNIX_SOCKET`]?.trim() ?? environment[`${prefix}DB_HOST`]?.trim();
  if (!connectionString && !host) {
    if (prefix === "GRAPH_") {
      throw new Error(
        "GRAPH_DATABASE_URL or GRAPH_INSTANCE_UNIX_SOCKET/GRAPH_DB_HOST is required when graph database settings are provided"
      );
    }
    return undefined;
  }
  if (connectionString) return { connectionString };

  const portValue = environment[`${prefix}DB_PORT`]?.trim();
  const port = portValue ? positivePort(portValue, `${prefix}DB_PORT`) : undefined;
  return {
    host,
    user: requiredEnvironment(environment, `${prefix}DB_USER`),
    password: requiredEnvironment(environment, `${prefix}DB_PASS`),
    database: requiredEnvironment(environment, `${prefix}DB_NAME`),
    ...(port !== undefined ? { port } : {})
  };
}

function requiredEnvironment(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when PostgreSQL storage is enabled`);
  return value;
}

function positivePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}
