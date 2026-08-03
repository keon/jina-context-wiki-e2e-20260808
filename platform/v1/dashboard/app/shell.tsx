"use client";

import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useDashboard } from "./providers";
import { apiUrl, parseInstallationResult } from "./lib/api";
import { normalizeCodexHarnessInfo } from "./lib/codex-harness";
import { formatRelative } from "./lib/presentation";
import type { InstallationResult, ViewerResponse } from "./lib/types";

type NavKey =
  | "reviews"
  | "issues"
  | "context"
  | "causal-graph"
  | "models"
  | "integrations"
  | "organization"
  | "billing"
  | "usage"
  | "settings";

type NavItem = { key: NavKey; label: string; href: string; icon: () => ReactNode };

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Workspace",
    items: [
      { key: "reviews", label: "Reviews", href: "/reviews", icon: ReviewsIcon },
      { key: "issues", label: "Issues", href: "/issues", icon: IssuesIcon },
      { key: "context", label: "Context Wiki", href: "/context", icon: ContextIcon },
      { key: "causal-graph", label: "Causal Graph", href: "/causal-graph", icon: GraphIcon },
    ],
  },
  {
    label: "Configure",
    items: [
      { key: "integrations", label: "Integrations", href: "/integrations", icon: IntegrationsIcon },
      { key: "models", label: "Models", href: "/models", icon: ModelsIcon },
    ],
  },
  {
    label: "Organization",
    items: [
      { key: "organization", label: "Members & Access", href: "/organization", icon: OrganizationIcon },
      { key: "usage", label: "Usage", href: "/usage", icon: UsageIcon },
      { key: "billing", label: "Billing", href: "/billing", icon: BillingIcon },
    ],
  },
];

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.usejina.com";

const SECTION_TITLE: Record<NavKey, string> = {
  reviews: "Reviews",
  issues: "Issues",
  context: "Context Wiki",
  "causal-graph": "Causal Graph",
  models: "Models",
  integrations: "Integrations",
  organization: "Members & Access",
  usage: "Usage",
  billing: "Billing",
  settings: "Settings",
};

function sectionForPath(pathname: string | null): NavKey {
  const path = pathname ?? "/";
  if (path.startsWith("/issues")) return "issues";
  if (path.startsWith("/causal-graph")) return "causal-graph";
  if (path.startsWith("/context")) return "context";
  if (path.startsWith("/models")) return "models";
  if (path.startsWith("/integrations")) return "integrations";
  if (path.startsWith("/organization")) return "organization";
  if (path.startsWith("/usage")) return "usage";
  if (path.startsWith("/billing")) return "billing";
  if (path.startsWith("/settings")) return "settings";
  return "reviews"; // "/", "/runs", and "/reviews/..." details
}

export function Shell({ children }: { children: ReactNode }) {
  const { data, viewer, error, loading, authLoading, authRequired, reload } = useDashboard();
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
      <Sidebar viewer={viewer} authLoading={authLoading} section={section} />

      <div className="content">
        <header className="header">
          <div className="header__inner">
            <span className="header__title">{SECTION_TITLE[section]}</span>
            <div className="header__actions">
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

function Sidebar({
  viewer,
  authLoading,
  section,
}: {
  viewer: ViewerResponse | null;
  authLoading: boolean;
  section: NavKey;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__workspace">
        <OrganizationSwitcher
          hidePersonal={false}
          afterCreateOrganizationUrl="/reviews"
          afterSelectOrganizationUrl="/reviews"
          afterSelectPersonalUrl="/reviews"
          organizationProfileMode="modal"
          createOrganizationMode="modal"
        />
      </div>

      <nav className="nav" aria-label="Dashboard navigation">
        {NAV_GROUPS.map((group) => (
          <div className="nav__group" key={group.label}>
            <span className="nav__group-label">{group.label}</span>
            {group.items.map((item) => {
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
          </div>
        ))}
      </nav>

      <div className="sidebar__spacer" />

      <nav className="nav nav--utility" aria-label="Utilities">
        <a className="nav__item" href={DOCS_URL} target="_blank" rel="noreferrer">
          <JinaGuideIcon />
          Documentation
        </a>
        <Link className={`nav__item${section === "settings" ? " nav__item--active" : ""}`} href="/settings">
          <SettingsIcon />
          Settings
        </Link>
      </nav>
      <div className="user clerk-user-menu">
        <UserButton
          userProfileMode="modal"
          userProfileProps={{ additionalOAuthScopes: { github: ["read:org", "repo"] } }}
        />
        <span className="user__name">{viewer?.user?.login ?? (authLoading ? "Loading…" : "Account")}</span>
      </div>
    </aside>
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

function IssuesIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75v3.75M8 11.15v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="m4.4 4 7.1-.8M3.8 5.35l3.4 6.3m4.9-7.3-3.3 7.3" stroke="currentColor" strokeWidth="1.2" />
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

function SettingsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
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
