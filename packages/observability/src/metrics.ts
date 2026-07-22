export type MetricLabels = Readonly<Record<string, string>>;

export interface CounterSnapshot {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface DurationSnapshot {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface MetricsSnapshot {
  readonly counters: readonly CounterSnapshot[];
  readonly durations: readonly DurationSnapshot[];
  /** Series discarded after the registry hit its cardinality cap. */
  readonly droppedSeries: number;
}

/**
 * In-process cumulative metrics. Counters and duration summaries are cheap to
 * record on every request and are surfaced as a JSON snapshot on health and
 * internal endpoints; durable time series come from Cloud Monitoring log-based
 * metrics over the structured event logs, so process restarts (Cloud Run
 * scale-to-zero, deploys) resetting these values is acceptable.
 */
export class MetricsRegistry {
  /** Distinct label combinations kept per registry before new series are dropped. */
  private static readonly MAX_SERIES = 1_000;
  private readonly counters = new Map<string, { name: string; labels: MetricLabels; value: number }>();
  private readonly durations = new Map<
    string,
    { name: string; labels: MetricLabels; count: number; totalMs: number; maxMs: number }
  >();
  private droppedSeries = 0;

  count(name: string, labels: MetricLabels = {}, delta = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += delta;
      return;
    }
    if (this.counters.size >= MetricsRegistry.MAX_SERIES) {
      this.droppedSeries += 1;
      return;
    }
    this.counters.set(key, { name, labels, value: delta });
  }

  observe(name: string, durationMs: number, labels: MetricLabels = {}): void {
    const key = seriesKey(name, labels);
    const existing = this.durations.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalMs += durationMs;
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      return;
    }
    if (this.durations.size >= MetricsRegistry.MAX_SERIES) {
      this.droppedSeries += 1;
      return;
    }
    this.durations.set(key, { name, labels, count: 1, totalMs: durationMs, maxMs: durationMs });
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.counters.values()].map((counter) => ({ ...counter })),
      durations: [...this.durations.values()].map((duration) => ({
        ...duration,
        totalMs: Math.round(duration.totalMs),
        maxMs: Math.round(duration.maxMs)
      })),
      droppedSeries: this.droppedSeries
    };
  }
}

function seriesKey(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label]}`);
  return `${name}|${parts.join(",")}`;
}
