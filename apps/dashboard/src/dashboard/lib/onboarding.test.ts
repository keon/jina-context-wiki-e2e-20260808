import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adjacentOnboardingStep,
  createOnboardingProgress,
  onboardingDestination,
  onboardingRedirect,
  onboardingPosition,
  onboardingSteps,
  parseInviteEmails,
  parseOnboardingProgress,
} from "./onboarding";

test("personal and team onboarding sequences derive stable progress", () => {
  assert.deepEqual(onboardingSteps("personal"), ["workspace", "intent", "github", "review", "model", "finish"]);
  assert.deepEqual(onboardingSteps("team"), [
    "workspace",
    "organization",
    "intent",
    "github",
    "review",
    "model",
    "invite",
    "finish",
  ]);
  assert.deepEqual(onboardingPosition("model", "personal"), { current: 5, total: 6 });
  assert.deepEqual(onboardingPosition("model", "team"), { current: 6, total: 8 });
  assert.equal(adjacentOnboardingStep("workspace", "personal", "previous"), null);
  assert.equal(adjacentOnboardingStep("workspace", "team", "next"), "organization");
  assert.equal(adjacentOnboardingStep("model", "personal", "next"), "finish");
  assert.equal(adjacentOnboardingStep("model", "team", "next"), "invite");
});

test("onboarding progress is versioned, validated, and reconciled to its path", () => {
  const started = createOnboardingProgress("2026-08-07T12:00:00.000Z");
  assert.deepEqual(parseOnboardingProgress(started), started);
  assert.equal(parseOnboardingProgress({ ...started, version: 2 }), null);
  assert.equal(parseOnboardingProgress({ ...started, step: "secret-step" }), null);
  assert.equal(parseOnboardingProgress({ ...started, startedAt: "not-a-date" }), null);
  assert.equal(
    parseOnboardingProgress({ ...started, workspaceKind: "personal", step: "invite" })?.step,
    "workspace",
  );
});

test("invite parsing normalizes, deduplicates, and retains invalid addresses", () => {
  assert.deepEqual(parseInviteEmails("Jane@Example.com, jane@example.com\npat@example.org nope"), {
    valid: ["jane@example.com", "pat@example.org"],
    invalid: ["nope"],
  });
});

test("starting intent maps to a real product destination", () => {
  assert.equal(onboardingDestination("reviews"), "/reviews");
  assert.equal(onboardingDestination("wiki"), "/wiki");
  assert.equal(onboardingDestination("issues"), "/issues");
  assert.equal(onboardingDestination(undefined), "/reviews");
});

test("navigation resumes incomplete setup without trapping completed or legacy users", () => {
  const inProgress = { ...createOnboardingProgress("2026-08-07T12:00:00.000Z"), intent: "wiki" as const };
  assert.equal(onboardingRedirect({ pathname: "/reviews", restartRequested: false, progress: inProgress }), "/onboarding");
  assert.equal(onboardingRedirect({ pathname: "/signin", restartRequested: false, progress: inProgress }), null);
  assert.equal(onboardingRedirect({ pathname: "/onboarding", restartRequested: false, progress: inProgress }), null);
  assert.equal(onboardingRedirect({ pathname: "/reviews", restartRequested: false, progress: null }), null);
  const complete = {
    ...inProgress,
    status: "complete" as const,
    step: "finish" as const,
    completedAt: "2026-08-07T12:01:00.000Z",
  };
  assert.equal(onboardingRedirect({ pathname: "/onboarding", restartRequested: false, progress: complete }), "/wiki");
  assert.equal(onboardingRedirect({ pathname: "/onboarding", restartRequested: true, progress: complete }), null);
});
