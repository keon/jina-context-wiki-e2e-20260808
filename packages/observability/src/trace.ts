import { randomBytes } from "node:crypto";

/**
 * One request's distributed-trace identity. Cloud Run assigns a trace to every
 * inbound request; carrying it into each log line lets Cloud Logging and Cloud
 * Trace group everything a request did across the API and workers.
 */
export interface RequestTraceContext {
  /** 32 lowercase hex characters. */
  readonly traceId: string;
  /** 16 lowercase hex characters. */
  readonly spanId: string;
  readonly sampled: boolean;
}

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const CLOUD_TRACE_PATTERN = /^([0-9a-f]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/i;

/** Parses a W3C `traceparent` header value. */
export function parseTraceparent(value: string): RequestTraceContext | undefined {
  const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match;
  if (!traceId || !spanId || traceId === "0".repeat(32) || spanId === "0".repeat(16)) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags ?? "0", 16) & 1) === 1 };
}

/** Parses a legacy `X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=1` header value. */
export function parseXCloudTraceContext(value: string): RequestTraceContext | undefined {
  const match = CLOUD_TRACE_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const traceId = match[1]?.toLowerCase();
  if (!traceId || traceId === "0".repeat(32)) return undefined;
  let spanId: string | undefined;
  if (match[2]) {
    const decimal = BigInt(match[2]);
    if (decimal > 0n && decimal <= 0xffffffffffffffffn) spanId = decimal.toString(16).padStart(16, "0");
  }
  return { traceId, spanId: spanId ?? randomHex(8), sampled: match[3] === "1" };
}

/**
 * Resolves the trace for one inbound request: W3C `traceparent` wins, Cloud
 * Run's `X-Cloud-Trace-Context` is honored next, and a request that arrived
 * without either gets a fresh unsampled trace so its logs still correlate.
 */
export function requestTraceContext(headers: HeaderBag): RequestTraceContext {
  const traceparent = firstHeaderValue(headers.traceparent);
  if (traceparent) {
    const parsed = parseTraceparent(traceparent);
    if (parsed) return parsed;
  }
  const cloudTrace = firstHeaderValue(headers["x-cloud-trace-context"]);
  if (cloudTrace) {
    const parsed = parseXCloudTraceContext(cloudTrace);
    if (parsed) return parsed;
  }
  return generateTraceContext();
}

/** Creates a new local root trace, for work that no inbound request initiated. */
export function generateTraceContext(): RequestTraceContext {
  return { traceId: randomHex(16), spanId: randomHex(8), sampled: false };
}

/** Formats the Cloud Logging trace resource name that links a log entry to Cloud Trace. */
export function cloudTraceResourceName(projectId: string, traceId: string): string {
  return `projects/${projectId}/traces/${traceId}`;
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
