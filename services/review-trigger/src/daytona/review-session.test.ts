import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  BYOK_OPENAI_OPENROUTER_PLACEHOLDER,
  collectCodexHarnessTokenSecrets,
  collectSecrets,
  codexContextGraphMcpConfig,
  daytonaWorkerEnv,
  ensureModelCredentials,
  extractWorkerWarnings,
  parseDaytonaResultPayload,
  parseDaytonaTransportResult,
  redactWorkerWarningForLog,
  resolveDaytonaSandboxImage,
  resolveDaytonaSandboxResources,
  resolveDaytonaWorkerToolBins,
  resolveOpenrouterKeyForRun,
} from "./review-session.js";
import { WORKER_WARNING_PREFIX } from "../shared/utils.js";
import { DAYTONA_WORKER_SOURCE_FILES } from "./worker-manifest.js";

test("Daytona worker manifest includes every relative runtime import", async () => {
  const remotePaths = new Set<string>(DAYTONA_WORKER_SOURCE_FILES.map((file) => file.remotePath));

  for (const file of DAYTONA_WORKER_SOURCE_FILES) {
    const source = await readFile(new URL(file.modulePath, import.meta.url), "utf8");
    const imports = source.matchAll(/^import\s+([^;]+?)\s+from\s+["'](\.[^"']+)\.js["'];/gm);
    for (const match of imports) {
      if (match[1]?.trim().startsWith("type ")) continue;
      const dependencyPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.remotePath), `${match[2]}.ts`),
      );
      assert.ok(
        remotePaths.has(dependencyPath),
        `${file.remotePath} imports ${dependencyPath}, but it is absent from the Daytona worker manifest`,
      );
    }
  }
});

test("resolveOpenrouterKeyForRun: BYOK OpenAI uses a non-secret placeholder, never the tenant OpenAI key", () => {
  // The whole point: a non-OpenAI stage model must NOT forward the tenant's real OpenAI key to openrouter.ai.
  const key = resolveOpenrouterKeyForRun({
    harnessMode: false,
    tenantOpenrouterKey: undefined,
    byokOpenaiKey: "sk-tenant-openai-secret",
    managedOpenrouterKey: "sk-managed-openrouter",
  });
  assert.equal(key, BYOK_OPENAI_OPENROUTER_PLACEHOLDER);
  assert.notEqual(key, "sk-tenant-openai-secret");
  // ...and it is SET (not undefined), so Codex can start the proxy provider whose env_key is OPENROUTER_API_KEY.
  assert.ok(key && key.length > 0);
});

test("resolveOpenrouterKeyForRun: precedence harness > tenant openrouter > byok-placeholder > managed", () => {
  // Harness: no proxy, no key at all.
  assert.equal(
    resolveOpenrouterKeyForRun({ harnessMode: true, byokOpenaiKey: "sk-x", managedOpenrouterKey: "m" }),
    undefined,
  );
  // BOTH company keys present (per-model routing): the REAL tenant OpenRouter key is used (not the
  // placeholder), while the OpenAI key is wired separately for the native openai/* route.
  assert.equal(
    resolveOpenrouterKeyForRun({
      harnessMode: false,
      tenantOpenrouterKey: "sk-tenant-or",
      byokOpenaiKey: "sk-openai",
      managedOpenrouterKey: "m",
    }),
    "sk-tenant-or",
  );
  // Managed run: no tenant credential of any kind -> managed OpenRouter key.
  assert.equal(
    resolveOpenrouterKeyForRun({ harnessMode: false, managedOpenrouterKey: "sk-managed" }),
    "sk-managed",
  );
});

test("extractWorkerWarnings reads worker warning markers alongside a result block", () => {
  const warning = {
    event: "temp_workspace_cleanup_failed_nonfatal",
    label: "runtime_review_workspace",
    path: "/tmp/jina-runtime-review-abc",
    code: "ENOTEMPTY",
    message: "directory not empty",
    maxRetries: 5,
    retryDelay: 200,
  };
  const output = [
    "normal setup output",
    `${WORKER_WARNING_PREFIX}${JSON.stringify(warning)}`,
    "__JINA_DAYTONA_RESULT_START__",
    JSON.stringify({ ok: true, result: { status: "passed" } }),
    "__JINA_DAYTONA_RESULT_END__",
  ].join("\n");

  assert.deepEqual(extractWorkerWarnings(output), [warning]);
});

test("extractWorkerWarnings ignores unrelated stdout and malformed warning lines", () => {
  const output = [
    "plain stdout",
    `${WORKER_WARNING_PREFIX}{not json`,
    "__JINA_DAYTONA_RESULT_START__",
    JSON.stringify({ ok: true, result: { status: "passed" } }),
    "__JINA_DAYTONA_RESULT_END__",
  ].join("\n");

  assert.deepEqual(extractWorkerWarnings(output), []);
});

test("redactWorkerWarningForLog redacts secret values before logging", () => {
  const warning = {
    event: "temp_workspace_cleanup_failed_nonfatal",
    label: "runtime_review_workspace",
    path: "/tmp/secret-token-value/workspace",
    message: "failed to remove /tmp/secret-token-value/workspace",
    maxRetries: 5,
    retryDelay: 200,
  };

  assert.deepEqual(redactWorkerWarningForLog(warning, ["secret-token-value"]), {
    event: "temp_workspace_cleanup_failed_nonfatal",
    label: "runtime_review_workspace",
    path: "/tmp/***REDACTED***/workspace",
    message: "failed to remove /tmp/***REDACTED***/workspace",
    maxRetries: 5,
    retryDelay: 200,
  });
});

test("redactWorkerWarningForLog redacts secrets NESTED in objects and arrays, not just top-level strings", () => {
  const warning = {
    event: "worker_env_snapshot",
    details: { env: { OPENAI_API_KEY: "sk-tenant-secret", OTHER: "safe" } },
    args: ["--key", "sk-tenant-secret"],
    top: "sk-tenant-secret in a top string",
  };

  assert.deepEqual(redactWorkerWarningForLog(warning, ["sk-tenant-secret"]), {
    event: "worker_env_snapshot",
    details: { env: { OPENAI_API_KEY: "***REDACTED***", OTHER: "safe" } },
    args: ["--key", "***REDACTED***"],
    top: "***REDACTED*** in a top string",
  });
});

test("parseDaytonaResultPayload returns a successful result file payload", () => {
  const result = parseDaytonaResultPayload<{ status: string }>(
    JSON.stringify({ ok: true, result: { status: "passed" } }),
  );

  assert.deepEqual(result, { status: "passed" });
});

test("parseDaytonaTransportResult handles ok false result file payload as a structured worker failure", () => {
  assert.throws(
    () =>
      parseDaytonaTransportResult({
        phase: "runtime-review",
        exitCode: 1,
        stdout: "__JINA_DAYTONA_RESULT_FILE_WRITTEN__",
        resultFileContent: JSON.stringify({ ok: false, error: "worker secret-token-value failed" }),
        secrets: ["secret-token-value"],
      }),
    /Daytona runtime-review worker failed: worker \*\*\*REDACTED\*\*\* failed/,
  );
});

test("parseDaytonaTransportResult falls back to redacted stdout preview when the result file is missing after nonzero exit", () => {
  assert.throws(
    () =>
      parseDaytonaTransportResult({
        phase: "review-context",
        exitCode: 1,
        stdout: "setup log\nfatal secret-token-value output",
        resultFileReadError: new Error("not found"),
        secrets: ["secret-token-value"],
      }),
    /Daytona review-context worker failed: worker exited before writing a result file\. Last output: setup log fatal \*\*\*REDACTED\*\*\* output/,
  );
});

test("parseDaytonaTransportResult explains missing bash as a Daytona image problem", () => {
  assert.throws(
    () =>
      parseDaytonaTransportResult({
        phase: "runtime-review",
        exitCode: 1,
        stdout: "fork/exec /usr/bin/bash: no such file or directory",
      }),
    /Daytona runtime-review worker failed: Daytona sandbox image is missing \/usr\/bin\/bash\./,
  );
});

test("parseDaytonaTransportResult reports successful worker result file download failures clearly", () => {
  assert.throws(
    () =>
      parseDaytonaTransportResult({
        phase: "review-context",
        exitCode: 0,
        stdout: "__JINA_DAYTONA_RESULT_FILE_WRITTEN__",
        resultFileReadError: new Error(
          '"downloadFiles" is not supported: Module "busboy" is not available with secret-token-value',
        ),
        secrets: ["secret-token-value"],
      }),
    /Daytona review-context result file download failed: "downloadFiles" is not supported: Module "busboy" is not available with \*\*\*REDACTED\*\*\*/,
  );
});

test("parseDaytonaTransportResult extracts warnings from stdout while parsing the result from file", () => {
  const warning = {
    event: "temp_workspace_cleanup_failed_nonfatal",
    path: "/tmp/workspace",
    message: "cleanup failed",
  };
  const stdout = [
    "normal setup output",
    `${WORKER_WARNING_PREFIX}${JSON.stringify(warning)}`,
    "not json result stdout",
  ].join("\n");
  const result = parseDaytonaTransportResult<{ status: string }>({
    phase: "runtime-review",
    exitCode: 0,
    stdout,
    resultFileContent: JSON.stringify({ ok: true, result: { status: "passed" } }),
  });

  assert.deepEqual(result, { status: "passed" });
  assert.deepEqual(extractWorkerWarnings(stdout), [warning]);
});

test("parseDaytonaTransportResult parses a large JSON payload from file content and not stdout", () => {
  const largeMarkdown = "large-result ".repeat(20_000);
  const result = parseDaytonaTransportResult<{ markdown: string }>({
    phase: "runtime-review",
    exitCode: 0,
    stdout: "__JINA_DAYTONA_RESULT_START__\nnot-json\n__JINA_DAYTONA_RESULT_END__",
    resultFileContent: JSON.stringify({ ok: true, result: { markdown: largeMarkdown } }),
  });

  assert.equal(result.markdown.length, largeMarkdown.length);
  assert.equal(result.markdown, largeMarkdown);
});

test("resolveDaytonaSandboxImage defaults to a bash-capable Node image", () => {
  assert.equal(resolveDaytonaSandboxImage({}), "node:22-bookworm");
});

test("resolveDaytonaSandboxImage honors an explicit custom image", () => {
  assert.equal(resolveDaytonaSandboxImage({ DAYTONA_SANDBOX_IMAGE: "ghcr.io/acme/review-worker:latest" }), "ghcr.io/acme/review-worker:latest");
});

test("resolveDaytonaSandboxResources defaults to supported Daytona caps", () => {
  assert.deepEqual(resolveDaytonaSandboxResources({}), { cpu: 4, memory: 8, disk: 10 });
});

test("resolveDaytonaSandboxResources lets lower explicit values override defaults", () => {
  assert.deepEqual(
    resolveDaytonaSandboxResources({
      DAYTONA_SANDBOX_CPU: "2",
      DAYTONA_SANDBOX_MEMORY: "4",
      DAYTONA_SANDBOX_DISK: "6",
    }),
    {
      cpu: 2,
      memory: 4,
      disk: 6,
    },
  );
});

test("resolveDaytonaSandboxResources caps explicit values to supported Daytona limits", () => {
  assert.deepEqual(resolveDaytonaSandboxResources({ DAYTONA_SANDBOX_CPU: "6", DAYTONA_SANDBOX_MEMORY: "16", DAYTONA_SANDBOX_DISK: "30" }), {
    cpu: 4,
    memory: 8,
    disk: 10,
  });
});

test("resolveDaytonaWorkerToolBins keeps installed worker dependency paths by default", () => {
  assert.deepEqual(
    resolveDaytonaWorkerToolBins({
      CODEX_BIN: "codex",
      CODEGRAPH_BIN: "codegraph",
    }),
    {
      codexBin: "@openai/codex",
      codegraphBin: "/home/daytona/jina-review-worker/node_modules/.bin/codegraph",
    },
  );
});

test("ensureModelCredentials fail-closes an LLM phase that has no model-gateway key", () => {
  assert.throws(
    () => ensureModelCredentials({ requiresModelKey: true }),
    /OPENROUTER_API_KEY is required for Codex inside Daytona/,
  );
});

test("ensureModelCredentials passes for an LLM phase once a key is available", () => {
  assert.doesNotThrow(() => ensureModelCredentials({ requiresModelKey: true, openrouterKey: "or-key" }));
});

test("ensureModelCredentials never throws for a codegraph-only phase, even without a key", () => {
  // The summary stage runs no LLM calls, so a missing key must not kill it.
  assert.doesNotThrow(() => ensureModelCredentials({ requiresModelKey: false }));
});

test("ensureModelCredentials is satisfied in harness mode without any model-gateway key", () => {
  // Native Codex runs on the author's ChatGPT subscription, so no OpenRouter key
  // is needed even for an LLM phase.
  assert.doesNotThrow(() => ensureModelCredentials({ requiresModelKey: true, harnessMode: true }));
});

test("ensureModelCredentials is satisfied by a BYOK native OpenAI key without an OpenRouter key", () => {
  // A tenant BYOK OpenAI run routes openai/* natively to api.openai.com under that key, so the native
  // OpenAI key alone satisfies the preflight even with no OpenRouter gateway key.
  assert.doesNotThrow(() => ensureModelCredentials({ requiresModelKey: true, openaiKey: "sk-tenant-openai" }));
});

test("daytonaWorkerEnv harness mode sets CODEX_HOME + JINA_HARNESS_MODE and omits OPENROUTER_API_KEY", () => {
  const env = daytonaWorkerEnv({
    token: "gh-token",
    reviewRunId: "run-123",
    harnessMode: true,
  });

  assert.equal(env.CODEX_HOME, "/home/daytona/jina-review-worker/codex-home");
  assert.equal(env.JINA_HARNESS_MODE, "1");
  // No model gateway key is wired in harness mode; this is what skips the proxy.
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  // The GitHub tokens and review-run tag are still emitted for checkout/attribution.
  assert.equal(env.GITHUB_TOKEN, "gh-token");
  assert.equal(env.JINA_OPENROUTER_USER, "review_run-123");
});

test("daytonaWorkerEnv normal mode uses isolated CODEX_HOME and wires the OpenRouter key", () => {
  const env = daytonaWorkerEnv({
    token: "gh-token",
    openrouterKey: "or-user-key",
    reviewRunId: "run-123",
  });

  assert.equal(env.CODEX_HOME, "/home/daytona/jina-review-worker/codex-home");
  assert.equal(env.JINA_HARNESS_MODE, undefined);
  assert.equal(env.OPENROUTER_API_KEY, "or-user-key");
});

test("daytonaWorkerEnv exposes only the short-lived ContextGraph token and its MCP config references the env name", () => {
  const contextGraphMcp = {
    mcpUrl: "https://graph.example/mcp",
    accessToken: "short-lived-graph-token-123",
    expiresAt: "2026-07-21T01:00:00.000Z",
  };
  const env = daytonaWorkerEnv({ token: "gh-token", contextGraphMcp });
  assert.equal(env.JINA_GRAPH_ACCESS_TOKEN, contextGraphMcp.accessToken);
  assert.equal(env.JINA_GRAPH_MCP_ENABLED, "1");
  const config = codexContextGraphMcpConfig(contextGraphMcp);
  assert.match(config, /\[mcp_servers\.jina_context\]/);
  assert.match(config, /url = "https:\/\/graph\.example\/mcp"/);
  assert.match(config, /bearer_token_env_var = "JINA_GRAPH_ACCESS_TOKEN"/);
  assert.match(
    config,
    /enabled_tools = \["search_context", "list_context", "read_context", "diff_context"\]/,
  );
  assert.doesNotMatch(config, /short-lived-graph-token-123/);
});

test("collectCodexHarnessTokenSecrets extracts nested token values for redaction", () => {
  const authJson = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "access-token-value-123456",
      refresh_token: "refresh-token-value-123456",
      id_token: "id-token-value-123456",
    },
    last_refresh: "2026-07-08T00:00:00Z",
  });

  assert.deepEqual(collectCodexHarnessTokenSecrets(authJson).sort(), [
    "access-token-value-123456",
    "id-token-value-123456",
    "refresh-token-value-123456",
  ].sort());
});

test("collectCodexHarnessTokenSecrets returns nothing for a missing or invalid blob", () => {
  assert.deepEqual(collectCodexHarnessTokenSecrets(undefined), []);
  assert.deepEqual(collectCodexHarnessTokenSecrets("not json"), []);
  assert.deepEqual(collectCodexHarnessTokenSecrets(JSON.stringify({ tokens: {} })), []);
});

test("daytonaWorkerEnv emits OPENAI_API_KEY + JINA_OPENAI_MODEL_PRICING for a managed native run", () => {
  const pricing = {
    "openai/gpt-5.4-mini": {
      input_per_token: "0.0000004",
      output_per_token: "0.0000016",
      cached_per_token: "0.0000001",
    },
  };
  const env = daytonaWorkerEnv({
    token: "gh-token",
    openrouterKey: "or-managed-key",
    openaiKey: "sk-openai-managed",
    openaiModelPricing: pricing,
    reviewRunId: "run-123",
  });

  assert.equal(env.OPENAI_API_KEY, "sk-openai-managed");
  assert.equal(env.JINA_OPENAI_MODEL_PRICING, JSON.stringify(pricing));
  // The OpenRouter route is still wired alongside the native one.
  assert.equal(env.OPENROUTER_API_KEY, "or-managed-key");
});

test("daytonaWorkerEnv wires BOTH keys for a two-key BYOK run, with no managed pricing map", () => {
  // The merge end state: a "user" run carrying the tenant OpenRouter key AND the tenant OpenAI key. The
  // proxy sends openai/* natively under OPENAI_API_KEY and everything else under OPENROUTER_API_KEY. No
  // pricing map (infra-only run — native cost is telemetry, not billed).
  const env = daytonaWorkerEnv({
    token: "gh-token",
    openrouterKey: "or-tenant-key",
    openaiKey: "sk-tenant-openai",
    reviewRunId: "run-123",
  });

  assert.equal(env.OPENROUTER_API_KEY, "or-tenant-key");
  assert.equal(env.OPENAI_API_KEY, "sk-tenant-openai");
  assert.equal(env.JINA_OPENAI_MODEL_PRICING, undefined);
});

test("daytonaWorkerEnv omits the native OpenAI envs in harness mode even if a key is passed", () => {
  const env = daytonaWorkerEnv({
    token: "gh-token",
    openaiKey: "sk-openai-managed",
    openaiModelPricing: { "openai/gpt-5.4-mini": { input_per_token: "1", output_per_token: "1", cached_per_token: "1" } },
    harnessMode: true,
    reviewRunId: "run-123",
  });

  // Harness runs must not gain an env that would start the capture proxy they bypass.
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.JINA_OPENAI_MODEL_PRICING, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});

test("daytonaWorkerEnv leaves the native OpenAI envs unset when no key is provided", () => {
  const env = daytonaWorkerEnv({ token: "gh-token", openrouterKey: "or-user-key", reviewRunId: "run-123" });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.JINA_OPENAI_MODEL_PRICING, undefined);
});

test("collectSecrets includes the managed native OpenAI key for redaction", () => {
  const secrets = collectSecrets(["gh-installation-token-123456", "sk-openai-managed-key-abcdef"]);
  assert.equal(secrets.includes("sk-openai-managed-key-abcdef"), true);
  // Longest-first ordering so overlapping secrets redact before their substrings.
  assert.deepEqual(
    secrets,
    ["gh-installation-token-123456", "sk-openai-managed-key-abcdef"].sort((a, b) => b.length - a.length),
  );
});

test("daytonaWorkerEnv maps resolved model settings onto the worker model envs", () => {
  const env = daytonaWorkerEnv({
    token: "gh-token",
    openrouterKey: "or-user-key",
    reviewRunId: "run-123",
    modelSettings: {
      planner_model: "anthropic/claude-opus-4.1",
      investigation_model: "openai/gpt-5.4",
      review_model: null,
      planner_effort: "high",
      investigation_effort: "low",
      review_effort: "medium",
    },
  });

  assert.equal(env.RUNTIME_PLANNER_MODEL, "anthropic/claude-opus-4.1");
  assert.equal(env.RUNTIME_AGENT_MODEL, "openai/gpt-5.4");
  // Null review_model falls back to the platform default.
  assert.equal(env.REVIEW_CODEX_MODEL, "openai/gpt-5.6-luna");
  // Mental-trace model stays an internal default (no tenant surface).
  assert.equal(env.RUNTIME_MENTAL_TRACE_MODEL, "openai/gpt-5.6-luna");
  assert.equal(env.RUNTIME_PLANNER_EFFORT, "high");
  assert.equal(env.RUNTIME_AGENT_EFFORT, "low");
  assert.equal(env.REVIEW_CODEX_EFFORT, "medium");
  assert.equal(env.OPENROUTER_API_KEY, "or-user-key");
  assert.equal(env.JINA_OPENROUTER_USER, "review_run-123");
  // Legacy OpenAI keys are never wired into the sandbox.
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.JINA_LEGACY_OPENAI_KEYS, undefined);
});

test("resolveDaytonaWorkerToolBins uses snapshot-provided tools when install is skipped", () => {
  assert.deepEqual(resolveDaytonaWorkerToolBins({ DAYTONA_SKIP_INSTALL: "true" }), {
    codexBin: "codex",
    codegraphBin: "codegraph",
  });
  assert.deepEqual(
    resolveDaytonaWorkerToolBins({
      DAYTONA_SKIP_INSTALL: "true",
      CODEX_BIN: "/opt/bin/codex",
      CODEGRAPH_BIN: "/opt/bin/codegraph",
    }),
    {
      codexBin: "/opt/bin/codex",
      codegraphBin: "/opt/bin/codegraph",
    },
  );
});
