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
  | "api_transport"
  | "lease"
  | "worker_execution";

/** Returns a stable, non-sensitive category suitable for a public health check. */
export function workerFailureCategory(reason: string): WorkerFailureCategory {
  const value = reason.toLowerCase();
  if (/github request failed with 401|github installation token request failed with 401|bad credentials/.test(value))
    return "github_authentication";
  if (/github (?:request|installation token request) failed with 403/.test(value))
    return value.includes("rate limit") ? "github_rate_limit" : "github_forbidden";
  if (/github (?:request|installation token request) failed with 404|repository not found/.test(value))
    return "github_not_found";
  if (/github (?:request|installation token request) failed with 429|rate limit/.test(value))
    return "github_rate_limit";
  if (/github.*(?:timed out|timeout)|(?:timed out|timeout).*github/.test(value)) return "github_timeout";
  if (/github request|github response|github installation token/.test(value)) return "github_response";
  if (/clone|repository ref|prepared commit|git fetch|git checkout/.test(value)) return "git_checkout";
  if (/daytona|sandbox/.test(value)) return "daytona";
  // The isolated board-agent process is the model transport boundary. A
  // non-zero Codex exit or hard model wall-clock can be caused by transient
  // provider capacity before the agent emits a result (and before there is
  // any semantic output to validate). Classify that boundary before matching
  // stage IDs such as "citation" or "context-..." as validation failures.
  if (/board agent stage .* (?:exited with [1-9][0-9]*|exceeded its \d+s budget)/.test(value)) return "model";
  if (
    /evidence|citation|knowledge output|context result|schema|document|publication plan|research plan|maintenance question|research assignment|repository area|shallow|not valid json|invalid json|outside the repository|does not match/.test(
      value
    )
  )
    return "context_validation";
  if (
    /context api .*failed with (?:408|425|429|5\d\d)|\b(?:econnreset|econnrefused|etimedout|enotfound)\b|fetch failed|network error|socket hang up|connection reset|service unavailable|bad gateway|gateway timeout|operation was aborted|aborted due to timeout|request timed out/.test(
      value
    )
  )
    return "api_transport";
  if (/openai|openrouter|codex|model_provider/.test(value)) return "model";
  if (/lease|completion/.test(value)) return "lease";
  return "worker_execution";
}

/** Conservative retry policy: unknown and semantic failures stay terminal. */
export function isRetryableWorkerFailure(reason: string): boolean {
  // Retrying cannot repair a tenant credential, exhausted quota, or unavailable
  // selected model. Preserve the first diagnostic on the task board so the
  // dashboard can tell the owner what to fix.
  if (
    /context_provider_configuration|invalid (?:api )?key|unauthorized|authentication failed|token_expired|invalid_grant|insufficient[_ ]quota|quota exhausted|usage limit|out of credits|unknown model|model .*not found/i.test(
      reason
    )
  ) {
    return false;
  }
  const category = workerFailureCategory(reason);
  if (
    category === "api_transport" ||
    category === "daytona" ||
    category === "github_rate_limit" ||
    category === "github_timeout" ||
    category === "model"
  ) {
    return true;
  }
  return (
    category === "github_response" &&
    /failed with (?:408|425|429|5\d\d)|timed out|timeout|fetch failed|network|connection|socket/i.test(reason)
  );
}

export function shouldRetryWorkerFailure(
  reason: string,
  input: {
    readonly attempt: number;
    readonly maxAttempts: number;
  }
): boolean {
  return (
    Number.isSafeInteger(input.attempt) &&
    Number.isSafeInteger(input.maxAttempts) &&
    input.attempt > 0 &&
    input.maxAttempts > 0 &&
    input.attempt < input.maxAttempts &&
    isRetryableWorkerFailure(reason)
  );
}
