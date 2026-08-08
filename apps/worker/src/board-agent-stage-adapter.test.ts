import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CITATION_AUDIT_STAGE_SCHEMA,
  CRITIC_STAGE_SCHEMA,
  DOCUMENTATION_STAGE_SCHEMA,
  RESEARCH_STAGE_SCHEMA,
  SOURCE_CHALLENGE_STAGE_SCHEMA,
  type BoardAgentStageInput,
  type BoardAgentStageResultEnvelope,
  type BoardAgentStageRunner
} from "@jina/daytona";
import {
  addBoardAgentModelUsage,
  boardAgentModelUsageForCompletion,
  configuredPortableContextBoardAgentStageRunner,
  configuredBoardAgentRunner,
  resolveContextExecutionProfile,
  type BoardAgentExecutionConfiguration,
  runPortableBoardAgentStage
} from "./board-agent-stage-adapter.js";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const usage = { inputTokens: 75, cachedInputTokens: 50, outputTokens: 25 } as const;

test("all production Codex response schemas recursively require every declared strict property", () => {
  const schemas = {
    RESEARCH_STAGE_SCHEMA,
    DOCUMENTATION_STAGE_SCHEMA,
    SOURCE_CHALLENGE_STAGE_SCHEMA,
    CITATION_AUDIT_STAGE_SCHEMA,
    CRITIC_STAGE_SCHEMA
  };
  const violations: string[] = [];

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (
      node.additionalProperties === false &&
      node.properties !== null &&
      typeof node.properties === "object" &&
      !Array.isArray(node.properties)
    ) {
      const propertyNames = Object.keys(node.properties);
      const required = Array.isArray(node.required)
        ? node.required.filter((item): item is string => typeof item === "string")
        : [];
      for (const propertyName of propertyNames) {
        if (!required.includes(propertyName)) violations.push(`${path}: ${propertyName}`);
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${path}.${key}`);
  };

  for (const [name, schema] of Object.entries(schemas)) visit(schema, name);
  assert.deepEqual(violations, []);
});

test("portable adapter maps host paths, seeds declared files, and writes exact returned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-board-adapter-test-"));
  const working = join(root, "stage");
  const checkout = join(root, "checkout");
  const output = join(working, "context");
  const target = join(output, "architecture.md");
  await Promise.all([mkdir(output, { recursive: true }), mkdir(join(checkout, "src"), { recursive: true })]);
  await Promise.all([
    writeFile(join(working, "audit.json"), '{"status":"repair"}\n', "utf8"),
    writeFile(join(checkout, "src", "runtime.ts"), "export const runtime = true;\n", "utf8"),
    writeFile(target, "# Architecture\n\nInitial draft.\n", "utf8"),
    mkdir(join(working, ".git"), { recursive: true }).then(() =>
      writeFile(join(working, ".git", "config"), "must not leave the host\n", "utf8")
    )
  ]);
  let captured: BoardAgentStageInput | undefined;
  const revised = Buffer.from("# Architecture\n\nRevised draft.\n");
  const runner: BoardAgentStageRunner = {
    mode: "local",
    async run(input) {
      captured = input;
      const result = Buffer.from('{"completed":true}');
      return {
        version: 1,
        contentType: "application/json",
        bytes: result,
        byteLength: result.byteLength,
        sha256: digest(result),
        usage,
        files: input.outputFiles!.map((file) => ({
          ...file,
          bytes: revised,
          sha256: digest(revised)
        }))
      };
    }
  };

  try {
    const result = await runPortableBoardAgentStage(
      runner,
      {
        id: "repair-architecture",
        prompt: [
          `Read ${join(checkout, "src", "runtime.ts")}.`,
          `Use findings in ${join(working, "audit.json")}.`,
          `Write ${target}.`,
          `Do not rewrite this non-path prefix: ${working}-suffix.`
        ].join("\n"),
        workingDirectory: working,
        additionalDirectories: [checkout],
        writableDirectories: [output],
        outputFiles: [target],
        budgetSeconds: 60
      },
      { commitSha: "a".repeat(40), attempt: 2 },
      {}
    );

    assert.equal(result.text, '{"completed":true}');
    assert.deepEqual(result.usage, usage);
    assert.equal(await readFile(target, "utf8"), revised.toString("utf8"));
    assert.ok(captured);
    assert.equal(captured.repository.commitSha, "a".repeat(40));
    assert.equal(captured.limits.attempt, 2);
    assert.equal(captured.limits.contextTokens, 128_000);
    assert.equal(captured.limits.compactTokens, 96_000);
    assert.deepEqual(captured.outputFiles, [
      {
        path: "writable/0/architecture.md",
        contentType: "text/markdown",
        maxBytes: 4 * 1024 * 1024
      }
    ]);
    assert.equal(
      Buffer.from(captured.initialOutputFiles![0]!.bytes).toString("utf8"),
      "# Architecture\n\nInitial draft.\n"
    );
    assert.match(captured.prompt, /repository\/additional\/0\/src\/runtime\.ts/);
    assert.match(captured.prompt, /repository\/work\/audit\.json/);
    assert.match(captured.prompt, /output\/writable\/0\/architecture\.md/);
    assert.match(captured.prompt, new RegExp(`${escapeRegExp(working)}-suffix`));
    assert.doesNotMatch(captured.prompt, new RegExp(`${escapeRegExp(checkout)}/src`));

    const expanded = await gunzipArchive(captured.repository.archive);
    assert.match(expanded, /work\/audit\.json/);
    assert.match(expanded, /additional\/0\/src\/runtime\.ts/);
    assert.doesNotMatch(expanded, /\.git\/config/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable adapter accepts bounded operator-recovery attempts through thirty-two", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-board-adapter-recovery-"));
  let captured: BoardAgentStageInput | undefined;
  const runner: BoardAgentStageRunner = {
    mode: "local",
    async run(input) {
      captured = input;
      return envelope(Buffer.from('{"text":"recovered"}'), []);
    }
  };

  try {
    const result = await runPortableBoardAgentStage(
      runner,
      {
        id: "operator-recovery",
        prompt: "Recover the retained task.",
        workingDirectory: root,
        readOnly: true,
        budgetSeconds: 30
      },
      { commitSha: "d".repeat(40), attempt: 32 },
      {}
    );

    assert.equal(result.text, "recovered");
    assert.equal(captured?.limits.attempt, 32);
    assert.equal(captured?.limits.maxAttempts, 32);
    await assert.rejects(
      () =>
        runPortableBoardAgentStage(
          runner,
          {
            id: "operator-recovery-exhausted",
            prompt: "Must not run.",
            workingDirectory: root,
            readOnly: true,
            budgetSeconds: 30
          },
          { commitSha: "d".repeat(40), attempt: 33 },
          {}
        ),
      /bounded retry contract/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable adapter rejects omitted declared files and outputs outside writable roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-board-adapter-bounds-"));
  const output = join(root, "context");
  await mkdir(output, { recursive: true });
  const runner: BoardAgentStageRunner = {
    mode: "local",
    async run() {
      const bytes = Buffer.from('{"completed":true}');
      return envelope(bytes, []);
    }
  };
  try {
    await assert.rejects(
      () =>
        runPortableBoardAgentStage(
          runner,
          {
            id: "missing-output",
            prompt: "Write the declared file.",
            workingDirectory: root,
            writableDirectories: [output],
            outputFiles: [join(output, "missing.md")],
            budgetSeconds: 30
          },
          { commitSha: "b".repeat(40), attempt: 1 },
          {}
        ),
      /omitted declared host output/
    );
    await assert.rejects(
      () =>
        runPortableBoardAgentStage(
          runner,
          {
            id: "escaping-output",
            prompt: "Write outside the root.",
            workingDirectory: root,
            writableDirectories: [output],
            outputFiles: [join(root, "escape.md")],
            budgetSeconds: 30
          },
          { commitSha: "b".repeat(40), attempt: 1 },
          {}
        ),
      /outside its writable roots/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable adapter fits a 96-page repair inside the aggregate output budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-board-adapter-pages-"));
  const output = join(root, "context");
  const targets = Array.from({ length: 96 }, (_, index) => join(output, `subject-${index}.md`));
  await mkdir(output, { recursive: true });
  let aggregateMaximum = 0;
  const runner: BoardAgentStageRunner = {
    mode: "local",
    async run(input) {
      const outputFiles = input.outputFiles ?? [];
      assert.equal(outputFiles.length, 96);
      aggregateMaximum = outputFiles.reduce((total, file) => total + file.maxBytes, 0);
      const bytes = Buffer.from('{"completed":true}');
      return envelope(
        bytes,
        outputFiles.map((file) => ({
          ...file,
          bytes: Buffer.from("x"),
          sha256: digest(Buffer.from("x"))
        }))
      );
    }
  };
  try {
    await runPortableBoardAgentStage(
      runner,
      {
        id: "repair-all-subjects",
        prompt: `Repair every page under ${output}.`,
        workingDirectory: root,
        writableDirectories: [output],
        outputFiles: targets,
        budgetSeconds: 60
      },
      { commitSha: "c".repeat(40), attempt: 1 },
      {}
    );
    assert.ok(aggregateMaximum <= 64 * 1024 * 1024);
    assert.equal(await readFile(targets[95]!, "utf8"), "x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production board workers reject implicit and explicit local execution", () => {
  assert.throws(
    () => configuredBoardAgentRunner({ NODE_ENV: "production" }),
    /CONTEXT_BOARD_EXECUTOR=daytona is required/
  );
  assert.throws(
    () =>
      configuredBoardAgentRunner({
        NODE_ENV: "production",
        CONTEXT_BOARD_EXECUTOR: "local"
      }),
    /CONTEXT_BOARD_EXECUTOR=daytona is required/
  );
  const runner = configuredBoardAgentRunner({
    NODE_ENV: "production",
    CONTEXT_BOARD_EXECUTOR: "daytona",
    DAYTONA_API_KEY: "daytona-test-key",
    CONTEXT_DAYTONA_SNAPSHOT: "board-agent-snapshot-v1",
    CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret"
  });
  assert.equal(runner.mode, "daytona");
});

test("Daytona worker configuration requires one immutable selector and a Secret name", () => {
  const base = {
    NODE_ENV: "production",
    CONTEXT_BOARD_EXECUTOR: "daytona",
    DAYTONA_API_KEY: "daytona-test-key",
    CONTEXT_DAYTONA_MODEL_SECRET: "openai-model-secret"
  };
  assert.throws(
    () => configuredBoardAgentRunner(base),
    /exactly one CONTEXT_DAYTONA_SNAPSHOT or CONTEXT_DAYTONA_IMAGE/
  );
  assert.throws(
    () =>
      configuredBoardAgentRunner({
        ...base,
        CONTEXT_DAYTONA_SNAPSHOT: "board-agent-snapshot-v1",
        CONTEXT_DAYTONA_IMAGE: `registry.example/agent@sha256:${"a".repeat(64)}`
      }),
    /exactly one CONTEXT_DAYTONA_SNAPSHOT or CONTEXT_DAYTONA_IMAGE/
  );
  assert.throws(
    () =>
      configuredBoardAgentRunner({
        ...base,
        CONTEXT_DAYTONA_IMAGE: "registry.example/agent:latest"
      }),
    /must be pinned by sha256 digest/
  );

  const credentialValue = "sk-proj-private-model-credential";
  assert.throws(
    () =>
      configuredBoardAgentRunner({
        ...base,
        CONTEXT_DAYTONA_SNAPSHOT: "board-agent-snapshot-v1",
        CONTEXT_DAYTONA_MODEL_SECRET: credentialValue
      }),
    (error) => {
      assert.match(String(error), /must be a Secret name, not a credential value/);
      assert.doesNotMatch(String(error), new RegExp(credentialValue));
      return true;
    }
  );

  assert.equal(
    configuredBoardAgentRunner({
      ...base,
      CONTEXT_DAYTONA_IMAGE: `registry.example/agent@sha256:${"b".repeat(64)}`
    }).mode,
    "daytona"
  );
});

test("execution profiles are fetched without retaining decrypted credentials and strictly bounded", async () => {
  const environment = {
    JINA_API_URL: "https://context.usejina.test",
    JINA_PRODUCT_API_URL: "https://api.usejina.test",
    JINA_PRODUCT_INTERNAL_API_TOKEN: "internal-test-token"
  };
  const attempt = {
    commitSha: "a".repeat(40),
    attempt: 1,
    tenantId: "tenant-1",
    buildId: "build-1"
  };
  let calls = 0;
  const requestedUrls: string[] = [];
  const profileFetch = async (input: string) => {
    calls += 1;
    requestedUrls.push(input);
    return profileResponse({
      provider: "byok",
      model: "openai/gpt-5.6-terra",
      effort: "medium",
      fallback_policy: "fail_notify",
      credential: {
        kind: "openai",
        value: `sk-profile-${calls}-credential`,
        revision: `revision-${calls}`
      },
      settings_revision: "settings-1"
    });
  };

  const first = await resolveContextExecutionProfile(environment, attempt, profileFetch);
  const second = await resolveContextExecutionProfile(environment, attempt, profileFetch);
  assert.equal(calls, 2);
  assert.deepEqual(requestedUrls, [
    "https://api.usejina.test/internal/context/execution-profile",
    "https://api.usejina.test/internal/context/execution-profile"
  ]);
  assert.equal(first?.credential.kind === "openai" ? first.credential.value : undefined, "sk-profile-1-credential");
  assert.equal(second?.credential.kind === "openai" ? second.credential.value : undefined, "sk-profile-2-credential");

  await assert.rejects(
    () =>
      resolveContextExecutionProfile(environment, attempt, async () =>
        profileResponse({
          provider: "byok",
          model: "openai/gpt-5.6-terra",
          effort: "extreme",
          fallback_policy: "fail_notify",
          credential: { kind: "openai", value: "sk-private-invalid", revision: "revision-1" },
          settings_revision: "settings-1"
        })
      ),
    /effort is invalid/
  );
  await assert.rejects(
    () =>
      resolveContextExecutionProfile(environment, attempt, async () =>
        profileResponse({
          provider: "managed",
          model: "openai/gpt-5.6-terra",
          effort: "medium",
          fallback_policy: "fail_notify",
          credential: { kind: "managed" },
          settings_revision: "settings-1",
          unexpected: true
        })
      ),
    /unexpected fields/
  );
  await assert.rejects(
    () =>
      resolveContextExecutionProfile(environment, attempt, async () =>
        profileResponse({
          provider: "managed",
          model: "openai/gpt-5.6-terra",
          effort: "medium",
          fallback_policy: "fail_notify",
          credential: {
            kind: "openrouter",
            value: "sk-or-v1-private-invalid",
            revision: "revision-1"
          },
          settings_revision: "settings-1"
        })
      ),
    /provider and credential are inconsistent/
  );
  await assert.rejects(
    () =>
      resolveContextExecutionProfile(
        environment,
        attempt,
        async () =>
          new Response("x".repeat(64 * 1024 + 1), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      ),
    /exceeds its byte bound/
  );
  await assert.rejects(
    () => resolveContextExecutionProfile(environment, attempt, async () => new Response("", { status: 503 })),
    /Context API execution-profile request failed with 503/
  );
  await assert.rejects(
    () => resolveContextExecutionProfile(environment, attempt, async () => new Response("", { status: 401 })),
    /Context API execution-profile request failed with 401/
  );
});

test("execution-profile requests retain the unified-API fallback", async () => {
  let requestedUrl = "";
  await resolveContextExecutionProfile(
    {
      JINA_API_URL: "https://unified.usejina.test",
      JINA_PRODUCT_INTERNAL_API_TOKEN: "internal-test-token"
    },
    {
      commitSha: "a".repeat(40),
      attempt: 1,
      tenantId: "tenant-1",
      buildId: "build-1"
    },
    async (input) => {
      requestedUrl = input;
      return profileResponse({
        provider: "managed",
        model: "openai/gpt-5.6-terra",
        effort: "medium",
        fallback_policy: "managed",
        credential: { kind: "managed" },
        settings_revision: "settings-1"
      });
    }
  );
  assert.equal(requestedUrl, "https://unified.usejina.test/internal/context/execution-profile");
});

test("worker-scoped API credentials create a fresh Daytona runner for every stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-worker-scoped-credential-"));
  const credentialValue = "sk-worker-scoped-test-credential";
  const executions: (BoardAgentExecutionConfiguration | undefined)[] = [];
  const protectedValues: (readonly string[])[] = [];
  const runner = configuredPortableContextBoardAgentStageRunner({
    environment: {},
    protectedValues: [credentialValue],
    defaultExecution: {
      credential: { kind: "api-key", environmentVariable: "OPENAI_API_KEY", value: credentialValue },
      model: "gpt-5.6-terra",
      effort: "medium",
      domains: ["api.openai.com"]
    },
    attemptContext: () => ({ commitSha: "c".repeat(40), attempt: 1 }),
    runnerFactory: (_environment, protectedInput, execution) => {
      executions.push(execution);
      protectedValues.push(protectedInput);
      return {
        mode: "daytona",
        async run() {
          return envelope(Buffer.from('{"text":"completed"}'), []);
        }
      };
    }
  });

  try {
    const input = {
      id: "worker-scoped-stage",
      prompt: "Complete the stage.",
      workingDirectory: root,
      readOnly: true,
      budgetSeconds: 30
    } as const;
    await runner.run(input);
    await runner.run(input);

    assert.equal(executions.length, 2);
    assert.ok(executions.every((execution) => execution?.credential.kind === "api-key"));
    assert.ok(protectedValues.every((values) => values.includes(credentialValue)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed initial execution and non-OpenAI provider fallback use the configured managed model", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-profile-fallback-"));
  const environment = {
    CONTEXT_DAYTONA_MODEL_SECRET: "managed-openai-secret",
    CONTEXT_DAYTONA_MODEL_SECRET_ENV: "OPENAI_API_KEY",
    CONTEXT_DAYTONA_MODEL_DOMAINS: "api.openai.com",
    CONTEXT_CODEX_MODEL: "openai/gpt-5.6-terra",
    JINA_API_URL: "https://api.usejina.test",
    JINA_PRODUCT_INTERNAL_API_TOKEN: "internal-test-token"
  };
  const executions: (BoardAgentExecutionConfiguration | undefined)[] = [];
  const runnerFactory = (
    _environment: Readonly<Record<string, string | undefined>>,
    _protectedValues: readonly string[],
    execution?: BoardAgentExecutionConfiguration
  ): BoardAgentStageRunner => {
    executions.push(execution);
    return {
      mode: "daytona",
      async run() {
        if (
          execution?.credential.kind === "api-key" &&
          execution.credential.environmentVariable === "OPENROUTER_API_KEY"
        ) {
          throw new Error("OpenRouter provider service unavailable");
        }
        return envelope(Buffer.from('{"text":"completed"}'), []);
      }
    };
  };
  const attemptContext = () => ({
    commitSha: "b".repeat(40),
    attempt: 1,
    tenantId: "tenant-1",
    buildId: "build-1"
  });
  try {
    const fallbackRunner = configuredPortableContextBoardAgentStageRunner({
      environment,
      attemptContext,
      runnerFactory,
      profileFetch: async () =>
        profileResponse({
          provider: "byok",
          model: "anthropic/claude-sonnet-4",
          effort: "high",
          fallback_policy: "managed",
          credential: { kind: "openrouter", value: "sk-or-v1-tenant-key", revision: "key-1" },
          settings_revision: "settings-1"
        })
    });
    await fallbackRunner.run({
      id: "fallback-stage",
      prompt: "Complete the stage.",
      workingDirectory: root,
      readOnly: true,
      budgetSeconds: 30
    });
    const selected = executions.find((execution) => execution?.credential.kind === "api-key");
    const fallback = executions.find((execution) => execution?.credential.kind === "secret");
    assert.equal(selected?.model, "anthropic/claude-sonnet-4");
    assert.equal(fallback?.model, "gpt-5.6-terra");
    assert.equal(fallback?.effort, "high");

    executions.length = 0;
    const semanticFailureRunner = configuredPortableContextBoardAgentStageRunner({
      environment,
      attemptContext,
      runnerFactory: (_environment, _protectedValues, execution) => {
        executions.push(execution);
        return {
          mode: "daytona",
          async run() {
            if (execution?.credential.kind === "api-key") {
              throw new Error("board agent model output is not valid JSON");
            }
            return envelope(Buffer.from('{"text":"must not fall back"}'), []);
          }
        };
      },
      profileFetch: async () =>
        profileResponse({
          provider: "byok",
          model: "anthropic/claude-sonnet-4",
          effort: "high",
          fallback_policy: "managed",
          credential: { kind: "openrouter", value: "sk-or-v1-tenant-key", revision: "key-1" },
          settings_revision: "settings-1"
        })
    });
    await assert.rejects(
      () =>
        semanticFailureRunner.run({
          id: "semantic-failure-stage",
          prompt: "Complete the stage.",
          workingDirectory: root,
          readOnly: true,
          budgetSeconds: 30
        }),
      /model output is not valid JSON/
    );
    assert.equal(
      executions.some((execution) => execution?.credential.kind === "secret"),
      false
    );

    executions.length = 0;
    const managedRunner = configuredPortableContextBoardAgentStageRunner({
      environment,
      attemptContext,
      runnerFactory,
      profileFetch: async () =>
        profileResponse({
          provider: "managed",
          model: "openai/gpt-5.6-luna",
          effort: "medium",
          fallback_policy: "fail_notify",
          credential: { kind: "managed" },
          settings_revision: "settings-2"
        })
    });
    await managedRunner.run({
      id: "managed-stage",
      prompt: "Complete the stage.",
      workingDirectory: root,
      readOnly: true,
      budgetSeconds: 30
    });
    const managed = executions.find((execution) => execution?.credential.kind === "secret");
    assert.equal(managed?.model, "gpt-5.6-luna");
    assert.equal(managed?.effort, "medium");

    executions.length = 0;
    const managedApiKey = "sk-managed-production-key";
    const managedKeyRunner = configuredPortableContextBoardAgentStageRunner({
      environment: { ...environment, JINA_MANAGED_MODEL_API_KEY: managedApiKey },
      attemptContext,
      runnerFactory,
      profileFetch: async () =>
        profileResponse({
          provider: "managed",
          model: "openai/gpt-5.6-luna",
          effort: "medium",
          fallback_policy: "fail_notify",
          credential: { kind: "managed" },
          settings_revision: "settings-managed-key"
        })
    });
    await managedKeyRunner.run({
      id: "managed-key-stage",
      prompt: "Complete the stage.",
      workingDirectory: root,
      readOnly: true,
      budgetSeconds: 30
    });
    const managedKey = executions.find(
      (execution) => execution?.credential.kind === "api-key" && execution.credential.value === managedApiKey
    );
    assert.equal(managedKey?.model, "gpt-5.6-luna");
    assert.equal(managedKey?.effort, "medium");

    executions.length = 0;
    const codexRunner = configuredPortableContextBoardAgentStageRunner({
      environment,
      attemptContext,
      runnerFactory,
      profileFetch: async () =>
        profileResponse({
          provider: "codex",
          model: "openai/gpt-5.6-terra",
          effort: "low",
          fallback_policy: "fail_notify",
          credential: { kind: "codex", value: '{"tokens":{"access_token":"private"}}', revision: "auth-1" },
          settings_revision: "settings-3"
        })
    });
    await codexRunner.run({
      id: "codex-stage",
      prompt: "Complete the stage.",
      workingDirectory: root,
      readOnly: true,
      budgetSeconds: 30
    });
    const codex = executions.find((execution) => execution?.credential.kind === "codex");
    assert.deepEqual(codex?.domains, ["chatgpt.com"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model usage aggregates every portable call and rejects unsafe totals", () => {
  const first = addBoardAgentModelUsage(
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20 }
  );
  assert.deepEqual(
    addBoardAgentModelUsage(first, {
      inputTokens: 45,
      cachedInputTokens: 10,
      outputTokens: 12
    }),
    { inputTokens: 145, cachedInputTokens: 70, outputTokens: 32 }
  );
  assert.throws(
    () =>
      addBoardAgentModelUsage(
        { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0 },
        { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }
      ),
    /safe integer range/
  );
});

test("completion usage preserves billable semantic failures and retries", () => {
  const aggregate = {
    inputTokens: 145,
    cachedInputTokens: 70,
    outputTokens: 32
  };
  assert.deepEqual(
    boardAgentModelUsageForCompletion({
      outcome: "failed",
      observed: true,
      usage: aggregate
    }),
    aggregate
  );
  assert.deepEqual(
    boardAgentModelUsageForCompletion({
      outcome: "retry",
      observed: true,
      usage: aggregate
    }),
    aggregate
  );
  assert.equal(
    boardAgentModelUsageForCompletion({
      outcome: "failed",
      observed: false,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    }),
    undefined
  );
  assert.deepEqual(
    boardAgentModelUsageForCompletion({
      outcome: "done",
      observed: false,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  );
});

function envelope(bytes: Uint8Array, files: BoardAgentStageResultEnvelope["files"]): BoardAgentStageResultEnvelope {
  return {
    version: 1,
    contentType: "application/json",
    bytes,
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
    usage,
    files
  };
}

function profileResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function gunzipArchive(bytes: Uint8Array): Promise<string> {
  const { gunzipSync } = await import("node:zlib");
  return gunzipSync(bytes).toString("latin1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
