import assert from "node:assert/strict";
import { test } from "node:test";

import { InternalApiError, internalApiLogPayload, postInternal, safeLogPreview } from "./api.js";

test("internalApiLogPayload omits request bodies and redacts response secrets", () => {
  const payload = internalApiLogPayload({
    path: "/internal/provider-keys",
    status: 200,
    durationMs: 42,
    response: {
      ok: true,
      openai_api_key: "sk-secret-openai-value",
      anthropic_api_key: "secret-anthropic-value",
      nested: {
        token: "github-token-value",
        authorization: "Bearer bearer-token-value",
      },
    },
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.path, "/internal/provider-keys");
  assert.equal(payload.status, 200);
  assert.equal(payload.duration_ms, 42);
  assert.equal("body" in payload, false);
  assert.equal("headers" in payload, false);
  assert.match(serialized, /response_preview/);
  assert.doesNotMatch(serialized, /sk-secret-openai-value/);
  assert.doesNotMatch(serialized, /secret-anthropic-value/);
  assert.doesNotMatch(serialized, /github-token-value/);
  assert.doesNotMatch(serialized, /bearer-token-value/);
});

test("internalApiLogPayload redacts error previews", () => {
  const payload = internalApiLogPayload({
    path: "/internal/reviews/prepare",
    durationMs: 13,
    error: new Error("request failed with Authorization: Bearer secret-token-value and api_key=sk-secret-value"),
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.success, false);
  assert.match(serialized, /error_preview/);
  assert.doesNotMatch(serialized, /secret-token-value/);
  assert.doesNotMatch(serialized, /sk-secret-value/);
});

test("postInternal throws an InternalApiError carrying the HTTP status on a non-2xx", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.API_BASE_URL;
  const originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.API_BASE_URL = "https://api.example.test";
  process.env.INTERNAL_API_TOKEN = "internal-token";
  const responseBody = {
    error: "insufficient credits",
    details: {
      review_run_id: "run-1",
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(responseBody), {
      status: 402,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    await assert.rejects(
      postInternal("/internal/reviews/prepare", { hello: "world" }),
      (error: unknown) => {
        assert.ok(error instanceof InternalApiError);
        assert.equal(error.status, 402);
        assert.deepEqual(error.response, responseBody);
        // Message format is unchanged from the prior plain Error for compatibility.
        assert.match(error.message, /^API \/internal\/reviews\/prepare returned 402: /);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("API_BASE_URL", originalBaseUrl);
    restoreEnv("INTERNAL_API_TOKEN", originalToken);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("safeLogPreview truncates long payload and error previews", () => {
  const preview = safeLogPreview({ message: "x".repeat(2_000) }, 120);

  assert.ok(preview.length <= 120);
  assert.match(preview, /\.\.\.$/);
});

// PR #141 re-review: the resolve endpoint returns the decrypted Codex auth.json blob for
// harness runs; it must never survive into response_preview logs — neither as an object
// field nor as JSON-quoted token fields inside a string payload.
test("safeLogPreview redacts codex harness auth blobs and JSON-quoted token fields", () => {
  const blob = JSON.stringify({ tokens: { refresh_token: "rt-SUPERSECRET-1", access_token: "at-SUPERSECRET-2" } });

  const objectPreview = safeLogPreview({ codex_harness_auth: blob, request_id: "req-1", ok: true });
  assert.ok(!objectPreview.includes("SUPERSECRET"), "object field must be redacted");
  assert.match(objectPreview, /\*\*\*REDACTED\*\*\*/);

  const stringPreview = safeLogPreview(`resolved: ${blob}`);
  assert.ok(!stringPreview.includes("rt-SUPERSECRET-1"), "quoted refresh_token must be redacted");
  assert.ok(!stringPreview.includes("at-SUPERSECRET-2"), "quoted access_token must be redacted");
});
