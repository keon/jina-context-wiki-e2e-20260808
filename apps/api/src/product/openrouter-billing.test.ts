import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { ApiError } from "./errors.js";
import { encryptSecret } from "./crypto.js";
import { parseUsageRequestBody } from "./internal.js";
import {
  callbackFlowMatchesBinding,
  decodeVerifierBinding,
  deriveCodeChallenge,
  encodeVerifierBinding,
  generateCodeVerifier,
} from "./openrouter-oauth.js";
import {
  getOpenAiModelPricing,
  getOpenRouterCatalog,
  openAiModelPricing,
  parseModelSettingsBody,
  resetCatalogCache,
  validateModelSettingsSlugs,
  type CatalogModel,
} from "./model-settings.js";
import {
  getUserIntegrations,
  PLATFORM_BILLING_POLICY,
  policyFromRow,
  usageBillingStatus,
  usageDedupeKey,
} from "./store.js";

// FINDING 4b: decodeVerifierBinding now REQUIRES an authenticated encryption envelope, so the PKCE
// binding tests need a real key. Set it at module load, before any crypto.ts call caches the key
// (this test file runs in its own node:test process, so no cross-file contamination).
process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/* ---------------------------------------------------------- dedupe key --- */

test("usageDedupeKey prefers the generation id when present", () => {
  assert.equal(usageDedupeKey("sbx-1", { generation_id: "gen-abc", request_seq: 3 }), "gen-abc");
});

test("usageDedupeKey falls back to sandbox:request_seq when generation id is missing/blank", () => {
  assert.equal(usageDedupeKey("sbx-1", { request_seq: 3 }), "sbx-1:3");
  assert.equal(usageDedupeKey("sbx-1", { generation_id: "   ", request_seq: 7 }), "sbx-1:7");
});

/* ----------------------------------------------------- billing status --- */

test("usageBillingStatus is not_billable for user keys and pending_outcome for managed when billing is active", () => {
  assert.equal(usageBillingStatus("user", true), "not_billable");
  assert.equal(usageBillingStatus("managed", true), "pending_outcome");
});

// FINDING 2: when billing is inactive (enforce=off or no secret) managed rows must NOT accrue as
// pending_outcome — a later flip to 'on' would back-bill them. Inactive persists telemetry only.
test("usageBillingStatus is not_billable for managed rows when billing is inactive (enforce=off)", () => {
  assert.equal(usageBillingStatus("managed", false), "not_billable");
  assert.equal(usageBillingStatus("user", false), "not_billable");
});

// Own-harness AI runs on the PR author's own subscription and is NEVER billed for managed AI — it is
// treated exactly like a 'user' (own-key) row, so it is not_billable whether billing is active or not.
test("usageBillingStatus is not_billable for harness rows (own-subscription AI, never billed)", () => {
  assert.equal(usageBillingStatus("harness", true), "not_billable");
  assert.equal(usageBillingStatus("harness", false), "not_billable");
});

/* ------------------------------------------------- usage body validation --- */

const validUsageBody = {
  stage: "runtime",
  sandbox_id: "sbx-1",
  key_source: "managed",
  usage_records: [
    { operation: "planner", request_seq: 1, cost: "0.0123", raw_usage: { total_tokens: 10 } },
  ],
};

test("parseUsageRequestBody accepts a well-formed body and keeps cost as a string", () => {
  const parsed = parseUsageRequestBody(validUsageBody);
  assert.equal(parsed.stage, "runtime");
  assert.equal(parsed.sandbox_id, "sbx-1");
  assert.equal(parsed.key_source, "managed");
  assert.equal(parsed.usage_records.length, 1);
  assert.equal(parsed.usage_records[0].cost, "0.0123");
  assert.equal(typeof parsed.usage_records[0].cost, "string");
});

// The trigger types already admit key_source "harness" (native/own-harness usage); the parser must
// accept it rather than 400 if such usage ever posts. "user"/"managed" remain valid; anything else 400s.
test("parseUsageRequestBody accepts key_source 'harness'", () => {
  assert.equal(parseUsageRequestBody({ ...validUsageBody, key_source: "harness" }).key_source, "harness");
  assert.equal(parseUsageRequestBody({ ...validUsageBody, key_source: "user" }).key_source, "user");
});

test("parseUsageRequestBody rejects an unknown key_source", () => {
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, key_source: "other" }), ApiError);
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, key_source: undefined }), ApiError);
});

test("parseUsageRequestBody rejects a non-object body", () => {
  assert.throws(() => parseUsageRequestBody(null), ApiError);
  assert.throws(() => parseUsageRequestBody([]), ApiError);
  assert.throws(() => parseUsageRequestBody("nope"), ApiError);
});

test("parseUsageRequestBody rejects a missing/invalid stage", () => {
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, stage: undefined }), ApiError);
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, stage: "other" }), ApiError);
});

test("parseUsageRequestBody rejects a missing sandbox_id", () => {
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, sandbox_id: undefined }), ApiError);
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, sandbox_id: "" }), ApiError);
});

test("parseUsageRequestBody rejects a non-array usage_records", () => {
  assert.throws(() => parseUsageRequestBody({ ...validUsageBody, usage_records: {} }), ApiError);
});

test("parseUsageRequestBody rejects a record missing operation or raw_usage", () => {
  assert.throws(
    () => parseUsageRequestBody({ ...validUsageBody, usage_records: [{ request_seq: 1, raw_usage: {} }] }),
    ApiError,
  );
  assert.throws(
    () => parseUsageRequestBody({ ...validUsageBody, usage_records: [{ operation: "planner", request_seq: 1 }] }),
    ApiError,
  );
});

/* --------------- FINDING C: DB-invalid numerics must 400 (not 5xx-loop on insert) --- */

function withRecord(overrides: Record<string, unknown>) {
  return { ...validUsageBody, usage_records: [{ operation: "planner", request_seq: 1, raw_usage: { total_tokens: 1 }, ...overrides }] };
}

test("parseUsageRequestBody rejects a non-integer request_seq (integer column)", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ request_seq: 1.5 })), ApiError);
});

test("parseUsageRequestBody rejects a negative request_seq", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ request_seq: -1 })), ApiError);
});

test("parseUsageRequestBody rejects a non-numeric request_seq", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ request_seq: "3" })), ApiError);
});

test("parseUsageRequestBody rejects a non-decimal cost string (numeric column)", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "not-a-number" })), ApiError);
});

test("parseUsageRequestBody rejects a negative or signed cost string", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "-0.5" })), ApiError);
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "+0.5" })), ApiError);
});

test("parseUsageRequestBody rejects a non-string cost", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: 0.5 })), ApiError);
});

test("parseUsageRequestBody rejects an invalid upstream_inference_cost", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ upstream_inference_cost: "abc" })), ApiError);
});

test("parseUsageRequestBody rejects a non-integer token count (bigint column)", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ prompt_tokens: 1.5 })), ApiError);
  assert.throws(() => parseUsageRequestBody(withRecord({ completion_tokens: -3 })), ApiError);
});

test("parseUsageRequestBody accepts valid decimals, integer tokens, and absent optional fields", () => {
  const parsed = parseUsageRequestBody(
    withRecord({ request_seq: 0, cost: "12", upstream_inference_cost: "0.00012345", prompt_tokens: 10, cached_tokens: 0 }),
  );
  const record = parsed.usage_records[0];
  assert.equal(record.request_seq, 0);
  assert.equal(record.cost, "12");
  assert.equal(record.upstream_inference_cost, "0.00012345");
  assert.equal(record.prompt_tokens, 10);
  assert.equal(record.cached_tokens, 0);
  // Absent cost / tokens stay undefined (treated as "not provided", not rejected).
  assert.equal(record.total_tokens, undefined);
});

test("parseUsageRequestBody treats an empty-string cost as absent", () => {
  const parsed = parseUsageRequestBody(withRecord({ cost: "" }));
  assert.equal(parsed.usage_records[0].cost, undefined);
});

/* ---------- FINDING 5: the proxy preserves wire literals — exponent notation must not 400 --- */

test("parseUsageRequestBody accepts scientific-notation cost literals, normalized exactly (FINDING 5)", () => {
  assert.equal(parseUsageRequestBody(withRecord({ cost: "1e-7" })).usage_records[0].cost, "0.0000001");
  assert.equal(parseUsageRequestBody(withRecord({ cost: "2.5E-6" })).usage_records[0].cost, "0.0000025");
  assert.equal(parseUsageRequestBody(withRecord({ cost: "1.23456789012e2" })).usage_records[0].cost, "123.456789012");
  assert.equal(
    parseUsageRequestBody(withRecord({ upstream_inference_cost: "1.5e-7" })).usage_records[0].upstream_inference_cost,
    "0.00000015",
  );
});

test("parseUsageRequestBody keeps full precision beyond 8 fractional digits (numeric(18,8) rounds on insert)", () => {
  // No truncation here — 0.0123456789012 has 13 fractional digits and is passed through intact.
  assert.equal(parseUsageRequestBody(withRecord({ cost: "1.23456789012e-2" })).usage_records[0].cost, "0.0123456789012");
});

test("parseUsageRequestBody still rejects malformed exponent literals (FINDING 5)", () => {
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "-1e-7" })), ApiError);
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "1e" })), ApiError);
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "e7" })), ApiError);
  assert.throws(() => parseUsageRequestBody(withRecord({ cost: "NaN" })), ApiError);
  assert.throws(() => parseUsageRequestBody(withRecord({ upstream_inference_cost: "1e1.5" })), ApiError);
});

/* ----------------------------------------------------------- PKCE --- */

test("generateCodeVerifier is base64url and at least 43 chars", () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43, `expected >=43 chars, got ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test("deriveCodeChallenge is S256 base64url(sha256(verifier))", () => {
  const verifier = "test-verifier-1234567890";
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(deriveCodeChallenge(verifier), expected);
  assert.match(deriveCodeChallenge(verifier), /^[A-Za-z0-9_-]+$/);
});

/* --------------------------------------------- catalog validation --- */

const catalog: CatalogModel[] = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", context_length: null, pricing: { prompt_per_1m: null, completion_per_1m: null } },
  { id: "anthropic/claude", name: "Claude", context_length: null, pricing: { prompt_per_1m: null, completion_per_1m: null } },
];

test("validateModelSettingsSlugs accepts known slugs", async () => {
  await assert.doesNotReject(
    validateModelSettingsSlugs(
      { planner_model: "openai/gpt-5.5", investigation_model: null, review_model: "anthropic/claude" },
      async () => catalog,
    ),
  );
});

test("validateModelSettingsSlugs rejects an unknown slug", async () => {
  await assert.rejects(
    validateModelSettingsSlugs(
      { planner_model: "made/up-model", investigation_model: null, review_model: null },
      async () => catalog,
    ),
    ApiError,
  );
});

test("validateModelSettingsSlugs fails open when the catalog cannot be loaded", async () => {
  await assert.doesNotReject(
    validateModelSettingsSlugs(
      { planner_model: "made/up-model", investigation_model: null, review_model: null },
      async () => {
        throw new Error("catalog down");
      },
    ),
  );
});

/* --------------------------------------- slug shape on the fail-open path (FINDING 6) --- */

const catalogDown = async (): Promise<CatalogModel[]> => {
  throw new Error("catalog down");
};

test("catalog-down fail-open still accepts slugs matching the OpenRouter shape (FINDING 6)", async () => {
  for (const slug of ["openai/gpt-5.5", "z-ai/glm-4.7", "anthropic/claude-3.5:beta", "meta_llama/llama-3.1"]) {
    await assert.doesNotReject(
      validateModelSettingsSlugs({ planner_model: slug, investigation_model: null, review_model: null }, catalogDown),
      `expected shape-valid slug to pass: ${slug}`,
    );
  }
});

test("catalog-down fail-open 400s a slug that violates the OpenRouter shape (FINDING 6)", async () => {
  for (const slug of [
    "no-slash-at-all",
    "/leading-slash",
    "trailing-slash/",
    "-bad/leading-dash",
    "openai/-leading-dash",
    "openai/model with spaces",
    "openai/model;rm -rf",
    'openai/"quoted"',
    "a/b/c-extra-segment",
  ]) {
    await assert.rejects(
      validateModelSettingsSlugs({ planner_model: slug, investigation_model: null, review_model: null }, catalogDown),
      ApiError,
      `expected shape-invalid slug to 400: ${slug}`,
    );
  }
});

/* --------------------------------------------- native OpenAI pricing map --- */

const pricingCatalog: CatalogModel[] = [
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    context_length: null,
    pricing: { prompt_per_1m: null, completion_per_1m: null },
    native_pricing: { input: "0.0000004", output: "0.0000016", cached: "0.0000001" },
  },
  {
    // cached omitted -> defaults to the input rate.
    id: "openai/gpt-5.4-mini",
    name: "GPT-5.4 mini",
    context_length: null,
    pricing: { prompt_per_1m: null, completion_per_1m: null },
    native_pricing: { input: "0.0000003", output: "0.0000012", cached: null },
  },
  {
    // missing output price -> cannot be priced -> skipped entirely.
    id: "openai/no-output-price",
    name: "No output price",
    context_length: null,
    pricing: { prompt_per_1m: null, completion_per_1m: null },
    native_pricing: { input: "0.0000003", output: null, cached: null },
  },
  {
    // non-openai/* id -> excluded from the native map.
    id: "anthropic/claude",
    name: "Claude",
    context_length: null,
    pricing: { prompt_per_1m: null, completion_per_1m: null },
    native_pricing: { input: "0.000001", output: "0.000002", cached: null },
  },
];

test("openAiModelPricing builds a per-token map for openai/* models; cached defaults to input; skips unpriced and non-openai", () => {
  assert.deepEqual(openAiModelPricing(pricingCatalog), {
    "openai/gpt-5.5": { input_per_token: "0.0000004", output_per_token: "0.0000016", cached_per_token: "0.0000001" },
    "openai/gpt-5.4-mini": { input_per_token: "0.0000003", output_per_token: "0.0000012", cached_per_token: "0.0000003" },
  });
});

test("getOpenRouterCatalog retains the raw per-token pricing (native_pricing) for cost", async () => {
  resetCatalogCache();
  await withStubbedFetch(
    {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "openai/gpt-5.5",
            name: "GPT-5.5",
            pricing: { prompt: "0.0000004", completion: "0.0000016", cached_input: "0.0000001" },
          },
        ],
      }),
    },
    async () => {
      const [model] = await getOpenRouterCatalog();
      // cached is read from the alternate `cached_input` spelling when `cached` is absent.
      assert.deepEqual(model.native_pricing, { input: "0.0000004", output: "0.0000016", cached: "0.0000001" });
      assert.deepEqual(openAiModelPricing([model]), {
        "openai/gpt-5.5": { input_per_token: "0.0000004", output_per_token: "0.0000016", cached_per_token: "0.0000001" },
      });
    },
  );
  resetCatalogCache();
});

test("getOpenAiModelPricing returns {} when the catalog is unavailable, else the mapped catalog", async () => {
  assert.deepEqual(await getOpenAiModelPricing(catalogDown), {});
  assert.deepEqual(await getOpenAiModelPricing(async () => pricingCatalog), openAiModelPricing(pricingCatalog));
});

/* ------------------------------------------- catalog fetch failure (FINDING 7) --- */

function withStubbedFetch(response: Partial<Response> & { ok: boolean }, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response as Response);
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("getOpenRouterCatalog treats a malformed-JSON 200 as a failure and does not cache it (FINDING 7)", async () => {
  resetCatalogCache();
  await withStubbedFetch(
    {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      text: async () => "<html>oops</html>",
    },
    async () => {
      await assert.rejects(getOpenRouterCatalog(), /empty or malformed/);
    },
  );
  // Nothing was cached: a subsequent good fetch must repopulate rather than return a stale empty set.
  await withStubbedFetch(
    { ok: true, status: 200, json: async () => ({ data: [{ id: "openai/gpt-5.5", name: "GPT-5.5" }] }) },
    async () => {
      const models = await getOpenRouterCatalog();
      assert.deepEqual(models, [
        {
          id: "openai/gpt-5.5",
          name: "GPT-5.5",
          context_length: null,
          pricing: { prompt_per_1m: null, completion_per_1m: null },
          native_pricing: { input: null, output: null, cached: null },
        },
      ]);
    },
  );
  resetCatalogCache();
});

test("getOpenRouterCatalog treats an empty-list 200 as a failure and does not cache it (FINDING 7)", async () => {
  resetCatalogCache();
  await withStubbedFetch({ ok: true, status: 200, json: async () => ({ data: [] }) }, async () => {
    await assert.rejects(getOpenRouterCatalog(), /empty or malformed/);
  });
  // A malformed catalog is never cached, so validation still fails OPEN (accept + warn) when it
  // loads the (throwing) catalog — mirrors an unreachable catalog.
  await assert.doesNotReject(
    validateModelSettingsSlugs(
      { planner_model: "made/up-model", investigation_model: null, review_model: null },
      async () => {
        throw new Error("openrouter models response was empty or malformed");
      },
    ),
  );
  resetCatalogCache();
});

/* --------------------------------------------- PKCE user binding (FINDING 6a) --- */

test("encode/decode verifier binding round-trips and exposes the bound github_user_id", () => {
  const binding = { code_verifier: generateCodeVerifier(), github_user_id: 4242, nonce: "n", tenant_id: "tenant-9" };
  const decoded = decodeVerifierBinding(encodeVerifierBinding(binding));
  assert.ok(decoded);
  assert.equal(decoded.github_user_id, 4242);
  assert.equal(decoded.code_verifier, binding.code_verifier);
});

test("verifier binding round-trips the required tenant_id", () => {
  const binding = { code_verifier: generateCodeVerifier(), github_user_id: 4242, nonce: "n", tenant_id: "tenant-9" };
  const decoded = decodeVerifierBinding(encodeVerifierBinding(binding));
  assert.ok(decoded);
  assert.equal(decoded.tenant_id, "tenant-9");
  assert.equal(decoded.github_user_id, 4242);
});

test("verifier binding without a tenant_id is rejected", () => {
  const raw = encryptSecret(JSON.stringify({ code_verifier: generateCodeVerifier(), github_user_id: 7, nonce: "n" }));
  assert.equal(decodeVerifierBinding(raw), undefined);
});

test("decodeVerifierBinding rejects a tampered/garbage cookie", () => {
  assert.equal(decodeVerifierBinding(undefined), undefined);
  assert.equal(decodeVerifierBinding("not-a-valid-binding"), undefined);
  assert.equal(decodeVerifierBinding("enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA"), undefined);
});

// A well-formed plaintext JSON binding must not bypass authenticated encryption.
test("decodeVerifierBinding rejects a well-formed but PLAINTEXT (non-envelope) binding cookie (FINDING 4b)", () => {
  const forged = JSON.stringify({ code_verifier: generateCodeVerifier(), github_user_id: 999, nonce: "n" });
  assert.equal(decodeVerifierBinding(forged), undefined, "plaintext binding must never be accepted");
});

/* -------------------------------------- PKCE flow fencing (callback nonce) --- */

// The single PKCE cookie is overwritten by a second /oauth/start; the callback must belong to the flow
// whose nonce it was stamped with, else an older callback could exchange its code under a newer binding
// (including its authorized tenant_id). callbackFlowMatchesBinding is the guard.
test("callbackFlowMatchesBinding accepts a query nonce that equals the binding nonce (match)", () => {
  const binding = { code_verifier: generateCodeVerifier(), github_user_id: 1, nonce: "flow-abc", tenant_id: "t-1" };
  assert.equal(callbackFlowMatchesBinding("flow-abc", binding), true);
});

test("callbackFlowMatchesBinding rejects a query nonce from a different flow (mismatch)", () => {
  const binding = { code_verifier: generateCodeVerifier(), github_user_id: 1, nonce: "flow-abc", tenant_id: "t-1" };
  // Simulates the overwritten-cookie case: the first flow's callback arrives with its own nonce but the
  // cookie now holds the second flow's binding (different nonce + tenant).
  assert.equal(callbackFlowMatchesBinding("flow-other", binding), false);
});

test("callbackFlowMatchesBinding rejects an absent or blank query nonce", () => {
  const binding = { code_verifier: generateCodeVerifier(), github_user_id: 1, nonce: "flow-abc", tenant_id: "t-1" };
  assert.equal(callbackFlowMatchesBinding(undefined, binding), false);
  assert.equal(callbackFlowMatchesBinding("", binding), false);
});

test("parseModelSettingsBody normalizes empty strings to null", () => {
  assert.deepEqual(parseModelSettingsBody({ planner_model: "  openai/gpt-5.5  ", investigation_model: "", review_model: 5 }), {
    planner_model: "openai/gpt-5.5",
    investigation_model: null,
    review_model: null,
    context_model: null,
    planner_effort: null,
    investigation_effort: null,
    review_effort: null,
    context_effort: null,
    review_fallback_policy: "fail_notify",
    context_fallback_policy: "fail_notify",
  });
});

/* --------------------------------------- billing policy validation (FINDING 3) --- */

/** Capture console.error calls so tests can assert billing_policy_invalid, then restore. */
function captureErrors(): { entries: unknown[][]; restore: () => void } {
  const entries: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    entries.push(args);
  };
  return { entries, restore: () => { console.error = original; } };
}

test("policyFromRow passes a sane tenant policy through unchanged", () => {
  const policy = policyFromRow(
    { subsidy_rate: "0.5000", infra_credits_per_run: 50, overage_infra_credits_per_run: 75, overage_subsidy_rate: "0.1000" },
    "tenant-1",
  );
  assert.deepEqual(policy, {
    subsidy_rate: "0.5000",
    infra_credits_per_run: 50,
    overage_infra_credits_per_run: 75,
    overage_subsidy_rate: "0.1000",
    auto_review_limit_enabled: false,
    auto_review_limit_credits: null,
  });
});

// FINDING 3: a reviewer probed a NEGATIVE infra credit charge all the way into an Autumn track. Every
// out-of-range field falls back to the platform default for that field and logs billing_policy_invalid.
test("policyFromRow clamps a negative infra credit charge to the platform default and logs (FINDING 3)", () => {
  const errors = captureErrors();
  let policy;
  try {
    policy = policyFromRow(
      { subsidy_rate: "0.3000", infra_credits_per_run: -100, overage_infra_credits_per_run: 150, overage_subsidy_rate: "0.0000" },
      "tenant-1",
    );
  } finally {
    errors.restore();
  }
  assert.equal(policy.infra_credits_per_run, PLATFORM_BILLING_POLICY.infra_credits_per_run);
  const logged = errors.entries.find((e) => e[0] === "billing_policy_invalid");
  assert.ok(logged, "billing_policy_invalid logged");
  const fields = logged[1] as Record<string, unknown>;
  assert.equal(fields.tenant_id, "tenant-1");
  assert.equal(fields.field, "infra_credits_per_run");
  assert.equal(fields.value, -100);
});

test("policyFromRow clamps out-of-range subsidy rates to [0,1] platform defaults (FINDING 3)", () => {
  const errors = captureErrors();
  let policy;
  try {
    policy = policyFromRow(
      { subsidy_rate: "1.5000", infra_credits_per_run: 100, overage_infra_credits_per_run: 150, overage_subsidy_rate: "-0.2000" },
      "tenant-1",
    );
  } finally {
    errors.restore();
  }
  assert.equal(policy.subsidy_rate, PLATFORM_BILLING_POLICY.subsidy_rate);
  assert.equal(policy.overage_subsidy_rate, PLATFORM_BILLING_POLICY.overage_subsidy_rate);
  assert.equal(errors.entries.filter((e) => e[0] === "billing_policy_invalid").length, 2, "one log per bad field");
});

test("policyFromRow clamps non-integer / unsafe credit values per-field, keeping valid fields (FINDING 3)", () => {
  const errors = captureErrors();
  let policy;
  try {
    policy = policyFromRow(
      { subsidy_rate: "0.4000", infra_credits_per_run: 2.5, overage_infra_credits_per_run: 175, overage_subsidy_rate: "0.0500" },
      "tenant-1",
    );
  } finally {
    errors.restore();
  }
  // Only the invalid field falls back; the valid fields are preserved.
  assert.equal(policy.infra_credits_per_run, PLATFORM_BILLING_POLICY.infra_credits_per_run);
  assert.equal(policy.subsidy_rate, "0.4000");
  assert.equal(policy.overage_infra_credits_per_run, 175);
  assert.equal(policy.overage_subsidy_rate, "0.0500");
});

test("policyFromRow returns platform defaults for an absent row (unchanged behavior)", () => {
  assert.deepEqual(policyFromRow(undefined, "tenant-1"), PLATFORM_BILLING_POLICY);
  assert.deepEqual(
    policyFromRow({ subsidy_rate: null, infra_credits_per_run: null, overage_infra_credits_per_run: null, overage_subsidy_rate: null }, "tenant-1"),
    PLATFORM_BILLING_POLICY,
  );
});

/* ------------------------------------------- integrations response shape --- */

test("getUserIntegrations returns an openrouter section", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const result = await getUserIntegrations(123);
    assert.deepEqual(result, {
      openrouter: { configured: false },
      openai: { configured: false },
      anthropic: { configured: false },
      codex_harness: { configured: false },
    });
  } finally {
    if (previous !== undefined) {
      process.env.DATABASE_URL = previous;
    }
  }
});
