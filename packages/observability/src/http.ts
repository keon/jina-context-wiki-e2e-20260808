import type { Logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";
import type { RequestTraceContext } from "./trace.js";

export interface HttpRequestRecord {
  /** Logger already bound to the request's trace context. */
  readonly logger: Logger;
  readonly metrics?: MetricsRegistry;
  readonly method: string;
  readonly path: string;
  /** Low-cardinality route label for metrics, e.g. "/wiki/read". */
  readonly route: string;
  /** Final HTTP status; 0 means the request aborted before any status was sent. */
  readonly statusCode: number;
  readonly durationMs: number;
  readonly trace?: RequestTraceContext;
  /** Suppresses the log line (metrics still record), e.g. for health probes. */
  readonly quiet?: boolean;
  /**
   * The connection closed before the response finished (client disconnect,
   * incomplete upload). Recorded under the single bounded status label
   * "aborted" so cancellation-heavy incidents stay visible in metrics.
   */
  readonly aborted?: boolean;
}

/**
 * Records one finished HTTP request: a structured `http.request` event whose
 * `httpRequest` key Cloud Logging renders natively, plus cumulative
 * request-count and latency series in the in-process registry.
 */
export function recordHttpRequest(record: HttpRequestRecord): void {
  const statusClass = record.aborted ? "aborted" : `${Math.floor(record.statusCode / 100)}xx`;
  record.metrics?.count("http.requests", { route: record.route, method: record.method, status: statusClass });
  record.metrics?.observe("http.request.duration_ms", record.durationMs, { route: record.route });
  if (record.quiet) return;
  const severity = record.aborted
    ? "WARNING"
    : record.statusCode >= 500
      ? "ERROR"
      : record.statusCode >= 400
        ? "WARNING"
        : "INFO";
  const outcome = record.aborted ? "aborted" : String(record.statusCode);
  record.logger.log(severity, `${record.method} ${record.path} ${outcome} ${Math.round(record.durationMs)}ms`, {
    event: "http.request",
    route: record.route,
    ...(record.aborted ? { aborted: true } : {}),
    httpRequest: {
      requestMethod: record.method,
      ...(record.statusCode > 0 ? { status: record.statusCode } : {}),
      latency: `${(record.durationMs / 1000).toFixed(3)}s`
    }
  });
}
