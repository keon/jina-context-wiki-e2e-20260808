import type { PostgresJsonStateStoreConfig } from "@jina/db";

export const API_BOARD_STATE_POOL_MAX = 2;
// Wiki page generation fans out concurrently (five children in the staging
// acceptance run, with a bounded planner allowed to produce more). Each child
// reads the large Board snapshot once to revalidate live cancellation authority,
// so two connections need a bounded queue window longer than one observed wave.
export const API_BOARD_STATE_CONNECTION_TIMEOUT_MS = 30_000;
export const API_BOARD_STATE_IDLE_TIMEOUT_MS = 30_000;

/**
 * Board state gets a dedicated pool so context/product query saturation cannot
 * block checkout before the state's own bounded advisory-lock acquisition.
 */
function dedicatedBoardStateStoreConfig(config: PostgresJsonStateStoreConfig): PostgresJsonStateStoreConfig {
  const {
    pool: _sharedPool,
    max: _sharedPoolMax,
    applicationName: _sharedApplicationName,
    connectionTimeoutMillis: _sharedConnectionTimeout,
    idleTimeoutMillis: _sharedIdleTimeout,
    ...database
  } = config;
  return {
    ...database,
    applicationName: "jina-api-board-state",
    max: API_BOARD_STATE_POOL_MAX,
    connectionTimeoutMillis: API_BOARD_STATE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: API_BOARD_STATE_IDLE_TIMEOUT_MS
  };
}

export function createDedicatedBoardStateStore<T>(
  config: PostgresJsonStateStoreConfig | undefined,
  factory: (dedicatedConfig: PostgresJsonStateStoreConfig) => T
): T | undefined {
  return config ? factory(dedicatedBoardStateStoreConfig(config)) : undefined;
}
