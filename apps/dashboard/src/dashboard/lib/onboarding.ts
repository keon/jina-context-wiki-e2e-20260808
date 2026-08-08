const ONBOARDING_VERSION = 2 as const;
const LEGACY_ONBOARDING_VERSION = 1 as const;

type OnboardingStatus = "in_progress" | "complete";
export type OnboardingIntent = "reviews" | "wiki" | "issues";
export type OnboardingStep =
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
  readonly selectedTenantId?: string;
  readonly intent?: OnboardingIntent;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

const ORGANIZATION_STEPS: readonly OnboardingStep[] = [
  "organization",
  "intent",
  "github",
  "review",
  "model",
  "invite",
  "finish",
];

const ALL_STEPS = new Set<OnboardingStep>(ORGANIZATION_STEPS);
const LEGACY_STEPS = new Set<string>(["workspace", ...ORGANIZATION_STEPS]);

export function onboardingSteps(): readonly OnboardingStep[] {
  return ORGANIZATION_STEPS;
}

export function onboardingPosition(step: OnboardingStep): { current: number; total: number } {
  const steps = onboardingSteps();
  const index = steps.indexOf(step);
  return { current: index >= 0 ? index + 1 : 1, total: steps.length };
}

export function adjacentOnboardingStep(
  step: OnboardingStep,
  direction: "next" | "previous",
): OnboardingStep | null {
  const steps = onboardingSteps();
  const index = steps.indexOf(step);
  if (index < 0) return steps[0] ?? null;
  return steps[index + (direction === "next" ? 1 : -1)] ?? null;
}

export function createOnboardingProgress(now = new Date().toISOString()): OnboardingProgress {
  return {
    version: ONBOARDING_VERSION,
    status: "in_progress",
    step: "organization",
    startedAt: now,
    updatedAt: now,
  };
}

export function parseOnboardingProgress(raw: unknown): OnboardingProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== ONBOARDING_VERSION && value.version !== LEGACY_ONBOARDING_VERSION) return null;
  if (value.status !== "in_progress" && value.status !== "complete") return null;
  if (typeof value.step !== "string") return null;
  if (value.version === ONBOARDING_VERSION && !ALL_STEPS.has(value.step as OnboardingStep)) return null;
  if (value.version === LEGACY_ONBOARDING_VERSION && !LEGACY_STEPS.has(value.step)) return null;
  if (!isIsoDate(value.startedAt) || !isIsoDate(value.updatedAt)) return null;
  if (
    value.version === LEGACY_ONBOARDING_VERSION &&
    value.workspaceKind !== undefined &&
    value.workspaceKind !== "personal" &&
    value.workspaceKind !== "team"
  ) {
    return null;
  }
  if (value.intent !== undefined && value.intent !== "reviews" && value.intent !== "wiki" && value.intent !== "issues") {
    return null;
  }
  if (value.selectedTenantId !== undefined && !nonEmptyString(value.selectedTenantId)) return null;
  if (value.completedAt !== undefined && !isIsoDate(value.completedAt)) return null;

  // Version 1 defaulted an omitted workspace kind to the personal path. Only an
  // explicit team choice is safe to preserve in the organization-only flow.
  const legacyPersonal = value.version === LEGACY_ONBOARDING_VERSION && value.workspaceKind !== "team";
  const requiresOrganization = legacyPersonal || value.step === "workspace";
  const requestedStep = value.step as OnboardingStep;
  const step = requiresOrganization || !ALL_STEPS.has(requestedStep) ? "organization" : requestedStep;
  const status = requiresOrganization ? "in_progress" : value.status;

  return {
    version: ONBOARDING_VERSION,
    status,
    step,
    ...(!requiresOrganization && typeof value.selectedTenantId === "string"
      ? { selectedTenantId: value.selectedTenantId.trim() }
      : {}),
    ...(value.intent ? { intent: value.intent } : {}),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(!requiresOrganization && typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
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
