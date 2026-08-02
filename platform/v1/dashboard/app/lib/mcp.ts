import type { ReviewEvent } from "./types";

export type ReviewMcpServer = { server: string; tools: string[] };
export type ReviewMcpUsageEvent = {
  id: string;
  stage: string;
  server: string;
  tool: string;
  status: string;
  error?: string;
  recordedAt: string;
};

export type ReviewMcpTelemetry = {
  enabled: ReviewMcpServer[];
  usage: ReviewMcpUsageEvent[];
  availability: "enabled" | "disabled" | "unavailable" | "unknown";
};

type JsonRecord = Record<string, unknown>;

export function reviewMcpTelemetry(events: readonly ReviewEvent[]): ReviewMcpTelemetry {
  const enabled = new Map<string, ReviewMcpServer>();
  const usage = new Map<string, ReviewMcpUsageEvent>();
  let availability: ReviewMcpTelemetry["availability"] = "unknown";

  for (const event of events) {
    const payload = record(event.payload);
    if (event.status === "context_graph_mcp_access_ready") {
      availability = "enabled";
      enabled.set("jina_context", {
        server: "jina_context",
        tools: ["search_context", "list_context", "read_context", "diff_context"],
      });
    } else if (event.status === "context_graph_mcp_not_attached" && availability === "unknown") {
      availability = "disabled";
    } else if (event.status === "context_graph_mcp_access_unavailable" && availability !== "enabled") {
      availability = "unavailable";
    }

    for (const item of records(payload?.mcps_enabled)) {
      const server = text(item.server);
      if (!server) continue;
      enabled.set(server, { server, tools: strings(item.tools) });
      availability = "enabled";
    }
    for (const item of records(payload?.mcp_usage_events)) {
      const id = text(item.id);
      const stage = text(item.stage);
      const server = text(item.server);
      const tool = text(item.tool);
      if (!id || !stage || !server || !tool) continue;
      const telemetryEvent: ReviewMcpUsageEvent = {
        id,
        stage,
        server,
        tool,
        status: text(item.status) || "unknown",
        recordedAt: event.recorded_at,
        ...(text(item.error) ? { error: text(item.error) } : {}),
      };
      usage.set(`${stage}:${id}`, telemetryEvent);
    }
  }
  return { enabled: [...enabled.values()], usage: [...usage.values()], availability };
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}
