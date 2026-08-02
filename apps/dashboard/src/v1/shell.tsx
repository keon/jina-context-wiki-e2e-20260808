"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDashboard, useTenant } from "./providers";
import { Badge } from "./components/ui";
import { apiUrl, createJinaOrganization, logout, parseInstallationResult } from "./lib/api";
import { normalizeCodexHarnessInfo } from "./lib/codex-harness";
import { formatRelative } from "./lib/presentation";
import { tenantRoleLabel, tenantTypeLabel } from "./lib/tenants";
import type { InstallationResult, ViewerResponse } from "./lib/types";

type NavKey =
  | "reviews"
  | "issues"
  | "context"
  | "models"
  | "integrations"
  | "organization"
  | "jina"
  | "billing"
  | "usage"
  | "board"
  | "history"
  | "task-types"
  | "context-operations";

const NAV: Array<{ key: NavKey; label: string; href: string; icon: () => ReactNode }> = [
  { key: "reviews", label: "Reviews", href: "/reviews", icon: ReviewsIcon },
  { key: "issues", label: "Issues", href: "/issues", icon: ReviewsIcon },
  { key: "context", label: "Context", href: "/context", icon: ContextIcon },
  { key: "models", label: "Models", href: "/models", icon: ModelsIcon },
  { key: "integrations", label: "Integrations", href: "/integrations", icon: IntegrationsIcon },
  { key: "organization", label: "Organization", href: "/organization", icon: OrganizationIcon },
  { key: "jina", label: ".jina Guide", href: "/jina", icon: JinaGuideIcon },
  { key: "usage", label: "Usage", href: "/usage", icon: UsageIcon },
  { key: "billing", label: "Billing", href: "/billing", icon: BillingIcon },
  { key: "board", label: "Work Board", href: "/board", icon: ReviewsIcon },
  { key: "history", label: "Event History", href: "/history", icon: UsageIcon },
  { key: "task-types", label: "Task Types", href: "/tasks", icon: ModelsIcon },
  { key: "context-operations", label: "Context Ops", href: "/operations/context", icon: ContextIcon },
];

const SECTION_TITLE: Record<NavKey, string> = {
  reviews: "Reviews",
  issues: "Issues",
  context: "Context",
  models: "Models",
  integrations: "Integrations",
  organization: "Organization settings",
  jina: "Using .jina",
  usage: "Usage",
  billing: "Billing",
  board: "Work Board",
  history: "Event History",
  "task-types": "Task Types",
  "context-operations": "Context Operations",
};

function sectionForPath(pathname: string | null): NavKey {
  const path = pathname ?? "/";
  if (path.startsWith("/issues")) return "issues";
  if (path.startsWith("/context")) return "context";
  if (path.startsWith("/models")) return "models";
  if (path.startsWith("/integrations")) return "integrations";
  if (path.startsWith("/organization")) return "organization";
  if (path.startsWith("/jina")) return "jina";
  if (path.startsWith("/usage")) return "usage";
  if (path.startsWith("/billing")) return "billing";
  if (path.startsWith("/board")) return "board";
  if (path.startsWith("/history")) return "history";
  if (path.startsWith("/tasks")) return "task-types";
  if (path.startsWith("/operations/context")) return "context-operations";
  return "reviews"; // "/", "/runs", and "/reviews/..." details
}

export function Shell({ children }: { children: ReactNode }) {
  const { data, viewer, error, loading, authLoading, authRequired, reload, reloadViewer } = useDashboard();
  const pathname = usePathname();
  const router = useRouter();
  const section = sectionForPath(pathname);
  const isSignin = pathname === "/signin";
  const [installationResult] = useState<InstallationResult | null>(() =>
    typeof window === "undefined" ? null : parseInstallationResult(window.location.search),
  );
  const [codexReconnectRequired, setCodexReconnectRequired] = useState(false);
  const hasDashboardData = Boolean(data);

  // This status is secondary to first paint. Load it once after dashboard data is
  // visible instead of repeating the query on every dashboard refresh.
  useEffect(() => {
    if (!viewer?.authenticated || !hasDashboardData) {
      setCodexReconnectRequired(false);
      return;
    }
    const controller = new AbortController();
    fetch(apiUrl("/v1/dashboard/integrations"), {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: Record<string, unknown> | undefined) => {
        if (body && !controller.signal.aborted) {
          setCodexReconnectRequired(normalizeCodexHarnessInfo(body?.codex_harness).reconnect_required === true);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [viewer?.authenticated, viewer?.user?.id, hasDashboardData]);

  // Strip the GitHub install callback query params (incl. installation_id) from
  // the URL once read, so they don't leak via the Referer header on later nav.
  useEffect(() => {
    if (!installationResult) return;
    if (typeof window === "undefined") return;
    if (!window.location.search) return;
    router.replace(window.location.pathname);
  }, [installationResult, router]);

  // Gate the app: push unauthenticated visitors to the dedicated sign-in page,
  // and bounce authenticated ones away from it.
  useEffect(() => {
    if (authLoading) return;
    if (authRequired && !isSignin) {
      router.replace("/signin");
    } else if (!authRequired && isSignin) {
      router.replace("/reviews");
    }
  }, [authLoading, authRequired, isSignin, router]);

  // Dedicated, chrome-less sign-in screen.
  if (isSignin) {
    return <div className="auth-shell">{children}</div>;
  }

  // Resolving the session, or redirecting an unauthenticated visitor to /signin.
  if (authLoading || authRequired) {
    return (
      <div className="auth-shell">
        <div className="auth-loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar viewer={viewer} authLoading={authLoading} section={section} onLoggedOut={reloadViewer} />

      <div className="content">
        <header className="header">
          <div className="header__inner">
            <span className="header__title">{SECTION_TITLE[section]}</span>
            <div className="header__actions">
              <TenantSwitcher />
              <span className="header__stamp">
                {data ? `Updated ${formatRelative(data.generated_at)}` : "Not loaded"}
              </span>
              <button type="button" className="btn btn--sm" onClick={reload} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
        </header>

        <main className={`main${section === "context" ? " main--context" : ""}`}>
          {error ? <div className="notice notice--bad">Dashboard API error: {error}</div> : null}
          {installationResult ? <InstallResultNotice result={installationResult} /> : null}
          {codexReconnectRequired ? <CodexReconnectNotice /> : null}
          {children}
        </main>
      </div>
    </div>
  );
}

function CodexReconnectNotice() {
  return (
    <div className="notice notice--bad reconnect-notice" role="alert">
      <span>
        <strong>Reconnect Codex.</strong> OpenAI rejected your saved sign-in, so reviews using your ChatGPT
        subscription cannot run.
      </span>
      {/* Reload even when already on Models so its credential card reads the newly detected failure. */}
      <a className="btn btn--sm" href="/models#codex-provider">
        Reconnect
      </a>
    </div>
  );
}

/** Compact workspace menu for switching tenants or creating an organization. */
function TenantSwitcher() {
  const { tenants, switcherVisible, selected, selectTenant, addTenant } = useTenant();
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setCreateMode(false);
        setOrganizationName("");
        setCreateError(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (!switcherVisible || !selected) return null;

  const pick = (tenantId: string) => {
    selectTenant(tenantId);
    setOpen(false);
    setCreateMode(false);
    setOrganizationName("");
    setCreateError(null);
  };

  const submitOrganization = async () => {
    const name = organizationName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const tenant = await createJinaOrganization(name);
      addTenant(tenant);
      setOrganizationName("");
      setCreateMode(false);
      setOpen(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create organization");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="model-pill-wrap" ref={containerRef}>
      <button
        type="button"
        className="model-pill"
        aria-expanded={open}
        aria-controls={open ? "tenant-workspace-menu" : undefined}
        aria-label="Switch workspace or create an organization"
        onClick={() => {
          if (open) {
            setOpen(false);
            setCreateMode(false);
            setOrganizationName("");
            setCreateError(null);
          } else {
            setOpen(true);
          }
        }}
      >
        <span className="model-pill__name">{selected.login}</span>
        <span className="tenant-pill__type">{tenantTypeLabel(selected.type)}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="model-pop" id="tenant-workspace-menu">
          {createMode ? (
            <form
              className="tenant-pop__form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitOrganization();
              }}
            >
              <label className="form-field">
                <span className="form-field__label">Jina organization name</span>
                <input
                  autoFocus
                  className="input"
                  value={organizationName}
                  maxLength={80}
                  placeholder="Acme Research"
                  onChange={(event) => setOrganizationName(event.target.value)}
                />
              </label>
              <p className="tenant-pop__hint">
                Create the Jina workspace first. You can connect GitHub organizations afterward.
              </p>
              {createError ? (
                <span className="tenant-pop__error" role="alert">
                  {createError}
                </span>
              ) : null}
              <div className="tenant-pop__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={creating}
                  onClick={() => {
                    setCreateMode(false);
                    setOrganizationName("");
                    setCreateError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary btn--sm"
                  disabled={creating || organizationName.trim().length === 0}
                >
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="model-pop__list">
                {tenants.map((tenant) => {
                  const active = tenant.tenant_id === selected.tenantId;
                  return (
                    <button
                      type="button"
                      key={tenant.tenant_id}
                      aria-current={active ? "true" : undefined}
                      className={`model-pop__opt${active ? " model-pop__opt--active" : ""}`}
                      onClick={() => pick(tenant.tenant_id)}
                    >
                      <span className="model-pop__opt-name">{tenant.login}</span>
                      <span className="tenant-pop__badges">
                        <Badge tone="info">{tenantTypeLabel(tenant.type)}</Badge>
                        {tenant.type === "Organization" ? <Badge>{tenantRoleLabel(tenant.role)}</Badge> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="tenant-pop__create"
                onClick={() => {
                  setCreateMode(true);
                  setCreateError(null);
                }}
              >
                <span aria-hidden="true">+</span>
                Create organization
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="model-pill__chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6.5 8 10l4-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Sidebar({
  viewer,
  authLoading,
  section,
  onLoggedOut,
}: {
  viewer: ViewerResponse | null;
  authLoading: boolean;
  section: NavKey;
  onLoggedOut: () => void;
}) {
  return (
    <aside className="sidebar">
      <Link className="brand" href="/reviews">
        <span className="brand__mark">J</span>
        <span className="brand__name">Jina</span>
      </Link>

      <nav className="nav">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              className={`nav__item${item.key === section ? " nav__item--active" : ""}`}
              href={item.href}
            >
              <Icon />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar__spacer" />

      <AuthControls viewer={viewer} authLoading={authLoading} onLoggedOut={onLoggedOut} />
    </aside>
  );
}

function AuthControls({
  viewer,
  authLoading,
  onLoggedOut,
}: {
  viewer: ViewerResponse | null;
  authLoading: boolean;
  onLoggedOut: () => void;
}) {
  if (authLoading || !viewer) {
    return <div className="user__role">Loading session…</div>;
  }

  if (!viewer.auth.enabled) {
    return <div className="user__role">Authentication disabled</div>;
  }

  return (
    <div className="user">
      {viewer.user?.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="user__avatar" src={viewer.user.avatar_url} alt="" />
      ) : null}
      <span className="user__name">{viewer.user?.login}</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void logout(onLoggedOut)}>
        Sign out
      </button>
    </div>
  );
}


function InstallResultNotice({ result }: { result: InstallationResult }) {
  const label = result.action === "update" ? "Installation updated" : "Installation complete";
  return (
    <div className="notice notice--ok">
      <strong>{label}</strong>
      {result.installationId ? <span>GitHub installation #{result.installationId}</span> : null}
    </div>
  );
}

function ReviewsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8h3l2-4.5 3 9 2-4.5h3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ContextIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.75" cy="3.25" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="12.25" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="m4.55 7.15 5.65-3.05M4.7 8.8l5.65 2.7M11.8 5v5.5" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="4" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="11.5" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="11.5" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 6.25v1.5m-1.4 1.9L5.4 9.4m5.2 0-1.2.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IntegrationsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="5.75" width="7" height="4.5" rx="2.25" stroke="currentColor" strokeWidth="1.3" />
      <rect x="7.25" y="5.75" width="7" height="4.5" rx="2.25" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function OrganizationIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 14V3.5h7V14M9.5 7h4v7M5 6h2M5 9h2M5 12h2M11.5 9.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function JinaGuideIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 1.75h6.5L13 5.25v9H3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9.5 1.75v3.5H13M5.5 8h5M5.5 10.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BillingIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.75 6.5h12.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 13.5V9m4 4.5v-7m4 7V4m4 9.5V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
