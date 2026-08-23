const REQUIRED_STEPS = Object.freeze(["profile", "verify_email", "accept_terms"]);
const REQUIRED_STEP_SET = new Set(REQUIRED_STEPS);

export function beginOnboarding() {
  return snapshot([]);
}

export function completeOnboardingStep(current, step) {
  const completed = readCompletedSteps(current);
  if (!REQUIRED_STEP_SET.has(step)) throw new TypeError("unknown onboarding step");
  if (!completed.includes(step)) completed.push(step);
  return snapshot(completed);
}

export function resetOnboarding() {
  return beginOnboarding();
}

function readCompletedSteps(current) {
  if (!current || !Array.isArray(current.completedSteps)) {
    throw new TypeError("onboarding state is required");
  }
  const completed = [...current.completedSteps];
  if (new Set(completed).size !== completed.length || completed.some((step) => !REQUIRED_STEP_SET.has(step))) {
    throw new TypeError("onboarding state contains invalid steps");
  }
  return completed;
}

function snapshot(completed) {
  const completedSet = new Set(completed);
  const completedSteps = Object.freeze(REQUIRED_STEPS.filter((step) => completedSet.has(step)));
  const remainingSteps = Object.freeze(REQUIRED_STEPS.filter((step) => !completedSet.has(step)));
  return Object.freeze({
    completedSteps,
    remainingSteps,
    status: remainingSteps.length === 0 ? "active" : "pending",
  });
}
