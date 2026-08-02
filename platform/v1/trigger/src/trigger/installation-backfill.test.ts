import assert from "node:assert/strict";
import { test } from "node:test";

import { requireBackfillResponse } from "./installation-backfill.js";

test("installation backfill requires an explicit boolean provisioning result", () => {
  for (const customer_provisioned of [true, false]) {
    assert.deepEqual(requireBackfillResponse({ ok: true, customer_provisioned }), { ok: true, customer_provisioned });
  }
  for (const response of [
    { ok: true },
    { ok: true, customer_provisioned: "true" },
    { ok: false, customer_provisioned: true },
  ]) {
    assert.throws(() => requireBackfillResponse(response), /invalid provisioning result/);
  }
});
