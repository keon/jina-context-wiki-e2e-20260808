import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  trace,
  type Attributes,
  type Context,
  type Span
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";

export interface OpenTelemetryRuntime {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

export interface SpanParent {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled?: boolean;
}

let runtime: OpenTelemetryRuntime | undefined;

/**
 * Starts the vendor-neutral OTLP trace SDK once per process. The exporter is
 * deliberately opt-in: production/staging set an OTLP endpoint (normally a
 * local or private Google-Built OpenTelemetry Collector), while tests and
 * developer shells do not attempt to dial localhost implicitly.
 */
export function startOpenTelemetry(input: {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  readonly attributes?: Attributes;
}): OpenTelemetryRuntime {
  if (runtime) return runtime;
  const disabled = process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true";
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (disabled || !endpoint) {
    runtime = { enabled: false, shutdown: async () => undefined };
    return runtime;
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: requiredText(input.serviceName, "OpenTelemetry serviceName"),
      ...(input.serviceVersion ? { [ATTR_SERVICE_VERSION]: input.serviceVersion } : {}),
      ...(input.environment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: input.environment } : {}),
      ...input.attributes
    }),
    traceExporter: new OTLPTraceExporter()
  });
  sdk.start();
  runtime = {
    enabled: true,
    shutdown: () => sdk.shutdown()
  };
  return runtime;
}

export async function withOpenTelemetrySpan<T>(input: {
  readonly name: string;
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  readonly parent?: SpanParent;
  readonly automaticSuccessStatus?: boolean;
  readonly operation: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("@jina/observability");
  const parentContext = input.parent ? contextFromParent(input.parent) : context.active();
  const span = tracer.startSpan(
    requiredText(input.name, "OpenTelemetry span name"),
    { kind: input.kind ?? SpanKind.INTERNAL, ...(input.attributes ? { attributes: input.attributes } : {}) },
    parentContext
  );
  return context.with(trace.setSpan(parentContext, span), async () => {
    try {
      const result = await input.operation(span);
      if (input.automaticSuccessStatus !== false) span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: safeSpanError(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setOpenTelemetrySpanOutcome(
  span: Span,
  input: { readonly outcome: string; readonly success: boolean; readonly message?: string }
): void {
  span.setAttribute("jina.outcome", requiredText(input.outcome, "OpenTelemetry outcome"));
  span.setStatus(
    input.success
      ? { code: SpanStatusCode.OK }
      : { code: SpanStatusCode.ERROR, ...(input.message ? { message: input.message.slice(0, 500) } : {}) }
  );
}

export function activeTraceparent(): string | undefined {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
  const flags = (spanContext.traceFlags & Number(TraceFlags.SAMPLED)) !== 0 ? "01" : "00";
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

function contextFromParent(parent: SpanParent): Context {
  if (!/^[0-9a-f]{32}$/.test(parent.traceId) || parent.traceId === "0".repeat(32)) {
    throw new Error("OpenTelemetry parent traceId is invalid");
  }
  if (!/^[0-9a-f]{16}$/.test(parent.spanId) || parent.spanId === "0".repeat(16)) {
    throw new Error("OpenTelemetry parent spanId is invalid");
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.sampled === false ? TraceFlags.NONE : TraceFlags.SAMPLED,
    isRemote: true
  });
}

function safeSpanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
