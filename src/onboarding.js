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
  if (!current || typeof current !== "object") {
    throw new TypeError("onboarding state is required");
  }
  const stateField = Object.getOwnPropertyDescriptor(current, "completedSteps");
  if (!stateField || !("value" in stateField) || !Array.isArray(stateField.value)) {
    throw new TypeError("onboarding state requires own completed steps");
  }
  const steps = stateField.value;
  const lengthField = Object.getOwnPropertyDescriptor(steps, "length");
  const length = lengthField && "value" in lengthField ? lengthField.value : Number.NaN;
  if (!Number.isSafeInteger(length) || length < 0 || length > REQUIRED_STEPS.length) {
    throw new TypeError("onboarding state contains too many steps");
  }
  const completed = [];
  for (let index = 0; index < length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(steps, String(index));
    if (!entry || !("value" in entry) || !REQUIRED_STEP_SET.has(entry.value) || completed.includes(entry.value)) {
      throw new TypeError("onboarding state contains invalid steps");
    }
    completed.push(entry.value);
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
