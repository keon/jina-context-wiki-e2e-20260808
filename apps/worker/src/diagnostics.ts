export type WorkerFailureCategory =
  | "github"
  | "daytona"
  | "model"
  | "ontology_validation"
  | "lease"
  | "worker_execution";

/** Returns a stable, non-sensitive category suitable for a public health check. */
export function workerFailureCategory(reason: string): WorkerFailureCategory {
  const value = reason.toLowerCase();
  if (/github|clone|repository ref|prepared commit|git fetch|git checkout/.test(value)) return "github";
  if (/daytona|sandbox/.test(value)) return "daytona";
  if (/openai|openrouter|codex|model_provider/.test(value)) return "model";
  if (/evidence|citation|ontology output|ontology result|schema|assertion/.test(value)) return "ontology_validation";
  if (/lease|completion/.test(value)) return "lease";
  return "worker_execution";
}
