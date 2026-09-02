import assert from "node:assert/strict";
import test from "node:test";

import { routeRepository } from "../src/repository-routing.js";

test("routes by immutable repository id instead of connection recency", () => {
  const route = routeRepository(1005172387, [
    {
      repositoryId: 999,
      tenantId: "om-labs-test-2",
      billingAccountId: "billing-om-labs-test-2",
      connectionVersion: 9,
      status: "active",
    },
    {
      repositoryId: 1005172387,
      tenantId: "omxyz",
      billingAccountId: "billing-omxyz",
      connectionVersion: 2,
      status: "active",
    },
  ]);

  assert.deepEqual(route, {
    tenantId: "omxyz",
    billingAccountId: "billing-omxyz",
    connectionVersion: 2,
  });
});

test("refuses ambiguous active ownership", () => {
  assert.equal(
    routeRepository(42, [
      {
        repositoryId: 42,
        tenantId: "one",
        billingAccountId: "billing-one",
        connectionVersion: 1,
        status: "active",
      },
      {
        repositoryId: 42,
        tenantId: "two",
        billingAccountId: "billing-two",
        connectionVersion: 1,
        status: "active",
      },
    ]),
    null,
  );
});
