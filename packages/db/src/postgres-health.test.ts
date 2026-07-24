import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { pingPostgresPool } from "./postgres-health.js";

test("Postgres health probes every idle pool member and waits for the full sweep", async () => {
  let connectCount = 0;
  let releaseHealthy: (() => void) | undefined;
  const healthyQuery = new Promise<void>((resolve) => {
    releaseHealthy = resolve;
  });
  const releases: { readonly client: number; readonly error: boolean }[] = [];
  const pool = Object.assign(new EventEmitter(), {
    idleCount: 2,
    totalCount: 2,
    async connect() {
      connectCount += 1;
      const clientId = connectCount;
      return {
        async query() {
          if (clientId === 1) await healthyQuery;
          else throw new Error("stale socket");
        },
        release(error?: Error | boolean) {
          releases.push({ client: clientId, error: Boolean(error) });
        }
      } as unknown as PoolClient;
    }
  }) as unknown as Pool;

  let settled = false;
  const outcome = pingPostgresPool(pool).then(
    () => "resolved",
    (error: unknown) => {
      assert.match(String(error), /stale socket/);
      return "rejected";
    }
  );
  void outcome.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connectCount, 2);
  assert.equal(pool.listenerCount("error"), 1);
  assert.equal(settled, false);
  releaseHealthy?.();
  assert.equal(await outcome, "rejected");
  assert.deepEqual(releases, [
    { client: 2, error: true },
    { client: 1, error: false }
  ]);
});

test("Postgres health does not fail solely because a healthy pool is fully busy", async () => {
  let checkoutStarted = false;
  let fulfillCheckout: ((client: PoolClient) => void) | undefined;
  const checkout = new Promise<PoolClient>((resolve) => {
    fulfillCheckout = resolve;
  });
  let lateReleaseCount = 0;
  const poolEvents = Object.assign(new EventEmitter(), {
    totalCount: 1,
    connect() {
      checkoutStarted = true;
      return checkout;
    }
  });
  Object.defineProperty(poolEvents, "idleCount", {
    get: () => (checkoutStarted ? 0 : 1)
  });
  const pool = poolEvents as unknown as Pool;

  await pingPostgresPool(pool, 10);
  fulfillCheckout?.({
    release() {
      lateReleaseCount += 1;
    }
  } as unknown as PoolClient);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lateReleaseCount, 1);
});
