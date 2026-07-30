import { join } from "node:path";

const RESUME_STAGE_ENVIRONMENT_KEY = "CONTEXT_RESUME_AGENT_STAGE_DIR";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function agentStageDirectoryForAttempt(attempt, priorRunDirectory) {
  positiveInteger(attempt, "attempt");
  if (attempt === 1 || !priorRunDirectory) return undefined;
  return join(priorRunDirectory, "derive-state", "agent-stages");
}

/**
 * Preserves a repair reserve before the first attempt. Unused time is carried
 * forward and divided fairly among the attempts that remain.
 */
export function allocateAttemptBudget({
  attempt,
  totalAttempts,
  totalBudgetSeconds,
  remainingSeconds,
  firstAttemptShare = 0.7,
  minimumAttemptSeconds = 60
}) {
  positiveInteger(attempt, "attempt");
  positiveInteger(totalAttempts, "totalAttempts");
  positiveInteger(totalBudgetSeconds, "totalBudgetSeconds");
  positiveInteger(minimumAttemptSeconds, "minimumAttemptSeconds");
  if (attempt > totalAttempts) throw new Error("attempt must not exceed totalAttempts");
  if (totalBudgetSeconds < totalAttempts * minimumAttemptSeconds) {
    throw new Error("totalBudgetSeconds cannot reserve the minimum for every attempt");
  }
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) {
    throw new Error("remainingSeconds must be a non-negative finite number");
  }
  if (!Number.isFinite(firstAttemptShare) || firstAttemptShare < 0.5 || firstAttemptShare > 0.9) {
    throw new Error("firstAttemptShare must be between 0.5 and 0.9");
  }
  const available = Math.floor(remainingSeconds);
  if (available < minimumAttemptSeconds) return 0;
  if (totalAttempts === 1 || attempt === totalAttempts) return available;

  const futureAttempts = totalAttempts - attempt;
  const futureReserve = futureAttempts * minimumAttemptSeconds;
  const maximumCurrent = available - futureReserve;
  if (maximumCurrent < minimumAttemptSeconds) return 0;
  if (attempt === 1) {
    const shareBudget = Math.floor(totalBudgetSeconds * firstAttemptShare);
    const percentageReserve = Math.floor(totalBudgetSeconds * (1 - firstAttemptShare));
    const requiredReserve = Math.max(futureReserve, percentageReserve);
    return Math.max(minimumAttemptSeconds, Math.min(shareBudget, totalBudgetSeconds - requiredReserve, maximumCurrent));
  }
  return Math.max(minimumAttemptSeconds, Math.min(maximumCurrent, Math.floor(available / (futureAttempts + 1))));
}

/**
 * The executor reads its private-stage resume path from the environment. Scope
 * it to one generate call so neither attempt one nor another harness invocation
 * can inherit a stale checkpoint.
 */
export async function withScopedAgentStageResume(stageDirectory, operation, environment = process.env) {
  const hadPrevious = Object.prototype.hasOwnProperty.call(environment, RESUME_STAGE_ENVIRONMENT_KEY);
  const previous = environment[RESUME_STAGE_ENVIRONMENT_KEY];
  if (stageDirectory) environment[RESUME_STAGE_ENVIRONMENT_KEY] = stageDirectory;
  else delete environment[RESUME_STAGE_ENVIRONMENT_KEY];
  try {
    return await operation();
  } finally {
    if (hadPrevious) environment[RESUME_STAGE_ENVIRONMENT_KEY] = previous;
    else delete environment[RESUME_STAGE_ENVIRONMENT_KEY];
  }
}
