import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Sandbox } from "@daytona/sdk";
import {
  buildFocusEvidenceBundle,
  contextGraphCheckout,
  isTransientModelExecutionFailure,
  requestOpenRouterStructuredOutput,
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

test("classifies retryable provider execution failures", () => {
  assert.equal(isTransientModelExecutionFailure("stream disconnected before completion: Internal Server Error"), true);
  assert.equal(isTransientModelExecutionFailure("HTTP 429: rate limit exceeded"), true);
  assert.equal(isTransientModelExecutionFailure("fetch failed"), true);
  assert.equal(isTransientModelExecutionFailure("contextGraph output failed schema validation"), false);
  assert.equal(isTransientModelExecutionFailure("model not found"), false);
});

test("calls OpenRouter directly with strict structured output", async () => {
  const previousMaximum = process.env.CONTEXT_GRAPH_MODEL_MAX_OUTPUT_TOKENS;
  process.env.CONTEXT_GRAPH_MODEL_MAX_OUTPUT_TOKENS = "12000";
  let requestedUrl = "";
  let requestedAuthorization = "";
  let requestedBody: Record<string, unknown> = {};
  try {
    const result = await requestOpenRouterStructuredOutput(
      {
        apiKey: "secret",
        model: "google/gemini-3.5-flash-lite",
        systemPrompt: "system",
        prompt: "evidence",
        outputSchema: { type: "object", additionalProperties: false }
      },
      async (url, init) => {
        requestedUrl = String(url);
        requestedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "generation-1",
            model: "google/gemini-3.5-flash-lite",
            choices: [{ finish_reason: "stop", message: { content: '{"summary":"ok"}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    assert.equal(requestedUrl, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requestedAuthorization, "Bearer secret");
    assert.equal(requestedBody.model, "google/gemini-3.5-flash-lite");
    assert.equal(requestedBody.max_tokens, 12000);
    assert.deepEqual(requestedBody.provider, { require_parameters: true });
    assert.deepEqual(requestedBody.response_format, {
      type: "json_schema",
      json_schema: {
        name: "context_graph_assertions",
        strict: true,
        schema: { type: "object", additionalProperties: false }
      }
    });
    assert.equal(result.id, "generation-1");
    assert.equal(result.text, '{"summary":"ok"}');
  } finally {
    if (previousMaximum === undefined) delete process.env.CONTEXT_GRAPH_MODEL_MAX_OUTPUT_TOKENS;
    else process.env.CONTEXT_GRAPH_MODEL_MAX_OUTPUT_TOKENS = previousMaximum;
  }
});

test("retries transient OpenRouter failures without involving a sandbox command", async () => {
  const previousAttempts = process.env.CONTEXT_GRAPH_MODEL_EXECUTION_ATTEMPTS;
  const previousDelay = process.env.CONTEXT_GRAPH_MODEL_RETRY_DELAY_MS;
  process.env.CONTEXT_GRAPH_MODEL_EXECUTION_ATTEMPTS = "2";
  process.env.CONTEXT_GRAPH_MODEL_RETRY_DELAY_MS = "1";
  let requests = 0;
  try {
    const result = await requestOpenRouterStructuredOutput(
      {
        apiKey: "secret",
        model: "google/gemini-3.5-flash-lite",
        systemPrompt: "system",
        prompt: "evidence",
        outputSchema: { type: "object" }
      },
      async () => {
        requests += 1;
        if (requests === 1) {
          return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"recovered"}' } }] }), {
          status: 200
        });
      }
    );
    assert.equal(requests, 2);
    assert.equal(result.text, '{"summary":"recovered"}');
  } finally {
    if (previousAttempts === undefined) delete process.env.CONTEXT_GRAPH_MODEL_EXECUTION_ATTEMPTS;
    else process.env.CONTEXT_GRAPH_MODEL_EXECUTION_ATTEMPTS = previousAttempts;
    if (previousDelay === undefined) delete process.env.CONTEXT_GRAPH_MODEL_RETRY_DELAY_MS;
    else process.env.CONTEXT_GRAPH_MODEL_RETRY_DELAY_MS = previousDelay;
  }
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
