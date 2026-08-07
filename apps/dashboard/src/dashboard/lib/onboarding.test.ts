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

test("organization onboarding derives one stable seven-step sequence", () => {
  assert.deepEqual(onboardingSteps(), [
    "organization",
    "intent",
    "github",
    "review",
    "model",
    "invite",
    "finish",
  ]);
  assert.deepEqual(onboardingPosition("model"), { current: 5, total: 7 });
  assert.equal(adjacentOnboardingStep("organization", "previous"), null);
  assert.equal(adjacentOnboardingStep("organization", "next"), "intent");
  assert.equal(adjacentOnboardingStep("model", "next"), "invite");
});

test("onboarding progress is versioned, validated, and reconciled to its path", () => {
  const started = createOnboardingProgress("2026-08-07T12:00:00.000Z");
  assert.deepEqual(parseOnboardingProgress(started), started);
  assert.equal(parseOnboardingProgress({ ...started, version: 3 }), null);
  assert.equal(parseOnboardingProgress({ ...started, step: "secret-step" }), null);
  assert.equal(parseOnboardingProgress({ ...started, startedAt: "not-a-date" }), null);
});

test("legacy personal progress is reopened at organization setup", () => {
  const legacy = {
    version: 1,
    status: "complete",
    step: "finish",
    workspaceKind: "personal",
    selectedTenantId: "tenant-personal",
    intent: "reviews",
    startedAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:01:00.000Z",
    completedAt: "2026-08-07T12:01:00.000Z",
  };
  assert.deepEqual(parseOnboardingProgress(legacy), {
    version: 2,
    status: "in_progress",
    step: "organization",
    intent: "reviews",
    startedAt: legacy.startedAt,
    updatedAt: legacy.updatedAt,
  });
});

test("legacy team progress keeps its organization path", () => {
  const parsed = parseOnboardingProgress({
    version: 1,
    status: "in_progress",
    step: "model",
    workspaceKind: "team",
    selectedTenantId: "tenant-acme",
    startedAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:01:00.000Z",
  });
  assert.equal(parsed?.version, 2);
  assert.equal(parsed?.step, "model");
  assert.equal(parsed?.selectedTenantId, "tenant-acme");
});

test("legacy progress without a workspace kind follows the old personal default", () => {
  const parsed = parseOnboardingProgress({
    version: 1,
    status: "complete",
    step: "finish",
    selectedTenantId: "tenant-personal",
    startedAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:01:00.000Z",
    completedAt: "2026-08-07T12:01:00.000Z",
  });
  assert.deepEqual(parsed, {
    version: 2,
    status: "in_progress",
    step: "organization",
    startedAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:01:00.000Z",
  });
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
