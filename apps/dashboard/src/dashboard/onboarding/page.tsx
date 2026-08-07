"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  dashboardUsesGithubAuth,
  useAppAccount,
  useAppOnboarding,
  useAppOrganization,
  useAppOrganizationSetup,
} from "../../components/auth/app-auth";
import { CodexConnection } from "../components/codex-connection";
import { apiUrl } from "../lib/api";
import {
  githubInstallationUrl,
  normalizeGithubConnections,
  type GithubConnection,
} from "../lib/github-installation";
import {
  adjacentOnboardingStep,
  onboardingDestination,
  onboardingPosition,
  parseInviteEmails,
  type OnboardingIntent,
  type OnboardingStep,
  type OnboardingWorkspaceKind,
} from "../lib/onboarding";
import { isTenantWritable, normalizeViewerTenants, type ViewerTenant } from "../lib/tenants";
import { useCodexHarness, useDashboard, useTenant } from "../providers";

type ReviewTriggerMode = "every_commit" | "first_commit" | "manual_only";

const REVIEW_MODES: readonly { value: ReviewTriggerMode; title: string; description: string }[] = [
  { value: "every_commit", title: "Review every update", description: "Run Jina whenever new commits reach a pull request." },
  { value: "first_commit", title: "Review once", description: "Run on the first commit, then wait for a manual review." },
  { value: "manual_only", title: "Manual only", description: "Only review when someone explicitly asks Jina." },
];

const INTENTS: readonly { value: OnboardingIntent; title: string; description: string }[] = [
  { value: "reviews", title: "Review pull requests", description: "Catch regressions and explain risky changes before merge." },
  { value: "wiki", title: "Understand a codebase", description: "Build a living, cited map of systems and decisions." },
  { value: "issues", title: "Turn findings into work", description: "Capture actionable issues with repository context attached." },
];

export default function OnboardingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const account = useAppAccount();
  const onboarding = useAppOnboarding();
  const organizationSetup = useAppOrganizationSetup();
  const { viewer, authLoading, reloadViewer } = useDashboard();
  const tenant = useTenant();
  const { harness, ready: harnessReady, setHarness } = useCodexHarness();
  const restartHandled = useRef(false);
  const beginHandled = useRef(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const savedTenant = onboarding.progress?.selectedTenantId
    ? tenant.tenants.find((candidate) => candidate.tenant_id === onboarding.progress?.selectedTenantId)
    : undefined;
  const activeTenant = savedTenant ?? (tenant.selected
    ? tenant.tenants.find((candidate) => candidate.tenant_id === tenant.selected?.tenantId)
    : undefined);
  useEffect(() => {
    if (!onboarding.ready || restartHandled.current || searchParams.get("restart") !== "1") return;
    restartHandled.current = true;
    void onboarding.restart().catch(() => undefined);
  }, [onboarding, searchParams]);

  useEffect(() => {
    if (!onboarding.ready || onboarding.progress || beginHandled.current || searchParams.get("restart") === "1") return;
    beginHandled.current = true;
    void onboarding.begin().catch(() => undefined);
  }, [onboarding, searchParams]);

  useEffect(() => {
    const tenantId = onboarding.progress?.selectedTenantId;
    if (!tenantId || !tenant.ready || tenant.selected?.tenantId === tenantId) return;
    if (tenant.tenants.some((candidate) => candidate.tenant_id === tenantId)) tenant.selectTenant(tenantId);
  }, [onboarding.progress?.selectedTenantId, tenant]);

  if (!account.githubConnected || (!authLoading && viewer?.authenticated !== true)) {
    return (
      <OnboardingFrame account={account} progress="Account check">
        <section className="onboarding-panel onboarding-panel--preflight">
          <span className="onboarding-eyebrow">Before you begin</span>
          <h1>Connect GitHub to Jina</h1>
          <p>Jina needs your GitHub identity to discover workspaces and safely authorize repository access.</p>
          <div className="onboarding-callout">
            <strong>GitHub identity required</strong>
            <span>Add or reconnect GitHub in your account settings, then retry this check.</span>
          </div>
          <div className="onboarding-actions onboarding-actions--inline">
            <button className="btn btn--primary" type="button" onClick={() => void account.openSettings()}>
              Open account settings
            </button>
            <button className="btn" type="button" onClick={() => reloadViewer()}>Retry</button>
          </div>
        </section>
      </OnboardingFrame>
    );
  }

  if (!onboarding.ready || searchParams.get("restart") === "1" && !restartHandled.current) {
    return <OnboardingFrame account={account} progress="Preparing your setup…"><LoadingState /></OnboardingFrame>;
  }
  if (!onboarding.progress) {
    return (
      <OnboardingFrame account={account} progress="Setup unavailable">
        <section className="onboarding-panel onboarding-panel--preflight">
          <h1>Setup could not start</h1>
          <p>{onboarding.error ?? "Jina could not save your setup progress. Retry when your account connection is ready."}</p>
          <div className="onboarding-actions onboarding-actions--inline">
            <button className="btn btn--primary" type="button" disabled={onboarding.saving} onClick={() => void onboarding.begin().catch(() => undefined)}>
              Retry
            </button>
          </div>
        </section>
      </OnboardingFrame>
    );
  }

  const progress = onboarding.progress;
  const position = onboardingPosition(progress.step, progress.workspaceKind);
  const move = async (step: OnboardingStep) => {
    setLocalError(null);
    await onboarding.update({ step }).catch((cause) => {
      setLocalError(cause instanceof Error ? cause.message : "Progress could not be saved.");
      throw cause;
    });
  };
  const back = adjacentOnboardingStep(progress.step, progress.workspaceKind, "previous");
  const next = adjacentOnboardingStep(progress.step, progress.workspaceKind, "next");

  return (
    <OnboardingFrame account={account} progress={`${position.current} / ${position.total}`}>
      {progress.step === "workspace" ? (
        <WorkspaceStep
          tenants={tenant.tenants}
          saving={onboarding.saving}
          onContinue={async (kind, personalTenant) => {
            if (personalTenant) tenant.selectTenant(personalTenant.tenant_id);
            await onboarding.update({
              workspaceKind: kind,
              ...(personalTenant ? { selectedTenantId: personalTenant.tenant_id } : {}),
              step: kind === "team" ? "organization" : "intent",
            });
          }}
        />
      ) : null}
      {progress.step === "organization" ? (
        <OrganizationStep
          tenants={tenant.tenants}
          setup={organizationSetup}
          addTenant={tenant.addTenant}
          selectTenant={tenant.selectTenant}
          reloadViewer={reloadViewer}
          saving={onboarding.saving}
          onContinue={async (selectedTenant) => {
            await onboarding.update({ selectedTenantId: selectedTenant.tenant_id, step: "intent" });
          }}
        />
      ) : null}
      {progress.step === "intent" ? (
        <IntentStep
          initial={progress.intent}
          saving={onboarding.saving}
          onContinue={async (intent) => {
            await onboarding.update({ intent, step: "github" });
          }}
        />
      ) : null}
      {progress.step === "github" ? (
        <GithubStep
          tenant={activeTenant}
          installBaseUrl={viewer?.github_app?.install_url}
          saving={onboarding.saving}
          onContinue={() => move("review")}
        />
      ) : null}
      {progress.step === "review" ? (
        <ReviewStep tenant={activeTenant} saving={onboarding.saving} onContinue={() => move("model")} />
      ) : null}
      {progress.step === "model" ? (
        <ModelStep
          ready={harnessReady}
          harness={harness}
          setHarness={setHarness}
          saving={onboarding.saving}
          onContinue={() => move(progress.workspaceKind === "team" ? "invite" : "finish")}
        />
      ) : null}
      {progress.step === "invite" ? (
        <InviteStepRoute
          organizationId={activeTenant?.clerk_organization_id ?? null}
          saving={onboarding.saving}
          onContinue={() => move("finish")}
        />
      ) : null}
      {progress.step === "finish" ? (
        <FinishStep
          intent={progress.intent}
          saving={onboarding.saving}
          onOpen={async (destination) => {
            await onboarding.complete();
            router.push(destination);
          }}
        />
      ) : null}

      {localError || onboarding.error ? <p className="onboarding-error" role="alert">{localError ?? onboarding.error}</p> : null}
      {back ? (
        <button className="onboarding-back" type="button" disabled={onboarding.saving} onClick={() => void move(back)}>
          ← Back
        </button>
      ) : null}
      {next && (progress.step === "github" || progress.step === "model" || progress.step === "invite") ? (
        <button className="onboarding-skip" type="button" disabled={onboarding.saving} onClick={() => void move(next)}>
          Skip →
        </button>
      ) : null}
    </OnboardingFrame>
  );
}

function OnboardingFrame({
  account,
  progress,
  children,
}: {
  account: ReturnType<typeof useAppAccount>;
  progress: string;
  children: ReactNode;
}) {
  return (
    <div className="onboarding-page">
      <header className="onboarding-header">
        <a className="onboarding-brand" href="/reviews" aria-label="Jina home"><span>J</span> jina</a>
        <button type="button" onClick={() => void account.signOut()}>Log out</button>
      </header>
      <main className="onboarding-main">
        <div className="onboarding-progress">{progress}</div>
        {children}
      </main>
    </div>
  );
}

function LoadingState() {
  return <div className="onboarding-loading" role="status">Loading…</div>;
}

function WorkspaceStep({
  tenants,
  saving,
  onContinue,
}: {
  tenants: ViewerTenant[];
  saving: boolean;
  onContinue: (kind: OnboardingWorkspaceKind, personal?: ViewerTenant) => Promise<void>;
}) {
  const [choice, setChoice] = useState<OnboardingWorkspaceKind | null>(null);
  const personal = tenants.find((tenant) => tenant.type === "User");
  return (
    <Step title="Who are you setting Jina up for?" description="Choose a personal workspace for your projects or a shared organization for your team.">
      <div className="onboarding-choice-grid">
        <ChoiceCard selected={choice === "personal"} title="Personal" description="A private workspace for your own projects" onClick={() => setChoice("personal")} />
        <ChoiceCard selected={choice === "team"} title="Team" description="A shared workspace for your organization" onClick={() => setChoice("team")} />
      </div>
      <PrimaryAction disabled={!choice || saving || choice === "personal" && !personal} onClick={() => {
        if (!choice) return;
        return onContinue(choice, choice === "personal" ? personal : undefined);
      }}>
        Continue →
      </PrimaryAction>
      {choice === "personal" && !personal ? <p className="onboarding-hint">Your personal workspace is still being prepared. Try again in a moment.</p> : null}
    </Step>
  );
}

function OrganizationStep({
  tenants,
  setup,
  addTenant,
  selectTenant,
  reloadViewer,
  saving,
  onContinue,
}: {
  tenants: ViewerTenant[];
  setup: ReturnType<typeof useAppOrganizationSetup>;
  addTenant: (tenant: ViewerTenant) => void;
  selectTenant: (tenantId: string) => void;
  reloadViewer: () => void;
  saving: boolean;
  onContinue: (tenant: ViewerTenant) => Promise<void>;
}) {
  const organizations = tenants.filter((tenant) => tenant.type === "Organization" && tenant.clerk_organization_id);
  const [selectedId, setSelectedId] = useState<string>(organizations[0]?.tenant_id ?? "new");
  const [name, setName] = useState("");
  const [createdOrganization, setCreatedOrganization] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (selectedId !== "new") {
        const existing = organizations.find((tenant) => tenant.tenant_id === selectedId);
        if (!existing?.clerk_organization_id) throw new Error("That organization is no longer available.");
        await setup.activate(existing.clerk_organization_id);
        selectTenant(existing.tenant_id);
        await onContinue(existing);
        return;
      }
      if (!setup.supported) throw new Error("Organization creation is not available with this authentication mode.");
      const created = createdOrganization ?? await setup.create(name.trim());
      setCreatedOrganization(created);
      reloadViewer();
      const mirrored = await waitForMirroredTenant(created.id);
      addTenant(mirrored);
      await onContinue(mirrored);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The organization could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Step title="Choose your organization" description="Use an existing team workspace or create a new shared home in Jina.">
      <div className="onboarding-stack">
        {organizations.map((organization) => (
          <ChoiceCard key={organization.tenant_id} selected={selectedId === organization.tenant_id} title={organization.login} description="Existing organization" onClick={() => setSelectedId(organization.tenant_id)} />
        ))}
        <ChoiceCard selected={selectedId === "new"} title="Create a new organization" description="Invite teammates after setup" onClick={() => setSelectedId("new")} />
      </div>
      {selectedId === "new" ? (
        <label className="onboarding-field">Organization name<input value={name} disabled={Boolean(createdOrganization)} onChange={(event) => setName(event.target.value)} placeholder="Acme" autoFocus /></label>
      ) : null}
      {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
      <PrimaryAction disabled={busy || saving || selectedId === "new" && !createdOrganization && !name.trim()} onClick={submit}>
        {busy ? "Preparing workspace…" : createdOrganization ? "Retry workspace sync →" : "Continue →"}
      </PrimaryAction>
    </Step>
  );
}

async function waitForMirroredTenant(clerkOrganizationId: string): Promise<ViewerTenant> {
  let lastFailure = "The new workspace has not reached Jina yet.";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await fetch(apiUrl("/dashboard/me"), { credentials: "include", cache: "no-store" }).catch(() => undefined);
    const response = await fetch(apiUrl("/dashboard/tenants"), { credentials: "include", cache: "no-store" });
    if (response.ok) {
      const tenant = normalizeViewerTenants(await response.json()).find(
        (candidate) => candidate.clerk_organization_id === clerkOrganizationId,
      );
      if (tenant) return tenant;
    } else {
      lastFailure = `Workspace discovery returned ${response.status}.`;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
  }
  throw new Error(`${lastFailure} Retry to continue; the organization was created safely.`);
}

function IntentStep({ initial, saving, onContinue }: { initial: OnboardingIntent | undefined; saving: boolean; onContinue: (intent: OnboardingIntent) => Promise<void> }) {
  const [intent, setIntent] = useState<OnboardingIntent | null>(initial ?? null);
  return (
    <Step title="What do you want Jina to help with first?" description="Choose a starting point. You can use every workspace feature later.">
      <div className="onboarding-stack">
        {INTENTS.map((option) => <ChoiceCard key={option.value} selected={intent === option.value} title={option.title} description={option.description} onClick={() => setIntent(option.value)} />)}
      </div>
      <PrimaryAction disabled={!intent || saving} onClick={() => {
        if (!intent) return;
        return onContinue(intent);
      }}>Continue →</PrimaryAction>
    </Step>
  );
}

function GithubStep({ tenant, installBaseUrl, saving, onContinue }: { tenant: ViewerTenant | undefined; installBaseUrl: string | undefined; saving: boolean; onContinue: () => Promise<void> }) {
  const [connections, setConnections] = useState<GithubConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = tenant ? { tenantId: tenant.tenant_id, login: tenant.login, type: tenant.type, role: tenant.role, ...(tenant.clerk_organization_id ? { clerkOrganizationId: tenant.clerk_organization_id } : {}) } : null;
  const installUrl = selected && isTenantWritable(selected)
    ? githubInstallationUrl(installBaseUrl, selected, "onboarding")
    : undefined;

  useEffect(() => {
    if (!tenant) return;
    const controller = new AbortController();
    void fetch(apiUrl(`/dashboard/tenants/${encodeURIComponent(tenant.tenant_id)}/github/installations`), { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub connections returned ${response.status}.`);
        setConnections(normalizeGithubConnections(await response.json()));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "GitHub connections are unavailable.");
      });
    return () => controller.abort();
  }, [tenant]);

  const connected = Boolean(connections?.some((connection) => connection.status === "active"));
  return (
    <Step title="Connect a GitHub repository" description="Jina only accesses repositories you choose during GitHub installation.">
      <div className="onboarding-integration-card">
        <span className="onboarding-integration-mark">GH</span>
        <div><strong>{connected ? "GitHub connected" : "Connect GitHub"}</strong><p>{connected ? `${connections?.reduce((sum, connection) => sum + connection.repositoryCount, 0)} repositories available` : "Select the repositories Jina can work in"}</p></div>
        {installUrl ? <a className="btn btn--primary" href={installUrl}>{connected ? "Manage access" : "Connect GitHub"}</a> : null}
      </div>
      {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
      {selected && !isTenantWritable(selected) ? <p className="onboarding-hint">A workspace admin can manage GitHub repository access.</p> : null}
      <PrimaryAction disabled={saving || !tenant} onClick={onContinue}>{connected ? "Continue →" : "Continue without connecting →"}</PrimaryAction>
    </Step>
  );
}

function ReviewStep({ tenant, saving, onContinue }: { tenant: ViewerTenant | undefined; saving: boolean; onContinue: () => Promise<void> }) {
  const [mode, setMode] = useState<ReviewTriggerMode>("every_commit");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = tenant?.type === "User" || tenant?.role === "admin";
  const url = tenant ? apiUrl(`/dashboard/tenants/${encodeURIComponent(tenant.tenant_id)}/review-trigger`) : null;

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Review settings returned ${response.status}.`);
        const body = (await response.json()) as { mode?: ReviewTriggerMode };
        if (body.mode) setMode(body.mode);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Review settings are unavailable.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [url]);

  const submit = async () => {
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      if (writable) {
        const response = await fetch(url, { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
        if (!response.ok) throw new Error(`Review settings could not be saved (${response.status}).`);
      }
      await onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Step title="Set up automatic reviews" description="Choose when Jina should review pull requests in this workspace.">
      <div className="onboarding-stack">
        {REVIEW_MODES.map((option) => (
          <label key={option.value} className={`onboarding-radio${mode === option.value ? " onboarding-radio--selected" : ""}`}>
            <input type="radio" name="review-mode" checked={mode === option.value} disabled={!writable || loading} onChange={() => setMode(option.value)} />
            <span><strong>{option.title}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </div>
      {!writable ? <p className="onboarding-hint">Only workspace admins can change this setting. You can continue with the current value.</p> : null}
      {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
      <PrimaryAction disabled={loading || busy || saving || !tenant} onClick={submit}>{busy ? "Saving…" : "Continue →"}</PrimaryAction>
    </Step>
  );
}

function ModelStep({ ready, harness, setHarness, saving, onContinue }: { ready: boolean; harness: Parameters<typeof CodexConnection>[0]["info"]; setHarness: Parameters<typeof CodexConnection>[0]["onChanged"]; saving: boolean; onContinue: () => Promise<void> }) {
  return (
    <Step title="Connect your coding model" description="Use your Codex subscription for Jina's repository work. You can also configure providers later.">
      {ready ? <CodexConnection info={harness} onChanged={setHarness} /> : <LoadingState />}
      <PrimaryAction disabled={saving} onClick={onContinue}>Continue →</PrimaryAction>
    </Step>
  );
}

function InviteStepRoute({ organizationId, saving, onContinue }: { organizationId: string | null; saving: boolean; onContinue: () => Promise<void> }) {
  if (dashboardUsesGithubAuth) {
    return (
      <Step title="Invite your teammates" description="Team invitations are managed by your organization's authentication provider.">
        <p className="onboarding-hint">Finish setup now, then share this workspace from your organization settings.</p>
        <PrimaryAction disabled={saving} onClick={onContinue}>Continue →</PrimaryAction>
      </Step>
    );
  }
  return <ClerkInviteStep organizationId={organizationId} saving={saving} onContinue={onContinue} />;
}

function ClerkInviteStep({ organizationId, saving, onContinue }: { organizationId: string | null; saving: boolean; onContinue: () => Promise<void> }) {
  const directory = useAppOrganization({ organizationId, withInvitations: true });
  return <InviteStep directory={directory} saving={saving} onContinue={onContinue} />;
}

function InviteStep({ directory, saving, onContinue }: { directory: ReturnType<typeof useAppOrganization>; saving: boolean; onContinue: () => Promise<void> }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const parsed = useMemo(() => parseInviteEmails(input), [input]);

  const submit = async () => {
    if (parsed.valid.length === 0) {
      await onContinue();
      return;
    }
    setBusy(true);
    const failures: string[] = [];
    const failedEmails: string[] = [];
    let sent = 0;
    for (const emailAddress of parsed.valid) {
      const failure = await directory.invite({ emailAddress, role: "org:member" });
      if (failure) {
        failures.push(`${emailAddress}: ${failure.message}`);
        failedEmails.push(emailAddress);
      }
      else sent += 1;
    }
    setBusy(false);
    if (failures.length > 0) {
      setInput(failedEmails.join(", "));
      setMessage(`${sent ? `${sent} invitation${sent === 1 ? "" : "s"} sent. ` : ""}${failures.join(" ")}`);
      return;
    }
    await onContinue();
  };

  return (
    <Step title="Invite your teammates" description="They'll land in this workspace with repository and review settings already in place.">
      <label className="onboarding-field">Email addresses<textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="alex@company.com, sam@company.com" rows={3} /></label>
      <p className="onboarding-hint">Separate multiple addresses with commas. Invitations use the Member role.</p>
      {parsed.invalid.length > 0 ? <p className="onboarding-error" role="alert">Check: {parsed.invalid.join(", ")}</p> : null}
      {directory.status === "loading" ? <p className="onboarding-hint">Loading your organization directory…</p> : null}
      {directory.status === "unavailable" ? <p className="onboarding-error" role="alert">{directory.error?.message ?? "The organization directory is unavailable."}</p> : null}
      {message ? <p className="onboarding-error" role="alert">{message}</p> : null}
      <PrimaryAction disabled={busy || saving || parsed.invalid.length > 0 || directory.status !== "ready"} onClick={submit}>{busy ? "Sending invitations…" : parsed.valid.length ? "Send and continue →" : "Continue →"}</PrimaryAction>
    </Step>
  );
}

function FinishStep({ intent, saving, onOpen }: { intent: OnboardingIntent | undefined; saving: boolean; onOpen: (destination: string) => Promise<void> }) {
  const cards = [
    { title: "Review pull requests", description: "Open Reviews and run your first repository check.", href: "/reviews", intent: "reviews" },
    { title: "Explore your Wiki", description: "Build a cited map of the codebase.", href: "/wiki", intent: "wiki" },
    { title: "Track issues", description: "Turn repository findings into work.", href: "/issues", intent: "issues" },
    { title: "Manage integrations", description: "Connect more repositories and model providers.", href: "/integrations", intent: null },
  ];
  const destination = onboardingDestination(intent);
  return (
    <Step title="You're ready to work with Jina" description="Choose a grounded starting point, or continue into the area you selected.">
      <div className="onboarding-finish-grid">
        {cards.map((card) => <button key={card.href} type="button" disabled={saving} className={card.intent === intent ? "onboarding-finish-card onboarding-finish-card--primary" : "onboarding-finish-card"} onClick={() => void onOpen(card.href)}><strong>{card.title}</strong><span>{card.description}</span><small>Open →</small></button>)}
      </div>
      <PrimaryAction disabled={saving} onClick={() => onOpen(destination)}>Start in Jina →</PrimaryAction>
    </Step>
  );
}

function Step({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="onboarding-panel"><h1>{title}</h1><p className="onboarding-description">{description}</p>{children}</section>;
}

function ChoiceCard({ selected, title, description, onClick }: { selected: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" className={`onboarding-choice${selected ? " onboarding-choice--selected" : ""}`} aria-pressed={selected} onClick={onClick}><span><strong>{title}</strong><small>{description}</small></span><i aria-hidden="true" /></button>;
}

function PrimaryAction({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void | Promise<void>; children: ReactNode }) {
  return <button className="btn btn--primary onboarding-primary" type="button" disabled={disabled} onClick={() => void onClick()}>{children}</button>;
}
