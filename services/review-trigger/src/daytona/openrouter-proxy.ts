// OpenRouter capture proxy. Runs INSIDE the Daytona sandbox via tsx, so it uses
// node builtins only (http, https) and pulls in no npm dependencies. The runtime
// review runner starts one proxy per sandbox, points Codex at it, and flushes the
// recorded usage into the worker result file. The API turns those records into
// billing events server-side; nothing about Autumn or credit rates lives here.
//
// Responsibilities (see docs/BILLING_OPENROUTER_AUTUMN.md "The capture proxy"):
//  - Forward every request to https://openrouter.ai preserving path/method/body,
//    streaming the response body through unchanged (SSE included).
//  - Pass through the Authorization header; inject the managed key only if absent.
//  - Set Jina attribution headers and inject `usage: { include: true }` (OpenRouter
//    route only -- api.openai.com rejects a `usage` param) + a stable non-PII `user`
//    into JSON POST bodies (defensive).
//  - Record one UsageRecord per completed response, tagged with the current
//    operation and a monotonic request_seq. Costs are kept as exact decimal
//    STRINGS lifted verbatim off the wire -- never re-derived with float math.
//  - flush() best-effort backfills missing usage from the generation-stats
//    endpoint, then returns every record.
//
// The API key is never logged, echoed, or placed into any record.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { URL } from "node:url";
import zlib from "node:zlib";

/** Per-token OpenAI pricing (exact decimal strings) for one `openai/<model>` slug,
 *  supplied by the API via JINA_OPENAI_MODEL_PRICING. Used only on the native route
 *  to compute cost from tokens, since api.openai.com returns no cost field. */
export type OpenaiModelPrice = {
  input_per_token: string;
  output_per_token: string;
  cached_per_token: string;
};

export type UsageRecord = {
  operation: string;
  request_seq: number;
  model?: string;
  generation_id?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  /** Which upstream served this request: "native" = api.openai.com (proxy-computed
   *  cost), "openrouter" = openrouter.ai (cost lifted off the wire). */
  route?: "native" | "openrouter";
  /** True on the native route when pricing for the model was absent/malformed, so
   *  cost could not be computed and is intentionally left undefined (never guessed).
   *  The API can surface this as a usage-missing/uncosted row. */
  cost_missing?: boolean;
  /** Exact decimal string lifted from the wire; never produced by float math. */
  cost?: string;
  upstream_inference_cost?: string;
  /** OpenRouter's usage.is_byok: true when this response's model spend rode a
   *  caller BYOK key rather than the managed key. Drives the API's BYOK billing
   *  basis (is_byok ? upstream_inference_cost + cost : cost). Omitted when the
   *  wire carried no boolean is_byok, which the API treats as false. */
  is_byok?: boolean;
  raw_usage: Record<string, unknown>;
  raw_response_metadata?: { status?: number; model?: string; id?: string };
};

export type StartOpenRouterProxyOptions = {
  /** Listen port; 0 (default) picks an ephemeral port. */
  port?: number;
  /** Upstream origin; overridable for tests. Defaults to OpenRouter. */
  upstream?: string;
  /** Managed key injected only when the incoming request has no Authorization. */
  apiKey?: string;
  /** Managed OpenAI key for the native route. When set, requests whose model
   *  starts with `openai/` are forwarded to api.openai.com with this key
   *  overriding the caller's Authorization. Defaults to process.env.OPENAI_API_KEY. */
  openaiApiKey?: string;
  /** Native-route upstream origin; overridable for tests. Defaults to api.openai.com. */
  openaiUpstream?: string;
  /** Per-model OpenAI pricing keyed by the original `openai/<model>` slug, used to
   *  compute cost on the native route. Defaults to JINA_OPENAI_MODEL_PRICING. */
  openaiModelPricing?: Record<string, OpenaiModelPrice>;
  /** OpenRouter HTTP-Referer attribution; omitted when unset. */
  appUrl?: string;
  /** OpenRouter X-Title attribution; omitted when unset. */
  appTitle?: string;
  /** Stable non-PII request `user` (e.g. review_<run-id>); omitted when unset. */
  user?: string;
  /** Max bytes buffered for non-streaming JSON usage capture before falling back
   *  to a generation-stats backfill. Defaults to 8 MB; overridable for tests. */
  captureByteLimit?: number;
};

export type FlushOptions = {
  /** Overall bound (ms) on how long flush() waits for in-flight requests before
   *  it destroys the stragglers and returns whatever was collected. Defaults to
   *  15s; overridable for tests. flush() must never hang the runtime result path. */
  timeoutMs?: number;
};

export type OpenRouterProxyHandle = {
  port: number;
  flush: (options?: FlushOptions) => Promise<UsageRecord[]>;
  close: () => Promise<void>;
};

const DEFAULT_UPSTREAM = "https://openrouter.ai";
const DEFAULT_OPENAI_UPSTREAM = "https://api.openai.com";
const OPENAI_MODEL_PREFIX = "openai/";
const OPERATION_HEADER = "x-jina-operation";
/** Non-streaming JSON responses are buffered to lift the exact cost literal; cap
 *  the buffer so a pathologically large body can't blow up memory. Past the cap
 *  we stop buffering and let the generation-stats backfill recover usage/cost. */
const DEFAULT_CAPTURE_BYTE_LIMIT = 8 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const BACKFILL_TOTAL_BUDGET_MS = 10_000;
const BACKFILL_MAX_RETRIES = 2;
const BACKFILL_BASE_DELAY_MS = 200;
/** Default overall bound on flush()'s wait for in-flight requests. */
const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;

/** `backfillAuth` is the Authorization header value actually sent upstream for
 *  this request (caller BYOH credential, or the injected managed key). It lives
 *  only in memory so the generation-stats backfill can authenticate as the same
 *  principal that created the generation; it is stripped by toUsageRecord and
 *  dropped after flush, and must NEVER reach a UsageRecord field, a log, or an
 *  error string. */
type InternalRecord = UsageRecord & { hasUsage: boolean; backfillAuth?: string };

/** One live request: its completion promise plus a hook that forcibly tears it
 *  down (destroys upstream, records what's known, resolves `done`) so flush()
 *  can stop waiting on a straggler without hanging. */
type InflightEntry = { done: Promise<void>; destroy: () => void };

export async function startOpenRouterProxy(
  options: StartOpenRouterProxyOptions = {},
): Promise<OpenRouterProxyHandle> {
  const upstream = new URL(options.upstream ?? DEFAULT_UPSTREAM);
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  const appUrl = options.appUrl ?? process.env.OPENROUTER_APP_URL;
  const appTitle = options.appTitle ?? process.env.OPENROUTER_APP_TITLE;
  const user = options.user ?? process.env.JINA_OPENROUTER_USER;
  const captureByteLimit = options.captureByteLimit ?? DEFAULT_CAPTURE_BYTE_LIMIT;
  // Native OpenAI route config. When openaiApiKey is set, `openai/*` requests are
  // routed to api.openai.com instead of OpenRouter (see resolveRoute).
  const openaiApiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
  const openaiUpstream = new URL(options.openaiUpstream ?? DEFAULT_OPENAI_UPSTREAM);
  const openaiModelPricing = options.openaiModelPricing ?? parseOpenaiModelPricingEnv(process.env.JINA_OPENAI_MODEL_PRICING);

  let requestSeq = 0;
  const records: InternalRecord[] = [];
  const inflight = new Set<InflightEntry>();

  const server = http.createServer((req, res) => {
    const seq = (requestSeq += 1);
    const operation = operationFor(req);
    // An abort signal per request lets flush() force a stuck request to terminate.
    const controller = new AbortController();
    const done = handleRequest(req, res, {
      upstream,
      apiKey,
      openaiApiKey,
      openaiUpstream,
      openaiModelPricing,
      appUrl,
      appTitle,
      user,
      operation,
      seq,
      records,
      captureByteLimit,
      signal: controller.signal,
    });
    const entry: InflightEntry = { done, destroy: () => controller.abort() };
    inflight.add(entry);
    void done.finally(() => inflight.delete(entry));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    async flush(flushOptions: FlushOptions = {}): Promise<UsageRecord[]> {
      const timeoutMs = flushOptions.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
      await settleInflightWithinTimeout(inflight, timeoutMs);
      await backfillMissingUsage(records, { upstream, apiKey });
      const out = records.map(toUsageRecord);
      // Drop the captured upstream credentials now that the backfill is done, so
      // no per-request auth lingers in memory past the flush that consumed it.
      for (const record of records) {
        record.backfillAuth = undefined;
      }
      return out;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// Production tags every request's billing operation exclusively via the
// x-jina-operation request header (set per Codex invocation); default to
// "unknown" when a request arrives without it.
function operationFor(req: IncomingMessage): string {
  const header = req.headers[OPERATION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  return trimmed ? trimmed : "unknown";
}

/** Wait for every in-flight request to settle, but no longer than timeoutMs.
 *  On timeout the stragglers are force-destroyed (each records what usage is
 *  known and resolves synchronously), so flush() never hangs the result path. */
async function settleInflightWithinTimeout(inflight: Set<InflightEntry>, timeoutMs: number): Promise<void> {
  const all = Promise.allSettled([...inflight].map((entry) => entry.done));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    // Do not keep the event loop alive solely for the flush timeout.
    timer.unref?.();
  });
  const outcome = await Promise.race([all.then(() => "done" as const), timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  if (outcome === "timeout") {
    // Stop waiting: tear down each straggler. destroy() drives the request's
    // terminal path synchronously (record pushed, `done` resolved), so awaiting
    // `all` afterwards resolves promptly rather than blocking indefinitely.
    for (const entry of inflight) {
      entry.destroy();
    }
    await all;
  }
}

/** Where one request is routed and everything the response path needs to record it.
 *  Resolved per request from the JSON body's `model` before the upstream is built. */
type RouteInfo = {
  kind: "native" | "openrouter";
  /** The upstream origin this request is forwarded to. */
  upstream: URL;
  /** Native only: the OpenAI Bearer that overrides whatever Codex sent. */
  overrideAuth?: string;
  /** Native only: the ORIGINAL `openai/<model>` slug (before the prefix is stripped
   *  from the body), used to look up pricing for the cost computation. */
  originalModel?: string;
  /** Native only: pricing for originalModel, or undefined when the map lacks it. */
  pricing?: OpenaiModelPrice;
};

type HandleContext = {
  upstream: URL;
  apiKey?: string;
  openaiApiKey?: string;
  openaiUpstream: URL;
  openaiModelPricing?: Record<string, OpenaiModelPrice>;
  appUrl?: string;
  appTitle?: string;
  user?: string;
  operation: string;
  seq: number;
  records: InternalRecord[];
  captureByteLimit: number;
  /** The route resolved for this request; set once the body is read. Absent means
   *  the body never parsed (e.g. an aborted upload), treated as the openrouter route. */
  route?: RouteInfo;
  /** Aborted by flush() to force a stuck request to terminate. */
  signal?: AbortSignal;
  /** Authorization header value actually sent upstream for this request, captured
   *  in-memory so a usage-missing row's generation-stats backfill authenticates as
   *  the same principal that created the generation (a caller's BYOH key is not
   *  visible to the managed key). Set after the upstream request is built; NEVER
   *  copied into a UsageRecord field, a log, or an error. */
  upstreamAuthorization?: string;
};

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  let requestBody: Buffer;
  try {
    requestBody = await readBody(req);
  } catch {
    // The downstream client (Codex) aborted mid-upload before the request body
    // finished -- no upstream request has been issued yet. Tear down the response,
    // record a usage-missing row (keeps request_seq dense), and resolve so the
    // request-stream 'error' never escapes unhandled and flush() is not blocked.
    if (!res.writableEnded) {
      res.destroy();
    }
    ctx.records.push(emptyRecord(ctx, undefined));
    return;
  }
  // Decide the upstream per request from the body's model. Native `openai/*` runs
  // go to api.openai.com under the managed OpenAI key; everything else to OpenRouter.
  const route = resolveRoute(req, requestBody, ctx);
  ctx.route = route;
  // OpenAI's API lives at /v1/*, but Codex points at the proxy with an
  // OpenRouter-shaped base_url (.../api/v1), so a native path must drop the /api.
  const targetPath = route.kind === "native" ? nativeOpenaiPath(req.url ?? "/") : req.url ?? "/";
  const target = new URL(targetPath, route.upstream);
  const { body, headers, authorization } = buildUpstreamRequest(req, requestBody, ctx, target, route);
  // Remember the credential actually sent upstream so this request's records can
  // back it off for a generation-stats backfill (caller BYOH key, else managed).
  ctx.upstreamAuthorization = authorization;

  return new Promise<void>((resolve) => {
    // Everything below funnels through finalize() so each request resolves exactly
    // once and records exactly once, no matter which side terminates it first:
    // upstream end/error, upstream request error, a downstream disconnect (Codex
    // dying mid-call), or a flush()-driven abort.
    let settled = false;
    let currentReq: http.ClientRequest | undefined;
    let upstreamRes: IncomingMessage | undefined;
    let capture: UsageCapture | undefined;
    let nativeFallbackUsed = false;
    const finalize = (record: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (ctx.signal) {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      record();
      resolve();
    };

    const issue = (issueTarget: URL, issueHeaders: http.OutgoingHttpHeaders, issueBody: Buffer): void => {
      const transport = issueTarget.protocol === "http:" ? http : https;
      const upstreamReq = transport.request(
        issueTarget,
        { method: req.method, headers: issueHeaders },
        (res2) => {
          upstreamRes = res2;
          const status = res2.statusCode ?? 502;
          // NATIVE→OPENROUTER FALLBACK (managed runs, once per request): api.openai.com cannot serve
          // every openai/* catalog slug (subscription-only codenames, tier-gated models). When the
          // native route rejects the request (400/403/404), replay it through OpenRouter under the
          // managed key — same managed billing, cost lifted from the wire — instead of failing the
          // stage. Never replayed on a BYOK-OpenAI run: its OPENROUTER_API_KEY is the non-secret
          // placeholder, so the replay would 401 and mask the real native error.
          if (
            ctx.route?.kind === "native" &&
            !nativeFallbackUsed &&
            NATIVE_FALLBACK_STATUSES.has(status) &&
            nativeFallbackEligible(ctx)
          ) {
            nativeFallbackUsed = true;
            const replay = (): void => {
              if (settled) {
                return;
              }
              const fallbackRoute: RouteInfo = { kind: "openrouter", upstream: ctx.upstream };
              ctx.route = fallbackRoute;
              const fallbackTarget = new URL(req.url ?? "/", ctx.upstream);
              const rebuilt = buildUpstreamRequest(req, requestBody, ctx, fallbackTarget, fallbackRoute);
              ctx.upstreamAuthorization = rebuilt.authorization;
              issue(fallbackTarget, rebuilt.headers, rebuilt.body);
            };
            // Drain and discard the native error body, then replay.
            res2.resume();
            res2.once("end", replay);
            res2.once("error", replay);
            return;
          }
          const responseHeaders = filterResponseHeaders(res2.headers);
          res.writeHead(status, responseHeaders);
          // Bytes stream to the client UNCHANGED (Content-Encoding preserved). The
          // capture path decompresses a copy so usage/generation_id survive an
          // upstream that compressed despite our stripped Accept-Encoding.
          capture = createUsageCapture(
            headerValue(res2.headers, "content-type") ?? "",
            ctx.captureByteLimit,
            headerValue(res2.headers, "content-encoding"),
          );
          res2.on("data", (chunk: Buffer) => {
            capture?.push(chunk);
            // Honor client backpressure: if the downstream socket buffer is full,
            // pause the upstream read until it drains so we never accumulate the
            // whole body in the client's write buffer.
            if (!res.write(chunk)) {
              res2.pause();
              res.once("drain", () => res2.resume());
            }
          });
          res2.on("end", () => {
            finalize(() => {
              res.end();
              recordCapturedUsage(ctx, res2.statusCode, capture?.finish() ?? {});
            });
          });
          res2.on("error", () => {
            finalize(() => {
              res.end();
              recordCapturedUsage(ctx, res2.statusCode, capture?.finish() ?? {});
            });
          });
        },
      );
      currentReq = upstreamReq;
      upstreamReq.on("error", (error) => {
        finalize(() => {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
          }
          res.end(JSON.stringify({ error: "openrouter proxy upstream request failed", detail: error.message }));
          // Still record the attempt so the request_seq stays dense and the row is
          // eligible for a generation-stats backfill if an id ever surfaces.
          ctx.records.push(emptyRecord(ctx, undefined));
        });
      });
      if (issueBody.length > 0) {
        upstreamReq.write(issueBody);
      }
      upstreamReq.end();
    };

    // The downstream client (Codex) went away, or flush() gave up waiting: the
    // upstream response may never arrive. Treat it as terminal -- destroy the
    // upstream request/response so nothing leaks, record what usage is known
    // (a usage-missing row, carrying any id we saw for a generation-stats
    // backfill), and resolve so flush() is never blocked.
    const abortRequest = (): void => {
      finalize(() => {
        const captured = capture?.finish();
        currentReq?.destroy();
        upstreamRes?.destroy();
        if (!res.writableEnded) {
          res.destroy();
        }
        recordCapturedUsage(ctx, upstreamRes?.statusCode, captured ?? {});
      });
    };
    const onAbort = (): void => abortRequest();
    // The response socket closing is the reliable disconnect signal. On a normal
    // finish res 'close' fires with writableEnded === true (we already called
    // res.end()); an early close with writableEnded === false means the client
    // (Codex) hung up before we finished -- the disconnect worth acting on.
    // (req 'close' is unusable here: Node emits it as soon as the request body is
    // consumed, well before the upstream responds, so it fires on every request.)
    const onDownstreamClose = (): void => {
      if (!res.writableEnded) {
        abortRequest();
      }
    };
    res.on("close", onDownstreamClose);
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        abortRequest();
      } else {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    issue(target, headers, body);
  });
}

/** Native-route statuses that trigger the one-shot OpenRouter replay: the model is invalid (400),
 *  tier-gated (403), or unknown (404) on api.openai.com — all cases OpenRouter may still serve. */
const NATIVE_FALLBACK_STATUSES = new Set([400, 403, 404]);

/** KEEP IN SYNC with review-session.ts BYOK_OPENAI_OPENROUTER_PLACEHOLDER (not imported — this file must
 *  stay free of non-builtin imports to run standalone inside the sandbox). */
const BYOK_OPENAI_OPENROUTER_PLACEHOLDER = "byok-openai-no-openrouter-credential";

/** The OpenRouter replay is only sound when the OpenRouter credential is REAL (a managed run). On a
 *  BYOK-OpenAI run the key is the non-secret placeholder: the replay would 401 at openrouter.ai and mask
 *  the true native error, so those runs keep the native response. */
function nativeFallbackEligible(ctx: HandleContext): boolean {
  return Boolean(ctx.apiKey) && ctx.apiKey !== BYOK_OPENAI_OPENROUTER_PLACEHOLDER;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    // A client that hangs up mid-upload can emit 'close' with req.complete=false
    // and never emit 'end'/'error'; treat that as a terminal abort so the caller
    // is not left awaiting the body forever.
    req.on("close", () => {
      if (!req.complete) {
        reject(new Error("request closed before the body completed"));
      }
    });
  });
}

function buildUpstreamRequest(
  req: IncomingMessage,
  requestBody: Buffer,
  ctx: HandleContext,
  target: URL,
  route: RouteInfo,
): { body: Buffer; headers: http.OutgoingHttpHeaders; authorization?: string } {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    // Drop the client host, hop-by-hop headers, our operation tag, and the
    // recomputed content-length. Strip Accept-Encoding so the upstream replies
    // in identity encoding, which keeps usage capture reliable for SSE + JSON.
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding" || lower === OPERATION_HEADER || HOP_BY_HOP.has(lower)) {
      continue;
    }
    headers[key] = value;
  }

  headers.host = target.host;
  if (route.kind === "native") {
    // The native route authenticates with the managed OpenAI key, overriding
    // whatever credential Codex sent (env_key=OPENROUTER_API_KEY is a dummy for
    // the native path). The OpenRouter attribution headers are omitted; OpenAI
    // has no use for them.
    if (route.overrideAuth) {
      headers.authorization = route.overrideAuth;
    }
  } else {
    if (!hasHeader(req.headers, "authorization") && ctx.apiKey) {
      headers.authorization = `Bearer ${ctx.apiKey}`;
    }
    if (ctx.appUrl) {
      headers["http-referer"] = ctx.appUrl;
    }
    if (ctx.appTitle) {
      headers["x-title"] = ctx.appTitle;
    }
  }

  const body = maybeMutateJsonBody(req, requestBody, ctx, route);
  headers["content-length"] = String(body.length);
  // The credential the upstream sees: the caller's preserved Authorization, or
  // the managed key injected above. Captured for a same-principal backfill only.
  const authHeader = headers.authorization;
  const authorization =
    typeof authHeader === "string" ? authHeader : Array.isArray(authHeader) ? authHeader[0] : undefined;
  return { body, headers, authorization };
}

function maybeMutateJsonBody(req: IncomingMessage, requestBody: Buffer, ctx: HandleContext, route: RouteInfo): Buffer {
  const method = (req.method ?? "GET").toUpperCase();
  // Lowercased: Content-Type is case-insensitive (RFC 9110), so "Application/JSON" must still route
  // natively and get its usage/user/model mutated — a lowercase-exact substring match would miss it.
  const contentType = (headerValue(req.headers, "content-type") ?? "").toLowerCase();
  if (method !== "POST" || !contentType.includes("application/json") || requestBody.length === 0) {
    return requestBody;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString("utf8"));
  } catch {
    return requestBody;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return requestBody;
  }
  const record = parsed as Record<string, unknown>;
  // OpenRouter only returns cost when usage accounting is explicitly enabled, so on
  // that route ensure usage.include:true (merging into any caller-supplied usage
  // object rather than replacing it; created outright only when the caller sent none).
  // The native api.openai.com /responses route MUST NOT carry a `usage` param: OpenAI
  // rejects it ("Unknown parameter: 'usage'", HTTP 400) and returns usage by default
  // anyway, so the injection is skipped entirely there.
  if (route.kind !== "native") {
    if (record.usage === undefined) {
      record.usage = { include: true };
    } else if (isObject(record.usage)) {
      record.usage = { ...record.usage, include: true };
    }
  } else if (record.usage !== undefined) {
    // Native api.openai.com route: OpenAI rejects ANY `usage` param (HTTP 400) and returns usage by
    // default. We never inject it here, but a caller (e.g. Codex, or a probe) may already carry one —
    // STRIP it so a caller-supplied usage field can't 400 the native request.
    delete record.usage;
  }
  // Always overwrite `user` with the configured non-PII id: a caller-supplied
  // value may carry PII and must never reach the upstream. Leave the caller's
  // value untouched only when no id is configured.
  if (ctx.user) {
    record.user = ctx.user;
  }
  // Native route: OpenAI wants the bare model id ("gpt-5.4-mini"), not the
  // OpenRouter-namespaced "openai/gpt-5.4-mini". The original slug is preserved on
  // route.originalModel for the pricing lookup.
  if (route.kind === "native" && typeof record.model === "string" && record.model.startsWith(OPENAI_MODEL_PREFIX)) {
    record.model = record.model.slice(OPENAI_MODEL_PREFIX.length);
  }
  return Buffer.from(JSON.stringify(record), "utf8");
}

/** Per request, choose the upstream from the JSON body's `model`. A model under the
 *  `openai/` namespace routes NATIVELY to api.openai.com when a managed OpenAI key
 *  is configured; every other case (non-openai model, or no OpenAI key) keeps the
 *  OpenRouter route unchanged. */
function resolveRoute(req: IncomingMessage, requestBody: Buffer, ctx: HandleContext): RouteInfo {
  const model = parseModelFromBody(req, requestBody);
  if (model && model.startsWith(OPENAI_MODEL_PREFIX) && ctx.openaiApiKey) {
    return {
      kind: "native",
      upstream: ctx.openaiUpstream,
      overrideAuth: `Bearer ${ctx.openaiApiKey}`,
      originalModel: model,
      pricing: ctx.openaiModelPricing?.[model],
    };
  }
  return { kind: "openrouter", upstream: ctx.upstream };
}

/** Read the `model` from a JSON POST body for routing. Returns undefined for any
 *  non-JSON/non-POST/unparseable request (which then takes the OpenRouter route).
 *  This parses the body a second time (buildUpstreamRequest re-parses to mutate);
 *  acceptable for a per-review request volume and keeps the two concerns separate. */
function parseModelFromBody(req: IncomingMessage, requestBody: Buffer): string | undefined {
  const method = (req.method ?? "GET").toUpperCase();
  // Lowercased: Content-Type is case-insensitive (RFC 9110), so "Application/JSON" must still route
  // natively and get its usage/user/model mutated — a lowercase-exact substring match would miss it.
  const contentType = (headerValue(req.headers, "content-type") ?? "").toLowerCase();
  if (method !== "POST" || !contentType.includes("application/json") || requestBody.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(requestBody.toString("utf8"));
    if (isObject(parsed) && typeof parsed.model === "string") {
      return parsed.model;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Rewrite an OpenRouter-shaped path ("/api/v1/responses") to OpenAI's ("/v1/...")
 *  for the native route. Anything not under /api/v1 passes through untouched. */
function nativeOpenaiPath(url: string): string {
  return url.startsWith("/api/v1") ? url.slice("/api".length) : url;
}

function filterResponseHeaders(headers: IncomingMessage["headers"]): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    // We buffered + re-emitted the body ourselves, so drop framing headers and
    // let Node recompute them for the client connection.
    if (lower === "content-length" || lower === "transfer-encoding" || lower === "connection" || HOP_BY_HOP.has(lower)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** What a streaming/JSON response contributed to usage capture. `costSourceText`
 *  is the exact raw text carrying cost literals (an SSE usage line or the JSON
 *  body); undefined when the body was truncated past the buffer cap. */
type CapturedUsage = {
  usage?: Record<string, unknown>;
  id?: string;
  model?: string;
  costSourceText?: string;
};

type UsageCapture = {
  push: (chunk: Buffer) => void;
  finish: () => CapturedUsage;
};

/** Extract usage incrementally as the response streams so we never retain the
 *  whole body: line-buffered for SSE, capped-buffer for non-streaming JSON. A
 *  compressed response (upstream ignored our stripped Accept-Encoding) can't be
 *  parsed incrementally, so its bytes are buffered and decompressed at finish. */
function createUsageCapture(contentType: string, byteLimit: number, contentEncoding?: string): UsageCapture {
  const encoding = normalizeContentEncoding(contentEncoding);
  if (encoding) {
    return createCompressedUsageCapture(contentType, byteLimit, encoding);
  }
  if (contentType.includes("text/event-stream")) {
    return createSseUsageCapture();
  }
  return createJsonUsageCapture(byteLimit);
}

type SupportedEncoding = "gzip" | "br" | "deflate";

/** Map a Content-Encoding header to a decompressor we support, or undefined for
 *  identity/absent/unknown encodings (handled by the plain-text capture path). */
function normalizeContentEncoding(contentEncoding?: string): SupportedEncoding | undefined {
  const value = contentEncoding?.trim().toLowerCase();
  if (!value || value === "identity") {
    return undefined;
  }
  if (value.includes("gzip") || value.includes("x-gzip")) {
    return "gzip";
  }
  if (value.includes("br")) {
    return "br";
  }
  if (value.includes("deflate")) {
    return "deflate";
  }
  return undefined;
}

function decompressBody(buffer: Buffer, encoding: SupportedEncoding): Buffer {
  if (encoding === "gzip") {
    return zlib.gunzipSync(buffer);
  }
  if (encoding === "br") {
    return zlib.brotliDecompressSync(buffer);
  }
  // Content-Encoding: deflate is zlib-wrapped per spec, but some servers emit a
  // raw stream; fall back to raw inflate so a stray server doesn't lose usage.
  try {
    return zlib.inflateSync(buffer);
  } catch {
    return zlib.inflateRawSync(buffer);
  }
}

/** Buffer the compressed bytes (capped), then decompress + extract usage at the
 *  end. On any decompression failure -- or an oversized body past the cap -- fall
 *  back to an empty capture so the row is recorded usage-missing, exactly as an
 *  unparseable identity body would be. */
function createCompressedUsageCapture(
  contentType: string,
  byteLimit: number,
  encoding: SupportedEncoding,
): UsageCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    push(chunk: Buffer): void {
      if (truncated) {
        return;
      }
      if (bytes + chunk.byteLength > byteLimit) {
        // Oversized body: the full stream is abandoned for size, but keep the
        // compressed prefix that fits. A partial gzip/deflate/br prefix still
        // decompresses (with a flush finish) far enough to recover the id/model
        // that sit near the top, so the row stays backfillable instead of empty.
        const remaining = byteLimit - bytes;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          bytes += remaining;
        }
        truncated = true;
        return;
      }
      bytes += chunk.byteLength;
      chunks.push(chunk);
    },
    finish(): CapturedUsage {
      if (chunks.length === 0) {
        return {};
      }
      if (truncated) {
        // Body too large to trust as a whole; decompress only the retained
        // prefix and lift whatever id/model was emitted before abandonment so a
        // generation-stats backfill can still recover cost/tokens.
        const prefix = decompressPartial(Buffer.concat(chunks), encoding);
        if (!prefix) {
          return {};
        }
        return { id: rawStringLiteral(prefix, "id"), model: rawStringLiteral(prefix, "model") };
      }
      try {
        const text = decompressBody(Buffer.concat(chunks), encoding).toString("utf8");
        const extracted = extractUsage(text, contentType);
        return { usage: extracted?.usage, id: extracted?.id, model: extracted?.model, costSourceText: text };
      } catch {
        return {};
      }
    },
  };
}

/** Decompress a truncated compressed prefix, tolerating the missing tail. Uses a
 *  sync-flush finish so zlib emits everything decoded so far instead of throwing
 *  on the incomplete stream; returns "" if even the prefix cannot be decoded. */
function decompressPartial(buffer: Buffer, encoding: SupportedEncoding): string {
  try {
    if (encoding === "gzip") {
      return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
    }
    if (encoding === "br") {
      return zlib
        .brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
        .toString("utf8");
    }
    try {
      return zlib.inflateSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
    } catch {
      return zlib.inflateRawSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
    }
  } catch {
    return "";
  }
}

function createSseUsageCapture(): UsageCapture {
  let pending = "";
  // Per the SSE spec one event's data can span multiple `data:` lines, joined
  // with "\n"; buffer them until the event-terminating blank line, then parse the
  // joined payload once. A single-line event is the degenerate case.
  let dataLines: string[] = [];
  // Retain only the latest event that carried a usage object (plus a last-seen
  // id/model fallback), never the full stream.
  let usagePayload: string | undefined;
  let usageEvent: { usage?: Record<string, unknown>; id?: string; model?: string } | undefined;
  let fallback: { id?: string; model?: string } | undefined;

  // A blank line terminates the current event: join its `data:` payloads with
  // "\n" and attempt a single JSON parse of the whole event payload.
  const flushEvent = (): void => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const candidate = findUsagePayload(parsed);
    if (candidate?.usage) {
      usageEvent = candidate;
      usagePayload = payload;
    } else if (candidate) {
      fallback = { id: candidate.id, model: candidate.model };
    }
  };

  const consumeLine = (line: string): void => {
    // Strip a trailing CR so CRLF-delimited streams parse like LF ones.
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    // A blank line ends the event; other SSE fields (event:, id:, retry:,
    // comments) are ignored -- only `data:` payloads accumulate.
    if (normalized === "") {
      flushEvent();
      return;
    }
    const match = normalized.match(/^\s*data:\s?(.*)$/);
    if (match) {
      dataLines.push(match[1]);
    }
  };

  return {
    push(chunk: Buffer): void {
      pending += chunk.toString("utf8");
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        consumeLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    finish(): CapturedUsage {
      if (pending) {
        consumeLine(pending);
        pending = "";
      }
      // Flush a trailing event that arrived without a terminating blank line.
      flushEvent();
      if (usageEvent?.usage) {
        return { usage: usageEvent.usage, id: usageEvent.id, model: usageEvent.model, costSourceText: usagePayload };
      }
      return { id: usageEvent?.id ?? fallback?.id, model: usageEvent?.model ?? fallback?.model };
    },
  };
}

function createJsonUsageCapture(byteLimit: number): UsageCapture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    push(chunk: Buffer): void {
      if (truncated) {
        return;
      }
      if (bytes + chunk.byteLength > byteLimit) {
        // Keep the prefix that fits (the response id sits near the top for a
        // backfill), then stop buffering the oversized body.
        const remaining = byteLimit - bytes;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          bytes += remaining;
        }
        truncated = true;
        return;
      }
      bytes += chunk.byteLength;
      chunks.push(chunk);
    },
    finish(): CapturedUsage {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      if (truncated) {
        // Body too large to parse reliably; surface only the id so flush() can
        // backfill usage/cost from the generation-stats endpoint.
        return { id: rawStringLiteral(bodyText, "id") };
      }
      const extracted = extractUsage(bodyText, "application/json");
      return { usage: extracted?.usage, id: extracted?.id, model: extracted?.model, costSourceText: bodyText };
    },
  };
}

function recordCapturedUsage(ctx: HandleContext, status: number | undefined, captured: CapturedUsage): void {
  const usage = captured.usage;
  const generationId = captured.id;
  const model = captured.model;
  if (!usage) {
    ctx.records.push({
      ...emptyRecord(ctx, generationId),
      model,
      raw_response_metadata: { status, model, id: generationId },
    });
    return;
  }
  const fields = parseUsageFields(usage);
  const costSourceText = captured.costSourceText ?? "";
  const base: InternalRecord = {
    operation: ctx.operation,
    request_seq: ctx.seq,
    model: model ?? fields.model,
    generation_id: generationId,
    prompt_tokens: fields.prompt_tokens,
    completion_tokens: fields.completion_tokens,
    total_tokens: fields.total_tokens,
    reasoning_tokens: fields.reasoning_tokens,
    cached_tokens: fields.cached_tokens,
    cache_write_tokens: fields.cache_write_tokens,
    raw_usage: usage,
    raw_response_metadata: { status, model, id: generationId },
    hasUsage: true,
  };
  if (ctx.route?.kind === "native") {
    // api.openai.com returns tokens but NO cost; compute it exactly from the
    // pricing map keyed by the ORIGINAL openai/<model> slug. upstream_inference_cost
    // equals cost natively (no gateway markup), and is_byok is always false so the
    // API's billable_cost = cost path bills it as managed spend, unchanged.
    const native = computeNativeCost(ctx.route, fields);
    ctx.records.push({
      ...base,
      cost: native.cost,
      upstream_inference_cost: native.cost,
      is_byok: false,
      cost_missing: native.costMissing ? true : undefined,
      route: "native",
    });
    return;
  }
  ctx.records.push({
    ...base,
    cost: rawNumberLiteral(costSourceText, "cost") ?? numberToString(usage.cost),
    upstream_inference_cost:
      rawNumberLiteral(costSourceText, "upstream_inference_cost") ?? numberToString(upstreamInferenceCost(usage)),
    // usage.is_byok already resolves both the top-level and response-nested usage
    // shapes because findUsagePayload returns whichever usage object it located.
    // Emit only a real boolean; omit otherwise so the API defaults it to false.
    is_byok: booleanOrUndefined(usage.is_byok),
    route: "openrouter",
  });
}

function emptyRecord(ctx: HandleContext, generationId: string | undefined): InternalRecord {
  return {
    operation: ctx.operation,
    request_seq: ctx.seq,
    generation_id: generationId,
    // Tag the route when it was resolved; an unresolved route (aborted upload
    // before the body parsed) defaults to openrouter.
    route: ctx.route?.kind ?? "openrouter",
    raw_usage: {},
    hasUsage: false,
    // Carry the upstream credential so a usage-missing row with an id can be
    // backfilled as the same principal; dropped after flush, never serialized.
    backfillAuth: ctx.upstreamAuthorization,
  };
}

/** Locate the terminal usage payload in a JSON or SSE response body. */
export function extractUsage(
  bodyText: string,
  contentType: string,
): { usage?: Record<string, unknown>; id?: string; model?: string } | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return undefined;
  }
  const isSse = contentType.includes("text/event-stream") || /(^|\n)\s*data:/.test(trimmed);
  if (isSse) {
    let found: { usage?: Record<string, unknown>; id?: string; model?: string } | undefined;
    // One event's data can span multiple `data:` lines (joined with "\n"); collect
    // them and parse the joined payload when the event-terminating blank line (or
    // end of body) is reached. A single-line event is the degenerate case.
    let dataLines: string[] = [];
    const flushEvent = (): void => {
      if (dataLines.length === 0) {
        return;
      }
      const payload = dataLines.join("\n").trim();
      dataLines = [];
      if (!payload || payload === "[DONE]") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const candidate = findUsagePayload(parsed);
      // Keep the last event that carried usage; fall back to the last event that
      // at least carried an id/model so a synthetic row still knows its id.
      if (candidate?.usage) {
        found = candidate;
      } else if (candidate && !found) {
        found = candidate;
      }
    };
    for (const line of trimmed.split(/\r?\n/)) {
      if (line === "") {
        flushEvent();
        continue;
      }
      const match = line.match(/^\s*data:\s?(.*)$/);
      if (match) {
        dataLines.push(match[1]);
      }
    }
    flushEvent();
    return found;
  }
  try {
    return findUsagePayload(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function findUsagePayload(
  value: unknown,
): { usage?: Record<string, unknown>; id?: string; model?: string } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  // Responses API nests the object one level under `response`; chat completions
  // put id/model/usage at the top level.
  const nested = isObject(obj.response) ? obj.response : undefined;
  const usage = isObject(obj.usage) ? obj.usage : nested && isObject(nested.usage) ? nested.usage : undefined;
  const id = stringOrUndefined(obj.id) ?? (nested ? stringOrUndefined(nested.id) : undefined);
  const model = stringOrUndefined(obj.model) ?? (nested ? stringOrUndefined(nested.model) : undefined);
  if (!usage && id === undefined && model === undefined) {
    return undefined;
  }
  return { usage, id, model };
}

type UsageFields = {
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
};

export function parseUsageFields(usage: Record<string, unknown>): UsageFields {
  const promptDetails = isObject(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : isObject(usage.input_tokens_details)
      ? usage.input_tokens_details
      : {};
  const completionDetails = isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : isObject(usage.output_tokens_details)
      ? usage.output_tokens_details
      : {};
  return {
    prompt_tokens: numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens),
    completion_tokens: numberOrUndefined(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: numberOrUndefined(usage.total_tokens),
    reasoning_tokens: numberOrUndefined(completionDetails.reasoning_tokens),
    cached_tokens: numberOrUndefined(promptDetails.cached_tokens ?? usage.cached_tokens),
    // OpenAI's Responses API spells cache writes `cache_write_tokens` (under input_tokens_details);
    // OpenRouter/chat uses `cache_creation_tokens` / top-level `cache_creation_input_tokens`.
    cache_write_tokens: numberOrUndefined(
      promptDetails.cache_creation_tokens ?? promptDetails.cache_write_tokens ?? usage.cache_creation_input_tokens,
    ),
  };
}

function upstreamInferenceCost(usage: Record<string, unknown>): unknown {
  const details = usage.cost_details;
  return isObject(details) ? details.upstream_inference_cost : undefined;
}

/**
 * Lift a number's exact source characters out of the raw body so decimals are
 * preserved byte-for-byte. JSON.parse would coerce to a float; billing must not
 * round-trip cost through IEEE-754. Returns the last literal for the key.
 */
export function rawNumberLiteral(bodyText: string, key: string): string | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "g");
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = pattern.exec(bodyText)) !== null) {
    last = match[1];
  }
  return last;
}

/** Lift the first string value for `key` out of a raw (possibly truncated) body
 *  without a full JSON.parse. Used to recover the response id from an oversized
 *  body so a generation-stats backfill can still run. */
export function rawStringLiteral(bodyText: string, key: string): string | undefined {
  const match = bodyText.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`));
  return match ? match[1] : undefined;
}

async function backfillMissingUsage(
  records: InternalRecord[],
  ctx: { upstream: URL; apiKey?: string },
): Promise<void> {
  const deadline = Date.now() + BACKFILL_TOTAL_BUDGET_MS;
  const fallbackAuth = ctx.apiKey ? `Bearer ${ctx.apiKey}` : undefined;
  for (const record of records) {
    if (record.hasUsage || !record.generation_id) {
      continue;
    }
    if (Date.now() >= deadline) {
      return;
    }
    // Authenticate the stats fetch as the same principal that created the
    // generation: the caller's BYOH key when one was used, else the managed key.
    // A generation created under a BYOH key is invisible to the managed key.
    const authorization = record.backfillAuth ?? fallbackAuth;
    const stats = await fetchGenerationStats(record.generation_id, { upstream: ctx.upstream, authorization }, deadline);
    if (stats) {
      applyGenerationStats(record, stats.data, stats.raw);
      record.hasUsage = true;
    }
  }
}

type GenerationStats = { data: Record<string, unknown>; raw: string };

async function fetchGenerationStats(
  generationId: string,
  ctx: { upstream: URL; authorization?: string },
  deadline: number,
): Promise<GenerationStats | undefined> {
  for (let attempt = 0; attempt <= BACKFILL_MAX_RETRIES; attempt += 1) {
    if (Date.now() >= deadline) {
      return undefined;
    }
    try {
      const raw = await generationStatsRequest(generationId, ctx, deadline);
      const parsed = JSON.parse(raw) as { data?: unknown };
      if (isObject(parsed.data)) {
        return { data: parsed.data, raw };
      }
    } catch {
      // fall through to retry/backoff
    }
    const delay = Math.min(BACKFILL_BASE_DELAY_MS * 2 ** attempt, Math.max(0, deadline - Date.now()));
    if (delay > 0 && attempt < BACKFILL_MAX_RETRIES) {
      await sleep(delay);
    }
  }
  return undefined;
}

function generationStatsRequest(
  generationId: string,
  ctx: { upstream: URL; authorization?: string },
  deadline: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL("/api/v1/generation", ctx.upstream);
    target.searchParams.set("id", generationId);
    const transport = target.protocol === "http:" ? http : https;
    const headers: http.OutgoingHttpHeaders = { accept: "application/json" };
    if (ctx.authorization) {
      headers.authorization = ctx.authorization;
    }
    const req = transport.request(target, { method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`generation stats ${res.statusCode}`));
          return;
        }
        // The stats request advertises no Accept-Encoding, but upstream may still
        // compress the body; decompress (gzip/br/deflate) before decoding as UTF-8
        // so a compressed stats reply doesn't defeat the missing-usage backfill.
        // A decompression failure rejects, which the caller treats as a failed
        // backfill attempt (retry/give-up), same as any other stats error.
        try {
          const encoding = normalizeContentEncoding(headerValue(res.headers, "content-encoding"));
          const raw = Buffer.concat(chunks);
          resolve((encoding ? decompressBody(raw, encoding) : raw).toString("utf8"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("generation stats decompression failed"));
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    const timeout = Math.max(0, Math.min(3_000, deadline - Date.now()));
    req.setTimeout(timeout, () => req.destroy(new Error("generation stats timeout")));
    req.end();
  });
}

/** Billing-relevant keys lifted from a generation-stats payload into raw_usage.
 *  Everything else (app_id, origin, prompt echoes, provider metadata, ...) is
 *  dropped so the backfill path minimizes stored usage exactly like the capture
 *  path, which persists only the response's `usage` object. */
const GENERATION_STATS_BILLING_KEYS = [
  "id",
  "model",
  "total_cost",
  "upstream_inference_cost",
  "cache_discount",
  "tokens_prompt",
  "tokens_completion",
  "native_tokens_prompt",
  "native_tokens_completion",
  "native_tokens_reasoning",
  "native_tokens_cached",
] as const;

function minimizeGenerationStats(data: Record<string, unknown>): Record<string, unknown> {
  const minimal: Record<string, unknown> = {};
  for (const key of GENERATION_STATS_BILLING_KEYS) {
    if (data[key] !== undefined) {
      minimal[key] = data[key];
    }
  }
  return minimal;
}

function applyGenerationStats(record: InternalRecord, data: Record<string, unknown>, raw: string): void {
  // Persist only the billing-relevant subset, never the full upstream stats blob.
  record.raw_usage = minimizeGenerationStats(data);
  record.prompt_tokens = numberOrUndefined(data.tokens_prompt ?? data.native_tokens_prompt) ?? record.prompt_tokens;
  record.completion_tokens =
    numberOrUndefined(data.tokens_completion ?? data.native_tokens_completion) ?? record.completion_tokens;
  record.reasoning_tokens = numberOrUndefined(data.native_tokens_reasoning) ?? record.reasoning_tokens;
  record.cached_tokens = numberOrUndefined(data.native_tokens_cached) ?? record.cached_tokens;
  record.cost = rawNumberLiteral(raw, "total_cost") ?? numberToString(data.total_cost) ?? record.cost;
  if (record.total_tokens === undefined && record.prompt_tokens !== undefined && record.completion_tokens !== undefined) {
    record.total_tokens = record.prompt_tokens + record.completion_tokens;
  }
  if (!record.model) {
    record.model = stringOrUndefined(data.model);
  }
}

function toUsageRecord(record: InternalRecord): UsageRecord {
  // Strip the in-memory-only fields: the hasUsage flag and the captured upstream
  // credential must never appear in an emitted UsageRecord.
  const { hasUsage: _hasUsage, backfillAuth: _backfillAuth, ...usage } = record;
  return usage;
}

function hasHeader(headers: IncomingMessage["headers"], name: string): boolean {
  return headers[name] !== undefined;
}

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberToString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse the JINA_OPENAI_MODEL_PRICING JSON object into the pricing map, or
 *  undefined when the env is absent/blank/malformed (native pricing then unknown). */
export function parseOpenaiModelPricingEnv(raw?: string): Record<string, OpenaiModelPrice> | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? (parsed as Record<string, OpenaiModelPrice>) : undefined;
  } catch {
    return undefined;
  }
}

/** Native-route cost: OpenAI reports tokens but no cost field, so compute it EXACTLY
 *  from tokens x per-token price using string-decimal (BigInt) math -- never a float.
 *  cost = (prompt_tokens - cached)*input + cached*cached + completion*output, where
 *  cached is the prompt_tokens_details.cached_tokens subset of prompt_tokens. Missing
 *  or malformed pricing yields an absent cost + a cost_missing marker (never guessed);
 *  a proxy warning is logged. Token counts are never secret, so the slug is safe to log. */
export function computeNativeCost(
  route: Pick<RouteInfo, "pricing" | "originalModel">,
  fields: UsageFields,
): { cost?: string; costMissing: boolean } {
  const pricing = route.pricing;
  if (!pricing) {
    console.warn(
      `[jina-openrouter-proxy] native OpenAI pricing missing for model ${route.originalModel ?? "unknown"}; recording cost as absent`,
    );
    return { costMissing: true };
  }
  const input = parseDecimalString(pricing.input_per_token);
  const output = parseDecimalString(pricing.output_per_token);
  const cached = parseDecimalString(pricing.cached_per_token);
  if (!input || !output || !cached) {
    console.warn(
      `[jina-openrouter-proxy] native OpenAI pricing malformed for model ${route.originalModel ?? "unknown"}; recording cost as absent`,
    );
    return { costMissing: true };
  }
  const promptTokens = fields.prompt_tokens ?? 0;
  const cachedTokens = fields.cached_tokens ?? 0;
  const completionTokens = fields.completion_tokens ?? 0;
  // OpenAI reports cached tokens WITHIN prompt_tokens, so bill the non-cached prompt
  // at the input rate and the cached portion at the (cheaper) cached rate.
  const billedPromptTokens = promptTokens > cachedTokens ? promptTokens - cachedTokens : 0;
  let total: DecimalValue = { mantissa: 0n, scale: 0 };
  total = addDecimals(total, mulTokensByPrice(billedPromptTokens, input));
  total = addDecimals(total, mulTokensByPrice(cachedTokens, cached));
  total = addDecimals(total, mulTokensByPrice(completionTokens, output));
  return { cost: decimalToString(total), costMissing: false };
}

/** A non-negative decimal as an integer mantissa scaled by 10^scale. Exact BigInt
 *  money math -- the trigger-side mirror of api/src/billing-math.ts's Decimal so the
 *  proxy never round-trips a cost through a float. */
type DecimalValue = { mantissa: bigint; scale: number };

/** Parse a non-negative decimal string; undefined for blank/negative/malformed. */
function parseDecimalString(value: string): DecimalValue | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const unsigned = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    return undefined;
  }
  const [intPart, fracPart = ""] = unsigned.split(".");
  return { mantissa: BigInt(`${intPart}${fracPart}`), scale: fracPart.length };
}

/** tokens (a non-negative integer count) x a per-token price, exact. */
function mulTokensByPrice(tokens: number, price: DecimalValue): DecimalValue {
  return { mantissa: BigInt(Math.max(0, Math.trunc(tokens))) * price.mantissa, scale: price.scale };
}

/** Add two decimals exactly by aligning to the wider scale. */
function addDecimals(a: DecimalValue, b: DecimalValue): DecimalValue {
  const scale = Math.max(a.scale, b.scale);
  const am = a.mantissa * 10n ** BigInt(scale - a.scale);
  const bm = b.mantissa * 10n ** BigInt(scale - b.scale);
  return { mantissa: am + bm, scale };
}

/** Format a decimal as a plain (non-scientific) decimal string. */
function decimalToString(d: DecimalValue): string {
  if (d.scale === 0) {
    return d.mantissa.toString();
  }
  const digits = d.mantissa.toString().padStart(d.scale + 1, "0");
  const intPart = digits.slice(0, digits.length - d.scale);
  const fracPart = digits.slice(digits.length - d.scale);
  return `${intPart}.${fracPart}`;
}
