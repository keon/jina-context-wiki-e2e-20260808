import assert from "node:assert/strict";
import test from "node:test";
import {
  beginOnboarding,
  completeOnboardingStep,
  isOnboardingComplete,
  resetOnboarding,
} from "../src/onboarding.js";

test("completion can be queried from a validated snapshot", () => {
  let state = beginOnboarding();
  assert.equal(isOnboardingComplete(state), false);
  for (const step of ["profile", "verify_email", "accept_terms"]) {
    state = completeOnboardingStep(state, step);
  }
  assert.equal(isOnboardingComplete(state), true);
});

test("a new onboarding flow starts pending with every required step", () => {
  assert.deepEqual(beginOnboarding(), {
    completedSteps: [],
    remainingSteps: ["profile", "verify_email", "accept_terms"],
    status: "pending",
  });
});

test("steps are idempotent and activation requires all of them", () => {
  const profile = completeOnboardingStep(beginOnboarding(), "profile");
  assert.deepEqual(completeOnboardingStep(profile, "profile"), profile);

  const verified = completeOnboardingStep(profile, "verify_email");
  assert.equal(verified.status, "pending");
  assert.deepEqual(verified.remainingSteps, ["accept_terms"]);

  const active = completeOnboardingStep(verified, "accept_terms");
  assert.equal(active.status, "active");
  assert.deepEqual(active.remainingSteps, []);
});

test("required steps may be completed in any order", () => {
  let state = beginOnboarding();
  for (const step of ["accept_terms", "profile", "verify_email"]) {
    state = completeOnboardingStep(state, step);
  }
  assert.equal(state.status, "active");
  assert.deepEqual(state.completedSteps, ["profile", "verify_email", "accept_terms"]);
});

test("snapshots are immutable and caller state is never mutated", () => {
  const initial = beginOnboarding();
  const next = completeOnboardingStep(initial, "profile");
  assert.deepEqual(initial.completedSteps, []);
  assert.throws(() => next.completedSteps.push("verify_email"), TypeError);
  assert.throws(() => {
    next.status = "active";
  }, TypeError);
});

test("invalid or forged state is rejected and reset starts clean", () => {
  assert.throws(() => completeOnboardingStep(undefined, "profile"), /state is required/);
  assert.throws(() => completeOnboardingStep(beginOnboarding(), "unknown"), /unknown onboarding step/);
  assert.throws(
    () => completeOnboardingStep({ completedSteps: ["profile", "profile"] }, "verify_email"),
    /invalid steps/,
  );
  assert.deepEqual(resetOnboarding(), beginOnboarding());
});

test("state validation is bounded and ignores caller iterators", () => {
  assert.throws(
    () => completeOnboardingStep({ completedSteps: new Array(1_000_000) }, "profile"),
    /too many steps/,
  );
  const completedSteps = ["profile"];
  completedSteps[Symbol.iterator] = () => {
    throw new Error("caller iterator must not run");
  };
  assert.equal(completeOnboardingStep({ completedSteps }, "verify_email").status, "pending");
});

test("inherited fields, sparse entries, and getters cannot forge progress", () => {
  assert.throws(
    () => completeOnboardingStep(Object.create({ completedSteps: ["profile"] }), "verify_email"),
    /own completed steps/,
  );

  const sparse = new Array(3);
  const inherited = Object.create(Array.prototype, {
    0: { value: "profile" },
    1: { value: "verify_email" },
    2: { value: "accept_terms" },
  });
  Object.setPrototypeOf(sparse, inherited);
  assert.throws(() => completeOnboardingStep({ completedSteps: sparse }, "profile"), /invalid steps/);

  const accessor = [];
  Object.defineProperty(accessor, "0", { get: () => "profile" });
  assert.throws(() => completeOnboardingStep({ completedSteps: accessor }, "verify_email"), /invalid steps/);
});
