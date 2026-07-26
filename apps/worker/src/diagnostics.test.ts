import assert from "node:assert/strict";
import test from "node:test";
import { workerFailureCategory } from "./diagnostics.js";

test("worker diagnostics expose only stable failure categories", () => {
  assert.equal(workerFailureCategory("GitHub request failed with 401: Bad credentials"), "github_authentication");
  assert.equal(workerFailureCategory("GitHub request failed with 403: Resource not accessible"), "github_forbidden");
  assert.equal(workerFailureCategory("GitHub request failed with 403: API rate limit exceeded"), "github_rate_limit");
  assert.equal(workerFailureCategory("GitHub request failed with 404: Not Found"), "github_not_found");
  assert.equal(workerFailureCategory("GitHub response is not an object array"), "github_response");
  assert.equal(workerFailureCategory("Unable to fetch prepared commit"), "git_checkout");
  assert.equal(workerFailureCategory("Daytona sandbox creation failed"), "daytona");
  assert.equal(workerFailureCategory("Codex contextGraph build failed"), "model");
  assert.equal(workerFailureCategory("citation path is outside the checkout"), "context_validation");
  assert.equal(workerFailureCategory("stale worker lease"), "lease");
  assert.equal(workerFailureCategory("unexpected failure with private details"), "worker_execution");
});
