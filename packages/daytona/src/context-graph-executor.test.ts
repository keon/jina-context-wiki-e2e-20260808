import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Sandbox } from "@daytona/sdk";
import {
  buildFocusEvidenceBundle,
  findExistingCodex,
  isTransientCodexExecutionFailure
} from "./context-graph-executor.js";

test("classifies retryable provider execution failures", () => {
  assert.equal(isTransientCodexExecutionFailure("stream disconnected before completion: Internal Server Error"), true);
  assert.equal(isTransientCodexExecutionFailure("HTTP 429: rate limit exceeded"), true);
  assert.equal(isTransientCodexExecutionFailure("Failed to execute command in sandbox: gateway unavailable"), true);
  assert.equal(isTransientCodexExecutionFailure("contextGraph output failed schema validation"), false);
  assert.equal(isTransientCodexExecutionFailure("model not found"), false);
});

test("uses a prebaked codex binary when the probe reports an absolute path", async () => {
  const commands: string[] = [];
  const sandbox = {
    process: {
      executeCommand: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, result: "/home/daytona/context-graph/node_modules/.bin/codex\n" };
      }
    }
  } as unknown as { readonly process: Pick<Sandbox["process"], "executeCommand"> };
  assert.equal(await findExistingCodex(sandbox), "/home/daytona/context-graph/node_modules/.bin/codex");
  assert.equal(commands.length, 1);
  assert.match(commands[0] ?? "", /command -v codex/);
});

test("falls back to installing codex when the probe finds nothing or fails", async () => {
  const missing = {
    process: { executeCommand: async () => ({ exitCode: 0, result: "" }) }
  } as unknown as { readonly process: Pick<Sandbox["process"], "executeCommand"> };
  assert.equal(await findExistingCodex(missing), undefined);
  const failing = {
    process: { executeCommand: async () => ({ exitCode: 1, result: "boom" }) }
  } as unknown as { readonly process: Pick<Sandbox["process"], "executeCommand"> };
  assert.equal(await findExistingCodex(failing), undefined);
  const relative = {
    process: { executeCommand: async () => ({ exitCode: 0, result: "codex" }) }
  } as unknown as { readonly process: Pick<Sandbox["process"], "executeCommand"> };
  assert.equal(await findExistingCodex(relative), undefined);
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
    const result = await buildFocusEvidenceBundle({ fs }, ["src/large.ts"]);
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
