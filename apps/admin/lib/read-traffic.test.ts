import assert from "node:assert/strict";
import test from "node:test";
import { summarizeReadTraffic } from "./read-traffic.ts";

test("summarizeReadTraffic weights aggregate latency and truncation by request volume", () => {
  assert.deepEqual(
    summarizeReadTraffic([
      {
        template: "structure",
        requests: 20,
        averageLatencyMs: 100,
        p95LatencyMs: 180,
        truncationRate: 0.1
      },
      {
        template: "causal_trace",
        requests: 5,
        averageLatencyMs: 500,
        p95LatencyMs: 700,
        truncationRate: 0.4
      }
    ]),
    {
      totalRequests: 25,
      activeTemplates: 2,
      averageLatencyMs: 180,
      highestP95LatencyMs: 700,
      truncationRate: 0.16,
      metricsOverTarget: 1
    }
  );
});

test("summarizeReadTraffic returns an empty baseline when no reads were recorded", () => {
  assert.deepEqual(summarizeReadTraffic([]), {
    totalRequests: 0,
    activeTemplates: 0,
    averageLatencyMs: 0,
    highestP95LatencyMs: 0,
    truncationRate: 0,
    metricsOverTarget: 0
  });
});
