import type { Pool, PoolClient } from "pg";

const POSTGRES_HEALTH_TIMEOUT_MS = 5_000;
class PostgresHealthTimeoutError extends Error {
  constructor() {
    super("Postgres health check timed out");
    this.name = "PostgresHealthTimeoutError";
  }
}

/**
 * Probes every currently idle pool member in parallel so one healthy socket
 * cannot mask a stale sibling. An empty pool still gets one connection probe.
 */
export async function pingPostgresPool(pool: Pool, timeoutMs = POSTGRES_HEALTH_TIMEOUT_MS): Promise<void> {
  if (pool.listenerCount("error") === 0) {
    pool.on("error", (error) => {
      console.error("postgres idle connection error", error);
    });
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, pool.idleCount) }, () => pingPostgresConnection(pool, timeoutMs))
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw asError(failure.reason);
}

/**
 * Bounds both pool checkout and the query itself. A timed-out query has its
 * client destroyed so an abandoned HTTP probe cannot leave database work
 * running in the background.
 */
async function pingPostgresConnection(pool: Pool, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const connection = pool.connect();
  let client: PoolClient | undefined;
  try {
    client = await beforeDeadline(connection, deadline);
    await beforeDeadline(client.query("select 1"), deadline);
    client.release();
  } catch (error) {
    if (client) {
      client.release(asError(error));
    } else {
      // node-postgres does not expose cancellation for a queued pool checkout.
      // Release it immediately if it is eventually fulfilled.
      void connection.then((lateClient) => lateClient.release()).catch(() => undefined);
      // A pool whose existing clients are all checked out is busy, not
      // disconnected. Avoid recycling a healthy instance for request load.
      if (error instanceof PostgresHealthTimeoutError && pool.totalCount > 0 && pool.idleCount === 0) return;
    }
    throw error;
  }
}

function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new PostgresHealthTimeoutError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PostgresHealthTimeoutError()), remaining);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(asError(error));
      }
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
