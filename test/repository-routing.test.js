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

test("rejects inherited, accessor-backed, and malformed route fields", () => {
  const inherited = Object.create({
    repositoryId: 42,
    status: "active",
    tenantId: "inherited",
    billingAccountId: "inherited-billing",
    connectionVersion: 1,
  });
  const accessor = {
    repositoryId: 42,
    status: "active",
    get tenantId() {
      return "side-effect";
    },
    billingAccountId: "side-effect-billing",
    connectionVersion: 1,
  };
  const malformed = {
    repositoryId: 42,
    status: "active",
    tenantId: "malformed",
    billingAccountId: "malformed-billing",
    connectionVersion: 1.5,
  };

  assert.equal(routeRepository(42, [inherited, accessor, malformed]), null);
});

test("returns an immutable scalar snapshot", () => {
  const binding = {
    repositoryId: 42,
    status: "active",
    tenantId: "one",
    billingAccountId: "billing-one",
    connectionVersion: 1,
  };
  const route = routeRepository(42, [binding]);
  binding.tenantId = "two";
  binding.billingAccountId = "billing-two";

  assert.deepEqual(route, {
    tenantId: "one",
    billingAccountId: "billing-one",
    connectionVersion: 1,
  });
  assert.equal(Object.isFrozen(route), true);
});
