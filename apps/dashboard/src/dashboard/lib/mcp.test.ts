import assert from "node:assert/strict";
import test from "node:test";
import { reviewMcpTelemetry } from "./mcp";

test("extracts enabled MCPs and redacted per-call usage from review events", () => {
  const telemetry = reviewMcpTelemetry([
    { status: "context_graph_mcp_access_ready", recorded_at: "2026-07-22T10:00:00.000Z" },
    {
      status: "runtime_review_completed",
      recorded_at: "2026-07-22T10:05:00.000Z",
      payload: {
        mcps_enabled: [{ server: "jina_context", tools: ["search_context"] }],
        mcp_usage_events: [
          { id: "call-1", stage: "planner", server: "jina_context", tool: "search_context", status: "completed" },
          { id: "call-2", stage: "review", server: "jina_context", tool: "search_context", status: "failed", error: "timeout" },
        ],
      },
    },
  ]);

  assert.deepEqual(telemetry.enabled, [{ server: "jina_context", tools: ["search_context"] }]);
  assert.equal(telemetry.availability, "enabled");
  assert.equal(telemetry.usage.length, 2);
  assert.deepEqual(telemetry.usage[1], {
    id: "call-2",
    stage: "review",
    server: "jina_context",
    tool: "search_context",
    status: "failed",
    error: "timeout",
    recordedAt: "2026-07-22T10:05:00.000Z",
  });
});

test("shows an unavailable MCP without inventing an enabled server", () => {
  const telemetry = reviewMcpTelemetry([
    { status: "context_graph_mcp_access_unavailable", payload: { error: "graph unavailable" }, recorded_at: "2026-07-22T10:00:00.000Z" },
  ]);
  assert.deepEqual(telemetry, { enabled: [], usage: [], availability: "unavailable" });
});
