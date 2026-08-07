import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import zlib from "node:zlib";

import {
  computeNativeCost,
  extractUsage,
  parseOpenaiModelPricingEnv,
  parseUsageFields,
  rawNumberLiteral,
  startOpenRouterProxy,
  type UsageRecord
} from "./openrouter-proxy.js";

const NATIVE_PRICING = {
  "openai/gpt-5.4-mini": {
    input_per_token: "0.0000004",
    output_per_token: "0.0000016",
    cached_per_token: "0.0000001"
  }
};

type CapturedRequest = {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

type Responder = (req: CapturedRequest, res: http.ServerResponse) => void;

async function startFakeUpstream(responder: Responder): Promise<{
  origin: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8")
      };
      requests.push(captured);
      responder(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

// Fail the test with a clear message instead of hanging if a promise that must
// resolve promptly (e.g. flush after a client abort) regresses to blocking.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function proxyRequest(
  port: number,
  input: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path, headers: input.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    if (input.body) {
      req.write(input.body);
    }
    req.end();
  });
}

// Like proxyRequest but preserves the raw response bytes (no utf8 coercion) so a
// binary body such as a gzipped response can be verified byte-for-byte.
function proxyRequestBinary(
  port: number,
  input: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path, headers: input.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    if (input.body) {
      req.write(input.body);
    }
    req.end();
  });
}

// Consume the proxy response deliberately slowly (pause after every chunk) so the
// client socket buffer fills and the proxy's res.write() returns false, exercising
// the backpressure pause/resume path. Returns the fully reassembled body.
function slowReadProxyResponse(
  port: number,
  input: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path, headers: input.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          res.pause();
          setTimeout(() => res.resume(), 3);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (input.body) {
      req.write(input.body);
    }
    req.end();
  });
}

test("proxy injects usage.include + user, keeps caller auth, sets attribution, records exact cost string", async () => {
  const exactCost = "0.00012345678901234567";
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-abc","model":"openai/gpt-5.4","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,` +
        `"cost":${exactCost},"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2},` +
        `"cost_details":{"upstream_inference_cost":0.001}}}`
    );
  });
  const proxy = await startOpenRouterProxy({
    upstream: upstream.origin,
    apiKey: "managed-key-should-not-be-used",
    appUrl: "https://jina.example",
    appTitle: "Jina Code Review",
    user: "review_run-123"
  });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-supplied-key",
        "x-jina-operation": "agent"
      },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi" })
    });
    assert.equal(response.status, 200);

    const captured = upstream.requests[0];
    // Caller Authorization is preserved; the managed key is not injected.
    assert.equal(captured.headers.authorization, "Bearer caller-supplied-key");
    // Attribution headers are set on the upstream request.
    assert.equal(captured.headers["http-referer"], "https://jina.example");
    assert.equal(captured.headers["x-title"], "Jina Code Review");
    // The operation tag is consumed by the proxy, not forwarded upstream.
    assert.equal(captured.headers["x-jina-operation"], undefined);
    // Body was mutated with usage.include + user.
    const forwarded = JSON.parse(captured.body) as Record<string, unknown>;
    assert.deepEqual(forwarded.usage, { include: true });
    assert.equal(forwarded.user, "review_run-123");
    assert.equal(forwarded.input, "hi");

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.operation, "agent");
    assert.equal(record.request_seq, 1);
    assert.equal(record.generation_id, "gen-abc");
    assert.equal(record.model, "openai/gpt-5.4");
    assert.equal(record.prompt_tokens, 10);
    assert.equal(record.completion_tokens, 5);
    assert.equal(record.total_tokens, 15);
    assert.equal(record.reasoning_tokens, 2);
    assert.equal(record.cached_tokens, 3);
    // Cost is the exact wire literal, not a float round-trip.
    assert.equal(record.cost, exactCost);
    assert.equal(typeof record.cost, "string");
    assert.equal(record.upstream_inference_cost, "0.001");
    assert.equal(record.raw_response_metadata?.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy records is_byok=true from a BYOK response alongside both cost fields", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-byok","model":"openai/gpt-5.4","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,` +
        `"cost":0.0001,"is_byok":true,"cost_details":{"upstream_inference_cost":0.002}}}`
    );
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer caller-byok-key" },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.is_byok, true);
    // Both cost fields ride out so the API's BYOK basis (upstream + cost) can be computed.
    assert.equal(record.cost, "0.0001");
    assert.equal(record.upstream_inference_cost, "0.002");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy leaves is_byok absent for a normal (non-BYOK) response", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // No is_byok on the wire, and an explicit false must record as false.
    res.end(
      `{"id":"gen-normal","model":"openai/gpt-5.4","usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0001}}`
    );
  });
  const upstreamFalse = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-false","model":"openai/gpt-5.4","usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0001,"is_byok":false}}`
    );
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin });
  const proxyFalse = await startOpenRouterProxy({ upstream: upstreamFalse.origin });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi" })
    });
    const records = await proxy.flush();
    assert.equal(records[0].is_byok, undefined);

    await proxyRequest(proxyFalse.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi" })
    });
    const recordsFalse = await proxyFalse.flush();
    assert.equal(recordsFalse[0].is_byok, false);
  } finally {
    await proxy.close();
    await proxyFalse.close();
    await upstream.close();
    await upstreamFalse.close();
  }
});

test("proxy overwrites a caller-supplied user with the configured non-PII id", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"g","usage":{"total_tokens":1,"cost":0.001}}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k", user: "review_run-123" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      // Caller sends a user value that could carry PII; it must be replaced.
      body: JSON.stringify({ model: "m", user: "customer-email@example.com" })
    });
    const forwarded = JSON.parse(upstream.requests[0].body) as Record<string, unknown>;
    assert.equal(forwarded.user, "review_run-123");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy leaves a caller-supplied user untouched when no id is configured", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"g","usage":{"total_tokens":1,"cost":0.001}}`);
  });
  // No `user` configured on the proxy.
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", user: "caller-value" })
    });
    const forwarded = JSON.parse(upstream.requests[0].body) as Record<string, unknown>;
    assert.equal(forwarded.user, "caller-value");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy injects the managed key only when the caller sends no Authorization", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen-1","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.01}}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "managed-secret-key" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    assert.equal(upstream.requests[0].headers.authorization, "Bearer managed-secret-key");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy extracts final usage from an SSE stream and passes the body through unchanged", async () => {
  const sseBody =
    `data: {"id":"gen-sse","model":"openai/gpt-5.4","choices":[{"delta":{"content":"hi"}}]}\n\n` +
    `data: {"id":"gen-sse","model":"openai/gpt-5.4","usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"cost":0.002}}\n\n` +
    `data: [DONE]\n\n`;
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseBody);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "planner" },
      body: JSON.stringify({ model: "m", stream: true })
    });
    // The SSE body is streamed through byte-for-byte.
    assert.equal(response.body, sseBody);

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "planner");
    assert.equal(records[0].generation_id, "gen-sse");
    assert.equal(records[0].prompt_tokens, 7);
    assert.equal(records[0].completion_tokens, 3);
    assert.equal(records[0].cost, "0.002");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy captures usage from an SSE event whose JSON spans multiple data: lines", async () => {
  // A single SSE event whose data payload is split across two `data:` lines; per
  // the spec they join with "\n" into one JSON object. The proxy must accumulate
  // the event before parsing, or it captures the event as usage-missing.
  const sseBody =
    `data: {"id":"gen-multi","model":"openai/gpt-5.4",\n` +
    `data: "usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12,"cost":0.003}}\n\n` +
    `data: [DONE]\n\n`;
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseBody);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "planner" },
      body: JSON.stringify({ model: "m", stream: true })
    });
    // The multi-line event is streamed through byte-for-byte, untouched.
    assert.equal(response.body, sseBody);

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].generation_id, "gen-multi");
    assert.equal(records[0].prompt_tokens, 8);
    assert.equal(records[0].completion_tokens, 4);
    assert.equal(records[0].total_tokens, 12);
    assert.equal(records[0].cost, "0.003");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy assigns a monotonic request_seq starting at 1", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen","usage":{"total_tokens":1,"cost":0.001}}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    for (let i = 0; i < 3; i += 1) {
      await proxyRequest(proxy.port, {
        method: "POST",
        path: "/api/v1/responses",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" })
      });
    }
    const records = await proxy.flush();
    assert.deepEqual(
      records.map((r: UsageRecord) => r.request_seq),
      [1, 2, 3]
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy records a usage-less response with an id for generation-stats backfill", async () => {
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":{"id":"gen-late","total_cost":0.042,"tokens_prompt":100,"tokens_completion":20}}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen-late","model":"openai/gpt-5.4"}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    // flush() backfilled cost/tokens from the generation-stats endpoint.
    assert.equal(records[0].generation_id, "gen-late");
    assert.equal(records[0].cost, "0.042");
    assert.equal(records[0].prompt_tokens, 100);
    assert.equal(records[0].completion_tokens, 20);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("operation defaults to 'unknown' when a request carries no operation header", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"g","usage":{"total_tokens":1,"cost":0.001}}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    const records = await proxy.flush();
    assert.equal(records[0].operation, "unknown");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy merges include:true into a caller-supplied usage object instead of replacing it", async () => {
  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"g","usage":{"total_tokens":1,"cost":0.001}}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      // Caller already sent a usage object (without include); it must be kept.
      body: JSON.stringify({ model: "m", usage: { some_option: 1 } })
    });
    const forwarded = JSON.parse(upstream.requests[0].body) as Record<string, unknown>;
    assert.deepEqual(forwarded.usage, { some_option: 1, include: true });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy honors client backpressure on a slow reader without corrupting the body", async () => {
  // A body large enough to overflow the client socket's write buffer, forcing
  // res.write() to return false so the proxy must pause/resume the upstream.
  const filler = "x".repeat(64 * 1024);
  const events: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    events.push(`data: {"id":"gen-bp","choices":[{"delta":{"content":"${filler}"}}]}\n\n`);
  }
  events.push(
    `data: {"id":"gen-bp","model":"openai/gpt-5.4","usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"cost":0.005}}\n\n`
  );
  events.push(`data: [DONE]\n\n`);
  const sseBody = events.join("");

  const upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseBody);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    const received = await slowReadProxyResponse(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "agent" },
      body: JSON.stringify({ model: "m", stream: true })
    });
    // Whole body arrived intact despite the slow reader.
    assert.equal(received, sseBody);

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].generation_id, "gen-bp");
    assert.equal(records[0].prompt_tokens, 4);
    assert.equal(records[0].cost, "0.005");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("oversized non-streaming JSON stops buffering and backfills usage by id", async () => {
  const filler = "y".repeat(200 * 1024);
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":{"id":"gen-big","total_cost":0.077,"tokens_prompt":300,"tokens_completion":40}}`);
      return;
    }
    // id sits at the top so it survives in the retained prefix; the usage tail is
    // pushed past the capture cap and dropped.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-big","filler":"${filler}","usage":{"prompt_tokens":300,"completion_tokens":40,"total_tokens":340,"cost":0.077}}`
    );
  });
  // Tiny cap so the ~200 KB body overflows without allocating megabytes.
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k", captureByteLimit: 4096 });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    // Client still received the full body byte-for-byte.
    assert.equal(response.body.length > 200 * 1024, true);

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    // Usage was not parsed from the truncated body; it was backfilled by id.
    assert.equal(records[0].generation_id, "gen-big");
    assert.equal(records[0].cost, "0.077");
    assert.equal(records[0].prompt_tokens, 300);
    assert.equal(records[0].completion_tokens, 40);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy passes a gzipped JSON response through unchanged and still captures usage", async () => {
  const json = `{"id":"gen-gz","model":"openai/gpt-5.4","usage":{"prompt_tokens":11,"completion_tokens":6,"total_tokens":17,"cost":0.009}}`;
  const gzipped = zlib.gzipSync(Buffer.from(json, "utf8"));
  const upstream = await startFakeUpstream((_req, res) => {
    // Upstream compresses despite the proxy stripping Accept-Encoding.
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipped);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    const response = await proxyRequestBinary(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "planner" },
      body: JSON.stringify({ model: "m" })
    });
    // The compressed body reaches the client byte-for-byte, encoding header intact.
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.deepEqual(response.body, gzipped);
    assert.equal(zlib.gunzipSync(response.body).toString("utf8"), json);

    // Usage/cost were still captured by decompressing the capture copy.
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].generation_id, "gen-gz");
    assert.equal(records[0].prompt_tokens, 11);
    assert.equal(records[0].completion_tokens, 6);
    assert.equal(records[0].cost, "0.009");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("gzipped generation-stats backfill is decompressed before parsing", async () => {
  const stats = `{"data":{"id":"gen-gz-stats","total_cost":0.033,"tokens_prompt":150,"tokens_completion":25}}`;
  const gzippedStats = zlib.gzipSync(Buffer.from(stats, "utf8"));
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      // Upstream compresses the generation-stats reply too; the backfill must
      // decompress it before JSON.parse, or the missing-usage row stays empty.
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzippedStats);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen-gz-stats","model":"openai/gpt-5.4"}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].generation_id, "gen-gz-stats");
    assert.equal(records[0].cost, "0.033");
    assert.equal(records[0].prompt_tokens, 150);
    assert.equal(records[0].completion_tokens, 25);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("client abort during request upload records a usage-missing row without crashing", async () => {
  // A downstream client that starts a POST body then destroys the socket before
  // finishing it. The request stream emits an abort while the proxy is still
  // reading the body; that must not escape as an unhandled 'error', and flush()
  // must return promptly with a usage-missing row.
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => {
    upstreamHits += 1;
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "POST",
        path: "/api/v1/responses",
        headers: {
          "content-type": "application/json",
          // Declare more body than we will send so the server sees it incomplete.
          "content-length": "1000",
          "x-jina-operation": "agent"
        }
      });
      req.on("error", () => {});
      req.on("close", resolve);
      // Start the abort timer only after Node has handed the partial request to
      // the socket. Resolving on the client-side close avoids racing flush()
      // against req.destroy() itself on a loaded CI host.
      req.write('{"model":"m","padding":"', () => {
        setTimeout(() => req.destroy(), 20);
      });
    });

    const started = Date.now();
    const records = await withTimeout(
      (async () => {
        // The TCP close and the server-side IncomingMessage abort are separate
        // event-loop turns. Polling flush keeps the test about the proxy's
        // bounded settlement guarantee without assuming a 20 ms scheduler.
        while (true) {
          const captured = await proxy.flush({ timeoutMs: 1_000 });
          if (captured.length > 0 || Date.now() - started >= 4_000) {
            return captured;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
      5_000,
      "flush hung after upload abort"
    );
    assert.equal(Date.now() - started < 4_000, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "agent");
    assert.equal(records[0].request_seq, 1);
    assert.equal(records[0].cost, undefined);
    assert.equal(records[0].total_tokens, undefined);
    // The aborted upload never produced a completed upstream request response.
    assert.equal(upstreamHits, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("flush resolves promptly when the client aborts and the upstream never responds", async () => {
  // The reviewer's probe: an upstream that accepts the request but never sends a
  // response, plus a downstream client that hangs up mid-call. Before the fix,
  // handleRequest's promise never resolved (nothing listened for the downstream
  // close), so flush() hung forever and failed reviews lost their usage rows.
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => {
    upstreamHits += 1;
    // Intentionally never call res.writeHead/res.end: the upstream hangs.
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    // Fire a request through the proxy, then destroy the client socket once the
    // upstream has received it.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "POST",
          path: "/api/v1/responses",
          headers: { "content-type": "application/json", "x-jina-operation": "agent" }
        },
        () => {}
      );
      req.on("error", () => {});
      req.write(JSON.stringify({ model: "m" }));
      req.end();
      // Give the upstream a beat to receive the request, then hang up.
      const timer = setInterval(() => {
        if (upstreamHits > 0) {
          clearInterval(timer);
          req.destroy();
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(timer);
        req.destroy();
        reject(new Error("upstream never received the request"));
      }, 2_000).unref?.();
    });

    // flush() must resolve promptly (not hang) with a usage-missing row for the
    // aborted request. Bound the assertion so a regression fails instead of hangs.
    const started = Date.now();
    const records = await withTimeout(proxy.flush({ timeoutMs: 1_000 }), 5_000, "flush hung after client abort");
    assert.equal(Date.now() - started < 4_000, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "agent");
    assert.equal(records[0].request_seq, 1);
    // No usage was ever seen, so the row is recorded usage-missing.
    assert.equal(records[0].cost, undefined);
    assert.equal(records[0].prompt_tokens, undefined);
    assert.equal(records[0].total_tokens, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("flush's bounded timeout stops waiting on a stuck request and returns collected records", async () => {
  // An upstream that accepts but never responds while the client keeps waiting:
  // the request stays in-flight. flush() must not block on it forever -- after its
  // bounded timeout it destroys the straggler and returns what it has.
  const upstream = await startFakeUpstream(() => {
    // Never responds; the request hangs open with the client still connected.
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  const client = http.request(
    {
      host: "127.0.0.1",
      port: proxy.port,
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "planner" }
    },
    () => {}
  );
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve) => {
      client.write(JSON.stringify({ model: "m" }));
      client.end();
      // Let the upstream receive the request before flushing.
      setTimeout(resolve, 100);
    });

    const started = Date.now();
    const records = await withTimeout(proxy.flush({ timeoutMs: 250 }), 5_000, "flush timeout did not fire");
    const elapsed = Date.now() - started;
    // The bounded timeout fired (~250ms) rather than waiting on the stuck request.
    assert.equal(elapsed < 4_000, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "planner");
    assert.equal(records[0].cost, undefined);
  } finally {
    client.destroy();
    await proxy.close();
    await upstream.close();
  }
});

test("generation-stats backfill authenticates with the per-request caller (BYOH) credential, not the managed key", async () => {
  const callerKey = "Bearer byoh-user-secret-key";
  const managedKey = "managed-should-not-be-used";
  let statsAuth: string | undefined;
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      // The generation was created under the caller's BYOH key, so the backfill
      // must present that same credential -- the managed key can't see it.
      statsAuth = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":{"id":"gen-byoh","total_cost":0.055,"tokens_prompt":80,"tokens_completion":12}}`);
      return;
    }
    // Usage-missing response so flush() falls into the backfill path.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen-byoh","model":"openai/gpt-5.4"}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: managedKey });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", authorization: callerKey },
      body: JSON.stringify({ model: "m" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    // The backfill request carried the caller's BYOH credential, not the managed key.
    assert.equal(statsAuth, callerKey);
    // Backfill still succeeded end-to-end.
    assert.equal(records[0].generation_id, "gen-byoh");
    assert.equal(records[0].cost, "0.055");
    assert.equal(records[0].prompt_tokens, 80);
    // No auth material leaks into the emitted record (no field, no nested value).
    const serialized = JSON.stringify(records[0]);
    assert.equal(serialized.includes("byoh-user-secret-key"), false);
    assert.equal(serialized.includes(managedKey), false);
    assert.equal(serialized.includes("Authorization"), false);
    assert.equal(serialized.toLowerCase().includes("authorization"), false);
    assert.equal("backfillAuth" in (records[0] as Record<string, unknown>), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("generation-stats backfill falls back to the managed key when no caller auth was captured", async () => {
  let statsAuth: string | undefined;
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      statsAuth = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":{"id":"gen-managed","total_cost":0.01,"tokens_prompt":5,"tokens_completion":5}}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen-managed","model":"openai/gpt-5.4"}`);
  });
  // No caller Authorization header, so the managed key is injected upstream and
  // reused for the backfill.
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "managed-key" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(statsAuth, "Bearer managed-key");
    assert.equal(records[0].cost, "0.01");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("generation-stats backfill persists only billing-relevant fields as raw_usage", async () => {
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      res.writeHead(200, { "content-type": "application/json" });
      // Stats payload carries extraneous non-billing metadata that must NOT be
      // persisted into raw_usage (mirrors the capture path's minimization).
      res.end(
        `{"data":{"id":"gen-min","model":"openai/gpt-5.4","total_cost":0.031,"tokens_prompt":60,` +
          `"tokens_completion":8,"native_tokens_reasoning":2,"app_id":123,"origin":"https://leak.example",` +
          `"prompt":"the raw user prompt that must never be stored","provider_name":"secret-provider"}}`
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"gen-min","model":"openai/gpt-5.4"}`);
  });
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    // Billing fields were extracted...
    assert.equal(records[0].cost, "0.031");
    assert.equal(records[0].prompt_tokens, 60);
    assert.equal(records[0].completion_tokens, 8);
    // ...but raw_usage keeps only the minimized billing subset.
    const rawUsage = records[0].raw_usage as Record<string, unknown>;
    assert.equal(rawUsage.total_cost, 0.031);
    assert.equal(rawUsage.tokens_prompt, 60);
    assert.equal("app_id" in rawUsage, false);
    assert.equal("origin" in rawUsage, false);
    assert.equal("prompt" in rawUsage, false);
    assert.equal("provider_name" in rawUsage, false);
    // Nothing extraneous survived anywhere in the serialized record.
    const serialized = JSON.stringify(records[0]);
    assert.equal(serialized.includes("leak.example"), false);
    assert.equal(serialized.includes("raw user prompt"), false);
    assert.equal(serialized.includes("secret-provider"), false);
    // raw_response_metadata stays { status, model, id }.
    assert.deepEqual(Object.keys(records[0].raw_response_metadata ?? {}).sort(), ["id", "model", "status"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("oversized gzipped response keeps the early generation id and stays backfillable", async () => {
  // Incompressible filler so the gzipped body is large enough to overflow the
  // capture cap; the id sits at the very top of the JSON, ahead of the filler.
  const filler = crypto.randomBytes(48 * 1024).toString("base64");
  const json =
    `{"id":"gen-gz-big","model":"openai/gpt-5.4","filler":"${filler}",` +
    `"usage":{"prompt_tokens":300,"completion_tokens":40,"total_tokens":340,"cost":0.088}}`;
  const gzipped = zlib.gzipSync(Buffer.from(json, "utf8"));
  const upstream = await startFakeUpstream((req, res) => {
    if (req.url?.startsWith("/api/v1/generation")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":{"id":"gen-gz-big","total_cost":0.088,"tokens_prompt":300,"tokens_completion":40}}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipped);
  });
  // Cap below the gzipped size forces the capture to abandon the body for size.
  const proxy = await startOpenRouterProxy({ upstream: upstream.origin, apiKey: "k", captureByteLimit: 4096 });
  try {
    const response = await proxyRequestBinary(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    // Client still received the full compressed body byte-for-byte.
    assert.deepEqual(response.body, gzipped);

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    // The early id survived the size abandonment, so the row was backfillable.
    assert.equal(records[0].generation_id, "gen-gz-big");
    assert.equal(records[0].cost, "0.088");
    assert.equal(records[0].prompt_tokens, 300);
    assert.equal(records[0].completion_tokens, 40);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("rawNumberLiteral preserves exact decimals and returns the last match", () => {
  assert.equal(rawNumberLiteral(`{"cost":0.00012345678901234567}`, "cost"), "0.00012345678901234567");
  assert.equal(rawNumberLiteral(`{"cost":0.1}{"cost":0.2}`, "cost"), "0.2");
  // Must not match a longer key that merely ends in the target name.
  assert.equal(rawNumberLiteral(`{"upstream_inference_cost":0.5}`, "cost"), undefined);
  assert.equal(rawNumberLiteral(`{"total_cost":1.25}`, "total_cost"), "1.25");
});

test("native route: openai/* forwards to api.openai.com, strips prefix, overrides auth, computes exact cost", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    // OpenAI returns tokens but NO cost field; cached_tokens sit within prompt_tokens.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"resp-openai","model":"gpt-5.4-mini","usage":{"prompt_tokens":1000,"completion_tokens":500,` +
        `"total_tokens":1500,"prompt_tokens_details":{"cached_tokens":200}}}`
    );
  });
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(`{"error":"openrouter must not be hit on the native route"}`);
  });
  const proxy = await startOpenRouterProxy({
    upstream: orouter.origin,
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer codex-sent-openrouter-key",
        "x-jina-operation": "agent"
      },
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi" })
    });
    assert.equal(response.status, 200);

    // Only the OpenAI upstream saw the request; OpenRouter was never contacted.
    assert.equal(openai.requests.length, 1);
    assert.equal(orouter.requests.length, 0);
    const captured = openai.requests[0];
    // Path rewritten from the OpenRouter-shaped /api/v1/... to OpenAI's /v1/...
    assert.equal(captured.url, "/v1/responses");
    // Auth overridden with the managed OpenAI key; Codex's credential is discarded.
    assert.equal(captured.headers.authorization, "Bearer sk-openai-managed");
    const forwarded = JSON.parse(captured.body) as Record<string, unknown>;
    // The openai/ prefix is stripped so api.openai.com sees the bare model id.
    assert.equal(forwarded.model, "gpt-5.4-mini");
    // The native route MUST NOT inject a `usage` param: api.openai.com rejects it
    // ("Unknown parameter: 'usage'", HTTP 400) and returns usage by default anyway.
    assert.equal("usage" in forwarded, false);
    assert.equal(forwarded.input, "hi");

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.route, "native");
    assert.equal(record.operation, "agent");
    // (1000-200)*0.0000004 + 200*0.0000001 + 500*0.0000016 = 0.00114
    assert.equal(record.cost, "0.0011400");
    // upstream_inference_cost equals cost natively (no gateway markup).
    assert.equal(record.upstream_inference_cost, "0.0011400");
    assert.equal(record.is_byok, false);
    assert.equal(record.cost_missing, undefined);
    assert.equal(record.prompt_tokens, 1000);
    assert.equal(record.cached_tokens, 200);
    assert.equal(record.completion_tokens, 500);
    // The managed OpenAI key never leaks into an emitted record.
    assert.equal(JSON.stringify(record).includes("sk-openai-managed"), false);
  } finally {
    await proxy.close();
    await openai.close();
    await orouter.close();
  }
});

test("native route strips a caller-supplied usage param (OpenAI 400s on it)", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"resp","model":"gpt-5.4-mini","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`
    );
  });
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(`{"error":"openrouter must not be hit"}`);
  });
  const proxy = await startOpenRouterProxy({
    upstream: orouter.origin,
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer x", "x-jina-operation": "agent" },
      // Caller sends usage.include (as the review probe did) — it must be removed before the native call.
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi", usage: { include: true } })
    });
    assert.equal(response.status, 200);
    assert.equal(openai.requests.length, 1);
    const forwarded = JSON.parse(openai.requests[0].body) as Record<string, unknown>;
    assert.equal("usage" in forwarded, false, "caller-supplied usage stripped on the native route");
  } finally {
    await proxy.close();
    await openai.close();
    await orouter.close();
  }
});

test("native route falls back to OpenRouter when api.openai.com rejects the model (managed run)", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    // api.openai.com does not serve this catalog slug (e.g. a subscription-only codename).
    res.writeHead(404, { "content-type": "application/json" });
    res.end(`{"error":{"message":"The model 'gpt-5.4-mini' does not exist","code":"model_not_found"}}`);
  });
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-or","model":"openai/gpt-5.4-mini","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.0001}}`
    );
  });
  const proxy = await startOpenRouterProxy({
    upstream: orouter.origin,
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer x", "x-jina-operation": "agent" },
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi" })
    });
    // The caller sees the SUCCESSFUL OpenRouter replay, not the native 404.
    assert.equal(response.status, 200);
    assert.equal(openai.requests.length, 1, "native attempted first");
    assert.equal(orouter.requests.length, 1, "replayed through OpenRouter");
    // The replay is a fresh OpenRouter-shaped request: namespaced model + usage.include restored.
    const replayed = JSON.parse(orouter.requests[0].body) as Record<string, unknown>;
    assert.equal(replayed.model, "openai/gpt-5.4-mini");
    assert.deepEqual(replayed.usage, { include: true });
    // Usage is recorded from the replay (openrouter route, wire cost) — managed billing as usual.
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].route, "openrouter");
    assert.equal(records[0].cost, "0.0001");
  } finally {
    await proxy.close();
    await openai.close();
    await orouter.close();
  }
});

test("native route does NOT replay via the BYOK placeholder key (keeps the true native error)", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(`{"error":{"message":"model_not_found"}}`);
  });
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(`{"error":"unauthorized"}`);
  });
  const proxy = await startOpenRouterProxy({
    upstream: orouter.origin,
    // BYOK-OpenAI run: the OpenRouter credential is the non-secret placeholder.
    apiKey: "byok-openai-no-openrouter-credential",
    openaiApiKey: "sk-tenant-openai",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer x", "x-jina-operation": "agent" },
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi" })
    });
    // No replay: the caller gets the REAL native error, and OpenRouter is never contacted.
    assert.equal(response.status, 404);
    assert.equal(orouter.requests.length, 0, "no replay under the placeholder");
  } finally {
    await proxy.close();
    await openai.close();
    await orouter.close();
  }
});

test("mixed-case Content-Type still routes openai/* natively and strips the prefix", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"resp","model":"gpt-5.4-mini","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`
    );
  });
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(`{"error":"openrouter must not be hit"}`);
  });
  const proxy = await startOpenRouterProxy({
    upstream: orouter.origin,
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    const response = await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      // Case-insensitive per RFC 9110 — a lowercase-exact check would misroute this to OpenRouter.
      headers: { "content-type": "Application/JSON", authorization: "Bearer x", "x-jina-operation": "agent" },
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi", usage: { include: true } })
    });
    assert.equal(response.status, 200);
    assert.equal(openai.requests.length, 1, "routed to the native OpenAI upstream");
    assert.equal(orouter.requests.length, 0);
    const forwarded = JSON.parse(openai.requests[0].body) as Record<string, unknown>;
    assert.equal(forwarded.model, "gpt-5.4-mini", "openai/ prefix stripped -> body was mutated");
    assert.equal("usage" in forwarded, false, "caller usage stripped");
  } finally {
    await proxy.close();
    await openai.close();
    await orouter.close();
  }
});

test("native route reads the Responses-API usage shape (input_tokens/output_tokens/input_tokens_details.cached_tokens)", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    // The EXACT shape api.openai.com's /v1/responses returns by default: input_tokens /
    // output_tokens (NOT prompt/completion), cached under input_tokens_details, reasoning
    // under output_tokens_details. No cost field is present.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"resp-shape","model":"gpt-5.4-mini","usage":{"input_tokens":1000,` +
        `"input_tokens_details":{"cached_tokens":200,"cache_write_tokens":50},` +
        `"output_tokens":500,"output_tokens_details":{"reasoning_tokens":120},"total_tokens":1500}}`
    );
  });
  const proxy = await startOpenRouterProxy({
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "agent" },
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi" })
    });
    // No `usage` param leaked to OpenAI.
    const forwarded = JSON.parse(openai.requests[0].body) as Record<string, unknown>;
    assert.equal("usage" in forwarded, false);

    const records = await proxy.flush();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.route, "native");
    // Tokens read from the Responses shape (input->prompt, output->completion, cached from
    // input_tokens_details, reasoning from output_tokens_details).
    assert.equal(record.prompt_tokens, 1000);
    assert.equal(record.completion_tokens, 500);
    assert.equal(record.cached_tokens, 200);
    assert.equal(record.reasoning_tokens, 120);
    assert.equal(record.total_tokens, 1500);
    // (1000-200)*0.0000004 + 200*0.0000001 + 500*0.0000016 = 0.0011400
    assert.equal(record.cost, "0.0011400");
    assert.equal(record.upstream_inference_cost, "0.0011400");
    assert.equal(record.cost_missing, undefined);
    assert.equal(record.is_byok, false);
  } finally {
    await proxy.close();
    await openai.close();
  }
});

test("parseUsageFields + computeNativeCost price the Responses-API usage shape exactly", () => {
  const usage = {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 50 },
    output_tokens: 500,
    output_tokens_details: { reasoning_tokens: 120 },
    total_tokens: 1500
  };
  const fields = parseUsageFields(usage);
  assert.equal(fields.prompt_tokens, 1000);
  assert.equal(fields.completion_tokens, 500);
  assert.equal(fields.cached_tokens, 200);
  assert.equal(fields.cache_write_tokens, 50);
  assert.equal(fields.reasoning_tokens, 120);
  assert.equal(fields.total_tokens, 1500);
  const result = computeNativeCost(
    { pricing: NATIVE_PRICING["openai/gpt-5.4-mini"], originalModel: "openai/gpt-5.4-mini" },
    fields
  );
  assert.equal(result.costMissing, false);
  // (1000-200)*0.0000004 + 200*0.0000001 + 500*0.0000016 = 0.0011400
  assert.equal(result.cost, "0.0011400");
});

test("openrouter route unchanged: a non-openai model stays on OpenRouter even when a native key is set", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(`{"error":"api.openai.com must not be hit for a non-openai model"}`);
  });
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-or","model":"anthropic/claude-opus","usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0002}}`
    );
  });
  const proxy = await startOpenRouterProxy({
    upstream: orouter.origin,
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    openaiModelPricing: NATIVE_PRICING
  });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "planner" },
      body: JSON.stringify({ model: "anthropic/claude-opus", input: "hi" })
    });
    assert.equal(orouter.requests.length, 1);
    assert.equal(openai.requests.length, 0);
    const captured = orouter.requests[0];
    // Path preserved (no /api strip on the OpenRouter route).
    assert.equal(captured.url, "/api/v1/responses");
    // Caller sent no auth, so the managed OpenRouter key is injected (unchanged).
    assert.equal(captured.headers.authorization, "Bearer or-managed-key");
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    assert.equal(records[0].route, "openrouter");
    // Cost is lifted off the wire exactly, as before.
    assert.equal(records[0].cost, "0.0002");
    assert.equal(records[0].is_byok, undefined);
    assert.equal(records[0].cost_missing, undefined);
  } finally {
    await proxy.close();
    await openai.close();
    await orouter.close();
  }
});

test("openai/* without a managed OpenAI key stays on the OpenRouter route (prefix kept)", async () => {
  const orouter = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      `{"id":"gen-or2","model":"openai/gpt-5.4","usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.0009}}`
    );
  });
  // No openaiApiKey configured -> native route disabled entirely.
  const proxy = await startOpenRouterProxy({ upstream: orouter.origin, apiKey: "or-managed-key" });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi" })
    });
    const captured = orouter.requests[0];
    assert.equal(captured.url, "/api/v1/responses");
    const forwarded = JSON.parse(captured.body) as Record<string, unknown>;
    // The prefix is NOT stripped on the OpenRouter route.
    assert.equal(forwarded.model, "openai/gpt-5.4");
    const records = await proxy.flush();
    assert.equal(records[0].route, "openrouter");
    assert.equal(records[0].cost, "0.0009");
  } finally {
    await proxy.close();
    await orouter.close();
  }
});

test("native route with missing pricing records cost absent + cost_missing marker (never guessed)", async () => {
  const openai = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"id":"resp-nopricing","model":"gpt-5.4-mini","usage":{"prompt_tokens":100,"completion_tokens":50}}`);
  });
  const proxy = await startOpenRouterProxy({
    apiKey: "or-managed-key",
    openaiApiKey: "sk-openai-managed",
    openaiUpstream: openai.origin,
    // Pricing map lacks the model -> native pricing unknown.
    openaiModelPricing: {}
  });
  try {
    await proxyRequest(proxy.port, {
      method: "POST",
      path: "/api/v1/responses",
      headers: { "content-type": "application/json", "x-jina-operation": "agent" },
      body: JSON.stringify({ model: "openai/gpt-5.4-mini", input: "hi" })
    });
    const records = await proxy.flush();
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.route, "native");
    // Cost could not be computed and was left absent, with the marker set.
    assert.equal(record.cost, undefined);
    assert.equal(record.upstream_inference_cost, undefined);
    assert.equal(record.cost_missing, true);
    assert.equal(record.is_byok, false);
    // Tokens are still recorded.
    assert.equal(record.prompt_tokens, 100);
    assert.equal(record.completion_tokens, 50);
  } finally {
    await proxy.close();
    await openai.close();
  }
});

test("computeNativeCost applies the exact tokens x price formula with cached subtracted from prompt", () => {
  const pricing = NATIVE_PRICING["openai/gpt-5.4-mini"];
  // Cached subset of prompt: (1000-200)*4e-7 + 200*1e-7 + 500*16e-7 = 0.00114.
  assert.deepEqual(
    computeNativeCost(
      { pricing, originalModel: "openai/gpt-5.4-mini" },
      { prompt_tokens: 1000, cached_tokens: 200, completion_tokens: 500 }
    ),
    { cost: "0.0011400", costMissing: false }
  );
  // No cached tokens: 1000*4e-7 + 500*16e-7 = 0.0012.
  assert.deepEqual(
    computeNativeCost(
      { pricing, originalModel: "openai/gpt-5.4-mini" },
      { prompt_tokens: 1000, completion_tokens: 500 }
    ),
    { cost: "0.0012000", costMissing: false }
  );
  // Missing pricing -> absent cost + marker.
  assert.deepEqual(
    computeNativeCost(
      { pricing: undefined, originalModel: "openai/gpt-5.4-mini" },
      { prompt_tokens: 10, completion_tokens: 5 }
    ),
    { costMissing: true }
  );
});

test("parseOpenaiModelPricingEnv parses a JSON map and rejects blank/malformed input", () => {
  assert.deepEqual(parseOpenaiModelPricingEnv(JSON.stringify(NATIVE_PRICING)), NATIVE_PRICING);
  assert.equal(parseOpenaiModelPricingEnv(undefined), undefined);
  assert.equal(parseOpenaiModelPricingEnv("   "), undefined);
  assert.equal(parseOpenaiModelPricingEnv("not json"), undefined);
  assert.equal(parseOpenaiModelPricingEnv("[1,2,3]"), undefined);
});

test("extractUsage reads Responses-API usage nested under response", () => {
  const found = extractUsage(
    `{"type":"response.completed","response":{"id":"resp-1","model":"openai/gpt-5.4","usage":{"input_tokens":9,"output_tokens":4}}}`,
    "application/json"
  );
  assert.equal(found?.id, "resp-1");
  assert.equal(found?.model, "openai/gpt-5.4");
  const fields = parseUsageFields(found?.usage ?? {});
  assert.equal(fields.prompt_tokens, 9);
  assert.equal(fields.completion_tokens, 4);
});
