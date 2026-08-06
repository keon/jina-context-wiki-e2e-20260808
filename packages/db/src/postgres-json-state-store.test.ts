import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { PostgresJsonStateStore } from "./postgres-json-state-store.js";

test("a state store does not close a process-owned shared pool", async () => {
  let closeCalls = 0;
  const sharedPool = {
    end: async () => {
      closeCalls += 1;
    }
  } as unknown as Pool;
  const store = new PostgresJsonStateStore({ pool: sharedPool, manageSchema: false });

  await store.close();

  assert.equal(closeCalls, 0);
});
