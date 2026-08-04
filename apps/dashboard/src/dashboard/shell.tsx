"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppAccountButton, useAppAuth } from "../components/auth/app-auth";
import { useDashboard, useTenant } from "./providers";
import { apiUrl, parseInstallationResult } from "./lib/api";
import { clerkAuthRedirect } from "./lib/auth-navigation";
import { normalizeCodexHarnessInfo } from "./lib/codex-harness";
import { WORKSPACE_NAV_ITEMS, type WorkspaceNavKey } from "./lib/navigation";
import { formatRelative } from "./lib/presentation";
import type { InstallationResult, ViewerResponse } from "./lib/types";

type NavKey =
  | WorkspaceNavKey
  | "models"
  | "integrations"
  | "organization"
  | "billing"
  | "usage"
  | "history"
  | "tasks"
  | "settings";

type NavItem = { key: NavKey; label: string; href: string; icon: () => ReactNode };

const WORKSPACE_ICONS: Record<WorkspaceNavKey, () => ReactNode> = {
  reviews: ReviewsIcon,
  issues: IssuesIcon,
  "task-board": TaskBoardIcon,
  context: ContextIcon,
  "causal-graph": GraphIcon,
};

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Workspace",
    items: WORKSPACE_NAV_ITEMS.map((item) => ({ ...item, icon: WORKSPACE_ICONS[item.key] })),
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

const PRIMARY_NAV_ITEMS: NavItem[] = [
  ...NAV_GROUPS[0]!.items,
  ...NAV_GROUPS[1]!.items,
  NAV_GROUPS[2]!.items.find((item) => item.key === "usage")!,
];

const MORE_NAV_ITEMS: NavItem[] = [
  { key: "organization", label: "Members & Access", href: "/organization", icon: OrganizationIcon },
  { key: "billing", label: "Billing", href: "/billing", icon: BillingIcon },
  { key: "history", label: "Run History", href: "/history", icon: HistoryIcon },
  { key: "tasks", label: "Tasks", href: "/tasks", icon: TaskBoardIcon },
];

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.usejina.com";

const SECTION_TITLE: Record<NavKey, string> = {
  reviews: "Reviews",
  issues: "Issues",
  "task-board": "Task Board",
  context: "Context Wiki",
  "causal-graph": "Causal Graph",
  models: "Models",
  integrations: "Integrations",
  organization: "Members & Access",
  usage: "Usage",
  billing: "Billing",
  history: "Run History",
  tasks: "Tasks",
  settings: "Settings",
};

function sectionForPath(pathname: string | null): NavKey {
  const path = pathname ?? "/";
  if (path.startsWith("/issues")) return "issues";
  if (path.startsWith("/board")) return "task-board";
  if (path.startsWith("/causal-graph")) return "causal-graph";
  if (path.startsWith("/operations/context")) return "context";
  if (path.startsWith("/context")) return "context";
  if (path.startsWith("/models")) return "models";
  if (path.startsWith("/integrations")) return "integrations";
  if (path.startsWith("/organization")) return "organization";
  if (path.startsWith("/usage")) return "usage";
  if (path.startsWith("/billing")) return "billing";
  if (path.startsWith("/history")) return "history";
  if (path.startsWith("/tasks")) return "tasks";
  if (path.startsWith("/settings")) return "settings";
  return "reviews"; // "/", "/runs", and "/reviews/..." details
}

export function Shell({ children }: { children: ReactNode }) {
  const { data, viewer, error, loading, authLoading, reload } = useDashboard();
  const { ready: authReady, signedIn } = useAppAuth();
  const pathname = usePathname();
  const router = useRouter();
  const section = sectionForPath(pathname);
  const isSignin = pathname === "/signin";
  const [installationResult] = useState<InstallationResult | null>(() =>
    typeof window === "undefined" ? null : parseInstallationResult(window.location.search),
  );
  const [codexReconnectRequired, setCodexReconnectRequired] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const hasDashboardData = Boolean(data);
  const appAuthEnabled = viewer?.auth.enabled !== false;

  // This status is secondary to first paint. Load it once after dashboard data is
  // visible instead of repeating the query on every dashboard refresh.
  useEffect(() => {
    if (!viewer?.authenticated || !hasDashboardData) {
      setCodexReconnectRequired(false);
      return;
    }
    const controller = new AbortController();
    fetch(apiUrl("/dashboard/integrations"), {
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

  // Clerk is the source of truth for navigation. The legacy API may briefly
  // return 401 while a fresh Clerk session is being exchanged or while the API
  // is unavailable; using that response to navigate creates a /signin ↔
  // /reviews redirect loop because Clerk already considers the user signed in.
  useEffect(() => {
    if (authLoading) return;
    if (!appAuthEnabled) {
      if (isSignin) router.replace("/reviews");
      return;
    }
    const destination = clerkAuthRedirect({
      isLoaded: authReady,
      isSignedIn: signedIn,
      isSigninPage: isSignin,
    });
    if (destination) router.replace(destination);
  }, [appAuthEnabled, authLoading, authReady, signedIn, isSignin, router]);

  useEffect(() => {
    const stored = window.localStorage.getItem("jina-sidebar-collapsed");
    if (stored === "true") setSidebarCollapsed(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      window.localStorage.setItem("jina-sidebar-collapsed", String(next));
      return next;
    });
  };

  // Dedicated, chrome-less sign-in screen.
  if (isSignin) {
    return <div className="auth-shell">{children}</div>;
  }

  // Resolve the Clerk session before rendering protected application chrome.
  // API authentication state is rendered as data/error state, never as a
  // competing redirect authority.
  if (authLoading || (appAuthEnabled && (!authReady || !signedIn))) {
    return (
      <div className="auth-shell">
        <div className="auth-loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className={`app${sidebarCollapsed ? " app--sidebar-collapsed" : ""}${mobileMenuOpen ? " app--mobile-open" : ""}`}>
      <Sidebar
        viewer={viewer}
        authLoading={authLoading}
        section={section}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        onOpenSearch={() => {
          setMobileMenuOpen(false);
          setCommandOpen(true);
        }}
        onNavigate={() => setMobileMenuOpen(false)}
        onMobileClose={() => setMobileMenuOpen(false)}
      />

      {mobileMenuOpen ? (
        <button
          type="button"
          className="sidebar__backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}

      <div className="content">
        <header className="header">
          <div className="header__inner">
            <div className="header__leading">
              <button
                type="button"
                className="header__menu"
                aria-label="Open navigation"
                aria-expanded={mobileMenuOpen}
                onClick={() => setMobileMenuOpen(true)}
              >
                <MenuIcon />
              </button>
              <span className="header__title">{SECTION_TITLE[section]}</span>
            </div>
            <div className="header__actions">
              <span className="header__stamp" title={error ?? undefined}>
                {error ? "Live data unavailable" : data ? `Updated ${formatRelative(data.generated_at)}` : "Not loaded"}
              </span>
              <button type="button" className="btn btn--sm" onClick={reload} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
        </header>

        <main className={`main${section === "context" ? " main--context" : ""}`}>
          {installationResult ? <InstallResultNotice result={installationResult} /> : null}
          {codexReconnectRequired ? <CodexReconnectNotice /> : null}
          {children}
        </main>
      </div>
      {commandOpen ? <CommandPalette section={section} onClose={() => setCommandOpen(false)} /> : null}
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
  collapsed,
  onToggle,
  onOpenSearch,
  onNavigate,
  onMobileClose,
}: {
  viewer: ViewerResponse | null;
  authLoading: boolean;
  section: NavKey;
  collapsed: boolean;
  onToggle: () => void;
  onOpenSearch: () => void;
  onNavigate: () => void;
  onMobileClose: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <aside className="sidebar" aria-label="Application sidebar">
      <div className="sidebar__top">
        <div className="sidebar__workspace" aria-hidden={collapsed}>
          <WorkspaceSwitcher />
        </div>
        {collapsed ? <span className="sidebar__mark" aria-hidden="true">J</span> : null}
        <button
          type="button"
          className="sidebar__collapse"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <CollapseIcon collapsed={collapsed} />
        </button>
        <button type="button" className="sidebar__mobile-close" onClick={onMobileClose} aria-label="Close navigation">
          <CloseIcon />
        </button>
      </div>

      <button type="button" className="nav__item sidebar__search" data-label="Search" onClick={onOpenSearch}>
        <SearchIcon />
        <span className="nav__label">Search</span>
        <kbd className="sidebar__shortcut">⌘ K</kbd>
      </button>

      <nav className="nav" aria-label="Dashboard navigation">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              className={`nav__item${item.key === section ? " nav__item--active" : ""}`}
              href={item.href}
              onClick={onNavigate}
              data-label={item.label}
              aria-current={item.key === section ? "page" : undefined}
            >
              <Icon />
              <span className="nav__label">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar__spacer" />

      <nav className="nav nav--utility" aria-label="Utilities">
        <a className="nav__item" href={DOCS_URL} target="_blank" rel="noreferrer" data-label="Documentation" onClick={onNavigate}>
          <JinaGuideIcon />
          <span className="nav__label">Documentation</span>
        </a>
        <div className="sidebar__more-wrap">
          {moreOpen ? (
            <div className="sidebar__more-menu" role="menu">
              <span className="sidebar__menu-label">More</span>
              {MORE_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.key}
                    className={`nav__item${item.key === section ? " nav__item--active" : ""}`}
                    href={item.href}
                    onClick={() => {
                      setMoreOpen(false);
                      onNavigate();
                    }}
                    role="menuitem"
                  >
                    <Icon />
                    <span className="nav__label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ) : null}
          <button
            type="button"
            className={`nav__item sidebar__more${MORE_NAV_ITEMS.some((item) => item.key === section) ? " nav__item--active" : ""}`}
            onClick={() => setMoreOpen((open) => !open)}
            aria-expanded={moreOpen}
            data-label="More"
          >
            <MoreIcon />
            <span className="nav__label">More</span>
            <ChevronIcon />
          </button>
        </div>
      </nav>
      <div className="user" data-label={viewer?.user?.login ?? "Account"}>
        <AppAccountButton />
        <span className="user__name">{viewer?.user?.login ?? (authLoading ? "Loading…" : "Account")}</span>
      </div>
    </aside>
  );
}

function WorkspaceSwitcher() {
  const { tenants, selected, selectTenant, ready } = useTenant();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="workspace-switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="workspace-switcher__mark" aria-hidden="true">
          {(selected?.login ?? "J").slice(0, 1).toUpperCase()}
        </span>
        <span className="workspace-switcher__copy">
          <strong>{selected?.login ?? (ready ? "Jina" : "Loading…")}</strong>
          <small>{selected?.type === "Organization" ? "Organization" : "Personal workspace"}</small>
        </span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="workspace-switcher__menu" role="menu">
          <span className="sidebar__menu-label">Workspaces</span>
          {tenants.map((tenant) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={tenant.tenant_id === selected?.tenantId}
              className={`workspace-switcher__option${tenant.tenant_id === selected?.tenantId ? " workspace-switcher__option--active" : ""}`}
              key={tenant.tenant_id}
              onClick={() => {
                selectTenant(tenant.tenant_id);
                setOpen(false);
              }}
            >
              <span className="workspace-switcher__mark" aria-hidden="true">{tenant.login.slice(0, 1).toUpperCase()}</span>
              <span className="workspace-switcher__copy">
                <strong>{tenant.login}</strong>
                <small>{tenant.type === "Organization" ? tenant.role : "Personal"}</small>
              </span>
              {tenant.tenant_id === selected?.tenantId ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommandPalette({ section, onClose }: { section: NavKey; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const items = useMemo(
    () => [...PRIMARY_NAV_ITEMS, ...MORE_NAV_ITEMS],
    [],
  );
  const visible = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="command" role="presentation" onMouseDown={onClose}>
      <section className="command__dialog" role="dialog" aria-modal="true" aria-label="Search Jina" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command__input-wrap">
          <SearchIcon />
          <input
            autoFocus
            className="command__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages and actions"
            aria-label="Search pages and actions"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command__results">
          <span className="command__group-label">Navigate</span>
          {visible.length ? visible.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.key}
                className={`command__result${item.key === section ? " command__result--active" : ""}`}
                href={item.href}
                onClick={onClose}
              >
                <Icon />
                <span>{item.label}</span>
                <span className="command__hint">Open</span>
              </Link>
            );
          }) : <div className="command__empty">No results</div>}
        </div>
      </section>
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

function IssuesIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75v3.75M8 11.15v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TaskBoardIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.25" width="3.25" height="11.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.4" y="2.25" width="3.25" height="7" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="2.25" width="3.25" height="9.25" rx="1" stroke="currentColor" strokeWidth="1.3" />
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

function SearchIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.25 10.25 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.25h11M2.5 8h11M2.5 11.75h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="13" cy="8" r="1" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="nav__chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="nav__icon workspace-switcher__check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.4 2.8 2.8 6.2-6.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2" width="12.5" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.25 2v12" stroke="currentColor" strokeWidth="1.2" />
      <path
        d={collapsed ? "m8 6 2 2-2 2" : "m10 6-2 2 2 2"}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 5.2A5.4 5.4 0 1 1 2.7 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 2v3.5h3.5M8 4.75v3.5l2.25 1.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
