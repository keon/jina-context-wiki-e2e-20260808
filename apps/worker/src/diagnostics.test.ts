import assert from "node:assert/strict";
import test from "node:test";
import { workerFailureCategory } from "./diagnostics.js";

test("worker diagnostics expose only stable failure categories", () => {
  assert.equal(workerFailureCategory("GitHub request failed with 401: Bad credentials"), "github");
  assert.equal(workerFailureCategory("Daytona sandbox creation failed"), "daytona");
  assert.equal(workerFailureCategory("Codex ontology build failed"), "model");
  assert.equal(workerFailureCategory("citation path is outside the checkout"), "ontology_validation");
  assert.equal(workerFailureCategory("stale worker lease"), "lease");
  assert.equal(workerFailureCategory("unexpected failure with private details"), "worker_execution");
});
