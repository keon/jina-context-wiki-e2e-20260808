import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  API_BOARD_STATE_CONNECTION_TIMEOUT_MS,
  API_BOARD_STATE_IDLE_TIMEOUT_MS,
  API_BOARD_STATE_POOL_MAX,
  createDedicatedBoardStateStore
} from "./postgres-runtime-config.js";

test("Board state factory strips the shared pool and bounds dedicated checkout", () => {
  const sharedPool = {} as Pool;
  let received: Parameters<typeof createDedicatedBoardStateStore>[0];
  const marker = createDedicatedBoardStateStore(
    {
      connectionString: "postgresql://runtime.example/jina",
      pool: sharedPool,
      max: 99,
      connectionTimeoutMillis: 90_000,
      idleTimeoutMillis: 120_000,
      applicationName: "shared-context-product",
      manageSchema: false
    },
    (config) => {
      received = config;
      return "created";
    }
  );

  assert.equal(marker, "created");
  assert.ok(received);
  assert.equal(Object.hasOwn(received, "pool"), false);
  assert.equal(received.max, API_BOARD_STATE_POOL_MAX);
  assert.equal(received.connectionTimeoutMillis, API_BOARD_STATE_CONNECTION_TIMEOUT_MS);
  assert.equal(received.idleTimeoutMillis, API_BOARD_STATE_IDLE_TIMEOUT_MS);
  assert.equal(received.applicationName, "jina-api-board-state");
  assert.equal(received.connectionString, "postgresql://runtime.example/jina");
  assert.equal(received.manageSchema, false);
  assert.ok(API_BOARD_STATE_POOL_MAX <= 2);
  assert.ok(API_BOARD_STATE_CONNECTION_TIMEOUT_MS < 10_000);
  assert.equal(API_BOARD_STATE_IDLE_TIMEOUT_MS, 30_000);
});

test("Board state factory stays disabled without PostgreSQL configuration", () => {
  let constructed = false;
  const store = createDedicatedBoardStateStore(undefined, () => {
    constructed = true;
    return "unexpected";
  });

  assert.equal(store, undefined);
  assert.equal(constructed, false);
});
