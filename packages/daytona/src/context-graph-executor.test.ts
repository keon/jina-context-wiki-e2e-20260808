import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Sandbox } from "@daytona/sdk";
import {
  buildFocusEvidenceBundle,
  collectCodexHarnessTokenSecrets,
  codexCommand,
  contextGraphCheckout,
  contextGraphGitAuthEnv,
  contextGraphModelEnvironment,
  executeAbortableSandboxCommand,
  findExistingCodex,
  isTransientModelExecutionFailure,
  resolveCodexSnapshot,
  sanitizeGeneratedModelOutput
} from "./context-graph-executor.js";

test("clones commit refs from the default branch before checking out the pinned SHA", () => {
  const sha = "5b8a5176b3463d5ef024c8b8d22cdacc7ed04147";
  assert.deepEqual(contextGraphCheckout(sha), { expectedCommitSha: sha });
  assert.deepEqual(contextGraphCheckout("main"), { cloneRef: "main" });
  assert.deepEqual(contextGraphCheckout("main", sha), {
    cloneRef: "main",
    expectedCommitSha: sha
  });
});

test("keeps installation credentials out of fetch commands while forwarding them through the environment", () => {
  const token = "installation-token";
  assert.deepEqual(contextGraphGitAuthEnv(token), {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  });
  assert.equal(contextGraphGitAuthEnv(), undefined);
});

test("classifies retryable provider execution failures", () => {
  assert.equal(isTransientModelExecutionFailure("stream disconnected before completion: Internal Server Error"), true);
  assert.equal(isTransientModelExecutionFailure("HTTP 429: rate limit exceeded"), true);
  assert.equal(isTransientModelExecutionFailure("fetch failed"), true);
  assert.equal(isTransientModelExecutionFailure("contextGraph output failed schema validation"), false);
  assert.equal(isTransientModelExecutionFailure("model not found"), false);
});

test("runs Codex through OpenRouter Responses with catalog-aware authentication", () => {
  const command = codexCommand("/opt/codex", "openai/gpt-5.6-luna");
  assert.match(command, /codex' exec --json --ephemeral/);
  assert.match(command, /--output-schema/);
  assert.match(command, /--output-last-message/);
  assert.match(command, /openai\/gpt-5\.6-luna/);
  assert.match(command, /model_provider=openrouter/);
  assert.match(command, /base_url=https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(command, /wire_api=responses/);
  assert.match(command, /auth\.command=printenv/);
  assert.match(command, /OPENROUTER_API_KEY/);
  assert.match(command, /model_reasoning_effort='medium'/);
  assert.match(command, /shell_environment_policy\.inherit=core/);
  assert.match(command, /shell_environment_policy\.exclude=/);
  assert.doesNotMatch(command, /chat\/completions/);
});

test("native OpenAI and Codex harness routes do not inherit OpenRouter configuration", () => {
  const openai = codexCommand("/opt/codex", {
    provider: "openai",
    model: "gpt-5.6-luna"
  });
  const codex = codexCommand("/opt/codex", {
    provider: "codex",
    model: "gpt-5.6-sol"
  });
  assert.doesNotMatch(openai, /model_provider=openrouter|model_providers\.openrouter/);
  assert.doesNotMatch(codex, /model_provider=openrouter|model_providers\.openrouter/);
  assert.match(openai, /gpt-5\.6-luna/);
  assert.match(codex, /gpt-5\.6-sol/);
  assert.deepEqual(contextGraphModelEnvironment("openrouter", "or-key"), {
    OPENROUTER_API_KEY: "or-key"
  });
  assert.deepEqual(contextGraphModelEnvironment("openai", "oa-key"), {
    CODEX_API_KEY: "oa-key"
  });
  assert.deepEqual(contextGraphModelEnvironment("codex", "auth-json"), {
    CODEX_HOME: "/home/daytona/context-graph/.codex"
  });
});

test("extracts nested Codex account tokens for field-level error redaction", () => {
  assert.deepEqual(
    collectCodexHarnessTokenSecrets(
      JSON.stringify({
        tokens: {
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          nested: { id_token: "identity-secret" }
        }
      })
    ).sort(),
    ["access-secret", "identity-secret", "refresh-secret"]
  );
  assert.deepEqual(collectCodexHarnessTokenSecrets("not-json"), []);
});

test("uses a prebaked Codex binary when the sandbox image provides one", async () => {
  const commands: string[] = [];
  const sandbox = {
    process: {
      executeCommand: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, result: "/home/daytona/context-graph/node_modules/.bin/codex\n" };
      }
    }
  };
  assert.equal(await findExistingCodex(sandbox), "/home/daytona/context-graph/node_modules/.bin/codex");
  assert.match(commands[0] ?? "", /command -v codex/);
});

test("reuses the versioned Codex snapshot instead of rebuilding it per task", async () => {
  const previous = process.env.DAYTONA_SNAPSHOT;
  delete process.env.DAYTONA_SNAPSHOT;
  let creates = 0;
  try {
    const snapshot = await resolveCodexSnapshot({
      snapshot: {
        get: async () => ({ name: "jina-context-graph-codex-0-145-0" }),
        create: async () => {
          creates += 1;
          return { name: "unexpected" };
        }
      }
    });
    assert.equal(snapshot, "jina-context-graph-codex-0-145-0");
    assert.equal(creates, 0);
  } finally {
    if (previous === undefined) delete process.env.DAYTONA_SNAPSHOT;
    else process.env.DAYTONA_SNAPSHOT = previous;
  }
});

test("aborts an in-flight Codex command when its task lease is lost", async () => {
  const controller = new AbortController();
  let deleted = false;
  const command = executeAbortableSandboxCommand(
    {
      process: {
        executeCommand: async () => new Promise<never>(() => undefined)
      }
    },
    "codex exec",
    "/repo",
    { OPENROUTER_API_KEY: "secret" },
    600,
    controller.signal,
    () => {
      deleted = true;
    }
  );
  controller.abort(new Error("lease lost"));
  await assert.rejects(command, /lease lost/);
  assert.equal(deleted, true);
});

test("canonicalizes GitHub work items and drops unanchored deterministic source aliases", () => {
  const sanitized = sanitizeGeneratedModelOutput({
    summary: "model output",
    nodes: [
      {
        id: "issue:github:omxyz/example#8",
        kind: "Issue",
        label: "Issue 8",
        description: "Regression",
        evidence: ["docs/root-cause.md:1"]
      },
      {
        id: "incident:compose:omxyz/old-name:api",
        kind: "Incident",
        label: "Old incident alias",
        description: "Unanchored",
        evidence: ["docs/postmortem.md:1"]
      }
    ],
    edges: [
      {
        source: "issue:github:omxyz/example#8",
        target: "incident:compose:omxyz/old-name:api",
        predicate: "INCIDENT_IMPACTS",
        plane: "knowledge",
        confidence: 1,
        why: "Model alias",
        evidence: ["docs/postmortem.md:1"]
      }
    ]
  });
  assert.deepEqual(
    sanitized.nodes.map((node) => node.id),
    ["8"]
  );
  assert.deepEqual(sanitized.edges, []);
});

test("focus evidence streaming stops at the configured byte budget", async () => {
  const previousMaximum = process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_MAX_CHARS;
  const previousPerFile = process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_FILE_CHARS;
  process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_MAX_CHARS = "64";
  process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_FILE_CHARS = "64";
  let destroyed = false;
  try {
    const stream = new Readable({
      read() {
        this.push(Buffer.alloc(32, "a"));
        this.push(Buffer.alloc(32, "b"));
        this.push(Buffer.alloc(32, "c"));
      },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      }
    });
    const fs = {
      downloadFileStream: async () => stream
    } as unknown as Pick<Sandbox["fs"], "downloadFileStream">;
    const processApi = {
      executeCommand: async () => ({ exitCode: 0, result: "" })
    } as unknown as Pick<Sandbox["process"], "executeCommand">;
    const result = await buildFocusEvidenceBundle({ fs, process: processApi }, ["src/large.ts"]);
    assert.equal(Buffer.byteLength(result.files[0]?.content ?? ""), 64);
    assert.equal(destroyed, true);
    assert.equal(result.files[0]?.content.includes("c"), false);
  } finally {
    if (previousMaximum === undefined) delete process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_MAX_CHARS;
    else process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_MAX_CHARS = previousMaximum;
    if (previousPerFile === undefined) delete process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_FILE_CHARS;
    else process.env.CONTEXT_GRAPH_FOCUS_BUNDLE_FILE_CHARS = previousPerFile;
  }
});

test("focus evidence rejects symlink escapes before downloading", async () => {
  let downloaded = false;
  const fs = {
    downloadFileStream: async () => {
      downloaded = true;
      return Readable.from("secret");
    }
  } as unknown as Pick<Sandbox["fs"], "downloadFileStream">;
  const processApi = {
    executeCommand: async () => ({ exitCode: 1, result: "symlink" })
  } as unknown as Pick<Sandbox["process"], "executeCommand">;
  await assert.rejects(
    buildFocusEvidenceBundle({ fs, process: processApi }, ["src/escape.ts"]),
    /not a regular in-repository file/
  );
  assert.equal(downloaded, false);
});
