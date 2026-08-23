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
  if (current.completedSteps.length > REQUIRED_STEPS.length) {
    throw new TypeError("onboarding state contains too many steps");
  }
  const completed = [];
  for (let index = 0; index < current.completedSteps.length; index += 1) {
    const step = current.completedSteps[index];
    if (!REQUIRED_STEP_SET.has(step) || completed.includes(step)) {
      throw new TypeError("onboarding state contains invalid steps");
    }
    completed.push(step);
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
