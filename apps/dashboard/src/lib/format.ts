export function shortId(value: string): string {
  return value.length > 34 ? `${value.slice(0, 18)}…${value.slice(-12)}` : value;
}

export function humanize(value: unknown): string {
  return String(value)
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Shared sentinel for a value the UI cannot render as itself. */
const ABSENT = "–";

export function formatTime(value: string | undefined | null): string {
  if (!value) return ABSENT;
  const parsed = new Date(value);
  // An unparseable timestamp otherwise reaches the UI as the literal string
  // "Invalid Date"; fall back to the same sentinel absence already uses.
  return Number.isNaN(parsed.getTime()) ? ABSENT : parsed.toLocaleString();
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  // JSON payload values are never symbols or functions.
  return "–";
}

export function relativeTime(value: string | undefined | null): string {
  if (!value) return "Never";
  const parsed = new Date(value).getTime();
  // Without this an unparseable timestamp renders as "NaNs ago".
  if (Number.isNaN(parsed)) return ABSENT;
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "task.created": "Task created",
  "task.queued": "Queued for execution",
  "task.transitioned": "Status changed",
  "task.dependency_added": "Dependency linked",
  "run.step": "Run comment",
  "review.completed": "Review completed",
  "publish.completed": "Publication comment",
  "github.issue_opened": "GitHub issue received",
  "context.generation_published": "Context release published",
  "context.build_failed": "Context build failed"
};

export function eventLabel(event: { readonly type: string }): string {
  return EVENT_LABELS[event.type] ?? humanize(event.type);
}

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function confidenceLabel(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not provided";
  const confidence = clampConfidence(value);
  return `${Math.round(confidence * 100)}% · ${confidence.toFixed(2)}`;
}
