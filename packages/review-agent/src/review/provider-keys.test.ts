import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { resolveProviderKeys } from "./provider-keys.js";

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

beforeEach(() => {
  process.env.API_BASE_URL = "https://api.example";
  process.env.INTERNAL_API_TOKEN = "internal-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("resolveProviderKeys returns a user OpenRouter key when one is configured", async () => {
  stubFetch(() => new Response(JSON.stringify({ openrouter_api_key: "or-user-key" }), { status: 200 }));
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { openrouter: "or-user-key", source: "user" });
});

test("resolveProviderKeys prefers a Codex harness auth blob over an OpenRouter key", async () => {
  // Harness beats user openrouter beats managed: when the PR author connected a
  // ChatGPT-subscription harness, the run goes native even if a tenant OpenRouter
  // key is also present.
  stubFetch(
    () =>
      new Response(
        JSON.stringify({
          codex_harness_auth: '{"tokens":{"access_token":"a"}}',
          codex_harness_connected_at_ms: 1_784_000_000_123,
          harness_owner_login: "author",
          openrouter_api_key: "or-user-key"
        }),
        { status: 200 }
      )
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, {
    codexHarnessAuth: '{"tokens":{"access_token":"a"}}',
    codexHarnessConnectedAtMs: 1_784_000_000_123,
    source: "harness"
  });
});

test("resolveProviderKeys ignores the deprecated codex_harness_model field", async () => {
  // The per-author model pin is gone (per-stage models drive harness runs); a legacy API response
  // still carrying the field must not leak it into the resolved keys.
  stubFetch(
    () =>
      new Response(
        JSON.stringify({ codex_harness_auth: '{"tokens":{"access_token":"a"}}', codex_harness_model: "gpt-5.4-mini" }),
        { status: 200 }
      )
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { codexHarnessAuth: '{"tokens":{"access_token":"a"}}', source: "harness" });
});

test("resolveProviderKeys falls back to the OpenRouter key when no harness is connected", async () => {
  stubFetch(
    () => new Response(JSON.stringify({ codex_harness_auth: null, openrouter_api_key: "or-user-key" }), { status: 200 })
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { openrouter: "or-user-key", source: "user" });
});

test("resolveProviderKeys returns a BYOK native OpenAI key as a 'user' run", async () => {
  // A tenant native OpenAI key (no harness, no openrouter) routes openai/* natively under the tenant's
  // own key and classifies BYOK ("user") -> billed infra-only.
  stubFetch(
    () =>
      new Response(JSON.stringify({ openrouter_api_key: null, openai_api_key: "sk-tenant-openai" }), { status: 200 })
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { openaiApiKey: "sk-tenant-openai", source: "user" });
});

test("resolveProviderKeys carries BOTH company keys when both are present (per-model BYOK routing)", async () => {
  // The merge: a BYOK run uses both keys at once — the capture proxy sends openai/* natively under the
  // OpenAI key and everything else under the OpenRouter key. Both ride along; the run stays "user".
  stubFetch(
    () =>
      new Response(JSON.stringify({ openrouter_api_key: "or-user-key", openai_api_key: "sk-tenant-openai" }), {
        status: 200
      })
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { openrouter: "or-user-key", openaiApiKey: "sk-tenant-openai", source: "user" });
});

test("resolveProviderKeys prefers a harness blob over a native OpenAI key", async () => {
  stubFetch(
    () =>
      new Response(
        JSON.stringify({ codex_harness_auth: '{"tokens":{"access_token":"a"}}', openai_api_key: "sk-tenant-openai" }),
        { status: 200 }
      )
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { codexHarnessAuth: '{"tokens":{"access_token":"a"}}', source: "harness" });
});

test("resolveProviderKeys reports a managed run when no key is configured (null)", async () => {
  stubFetch(() => new Response(JSON.stringify({ openrouter_api_key: null }), { status: 200 }));
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { source: "managed" });
});

test("resolveProviderKeys reports a managed run when the key is absent", async () => {
  stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { source: "managed" });
});

test("resolveProviderKeys carries the OpenAI pricing map onto a managed run", async () => {
  const pricing = {
    "openai/gpt-5.4-mini": {
      input_per_token: "0.0000004",
      output_per_token: "0.0000016",
      cached_per_token: "0.0000001"
    }
  };
  stubFetch(
    () => new Response(JSON.stringify({ openrouter_api_key: null, openai_model_pricing: pricing }), { status: 200 })
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { source: "managed", openaiModelPricing: pricing });
});

test("resolveProviderKeys omits the pricing map when the API returns null for it", async () => {
  stubFetch(
    () => new Response(JSON.stringify({ openrouter_api_key: null, openai_model_pricing: null }), { status: 200 })
  );
  const keys = await resolveProviderKeys(42, "run-1");
  assert.deepEqual(keys, { source: "managed" });
});

test("resolveProviderKeys is fail-closed: a resolution failure throws instead of falling back", async () => {
  stubFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
  await assert.rejects(resolveProviderKeys(42, "run-1"));
});
