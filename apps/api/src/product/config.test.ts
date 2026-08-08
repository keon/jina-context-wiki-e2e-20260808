import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

/** A valid base64-encoded 32-byte SECRETS_ENCRYPTION_KEY (FINDING 4a requires one in production). */
const PROD_SECRETS_KEY = Buffer.alloc(32).toString("base64");
const WEBHOOK_INBOX_KEY = Buffer.alloc(32, 7).toString("base64");

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
    INTERNAL_API_TOKEN: "internal-token",
    ...overrides,
  };
}

test("uses the dedicated product token when Context and review workers have separate credentials", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    INTERNAL_API_TOKEN: "v2-token",
    JINA_PRODUCT_INTERNAL_API_TOKEN: "product-token",
  }));

  assert.equal(config.internalApiToken, "product-token");
});

test("review Board pipeline selection defaults v1 and validates canary configuration", () => {
  assert.deepEqual(loadConfig(baseEnv()).reviewBoardPipeline, {
    mode: "v1",
    v2Repositories: new Set(),
  });
  assert.deepEqual(
    loadConfig(
      baseEnv({
        JINA_REVIEW_BOARD_PIPELINE_MODE: "allowlist",
        JINA_REVIEW_BOARD_V2_REPOSITORIES: "Acme/Example, omxyz/jina",
      }),
    ).reviewBoardPipeline,
    { mode: "allowlist", v2Repositories: new Set(["acme/example", "omxyz/jina"]) },
  );
  assert.equal(
    loadConfig(baseEnv({ JINA_REVIEW_BOARD_PIPELINE_MODE: "v2" })).reviewBoardPipeline.mode,
    "v2",
  );
  assert.throws(
    () => loadConfig(baseEnv({ JINA_REVIEW_BOARD_PIPELINE_MODE: "unknown" })),
    /must be paused, v1, v2, or allowlist/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ JINA_REVIEW_BOARD_PIPELINE_MODE: "allowlist" })),
    /must not be empty/,
  );
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          JINA_REVIEW_BOARD_PIPELINE_MODE: "allowlist",
          JINA_REVIEW_BOARD_V2_REPOSITORIES: "not-a-repository",
        }),
      ),
    /invalid repository/,
  );
});

test("GitHub webhook inbox is opt-in and requires a versioned dedicated key", () => {
  assert.equal(loadConfig(baseEnv()).githubWebhookInbox, undefined);
  assert.throws(
    () => loadConfig(baseEnv({ JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "yes" })),
    /must be true or false/,
  );
  assert.throws(
    () => loadConfig(baseEnv({ JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "true" })),
    /GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY/,
  );
  assert.throws(
    () => loadConfig(baseEnv({
      JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "true",
      GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY: WEBHOOK_INBOX_KEY,
      GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION: "latest",
    })),
    /numeric Secret Manager version/,
  );

  const inbox = loadConfig(baseEnv({
    JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "true",
    GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY: WEBHOOK_INBOX_KEY,
    GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION: "17",
  })).githubWebhookInbox;
  assert.equal(inbox?.encryptionKeyVersion, "17");
  assert.equal(inbox?.encryptionKey.equals(Buffer.alloc(32, 7)), true);
  assert.equal(inbox?.leaseMs, 120_000);
  assert.equal(inbox?.maxBodyBytes, 2 * 1024 * 1024);
});

test("GitHub legacy forwarding accepts only an exact tagged Cloud Run webhook URL", () => {
  const enabled = {
    JINA_GITHUB_WEBHOOK_INBOX_ENABLED: "true",
    GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY: WEBHOOK_INBOX_KEY,
    GITHUB_WEBHOOK_INBOX_ENCRYPTION_KEY_VERSION: "9",
    API_BASE_URL: "https://api.usejina.com",
  };
  for (const legacyForwardUrl of [
    "https://api.usejina.com/webhooks/github",
    "https://jina-code-review-api-hash-ue.a.run.app/webhooks/github",
    "https://rollback---jina-code-review-api-hash-ue.a.run.app/other",
    "http://rollback---jina-code-review-api-hash-ue.a.run.app/webhooks/github",
  ]) {
    assert.throws(
      () => loadConfig(baseEnv({
        ...enabled,
        JINA_GITHUB_WEBHOOK_LEGACY_FORWARD_URL: legacyForwardUrl,
      })),
      /tagged Cloud Run|must not target/,
      legacyForwardUrl,
    );
  }

  const url = "https://rollback---jina-code-review-api-hash-ue.a.run.app/webhooks/github";
  assert.equal(loadConfig(baseEnv({
    ...enabled,
    JINA_GITHUB_WEBHOOK_LEGACY_FORWARD_URL: url,
  })).githubWebhookInbox?.legacyForwardUrl, url);
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

test("hybrid auth requires both Clerk and rollback-capable GitHub credentials", () => {
  const config = loadConfig(baseEnv({
    NODE_ENV: "development",
    DASHBOARD_AUTH_MODE: "hybrid",
    GITHUB_OAUTH_CLIENT_ID: "github-client",
    GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
    CLERK_PUBLISHABLE_KEY: "pk_test_example",
    CLERK_SECRET_KEY: "sk_test_example",
  }));
  assert.equal(config.auth.mode, "hybrid");
  assert.equal(config.auth.githubClientId, "github-client");
  assert.equal(config.auth.clerkPublishableKey, "pk_test_example");

  assert.throws(
    () => loadConfig(baseEnv({
      NODE_ENV: "development",
      DASHBOARD_AUTH_MODE: "hybrid",
      CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
    })),
    /Missing required environment variable GITHUB_OAUTH_CLIENT_ID/,
  );
});

/* ----------------------------------------- SECRETS_ENCRYPTION_KEY (FINDING 4a) --- */

test("requires SECRETS_ENCRYPTION_KEY in production (does not fail open to plaintext)", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_ENV: "production" })),
    /SECRETS_ENCRYPTION_KEY is required when NODE_ENV=production/,
  );
});

test("rejects an invalid (non-32-byte) SECRETS_ENCRYPTION_KEY in production", () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({ NODE_ENV: "production", SECRETS_ENCRYPTION_KEY: "too-short" }),
      ),
    /must be a base64-encoded 32 bytes/,
  );
});

test("accepts a valid base64 32-byte SECRETS_ENCRYPTION_KEY in production", () => {
  const config = loadConfig(
    baseEnv({ NODE_ENV: "production", SECRETS_ENCRYPTION_KEY: PROD_SECRETS_KEY }),
  );
  assert.equal(config.auth.mode, "disabled");
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
