import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const fakeApiKey = "dtn_private_preflight_key";
const fakeBearer = "private-bearer-value";

test("Daytona preflight delegates its exact bounded contract to the production runner", async () => {
  const fixture = await fakeRunnerFixture();
  try {
    const { stdout, stderr } = await runPreflight(fixture);
    assert.match(stdout, /Daytona production BoardAgent preflight passed/);
    assert.equal(stderr, "");
    const captured = JSON.parse(await readFile(fixture.capturePath, "utf8"));
    assert.deepEqual(captured, {
      snapshot: null,
      image: `registry.example/board-agent@sha256:${"a".repeat(64)}`,
      environmentVariable: "OPENAI_API_KEY",
      secretName: "organization-model-secret",
      domains: ["api.openai.com"],
      model: "gpt-5.6-terra",
      effort: "low",
      verbosity: "high",
      setupTimeoutSeconds: 300,
      apiKeyProtected: true,
      id: "production-preflight",
      promptRequiresShellFile: true,
      timeoutSeconds: 180,
      contextTokens: 128000,
      compactTokens: 96000,
      outputFiles: [{ path: "tool-ok", contentType: "text/plain", maxBytes: 64 }]
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Daytona preflight bounds and redacts runner failures without retaining a transcript", async () => {
  const fixture = await fakeRunnerFixture();
  try {
    await assert.rejects(
      () => runPreflight(fixture, { PREFLIGHT_FAKE_FAILURE: "true" }),
      (error) => {
        const stderr = String(error.stderr);
        assert.match(stderr, /Daytona production BoardAgent preflight failed/);
        assert.match(stderr, /\[credential-redacted\]/);
        assert.doesNotMatch(stderr, new RegExp(fakeApiKey));
        assert.doesNotMatch(stderr, new RegExp(fakeBearer));
        assert.doesNotMatch(stderr, /dtn_secret_private_placeholder/);
        assert.ok(stderr.length < 4_000, `diagnostic was ${stderr.length} bytes`);
        return true;
      }
    );
  } finally {
    await fixture.cleanup();
  }
});

async function fakeRunnerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "jina-daytona-preflight-test-"));
  const modulePath = join(directory, "daytona.mjs");
  const capturePath = join(directory, "capture.json");
  await writeFile(
    modulePath,
    `
      import { writeFileSync } from "node:fs";

      export class DaytonaBoardAgentStageRunner {
        constructor(options) {
          this.options = options;
        }

        async run(input) {
          if (process.env.PREFLIGHT_FAKE_FAILURE === "true") {
            throw new Error(
              "provider failed " +
                process.env.DAYTONA_API_KEY +
                " Bearer ${fakeBearer} dtn_secret_private_placeholder " +
                "x".repeat(5_000) +
                " " +
                process.env.DAYTONA_API_KEY
            );
          }
          writeFileSync(
            process.env.PREFLIGHT_CAPTURE_PATH,
            JSON.stringify({
              snapshot: this.options.snapshot ?? null,
              image: this.options.image ?? null,
              environmentVariable: this.options.modelSecret.environmentVariable,
              secretName: this.options.modelSecret.secretName,
              domains: this.options.allowedDomains,
              model: this.options.model,
              effort: this.options.effort,
              verbosity: this.options.verbosity,
              setupTimeoutSeconds: this.options.setupTimeoutSeconds,
              apiKeyProtected: this.options.protectedValues.includes(process.env.DAYTONA_API_KEY),
              id: input.id,
              promptRequiresShellFile: input.prompt.includes("shell tool") && input.prompt.includes("TOOL_OK"),
              timeoutSeconds: input.limits.timeoutSeconds,
              contextTokens: input.limits.contextTokens,
              compactTokens: input.limits.compactTokens,
              outputFiles: input.outputFiles
            })
          );
          return {
            bytes: Buffer.from('{"status":"AUTH_OK"}'),
            files: [{ path: "tool-ok", bytes: Buffer.from("TOOL_OK") }]
          };
        }
      }
    `,
    "utf8"
  );
  return {
    modulePath,
    capturePath,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function runPreflight(fixture, additionalEnvironment = {}) {
  return execFileAsync(process.execPath, ["scripts/context-production-preflight.mjs", "daytona"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DAYTONA_API_KEY: fakeApiKey,
      CONTEXT_DAYTONA_MODULE_PATH: fixture.modulePath,
      CONTEXT_DAYTONA_SNAPSHOT: "",
      CONTEXT_DAYTONA_IMAGE: `registry.example/board-agent@sha256:${"a".repeat(64)}`,
      CONTEXT_DAYTONA_MODEL_SECRET: "organization-model-secret",
      CONTEXT_DAYTONA_MODEL_SECRET_ENV: "OPENAI_API_KEY",
      CONTEXT_DAYTONA_MODEL_DOMAINS: "api.openai.com",
      CONTEXT_CODEX_MODEL: "gpt-5.6-terra",
      CONTEXT_CODEX_EFFORT: "low",
      CONTEXT_CODEX_VERBOSITY: "high",
      CONTEXT_CODEX_CONTEXT_TOKENS: "128000",
      CONTEXT_CODEX_COMPACT_TOKENS: "96000",
      PREFLIGHT_CAPTURE_PATH: fixture.capturePath,
      ...additionalEnvironment
    }
  });
}
