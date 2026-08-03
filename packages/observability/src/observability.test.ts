import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, createStreamLogSink, errorLogFields, type LogStream } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { recordHttpRequest } from "./http.js";
import { parseTraceparent, parseXCloudTraceContext, requestTraceContext } from "./trace.js";

function capture(): { lines: Record<string, unknown>[]; write: (line: string) => void } {
  const lines: Record<string, unknown>[] = [];
  return { lines, write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) };
}

test("parseTraceparent accepts a sampled W3C header and rejects invalid ones", () => {
  const parsed = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  assert.deepEqual(parsed, { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
  assert.equal(parseTraceparent("00-" + "0".repeat(32) + "-00f067aa0ba902b7-01"), undefined);
  assert.equal(parseTraceparent("not-a-traceparent"), undefined);
});

test("parseXCloudTraceContext converts the decimal span id to hex", () => {
  const parsed = parseXCloudTraceContext("105445AA7843BC8BF206B12000100000/255;o=1");
  assert.ok(parsed);
  assert.equal(parsed.traceId, "105445aa7843bc8bf206b12000100000");
  assert.equal(parsed.spanId, "00000000000000ff");
  assert.equal(parsed.sampled, true);
});

test("requestTraceContext prefers traceparent, falls back to Cloud Trace, then generates", () => {
  const fromW3c = requestTraceContext({
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1;o=1"
  });
  assert.equal(fromW3c.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  const fromCloud = requestTraceContext({ "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1;o=0" });
  assert.equal(fromCloud.traceId, "105445aa7843bc8bf206b12000100000");
  assert.equal(fromCloud.sampled, false);
  const generated = requestTraceContext({});
  assert.match(generated.traceId, /^[0-9a-f]{32}$/);
  assert.match(generated.spanId, /^[0-9a-f]{16}$/);
});

test("logger emits Cloud Logging severity, service, bound fields, and trace correlation", () => {
  const { lines, write } = capture();
  const logger = createLogger({ service: "jina-api", projectId: "jina-v2", write });
  logger
    .child({ tenantId: "omlabs" })
    .withTrace({ traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true })
    .info("board command applied", { command: "TransitionTask" });
  assert.equal(lines.length, 1);
  const entry = lines[0]!;
  assert.equal(entry.severity, "INFO");
  assert.equal(entry.message, "board command applied");
  assert.equal(entry.service, "jina-api");
  assert.equal(entry.tenantId, "omlabs");
  assert.equal(entry.command, "TransitionTask");
  assert.equal(entry["logging.googleapis.com/trace"], `projects/jina-v2/traces/${"a".repeat(32)}`);
  assert.equal(entry["logging.googleapis.com/spanId"], "b".repeat(16));
  assert.equal(entry["logging.googleapis.com/trace_sampled"], true);
  assert.equal(typeof entry.time, "string");
});

test("logger drops entries below the minimum severity", () => {
  const { lines, write } = capture();
  const logger = createLogger({ minSeverity: "WARNING", write });
  logger.info("hidden");
  logger.warn("shown");
  assert.deepEqual(
    lines.map((line) => line.message),
    ["shown"]
  );
});

interface FakeStream extends LogStream {
  readonly lines: string[];
  accepting: boolean;
  errorListeners: ((error: Error) => void)[];
  drain(): void;
}

function fakeStream(): FakeStream {
  let drainListeners: (() => void)[] = [];
  const stream: FakeStream = {
    lines: [],
    accepting: true,
    errorListeners: [],
    write(chunk: string) {
      stream.lines.push(chunk.trimEnd());
      return stream.accepting;
    },
    on(_event: "error", listener: (error: Error) => void) {
      stream.errorListeners.push(listener);
      return stream;
    },
    once(_event: "drain", listener: () => void) {
      drainListeners.push(listener);
      return stream;
    },
    drain() {
      const listeners = drainListeners;
      drainListeners = [];
      for (const listener of listeners) listener();
    }
  };
  return stream;
}

test("stream sink drops lines while the stream is blocked and reports the gap on drain", () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const sink = createStreamLogSink(stdout, stderr);
  sink('{"n":1}', "INFO");
  assert.equal(stdout.lines.length, 1);
  stdout.accepting = false;
  sink('{"n":2}', "INFO"); // written by the stream but not flushed; marks it blocked
  sink('{"n":3}', "INFO"); // dropped
  sink('{"n":4}', "INFO"); // dropped
  assert.equal(stdout.lines.length, 2);
  stdout.accepting = true;
  stdout.drain();
  const report = JSON.parse(stdout.lines[2]!) as Record<string, unknown>;
  assert.equal(report.event, "logger.dropped");
  assert.equal(report.droppedCount, 2);
  assert.equal(report.severity, "WARNING");
  sink('{"n":5}', "INFO");
  assert.equal(stdout.lines.length, 4);
  assert.equal(stderr.lines.length, 0);
});

test("stream sink installs error listeners so a closed log pipe cannot crash the process", () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  createStreamLogSink(stdout, stderr);
  assert.equal(stdout.errorListeners.length, 1);
  assert.equal(stderr.errorListeners.length, 1);
  // The listener must swallow the error, not rethrow it.
  stdout.errorListeners[0]!(new Error("EPIPE"));
  stderr.errorListeners[0]!(new Error("EPIPE"));
  createStreamLogSink(stdout, stderr);
  assert.equal(stdout.errorListeners.length, 1, "reused process streams must not accumulate listeners");
  assert.equal(stderr.errorListeners.length, 1, "reused process streams must not accumulate listeners");
});

test("errorLogFields keeps the message and stack of real errors", () => {
  const fields = errorLogFields(new RangeError("boom"));
  assert.equal(fields.errorName, "RangeError");
  assert.equal(fields.errorMessage, "boom");
  assert.equal(typeof fields.stack, "string");
  assert.deepEqual(errorLogFields("plain failure"), { errorMessage: "plain failure" });
});

test("metrics registry accumulates counters and duration summaries per label set", () => {
  const metrics = new MetricsRegistry();
  metrics.count("worker.tasks", { topic: "run-review", outcome: "done" });
  metrics.count("worker.tasks", { topic: "run-review", outcome: "done" });
  metrics.count("worker.tasks", { topic: "run-review", outcome: "failed" });
  metrics.observe("stage.duration_ms", 120, { topic: "run-review" });
  metrics.observe("stage.duration_ms", 80, { topic: "run-review" });
  const snapshot = metrics.snapshot();
  const done = snapshot.counters.find((counter) => counter.labels.outcome === "done");
  assert.equal(done?.value, 2);
  const failed = snapshot.counters.find((counter) => counter.labels.outcome === "failed");
  assert.equal(failed?.value, 1);
  assert.deepEqual(snapshot.durations, [
    { name: "stage.duration_ms", labels: { topic: "run-review" }, count: 2, totalMs: 200, maxMs: 120 }
  ]);
  assert.equal(snapshot.droppedSeries, 0);
});

test("metrics registry caps series cardinality instead of growing without bound", () => {
  const metrics = new MetricsRegistry();
  for (let index = 0; index < 1_005; index += 1) metrics.count("unbounded", { key: `value-${index}` });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.length, 1_000);
  assert.equal(snapshot.droppedSeries, 5);
});

test("recordHttpRequest logs by status class and records request metrics", () => {
  const { lines, write } = capture();
  const logger = createLogger({ write });
  const metrics = new MetricsRegistry();
  recordHttpRequest({
    logger,
    metrics,
    method: "GET",
    path: "/board",
    route: "/board",
    statusCode: 200,
    durationMs: 12.4
  });
  recordHttpRequest({
    logger,
    metrics,
    method: "POST",
    path: "/webhooks/github",
    route: "/webhooks/github",
    statusCode: 500,
    durationMs: 3
  });
  recordHttpRequest({
    logger,
    metrics,
    method: "GET",
    path: "/health",
    route: "/health",
    statusCode: 200,
    durationMs: 1,
    quiet: true
  });
  assert.deepEqual(
    lines.map((line) => [line.severity, line.event]),
    [
      ["INFO", "http.request"],
      ["ERROR", "http.request"]
    ]
  );
  const first = lines[0] as { httpRequest: Record<string, unknown> };
  assert.deepEqual(first.httpRequest, { requestMethod: "GET", status: 200, latency: "0.012s" });
  const requests = metrics.snapshot().counters.filter((counter) => counter.name === "http.requests");
  assert.equal(requests.length, 3);
  assert.equal(requests.find((counter) => counter.labels.route === "/health")?.value, 1);
});

test("recordHttpRequest records aborted requests under one bounded status label", () => {
  const { lines, write } = capture();
  const logger = createLogger({ write });
  const metrics = new MetricsRegistry();
  recordHttpRequest({
    logger,
    metrics,
    method: "POST",
    path: "/webhooks/github",
    route: "/webhooks/github",
    statusCode: 0,
    durationMs: 45,
    aborted: true
  });
  assert.equal(lines.length, 1);
  const entry = lines[0]!;
  assert.equal(entry.severity, "WARNING");
  assert.equal(entry.aborted, true);
  assert.equal(entry.message, "POST /webhooks/github aborted 45ms");
  // No status was ever sent, so none may be reported as if it were.
  assert.deepEqual(entry.httpRequest, { requestMethod: "POST", latency: "0.045s" });
  const counter = metrics.snapshot().counters.find((candidate) => candidate.name === "http.requests");
  assert.deepEqual(counter?.labels, { route: "/webhooks/github", method: "POST", status: "aborted" });
});
