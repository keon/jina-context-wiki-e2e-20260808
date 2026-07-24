import type { AdminReadTrafficMetric } from "./jina-api";

export const READ_TRAFFIC_P95_TARGET_MS = 400;

export interface ReadTrafficSummary {
  readonly totalRequests: number;
  readonly activeTemplates: number;
  readonly averageLatencyMs: number;
  readonly highestP95LatencyMs: number;
  readonly truncationRate: number;
  readonly metricsOverTarget: number;
}

export function summarizeReadTraffic(metrics: readonly AdminReadTrafficMetric[]): ReadTrafficSummary {
  const totalRequests = metrics.reduce((sum, metric) => sum + metric.requests, 0);
  const weightedAverageLatency = metrics.reduce((sum, metric) => sum + metric.averageLatencyMs * metric.requests, 0);
  const weightedTruncations = metrics.reduce((sum, metric) => sum + metric.truncationRate * metric.requests, 0);

  return {
    totalRequests,
    activeTemplates: new Set(metrics.filter((metric) => metric.requests > 0).map((metric) => metric.template)).size,
    averageLatencyMs: totalRequests > 0 ? weightedAverageLatency / totalRequests : 0,
    highestP95LatencyMs: metrics.reduce((highest, metric) => Math.max(highest, metric.p95LatencyMs), 0),
    truncationRate: totalRequests > 0 ? weightedTruncations / totalRequests : 0,
    metricsOverTarget: metrics.filter(
      (metric) => metric.requests > 0 && metric.p95LatencyMs > READ_TRAFFIC_P95_TARGET_MS
    ).length
  };
}
