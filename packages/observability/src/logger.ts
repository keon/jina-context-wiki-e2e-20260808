import { cloudTraceResourceName, type RequestTraceContext } from "./trace.js";

/** Cloud Logging severities, ordered. Anything at or above the configured minimum is emitted. */
export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  log(severity: LogSeverity, message: string, fields?: LogFields): void;
  /** Returns a logger that adds `fields` to every line it emits. */
  child(fields: LogFields): Logger;
  /** Returns a logger whose lines carry Cloud Trace correlation for `trace`. */
  withTrace(trace: RequestTraceContext): Logger;
}

export interface LoggerOptions {
  /** Logical service name, e.g. "jina-api". Defaults to $K_SERVICE. */
  readonly service?: string;
  /**
   * Google Cloud project used to build trace resource names. Defaults to
   * $GOOGLE_CLOUD_PROJECT. Without it, lines still carry a raw traceId field.
   */
  readonly projectId?: string;
  readonly minSeverity?: LogSeverity;
  /**
   * Line sink, one JSON document per call. The default writes WARNING and
   * above to stderr and the rest to stdout; Cloud Logging reads the embedded
   * `severity` either way, and local tools keep errors on the error stream.
   * Tests inject a capture.
   */
  readonly write?: (line: string, severity: LogSeverity) => void;
}

const SEVERITY_RANK: Record<LogSeverity, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };

/** The stream surface the default sink needs; process.stdout/stderr satisfy it. */
export interface LogStream {
  write(chunk: string): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "drain", listener: () => void): unknown;
}

interface LogStreamState {
  blocked: boolean;
  dropped: number;
}

const errorHandledStreams = new WeakSet<object>();

/**
 * Builds the default line sink over a pair of process streams. Logging must
 * never take the service down or grow its memory without bound, so the sink
 * is deliberately lossy under failure:
 *
 * - Stream errors are swallowed — without a listener, an 'error' event on a
 *   closed log pipe (EPIPE) is fatal in Node.
 * - A write the stream cannot flush marks it blocked; lines are dropped, not
 *   buffered, until 'drain', and one WARNING entry then reports the gap.
 */
export function createStreamLogSink(
  stdout: LogStream,
  stderr: LogStream
): (line: string, severity: LogSeverity) => void {
  const states = new Map<LogStream, LogStreamState>([
    [stdout, { blocked: false, dropped: 0 }],
    [stderr, { blocked: false, dropped: 0 }]
  ]);
  for (const stream of states.keys()) {
    if (errorHandledStreams.has(stream)) continue;
    stream.on("error", () => undefined);
    errorHandledStreams.add(stream);
  }
  const writeLine = (stream: LogStream, state: LogStreamState, line: string): void => {
    if (state.blocked) {
      state.dropped += 1;
      return;
    }
    if (stream.write(`${line}\n`)) return;
    state.blocked = true;
    stream.once("drain", () => {
      state.blocked = false;
      const dropped = state.dropped;
      state.dropped = 0;
      if (dropped === 0) return;
      writeLine(
        stream,
        state,
        JSON.stringify({
          severity: "WARNING",
          time: new Date().toISOString(),
          message: `logger dropped ${dropped} entries while the log stream was blocked`,
          event: "logger.dropped",
          droppedCount: dropped
        })
      );
    });
  };
  return (line, severity) => {
    const stream = SEVERITY_RANK[severity] >= SEVERITY_RANK.WARNING ? stderr : stdout;
    writeLine(stream, states.get(stream)!, line);
  };
}

/**
 * Creates a structured logger that prints one Cloud Logging-native JSON line
 * per event. Cloud Run forwards stdout to Cloud Logging, which promotes the
 * `severity`, `time`, `logging.googleapis.com/trace`, and `httpRequest` keys,
 * so entries filter, alert, and correlate without any logging agent.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? createStreamLogSink(process.stdout, process.stderr);
  const service = options.service ?? process.env.K_SERVICE;
  const projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT;
  const minRank = SEVERITY_RANK[options.minSeverity ?? "DEBUG"];
  return build({}, undefined);

  function build(bound: LogFields, trace: RequestTraceContext | undefined): Logger {
    function log(severity: LogSeverity, message: string, fields?: LogFields): void {
      if (SEVERITY_RANK[severity] < minRank) return;
      const entry: Record<string, unknown> = {
        severity,
        time: new Date().toISOString(),
        message,
        ...(service ? { service } : {}),
        ...bound,
        ...fields
      };
      if (trace) {
        entry.traceId = trace.traceId;
        entry["logging.googleapis.com/spanId"] = trace.spanId;
        entry["logging.googleapis.com/trace_sampled"] = trace.sampled;
        if (projectId) entry["logging.googleapis.com/trace"] = cloudTraceResourceName(projectId, trace.traceId);
      }
      write(JSON.stringify(entry), severity);
    }
    return {
      log,
      debug: (message, fields) => log("DEBUG", message, fields),
      info: (message, fields) => log("INFO", message, fields),
      warn: (message, fields) => log("WARNING", message, fields),
      error: (message, fields) => log("ERROR", message, fields),
      child: (fields) => build({ ...bound, ...fields }, trace),
      withTrace: (nextTrace) => build(bound, nextTrace)
    };
  }
}

/**
 * Normalizes a thrown value into log fields. Stack traces are included so
 * Cloud Error Reporting can group ERROR entries into distinct error types.
 * Both fields are bounded: error messages can embed untrusted upstream
 * content, and durable logs must not retain it at arbitrary length.
 */
export function errorLogFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message.slice(0, 1_000),
      ...(error.stack ? { stack: error.stack.slice(0, 2_000) } : {})
    };
  }
  return { errorMessage: String(error).slice(0, 1_000) };
}
