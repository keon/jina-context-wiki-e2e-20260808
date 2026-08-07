const ONBOARDING_VERSION = 1 as const;

type OnboardingStatus = "in_progress" | "complete";
export type OnboardingWorkspaceKind = "personal" | "team";
export type OnboardingIntent = "reviews" | "wiki" | "issues";
export type OnboardingStep =
  | "workspace"
  | "organization"
  | "intent"
  | "github"
  | "review"
  | "model"
  | "invite"
  | "finish";

export interface OnboardingProgress {
  readonly version: typeof ONBOARDING_VERSION;
  readonly status: OnboardingStatus;
  readonly step: OnboardingStep;
  readonly workspaceKind?: OnboardingWorkspaceKind;
  readonly selectedTenantId?: string;
  readonly intent?: OnboardingIntent;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

const PERSONAL_STEPS: readonly OnboardingStep[] = [
  "workspace",
  "intent",
  "github",
  "review",
  "model",
  "finish",
];

const TEAM_STEPS: readonly OnboardingStep[] = [
  "workspace",
  "organization",
  "intent",
  "github",
  "review",
  "model",
  "invite",
  "finish",
];

const ALL_STEPS = new Set<OnboardingStep>(TEAM_STEPS);

export function onboardingSteps(kind: OnboardingWorkspaceKind | undefined): readonly OnboardingStep[] {
  return kind === "team" ? TEAM_STEPS : PERSONAL_STEPS;
}

export function onboardingPosition(
  step: OnboardingStep,
  kind: OnboardingWorkspaceKind | undefined,
): { current: number; total: number } {
  const steps = onboardingSteps(kind);
  const index = steps.indexOf(step);
  return { current: index >= 0 ? index + 1 : 1, total: steps.length };
}

export function adjacentOnboardingStep(
  step: OnboardingStep,
  kind: OnboardingWorkspaceKind | undefined,
  direction: "next" | "previous",
): OnboardingStep | null {
  const steps = onboardingSteps(kind);
  const index = steps.indexOf(step);
  if (index < 0) return steps[0] ?? null;
  return steps[index + (direction === "next" ? 1 : -1)] ?? null;
}

export function createOnboardingProgress(now = new Date().toISOString()): OnboardingProgress {
  return {
    version: ONBOARDING_VERSION,
    status: "in_progress",
    step: "workspace",
    startedAt: now,
    updatedAt: now,
  };
}

export function parseOnboardingProgress(raw: unknown): OnboardingProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== ONBOARDING_VERSION) return null;
  if (value.status !== "in_progress" && value.status !== "complete") return null;
  if (typeof value.step !== "string" || !ALL_STEPS.has(value.step as OnboardingStep)) return null;
  if (!isIsoDate(value.startedAt) || !isIsoDate(value.updatedAt)) return null;
  if (value.workspaceKind !== undefined && value.workspaceKind !== "personal" && value.workspaceKind !== "team") {
    return null;
  }
  if (value.intent !== undefined && value.intent !== "reviews" && value.intent !== "wiki" && value.intent !== "issues") {
    return null;
  }
  if (value.selectedTenantId !== undefined && !nonEmptyString(value.selectedTenantId)) return null;
  if (value.completedAt !== undefined && !isIsoDate(value.completedAt)) return null;

  const workspaceKind = value.workspaceKind;
  const steps = onboardingSteps(workspaceKind);
  const requestedStep = value.step as OnboardingStep;
  const step = steps.includes(requestedStep) ? requestedStep : "workspace";

  return {
    version: ONBOARDING_VERSION,
    status: value.status,
    step,
    ...(workspaceKind ? { workspaceKind } : {}),
    ...(typeof value.selectedTenantId === "string" ? { selectedTenantId: value.selectedTenantId.trim() } : {}),
    ...(value.intent ? { intent: value.intent } : {}),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
  };
}

export function onboardingDestination(intent: OnboardingIntent | undefined): string {
  if (intent === "wiki") return "/wiki";
  if (intent === "issues") return "/issues";
  return "/reviews";
}

export function onboardingRedirect(input: {
  readonly pathname: string;
  readonly restartRequested: boolean;
  readonly progress: OnboardingProgress | null;
}): string | null {
  if (input.pathname === "/signin") return null;
  if (input.restartRequested && input.pathname === "/onboarding") return null;
  if (input.progress?.status === "in_progress" && input.pathname !== "/onboarding") return "/onboarding";
  if (input.progress?.status === "complete" && input.pathname === "/onboarding") {
    return onboardingDestination(input.progress.intent);
  }
  return null;
}

export interface ParsedInviteEmails {
  readonly valid: readonly string[];
  readonly invalid: readonly string[];
}

export function parseInviteEmails(input: string): ParsedInviteEmails {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) valid.push(email);
    else invalid.push(email);
  }
  return { valid, invalid };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}
