import type { ReviewIssue, Tone } from "./types";

export function severityTone(severity: string): Tone {
  const value = severity.toLowerCase();
  if (value === "critical" || value === "high") return "bad";
  if (value === "medium" || value === "low") return "warn";
  if (value === "info") return "info";
  return "";
}

export function issueLocation(issue: ReviewIssue): string {
  return [issue.file_path, issue.line_number ? `:${issue.line_number}` : ""].filter(Boolean).join("");
}

export function issueTitle(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "Untitled issue";
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
}

export function issueHref(issue: ReviewIssue): string {
  return `/issues/${encodeURIComponent(issue.id)}`;
}
