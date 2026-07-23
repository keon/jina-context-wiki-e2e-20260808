import type { ReactNode } from "react";
import { JinaApiError } from "../lib/jina-api";

export function PageHeader({
  title,
  description,
  action
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  );
}

export function ErrorPanel({
  error,
  message = "Could not load this page from the Jina API."
}: {
  readonly error: unknown;
  readonly message?: string;
}) {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      <code>{error instanceof JinaApiError ? error.message : "unexpected error"}</code>
      <p className="muted">Check the admin API credentials and service configuration.</p>
    </div>
  );
}

export function Status({
  tone,
  children
}: {
  readonly tone: "success" | "warning" | "danger" | "muted";
  readonly children: ReactNode;
}) {
  return (
    <span className={`status status-${tone}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "") || ref;
}

export function shortTenant(tenantId: string): string {
  return tenantId.length > 12 ? `${tenantId.slice(0, 8)}…` : tenantId;
}

export function formatRelativeTime(iso: string, now = new Date()): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return iso;
  const seconds = Math.max(0, Math.round((now.getTime() - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(timestamp)
  );
}

export function formatTimestamp(iso: string): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(timestamp);
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
