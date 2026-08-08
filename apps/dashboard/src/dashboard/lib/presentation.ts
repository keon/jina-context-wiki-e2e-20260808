import type { Tone } from "./types";

export function statusTone(status: string): Tone {
  const value = status.toLowerCase();
  if (value.includes("fail") || value.includes("error") || value.includes("block")) return "bad";
  if (value.includes("warn")) return "warn";
  if (value.includes("complete") || value.includes("published") || value.includes("pass")) return "ok";
  if (value.includes("queued") || value.includes("running") || value.includes("review") || value.includes("token")) {
    return "warn";
  }
  return "";
}

export function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function formatRelative(value?: string) {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

export function shortSha(value?: string) {
  return value ? value.slice(0, 8) : "—";
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
