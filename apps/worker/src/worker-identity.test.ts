import assert from "node:assert/strict";
import test from "node:test";
import { runtimeWorkerId } from "./worker-identity.js";

test("runtime worker identity is unique per process instance", () => {
  assert.equal(runtimeWorkerId({ configured: " explicit-worker " }), "explicit-worker");
  assert.equal(
    runtimeWorkerId({ revision: "context-worker-r1", instanceId: "instance-a" }),
    "context-worker-r1:instance-a"
  );
  assert.notEqual(
    runtimeWorkerId({ revision: "context-worker-r1" }),
    runtimeWorkerId({ revision: "context-worker-r1" })
  );
});
