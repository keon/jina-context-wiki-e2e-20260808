import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

/** A valid base64-encoded 32-byte SECRETS_ENCRYPTION_KEY (FINDING 4a requires one in production). */
const PROD_SECRETS_KEY = Buffer.alloc(32).toString("base64");

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
    INTERNAL_API_TOKEN: "internal-token",
    TRIGGER_SECRET_KEY: "tr_dev_local",
    ...overrides,
  };
}

test("allows a Trigger.dev development key outside production", () => {
  const config = loadConfig(baseEnv({ NODE_ENV: "development" }));

  assert.equal(config.trigger.secretKey, "tr_dev_local");
});

test("defaults installation backfill dispatch to the backfill task", () => {
  const config = loadConfig(baseEnv({ NODE_ENV: "development" }));

  assert.equal(config.trigger.backfillTaskId, "github-installation-backfill");
});

test("uses the dedicated product token when V2 and review workers have separate credentials", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    INTERNAL_API_TOKEN: "v2-token",
    JINA_PRODUCT_INTERNAL_API_TOKEN: "product-token",
  }));

  assert.equal(config.internalApiToken, "product-token");
});

test("ignores stale installation backfill task overrides", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    TRIGGER_BACKFILL_TASK_ID: "legacy-backfill",
  }));

  assert.equal(config.trigger.backfillTaskId, "github-installation-backfill");
});

test("uses DASHBOARD_URL as the default credentialed dashboard origin", () => {
  const config = loadConfig(baseEnv({ NODE_ENV: "development", DASHBOARD_URL: "https://app.example.com/" }));

  assert.deepEqual(config.dashboardAllowedOrigins, ["https://app.example.com"]);
});

test("adds optional extra dashboard origins without duplicating the canonical dashboard url", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    DASHBOARD_URL: "https://app.example.com",
    DASHBOARD_ORIGIN: "https://preview.example.com, https://app.example.com/",
  }));

  assert.deepEqual(config.dashboardAllowedOrigins, ["https://preview.example.com", "https://app.example.com"]);
});

test("rejects malformed dashboard urls and origins", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "development", DASHBOARD_URL: "app.example.com" })),
    /Invalid DASHBOARD_URL or DASHBOARD_ORIGIN/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "development", DASHBOARD_ORIGIN: "preview.example.com" })),
    /Invalid DASHBOARD_URL or DASHBOARD_ORIGIN/,
  );
});

test("rejects wildcard dashboard origin because credentialed dashboard CORS needs explicit origins", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "development", DASHBOARD_URL: "https://app.example.com", DASHBOARD_ORIGIN: "*" })),
    /DASHBOARD_ORIGIN cannot include \*/,
  );
});

test("Clerk auth requires both server and browser keys", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    DASHBOARD_AUTH_MODE: "clerk",
    CLERK_PUBLISHABLE_KEY: "pk_test_example",
    CLERK_SECRET_KEY: "sk_test_example",
  }));
  assert.equal(config.auth.mode, "clerk");
  assert.equal(config.auth.clerkPublishableKey, "pk_test_example");
  assert.equal(config.auth.clerkSecretKey, "sk_test_example");

  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "development", DASHBOARD_AUTH_MODE: "clerk" })),
    /Missing required environment variable CLERK_PUBLISHABLE_KEY/,
  );
});

test("rejects a Trigger.dev development key in production", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "production" })),
    /development key while NODE_ENV=production/,
  );
});

test("allows a Trigger.dev production key in production", () => {
  const config = loadConfig(
    baseEnv({ NODE_ENV: "production", TRIGGER_SECRET_KEY: "tr_prod_live", SECRETS_ENCRYPTION_KEY: PROD_SECRETS_KEY }),
  );

  assert.equal(config.trigger.secretKey, "tr_prod_live");
});

/* ----------------------------------------- SECRETS_ENCRYPTION_KEY (FINDING 4a) --- */

test("requires SECRETS_ENCRYPTION_KEY in production (does not fail open to plaintext)", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "production", TRIGGER_SECRET_KEY: "tr_prod_live" })),
    /SECRETS_ENCRYPTION_KEY is required when NODE_ENV=production/,
  );
});

test("rejects an invalid (non-32-byte) SECRETS_ENCRYPTION_KEY in production", () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({ NODE_ENV: "production", TRIGGER_SECRET_KEY: "tr_prod_live", SECRETS_ENCRYPTION_KEY: "too-short" }),
      ),
    /must be a base64-encoded 32 bytes/,
  );
});

test("accepts a valid base64 32-byte SECRETS_ENCRYPTION_KEY in production", () => {
  const config = loadConfig(
    baseEnv({ NODE_ENV: "production", TRIGGER_SECRET_KEY: "tr_prod_live", SECRETS_ENCRYPTION_KEY: PROD_SECRETS_KEY }),
  );
  assert.equal(config.trigger.secretKey, "tr_prod_live");
});

test("does not require SECRETS_ENCRYPTION_KEY outside production (dev keeps plaintext fallback)", () => {
  assert.doesNotThrow(() => loadConfig(baseEnv({ NODE_ENV: "development" })));
});

test("billing defaults to disabled with Autumn defaults when no billing env is set", () => {
  const config = loadConfig(baseEnv({ NODE_ENV: "development" }));

  assert.equal(config.billing.autumnSecretKey, undefined);
  assert.equal(config.billing.autumnApiUrl, "https://api.useautumn.com/v1");
  assert.equal(config.billing.creditsFeatureId, "jina_credits");
  assert.equal(config.billing.managedAiFeatureId, "managed_ai_access");
  assert.equal(config.billing.enforce, "off");
});

test("billing reads Autumn overrides and clamps unknown enforcement to off", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    AUTUMN_SECRET_KEY: "sk_test",
    AUTUMN_API_URL: "https://staging.useautumn.com/v1/",
    AUTUMN_CREDITS_FEATURE_ID: "credits",
    JINA_BILLING_ENFORCE: "shadow",
  }));

  assert.equal(config.billing.autumnSecretKey, "sk_test");
  assert.equal(config.billing.autumnApiUrl, "https://staging.useautumn.com/v1");
  assert.equal(config.billing.creditsFeatureId, "credits");
  assert.equal(config.billing.enforce, "shadow");

  const bogus = loadConfig(baseEnv({ NODE_ENV: "development", JINA_BILLING_ENFORCE: "loud" }));
  assert.equal(bogus.billing.enforce, "off");
});

test("graph integration is optional and requires its URL and token together", () => {
  assert.equal(loadConfig(baseEnv({ NODE_ENV: "development" })).graph, undefined);
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "development", JINA_GRAPH_API_URL: "https://graph.example" })),
    /must be configured together/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "development", JINA_GRAPH_API_TOKEN: "token" })),
    /must be configured together/,
  );
  assert.deepEqual(loadConfig(baseEnv({
    NODE_ENV: "development",
    JINA_GRAPH_API_URL: "https://graph.example/",
    JINA_GRAPH_API_TOKEN: "token",
    JINA_GRAPH_REQUEST_TIMEOUT_MS: "3456",
  })).graph, {
    apiUrl: "https://graph.example",
    accessToken: "token",
    timeoutMs: 3456,
    delegatedTokenTtlMinutes: 15,
  });

  // The internal credential is optional and absent by default, which is what
  // keeps the static-credential path the behaviour until it is configured.
  assert.equal(
    loadConfig(baseEnv({
      NODE_ENV: "development",
      JINA_GRAPH_API_URL: "https://graph.example/",
      JINA_GRAPH_API_TOKEN: "token",
    })).graph?.internalToken,
    undefined,
  );
  const delegating = loadConfig(baseEnv({
    NODE_ENV: "development",
    JINA_GRAPH_API_URL: "https://graph.example/",
    JINA_GRAPH_API_TOKEN: "token",
    JINA_GRAPH_INTERNAL_TOKEN: "graph-internal",
    JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES: "30",
  })).graph;
  assert.equal(delegating?.internalToken, "graph-internal");
  assert.equal(delegating?.delegatedTokenTtlMinutes, 30);
  // The graph service refuses a lifetime under five minutes, so the floor is
  // applied here rather than discovered as a 400 at the first mint.
  assert.equal(
    loadConfig(baseEnv({
      NODE_ENV: "development",
      JINA_GRAPH_API_URL: "https://graph.example/",
      JINA_GRAPH_API_TOKEN: "token",
      JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES: "1",
    })).graph?.delegatedTokenTtlMinutes,
    5,
  );
});
