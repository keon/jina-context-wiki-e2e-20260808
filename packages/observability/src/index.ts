export {
  createLogger,
  createStreamLogSink,
  errorLogFields,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogSeverity,
  type LogStream
} from "./logger.js";
export {
  MetricsRegistry,
  type CounterSnapshot,
  type DurationSnapshot,
  type MetricLabels,
  type MetricsSnapshot
} from "./metrics.js";
export { recordHttpRequest, type HttpRequestRecord } from "./http.js";
export {
  cloudTraceResourceName,
  generateTraceContext,
  parseTraceparent,
  parseXCloudTraceContext,
  requestTraceContext,
  type HeaderBag,
  type RequestTraceContext
} from "./trace.js";
export {
  activeTraceparent,
  setOpenTelemetrySpanOutcome,
  startOpenTelemetry,
  withOpenTelemetrySpan,
  type OpenTelemetryRuntime,
  type SpanParent
} from "./otel.js";
