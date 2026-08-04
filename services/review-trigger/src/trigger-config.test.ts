import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSyncedEnvVars } from "../trigger.config.js";

test("resolveSyncedEnvVars lets current deployment env override stale manifest env", () => {
  const env = resolveSyncedEnvVars({
    env: {
      DAYTONA_SANDBOX_IMAGE: "ghcr.io/acme/alpine:old",
      API_BASE_URL: "https://old.example.com",
      INTERNAL_API_TOKEN: "old-token",
    },
    processEnv: {
      DAYTONA_SANDBOX_IMAGE: "node:22-bookworm",
      API_BASE_URL: "https://new.example.com",
      INTERNAL_API_TOKEN: "new-token",
    },
  });

  assert.equal(env.DAYTONA_SANDBOX_IMAGE, "node:22-bookworm");
  assert.equal(env.API_BASE_URL, "https://new.example.com");
  assert.equal(env.INTERNAL_API_TOKEN, "new-token");
});

test("resolveSyncedEnvVars sets supported Daytona defaults and clears optional runtime vars", () => {
  const env = resolveSyncedEnvVars({
    env: {
      DAYTONA_SNAPSHOT: "old-snapshot",
      DAYTONA_SANDBOX_CPU: "16",
      DAYTONA_SANDBOX_MEMORY: "32",
      DAYTONA_SANDBOX_DISK: "80",
      DAYTONA_SKIP_INSTALL: "true",
      DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS: "240",
      GITHUB_CLONE_TOKEN: "old-token",
      REVIEW_CODEX_EFFORT: "high",
      RUNTIME_AGENT_MODEL: "old-model",
    },
    processEnv: {},
  });

  assert.equal(env.DAYTONA_SANDBOX_IMAGE, "node:22-bookworm");
  assert.equal(env.DAYTONA_SNAPSHOT, "");
  assert.equal(env.DAYTONA_SANDBOX_CPU, "4");
  assert.equal(env.DAYTONA_SANDBOX_MEMORY, "8");
  assert.equal(env.DAYTONA_SANDBOX_DISK, "10");
  assert.equal(env.DAYTONA_SKIP_INSTALL, "");
  assert.equal(env.DAYTONA_RESULT_DOWNLOAD_TIMEOUT_SECONDS, "");
  assert.equal(env.GITHUB_CLONE_TOKEN, "");
  assert.equal(env.REVIEW_CODEX_EFFORT, "");
  assert.equal(env.RUNTIME_AGENT_MODEL, "");
});

test("resolveSyncedEnvVars caps explicit Daytona resource values", () => {
  const env = resolveSyncedEnvVars({
    env: {},
    processEnv: {
      DAYTONA_SANDBOX_CPU: "6",
      DAYTONA_SANDBOX_MEMORY: "16",
      DAYTONA_SANDBOX_DISK: "30",
    },
  });

  assert.equal(env.DAYTONA_SANDBOX_CPU, "4");
  assert.equal(env.DAYTONA_SANDBOX_MEMORY, "8");
  assert.equal(env.DAYTONA_SANDBOX_DISK, "10");
});
