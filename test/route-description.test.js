import assert from "node:assert/strict";
import test from "node:test";

import { describeRepositoryRoute } from "../src/route-description.js";

test("describes an assigned repository route without using user identity", () => {
  assert.equal(
    describeRepositoryRoute({
      tenantId: "workspace-omxyz",
      billingAccountId: "billing-omxyz",
      connectionVersion: 3,
    }),
    "workspace-omxyz@v3",
  );
});

test("describes an unassigned repository explicitly", () => {
  assert.equal(describeRepositoryRoute(null), "unassigned");
});

test("rejects incomplete routing snapshots", () => {
  assert.throws(
    () => describeRepositoryRoute({ tenantId: "workspace-omxyz", connectionVersion: 3 }),
    /valid immutable routing snapshot/,
  );
});
