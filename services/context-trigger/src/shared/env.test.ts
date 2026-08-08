import assert from "node:assert/strict";
import test from "node:test";

import { readContextTriggerEnv, resolveSyncedEnvVars } from "./env.js";

const digest = "a".repeat(64);

test("readContextTriggerEnv strictly parses the isolated service environment", () => {
  assert.deepEqual(
    readContextTriggerEnv({
      API_BASE_URL: "https://api.example.test/",
      CONTEXT_INTERNAL_API_TOKEN: "secret",
      CONTEXT_WIKI_AUDIT_POLICY_VERSION: "audit.v1",
      CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST: digest
    }),
    {
      apiBaseUrl: "https://api.example.test",
      internalApiToken: "secret",
      auditPolicyVersion: "audit.v1",
      auditorConfigDigest: digest
    }
  );
});

test("readContextTriggerEnv rejects malformed or missing values", () => {
  assert.throws(() => readContextTriggerEnv({}), /API_BASE_URL/);
  assert.throws(
    () =>
      readContextTriggerEnv({
        API_BASE_URL: "file:///tmp/api",
        CONTEXT_INTERNAL_API_TOKEN: "secret",
        CONTEXT_WIKI_AUDIT_POLICY_VERSION: "audit.v1",
        CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST: digest
      }),
    /HTTP\(S\)/
  );
  assert.throws(
    () =>
      readContextTriggerEnv({
        API_BASE_URL: "https://api.example.test",
        CONTEXT_INTERNAL_API_TOKEN: "secret",
        CONTEXT_WIKI_AUDIT_POLICY_VERSION: "spaces are invalid",
        CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST: digest
      }),
    /identifier/
  );
});

test("resolveSyncedEnvVars syncs only the allowlist and prefers process values", () => {
  assert.deepEqual(
    resolveSyncedEnvVars({
      manifestEnv: {
        API_BASE_URL: "https://manifest.example.test",
        DATABASE_URL: "must-not-sync",
        CONTEXT_INTERNAL_API_TOKEN: "manifest-token",
        CONTEXT_WIKI_AUDIT_POLICY_VERSION: "audit.v1",
        CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST: digest
      },
      processEnv: {
        API_BASE_URL: "https://process.example.test",
        GCS_SERVICE_ACCOUNT_KEY: "must-not-sync"
      }
    }),
    {
      API_BASE_URL: "https://process.example.test",
      CONTEXT_INTERNAL_API_TOKEN: "manifest-token",
      CONTEXT_WIKI_AUDIT_POLICY_VERSION: "audit.v1",
      CONTEXT_WIKI_AUDITOR_CONFIG_DIGEST: digest
    }
  );
});
