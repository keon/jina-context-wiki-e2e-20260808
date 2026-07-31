import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  DaytonaBoardAgentStageRunner,
  LocalBoardAgentStageRunner,
  type BoardAgentStageInput,
  type DaytonaBoardAgentCreateRequest,
  type DaytonaBoardAgentSandbox
} from "./board-agent-stage-runner.js";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const usage = { inputTokens: 120, cachedInputTokens: 80, outputTokens: 30 } as const;
const execFileAsync = promisify(execFile);

function fixtureInput(signal?: AbortSignal): BoardAgentStageInput {
  const archive = archiveWithFile("README.md", "fixture\n");
  const artifact = Buffer.from("evidence");
  return {
    id: "bounded-fixture",
    prompt: "Return the fixture result.",
    schema: { type: "object" },
    repository: { commitSha: "a".repeat(40), archive, sha256: digest(archive) },
    artifacts: [{ name: "evidence.txt", contentType: "text/plain", bytes: artifact, sha256: digest(artifact) }],
    limits: { timeoutSeconds: 30, contextTokens: 4096, compactTokens: 2048, attempt: 1, maxAttempts: 1 },
    ...(signal ? { signal } : {})
  };
}

test("runner accepts bounded operator-recovery attempts through thirty-two", async () => {
  const local = new LocalBoardAgentStageRunner({
    processClient: {
      async execute() {
        return {
          exitCode: 0,
          timedOut: false,
          output: Buffer.from('{"completed":true}'),
          usage
        };
      }
    }
  });

  await local.run({
    ...fixtureInput(),
    limits: { timeoutSeconds: 30, contextTokens: 4096, compactTokens: 2048, attempt: 32, maxAttempts: 32 }
  });
  await assert.rejects(
    () =>
      local.run({
        ...fixtureInput(),
        limits: { timeoutSeconds: 30, contextTokens: 4096, compactTokens: 2048, attempt: 33, maxAttempts: 33 }
      }),
    /1\.\.32 retry budget/
  );
});

test("runner recursively rejects strict schemas with declared but optional properties", async () => {
  let started = false;
  const local = new LocalBoardAgentStageRunner({
    processClient: {
      async execute() {
        started = true;
        return {
          exitCode: 0,
          timedOut: false,
          output: Buffer.from('{"completed":true}'),
          usage
        };
      }
    }
  });

  await assert.rejects(
    () =>
      local.run({
        ...fixtureInput(),
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["results"],
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  nullableDetail: { type: ["string", "null"] }
                }
              }
            }
          }
        }
      }),
    /strict JSON schema .*properties\.results\.items.*missing: nullableDetail/
  );
  assert.equal(started, false);
});

test("local and Daytona runners return byte-compatible canonical envelopes without forwarding credentials", async () => {
  const localRequests: unknown[] = [];
  const local = new LocalBoardAgentStageRunner({
    processClient: {
      async execute(request) {
        localRequests.push(request);
        return { exitCode: 0, timedOut: false, output: Buffer.from('{"z":1,"a":true}'), usage };
      }
    }
  });
  let createRequest: DaytonaBoardAgentCreateRequest | undefined;
  const daytonaCommands: string[] = [];
  const uploads = new Map<string, Buffer>();
  const sandbox: DaytonaBoardAgentSandbox = {
    fs: {
      async uploadFile(file, path) {
        uploads.set(path, file);
      },
      async downloadFileStream(path) {
        return (async function* () {
          yield path.endsWith("/usage.json") ? Buffer.from(JSON.stringify(usage)) : Buffer.from('{"a":true,"z":1}');
        })();
      }
    },
    process: {
      async executeCommand(command) {
        daytonaCommands.push(command);
        return { exitCode: 0, result: "" };
      }
    },
    async delete() {}
  };
  const daytona = new DaytonaBoardAgentStageRunner({
    client: {
      async create(request) {
        createRequest = request;
        return sandbox;
      }
    },
    snapshot: "board-agent-image-v1",
    modelSecret: { environmentVariable: "OPENAI_API_KEY", secretName: "board-openai-key" },
    allowedDomains: ["api.openai.com"]
  });

  const input = fixtureInput();
  const [localResult, daytonaResult] = await Promise.all([local.run(input), daytona.run(input)]);
  assert.deepEqual(localResult, daytonaResult);
  assert.equal(Buffer.from(localResult.bytes).toString(), '{"a":true,"z":1}');
  assert.equal(localRequests.length, 1);
  const localRequest = localRequests[0] as { readonly args: readonly string[] };
  assert.equal(localRequest.args.includes("model_provider=openai_direct"), false);
  assert.equal(
    localRequest.args.some((argument) => argument.includes("OPENAI_API_KEY")),
    false
  );
  assert.ok(createRequest);
  assert.deepEqual(createRequest.secrets, { OPENAI_API_KEY: "board-openai-key" });
  assert.equal(JSON.stringify([...uploads.values()].map(String)).includes("board-openai-key"), false);
  assert.equal(JSON.stringify(createRequest.envVars).includes("OPENAI_API_KEY"), false);
  assert.ok(uploads.has("/workspace/inputs/usage-parser.cjs"));
  const modelCommand = daytonaCommands.find((command) => command.includes("codex"));
  assert.ok(modelCommand);
  assert.match(modelCommand, /model_provider=openai_direct/);
  assert.match(modelCommand, /model_providers\.openai_direct\.env_key=OPENAI_API_KEY/);
  assert.match(modelCommand, /model_providers\.openai_direct\.base_url=https:\/\/api\.openai\.com\/v1/);
  assert.match(modelCommand, /model_providers\.openai_direct\.wire_api=responses/);
  await assertUploadedUsageParserHandlesOversizedNonUsageEvent(uploads.get("/workspace/inputs/usage-parser.cjs")!);
});

test("Daytona runner rejects a credential value where a Secret name is required", () => {
  const credentialValue = "sk-proj-private-model-credential";
  assert.throws(
    () =>
      new DaytonaBoardAgentStageRunner({
        client: {
          async create() {
            throw new Error("must not create a sandbox");
          }
        },
        snapshot: "board-agent-image-v1",
        modelSecret: {
          environmentVariable: "OPENAI_API_KEY",
          secretName: credentialValue
        },
        allowedDomains: ["api.openai.com"]
      }),
    (error) => {
      assert.match(String(error), /Daytona model Secret name is invalid/);
      assert.doesNotMatch(String(error), new RegExp(credentialValue));
      return true;
    }
  );
});

test("Daytona runner supports per-build OpenRouter and Codex credentials without persisting them in outputs", async () => {
  const requests: DaytonaBoardAgentCreateRequest[] = [];
  const commands: string[] = [];
  const uploads = new Map<string, Buffer>();
  const sandbox: DaytonaBoardAgentSandbox = {
    fs: {
      async uploadFile(file, path) {
        uploads.set(path, file);
      },
      async downloadFileStream(path) {
        return (async function* () {
          yield path.endsWith("/usage.json") ? Buffer.from(JSON.stringify(usage)) : Buffer.from('{"a":true}');
        })();
      }
    },
    process: {
      async executeCommand(command) {
        commands.push(command);
        return { exitCode: 0, result: "" };
      }
    },
    async delete() {}
  };
  const client = {
    async create(request: DaytonaBoardAgentCreateRequest) {
      requests.push(request);
      return sandbox;
    }
  };

  await new DaytonaBoardAgentStageRunner({
    client,
    snapshot: "board-agent-image-v1",
    credential: { kind: "api-key", environmentVariable: "OPENROUTER_API_KEY", value: "or-test-key" },
    model: "openai/gpt-5.6-terra",
    allowedDomains: ["openrouter.ai"],
    protectedValues: ["or-test-key"]
  }).run(fixtureInput());
  assert.equal(requests[0]?.envVars.OPENROUTER_API_KEY, "or-test-key");
  assert.deepEqual(requests[0]?.secrets, {});
  assert.match(commands.find((command) => command.includes("codex")) ?? "", /model_provider=openrouter/);
  assert.match(commands.find((command) => command.includes("codex")) ?? "", /'-m' 'openai\/gpt-5\.6-terra'/);

  commands.length = 0;
  const authJson = JSON.stringify({ tokens: { access_token: "codex-test-access" } });
  await new DaytonaBoardAgentStageRunner({
    client,
    snapshot: "board-agent-image-v1",
    credential: { kind: "codex", authJson },
    allowedDomains: ["api.openai.com"],
    protectedValues: [authJson, "codex-test-access"]
  }).run(fixtureInput());
  assert.equal(uploads.get("/home/daytona/.codex/auth.json")?.toString(), authJson);
  assert.doesNotMatch(commands.find((command) => command.includes("codex")) ?? "", /model_provider=/);
});

test("raw per-build credentials are redacted from creation and Codex failure diagnostics then consumed", async () => {
  const apiKey = "sk-or-v1-private-api-key";
  const createFailureRunner = new DaytonaBoardAgentStageRunner({
    client: {
      async create() {
        throw new Error(`sandbox request rejected credential ${apiKey}`);
      }
    },
    snapshot: "board-agent-image-v1",
    credential: { kind: "api-key", environmentVariable: "OPENROUTER_API_KEY", value: apiKey },
    model: "openai/gpt-5.6-terra",
    allowedDomains: ["openrouter.ai"]
  });
  await assert.rejects(
    () => createFailureRunner.run(fixtureInput()),
    (error) => {
      assert.match(String(error), /\[REDACTED\]/);
      assert.doesNotMatch(String(error), new RegExp(apiKey));
      return true;
    }
  );
  await assert.rejects(() => createFailureRunner.run(fixtureInput()), /credential was already consumed/);

  const accessToken = "codex-private-access-token";
  const refreshToken = "codex-private-refresh-token";
  const authJson = JSON.stringify({
    tokens: { access_token: accessToken, refresh_token: refreshToken },
    account: { id: "account-private-value" }
  });
  const codexFailureRunner = new DaytonaBoardAgentStageRunner({
    client: {
      async create() {
        return {
          fs: {
            async uploadFile() {},
            async downloadFileStream() {
              throw new Error("must not download failed output");
            }
          },
          process: {
            async executeCommand(command) {
              return command.includes("'codex' 'exec'")
                ? {
                    exitCode: 9,
                    result: `provider stderr echoed ${accessToken} ${refreshToken} ${authJson}`
                  }
                : { exitCode: 0, result: "" };
            }
          },
          async delete() {}
        };
      }
    },
    snapshot: "board-agent-image-v1",
    credential: { kind: "codex", authJson },
    allowedDomains: ["api.openai.com"]
  });
  await assert.rejects(
    () => codexFailureRunner.run(fixtureInput()),
    (error) => {
      const message = String(error);
      assert.match(message, /\[REDACTED\]/);
      for (const secret of [accessToken, refreshToken, authJson]) {
        assert.doesNotMatch(message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      return true;
    }
  );
  await assert.rejects(() => codexFailureRunner.run(fixtureInput()), /credential was already consumed/);
});

test("local Codex JSON events are streamed into exact usage without retaining transcript content", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-codex-usage-fixture-"));
  const binary = join(root, "codex-fixture.cjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const resultFlag = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[resultFlag + 1], '{"completed":true}');
process.stdout.write('{"type":"item.completed","item":{"text":"private transcript content"}}\\n');
process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":91,"cached_input_tokens":40,"output_tokens":17}}\\n');
`,
    "utf8"
  );
  await chmod(binary, 0o755);
  try {
    const runner = new LocalBoardAgentStageRunner({ binary });
    const result = await runner.run(fixtureInput());
    assert.deepEqual(result.usage, {
      inputTokens: 91,
      cachedInputTokens: 40,
      outputTokens: 17
    });
    assert.equal(JSON.stringify(result).includes("private transcript content"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Codex usage collection stream-discards oversized non-usage events", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-codex-large-event-fixture-"));
  const binary = join(root, "codex-fixture.cjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const resultFlag = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[resultFlag + 1], '{"completed":true}');
process.stdout.write(JSON.stringify({type:"item.completed",item:{text:"x".repeat(2 * 1024 * 1024)}}) + "\\n");
process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":91,"cached_input_tokens":40,"output_tokens":17}}\\n');
`,
    "utf8"
  );
  await chmod(binary, 0o755);
  try {
    const result = await new LocalBoardAgentStageRunner({ binary }).run(fixtureInput());
    assert.deepEqual(result.usage, {
      inputTokens: 91,
      cachedInputTokens: 40,
      outputTokens: 17
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local Codex usage collection keeps completion events tightly bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "jina-codex-large-usage-fixture-"));
  const binary = join(root, "codex-fixture.cjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const resultFlag = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[resultFlag + 1], '{"completed":true}');
process.stdout.write(JSON.stringify({
  type:"turn.completed",
  padding:"x".repeat(20 * 1024),
  usage:{input_tokens:91,cached_input_tokens:40,output_tokens:17}
}) + "\\n");
`,
    "utf8"
  );
  await chmod(binary, 0o755);
  try {
    await assert.rejects(
      () => new LocalBoardAgentStageRunner({ binary }).run(fixtureInput()),
      /turn\.completed event exceeds its bound/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful stages fail closed when Codex usage is missing or invalid", async () => {
  const missing = new LocalBoardAgentStageRunner({
    processClient: {
      async execute() {
        return { exitCode: 0, timedOut: false, output: Buffer.from('{"completed":true}') };
      }
    }
  });
  await assert.rejects(() => missing.run(fixtureInput()), /turn\.completed usage.*missing/);

  const malformed = new LocalBoardAgentStageRunner({
    processClient: {
      async execute() {
        return {
          exitCode: 0,
          timedOut: false,
          output: Buffer.from('{"completed":true}'),
          usage: { inputTokens: 2, cachedInputTokens: 3, outputTokens: 1 }
        };
      }
    }
  });
  await assert.rejects(() => malformed.run(fixtureInput()), /cachedInputTokens cannot exceed inputTokens/);
});

test("local and Daytona runners seed and collect identical declared output files", async () => {
  const initial = Buffer.from("# Architecture\n\nInitial draft.\n");
  const revised = Buffer.from("# Architecture\n\nRevised and grounded draft.\n");
  const declaration = {
    path: "docs/architecture.md",
    contentType: "text/markdown",
    maxBytes: 1_024
  } as const;
  const input: BoardAgentStageInput = {
    ...fixtureInput(),
    outputFiles: [declaration],
    initialOutputFiles: [
      {
        name: declaration.path,
        contentType: declaration.contentType,
        bytes: initial,
        sha256: digest(initial)
      }
    ]
  };

  const local = new LocalBoardAgentStageRunner({
    processClient: {
      async execute(request) {
        const target = join(request.cwd, "output", declaration.path);
        assert.equal(await readFile(target, "utf8"), initial.toString("utf8"));
        assert.match(request.prompt, /output\/docs\/architecture\.md/);
        assert.match(request.prompt, /Before returning the final JSON.*write every declared file/);
        assert.match(request.prompt, /Returning the JSON without those files fails the task/);
        await writeFile(target, revised);
        return { exitCode: 0, timedOut: false, output: Buffer.from('{"completed":true}'), usage };
      }
    }
  });

  const uploads = new Map<string, Buffer>();
  const daytona = new DaytonaBoardAgentStageRunner({
    client: {
      async create() {
        return {
          fs: {
            async uploadFile(file, path) {
              uploads.set(path, file);
            },
            async downloadFileStream(path) {
              const bytes = path.endsWith("/result.json")
                ? Buffer.from('{"completed":true}')
                : path.endsWith("/usage.json")
                  ? Buffer.from(JSON.stringify(usage))
                  : revised;
              return (async function* () {
                yield bytes;
              })();
            }
          },
          process: {
            async executeCommand(command) {
              if (command.includes("codex")) {
                assert.equal(
                  uploads.get("/workspace/output/docs/architecture.md")?.toString("utf8"),
                  initial.toString("utf8")
                );
              }
              return { exitCode: 0, result: "" };
            }
          },
          async delete() {}
        };
      }
    },
    snapshot: "board-agent-image-v1",
    modelSecret: { environmentVariable: "OPENAI_API_KEY", secretName: "board-openai-key" },
    allowedDomains: ["api.openai.com"]
  });

  const localResult = await local.run(input);
  const daytonaResult = await daytona.run(input);
  assert.deepEqual(localResult, daytonaResult);
  assert.deepEqual(localResult.files, [
    {
      ...declaration,
      bytes: revised,
      sha256: digest(revised)
    }
  ]);
});

test("initial output files must be declared, bounded, and free of protected credentials", async () => {
  const initial = Buffer.from("too large");
  const undeclared = {
    ...fixtureInput(),
    initialOutputFiles: [
      {
        name: "docs/architecture.md",
        contentType: "text/markdown",
        bytes: initial,
        sha256: digest(initial)
      }
    ]
  };
  const runner = new LocalBoardAgentStageRunner({
    protectedValues: ["protected-value"],
    processClient: {
      async execute(request) {
        await writeFile(join(request.cwd, "output", "docs", "architecture.md"), "protected-value");
        return { exitCode: 0, timedOut: false, output: Buffer.from('{"completed":true}'), usage };
      }
    }
  });
  await assert.rejects(() => runner.run(undeclared), /initial output file is not declared/);
  await assert.rejects(
    () =>
      runner.run({
        ...undeclared,
        outputFiles: [{ path: "docs/architecture.md", contentType: "text/markdown", maxBytes: initial.byteLength - 1 }]
      }),
    /exceeds its declared size bound/
  );
  await assert.rejects(
    () =>
      runner.run({
        ...undeclared,
        outputFiles: [{ path: "docs/architecture.md", contentType: "text/markdown", maxBytes: 1_024 }],
        initialOutputFiles: [
          {
            ...undeclared.initialOutputFiles[0]!,
            contentType: "application/octet-stream"
          }
        ]
      }),
    /does not match its declared content type/
  );
  const safeInitial = Buffer.from("safe");
  await assert.rejects(
    () =>
      runner.run({
        ...undeclared,
        outputFiles: [{ path: "docs/architecture.md", contentType: "text/markdown", maxBytes: 1_024 }],
        initialOutputFiles: [
          {
            name: "docs/architecture.md",
            contentType: "text/markdown",
            bytes: safeInitial,
            sha256: digest(safeInitial)
          }
        ]
      }),
    /protected credential/
  );
});

test("declared outputs support 96 pages under a bounded aggregate byte budget", async () => {
  const declarations = Array.from({ length: 96 }, (_, index) => ({
    path: `page-${index}.md`,
    contentType: "text/markdown",
    maxBytes: 1
  }));
  const runner = new LocalBoardAgentStageRunner({
    processClient: {
      async execute(request) {
        await Promise.all(declarations.map((file) => writeFile(join(request.cwd, "output", file.path), "x")));
        return { exitCode: 0, timedOut: false, output: Buffer.from('{"completed":true}'), usage };
      }
    }
  });
  const result = await runner.run({ ...fixtureInput(), outputFiles: declarations });
  assert.equal(result.files.length, 96);

  await assert.rejects(
    () =>
      runner.run({
        ...fixtureInput(),
        outputFiles: Array.from({ length: 97 }, (_, index) => ({
          path: `overflow-${index}.md`,
          contentType: "text/markdown",
          maxBytes: 1
        }))
      }),
    /declares at most 96 output files/
  );
  await assert.rejects(
    () =>
      runner.run({
        ...fixtureInput(),
        outputFiles: Array.from({ length: 17 }, (_, index) => ({
          path: `large-${index}.md`,
          contentType: "text/markdown",
          maxBytes: 4 * 1024 * 1024
        }))
      }),
    /declared output budget exceeds 67108864 bytes/
  );
});

test("an already-aborted board stage does not create a sandbox or start a local process", async () => {
  const controller = new AbortController();
  controller.abort();
  let localStarted = false;
  const local = new LocalBoardAgentStageRunner({
    processClient: {
      async execute() {
        localStarted = true;
        return { exitCode: 0, timedOut: false, usage };
      }
    }
  });
  await assert.rejects(() => local.run(fixtureInput(controller.signal)), /aborted/);
  assert.equal(localStarted, false);

  let created = false;
  const daytona = new DaytonaBoardAgentStageRunner({
    client: {
      async create() {
        created = true;
        throw new Error("should not run");
      }
    },
    image: "board-agent-image-v1",
    modelSecret: { environmentVariable: "OPENAI_API_KEY", secretName: "board-openai-key" },
    allowedDomains: ["api.openai.com"]
  });
  await assert.rejects(() => daytona.run(fixtureInput(controller.signal)), /aborted/);
  assert.equal(created, false);
});

function archiveWithFile(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const payload = Buffer.from(body);
  return gzipSync(
    Buffer.concat([header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512), Buffer.alloc(1024)])
  );
}

async function assertUploadedUsageParserHandlesOversizedNonUsageEvent(parser: Buffer): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jina-daytona-usage-parser-fixture-"));
  const script = join(root, "usage-parser.cjs");
  const events = join(root, "events.jsonl");
  const output = join(root, "usage.json");
  try {
    await Promise.all([
      writeFile(script, parser),
      writeFile(
        events,
        `${JSON.stringify({ type: "item.completed", item: { text: "x".repeat(2 * 1024 * 1024) } })}\n` +
          '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":80,"output_tokens":30}}\n'
      )
    ]);
    await execFileAsync(process.execPath, [script, events, output]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), usage);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
