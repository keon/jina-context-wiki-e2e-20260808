export type WorkerFailureCategory =
  | "github_authentication"
  | "github_forbidden"
  | "github_not_found"
  | "github_rate_limit"
  | "github_timeout"
  | "github_response"
  | "git_checkout"
  | "daytona"
  | "model"
  | "context_validation"
  | "lease"
  | "worker_execution";

/** Returns a stable, non-sensitive category suitable for a public health check. */
export function workerFailureCategory(reason: string): WorkerFailureCategory {
  const value = reason.toLowerCase();
  if (/github request failed with 401|bad credentials/.test(value)) return "github_authentication";
  if (value.includes("github request failed with 403"))
    return value.includes("rate limit") ? "github_rate_limit" : "github_forbidden";
  if (/github request failed with 404|repository not found/.test(value)) return "github_not_found";
  if (/github request failed with 429|rate limit/.test(value)) return "github_rate_limit";
  if (/github.*(?:timed out|timeout)|(?:timed out|timeout).*github/.test(value)) return "github_timeout";
  if (/github request|github response/.test(value)) return "github_response";
  if (/clone|repository ref|prepared commit|git fetch|git checkout/.test(value)) return "git_checkout";
  if (/daytona|sandbox/.test(value)) return "daytona";
  if (/openai|openrouter|codex|model_provider/.test(value)) return "model";
  if (/evidence|citation|knowledge output|context result|schema|document/.test(value)) return "context_validation";
  if (/lease|completion/.test(value)) return "lease";
  return "worker_execution";
}
