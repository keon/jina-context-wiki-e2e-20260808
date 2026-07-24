import type { Pool, PoolClient } from "pg";

const POSTGRES_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Bounds both pool checkout and the query itself. A timed-out query has its
 * client destroyed so an abandoned HTTP probe cannot leave database work
 * running in the background.
 */
export async function pingPostgresPool(pool: Pool): Promise<void> {
  const deadline = Date.now() + POSTGRES_HEALTH_TIMEOUT_MS;
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
    }
    throw error;
  }
}

function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("Postgres health check timed out"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Postgres health check timed out")), remaining);
    timer.unref();
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
