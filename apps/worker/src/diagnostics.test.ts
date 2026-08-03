import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableWorkerFailure, shouldRetryWorkerFailure, workerFailureCategory } from "./diagnostics.js";

test("worker diagnostics expose only stable failure categories", () => {
  assert.equal(workerFailureCategory("GitHub request failed with 401: Bad credentials"), "github_authentication");
  assert.equal(
    workerFailureCategory("GitHub installation token request failed with 401: Bad credentials"),
    "github_authentication"
  );
  assert.equal(workerFailureCategory("GitHub request failed with 403: Resource not accessible"), "github_forbidden");
  assert.equal(workerFailureCategory("GitHub request failed with 403: API rate limit exceeded"), "github_rate_limit");
  assert.equal(workerFailureCategory("GitHub request failed with 404: Not Found"), "github_not_found");
  assert.equal(workerFailureCategory("GitHub response is not an object array"), "github_response");
  assert.equal(workerFailureCategory("GitHub repository checkout timed out after 300000ms"), "github_timeout");
  assert.equal(workerFailureCategory("Unable to fetch prepared commit"), "git_checkout");
  assert.equal(workerFailureCategory("Daytona sandbox creation failed"), "daytona");
  assert.equal(workerFailureCategory("command execution timeout"), "daytona");
  assert.equal(workerFailureCategory("Operation timed out"), "daytona");
  assert.equal(workerFailureCategory("Codex context build failed"), "model");
  assert.equal(
    workerFailureCategory("stream disconnected before completion: Codex provider websocket failed"),
    "model"
  );
  assert.equal(
    workerFailureCategory(
      "board agent stage repair-context-projection-and-indexing-md-7 exited with 1: Reading prompt from stdin..."
    ),
    "model"
  );
  assert.equal(workerFailureCategory("board agent stage audit-citation-contract exceeded its 600s budget"), "model");
  assert.equal(workerFailureCategory("citation path is outside the checkout"), "context_validation");
  assert.equal(
    workerFailureCategory("source_challenge_contract: source challenge worker id must be source-challenge-0"),
    "context_validation"
  );
  assert.equal(
    workerFailureCategory("research maintenance question is absent from the page plan"),
    "context_validation"
  );
  assert.equal(
    workerFailureCategory("Context API /internal/context/board/artifacts failed with 503: unavailable"),
    "api_transport"
  );
  assert.equal(workerFailureCategory("stale worker lease"), "lease");
  assert.equal(workerFailureCategory("unexpected failure with private details"), "worker_execution");
});

test("only transient failures and bounded source-challenge corrections retry", () => {
  for (const reason of [
    "Daytona sandbox creation failed",
    "command execution timeout",
    "Operation timed out",
    "OpenAI model_provider temporarily unavailable",
    "board agent stage repair-context-projection-and-indexing-md-7 exited with 1: Reading prompt from stdin...",
    "board agent stage audit-citation-contract exceeded its 600s budget",
    "GitHub request failed with 429: rate limit",
    "GitHub request timed out",
    "GitHub repository checkout timed out after 300000ms",
    "GitHub request failed with 503: service unavailable",
    "Context API /internal/context/board/artifacts failed with 502: bad gateway",
    "This operation was aborted",
    "fetch failed: ECONNRESET",
    "source_challenge_contract: source challenge worker id must be source-challenge-0"
  ]) {
    assert.equal(isRetryableWorkerFailure(reason), true, reason);
  }
  for (const reason of [
    "citation path is outside the checkout",
    "publication plan does not match repository subjects",
    "research plan schema is invalid",
    "GitHub request failed with 401: Bad credentials",
    "GitHub request failed with 404: Not Found",
    "Unable to fetch prepared commit",
    "stale worker lease",
    "unexpected failure with private details"
  ]) {
    assert.equal(isRetryableWorkerFailure(reason), false, reason);
  }
  assert.equal(
    shouldRetryWorkerFailure("Daytona sandbox creation failed", {
      attempt: 3,
      maxAttempts: 4
    }),
    true
  );
  assert.equal(
    shouldRetryWorkerFailure("Daytona sandbox creation failed", {
      attempt: 4,
      maxAttempts: 4
    }),
    false
  );
  assert.equal(
    shouldRetryWorkerFailure("citation schema is invalid", {
      attempt: 1,
      maxAttempts: 4
    }),
    false
  );
  assert.equal(
    shouldRetryWorkerFailure("source_challenge_contract: source challenge worker id must be source-challenge-0", {
      attempt: 4,
      maxAttempts: 4
    }),
    false
  );
});

test("credential, quota, and selected-model failures fail once so owners can act", () => {
  for (const reason of [
    "context_provider_configuration: connect an OpenAI key",
    "Codex failed: usage limit reached",
    "OpenAI: invalid API key",
    "provider returned unknown model"
  ]) {
    assert.equal(isRetryableWorkerFailure(reason), false, reason);
  }
});

test("execution-profile transport statuses retry only when another request can repair them", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(
      isRetryableWorkerFailure(`Context API execution-profile request failed with ${status}`),
      true,
      String(status)
    );
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(
      isRetryableWorkerFailure(`Context API execution-profile request failed with ${status}`),
      false,
      String(status)
    );
  }
});
