"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppAccount, useAppAuth, useDeveloperMode } from "../components/auth/app-auth";
import { useCodexHarness, useDashboard, useTenant } from "./providers";
import { parseInstallationResult } from "./lib/api";
import { clerkAuthRedirect } from "./lib/auth-navigation";
import { useSelectedClerkOrganization } from "./lib/clerk-organization";
import { WORKSPACE_NAV_ITEMS, type WorkspaceNavKey } from "./lib/navigation";
import { formatRelative } from "./lib/presentation";
import type { DashboardResponse, InstallationResult, ViewerResponse } from "./lib/types";

type NavKey =
  | WorkspaceNavKey
  | "models"
  | "integrations"
  | "organization-settings"
  | "organization"
  | "billing"
  | "usage"
  | "history"
  | "tasks"
  | "settings";

interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  icon: () => ReactNode;
}

const WORKSPACE_ICONS: Record<WorkspaceNavKey, () => ReactNode> = {
  reviews: ReviewsIcon,
  issues: IssuesIcon,
  "task-board": TaskBoardIcon,
  context: ContextIcon,
  "causal-graph": GraphIcon,
};

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
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
];

const PRIMARY_NAV_ITEMS: NavItem[] = [...NAV_GROUPS[0]!.items, ...NAV_GROUPS[1]!.items];

const DEVELOPER_NAV_ITEMS: NavItem[] = [
  { key: "history", label: "Run History", href: "/history", icon: HistoryIcon },
  { key: "tasks", label: "Tasks", href: "/tasks", icon: TasksIcon },
];

const ORGANIZATION_NAV_ITEMS: NavItem[] = [
  { key: "organization-settings", label: "General", href: "/organization/settings", icon: SettingsIcon },
  { key: "organization", label: "Members", href: "/organization", icon: OrganizationIcon },
  { key: "billing", label: "Billing", href: "/billing", icon: BillingIcon },
  { key: "usage", label: "Usage", href: "/usage", icon: UsageIcon },
];

const PERSONAL_SETTINGS_NAV_ITEMS: NavItem[] = [
  { key: "settings", label: "User Settings", href: "/settings", icon: AccountIcon },
];

const DEVELOPER_SECTIONS = new Set<NavKey>(["task-board", "history", "tasks"]);

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.usejina.com";

const SECTION_TITLE: Record<NavKey, string> = {
  reviews: "Reviews",
  issues: "Issues",
  "task-board": "Task Board",
  context: "Context Wiki",
  "causal-graph": "Causal Graph",
  models: "Models",
  integrations: "Integrations",
  "organization-settings": "Org Settings",
  organization: "Members & Access",
  usage: "Usage",
  billing: "Billing",
  history: "Run History",
  tasks: "Tasks",
  settings: "User Settings",
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
  if (path.startsWith("/organization/settings")) return "organization-settings";
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
  const developerMode = useDeveloperMode();
  const pathname = usePathname();
  const router = useRouter();
  const section = sectionForPath(pathname);
  const isSignin = pathname === "/signin";
  const [installationResult] = useState<InstallationResult | null>(() =>
    typeof window === "undefined" ? null : parseInstallationResult(window.location.search),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const appAuthEnabled = viewer?.auth.enabled !== false;
  const settingsMode =
    section === "settings" ||
    section === "organization-settings" ||
    section === "organization" ||
    section === "billing" ||
    section === "usage";
  const developerRouteBlocked = developerMode.ready && !developerMode.enabled && DEVELOPER_SECTIONS.has(section);
  // Read from the shared harness provider rather than querying /dashboard/integrations here: the
  // Models page needs the same viewer-scoped status, and on /models both reads fired in the same tick.
  const { harness } = useCodexHarness();
  const codexReconnectRequired = harness.reconnect_required === true;

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
    if (developerRouteBlocked) {
      router.replace("/reviews");
    }
  }, [developerRouteBlocked, router]);

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
    <div
      className={`app${sidebarCollapsed ? " app--sidebar-collapsed" : ""}${mobileMenuOpen ? " app--mobile-open" : ""}`}
    >
      <Sidebar
        viewer={viewer}
        authLoading={authLoading}
        section={section}
        settingsMode={settingsMode}
        collapsed={sidebarCollapsed}
        commandOpen={commandOpen}
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
                {freshnessLabel(data, error)}
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
          {developerRouteBlocked ? (
            <div className="page-placeholder page-placeholder--compact" role="status">
              Opening Reviews…
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      {commandOpen ? (
        <CommandPalette section={section} developerMode={developerMode.enabled} onClose={() => setCommandOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * Header freshness stamp. `generated_at` is the newest activity in the payload — the latest review-run
 * update or finding — not the moment the response was generated, so this answers "how current is this
 * workspace" instead of always reading "just now". A workspace with no rows has no such timestamp and
 * says so rather than rendering a relative time for a value that does not exist.
 */
function freshnessLabel(data: DashboardResponse | null, error: string | null): string {
  if (error) return "Live data unavailable";
  if (!data) return "Not loaded";
  if (!data.generated_at) return "No activity yet";
  return `Updated ${formatRelative(data.generated_at)}`;
}

function CodexReconnectNotice() {
  return (
    <div className="notice notice--bad reconnect-notice" role="alert">
      <span>
        <strong>Reconnect Codex.</strong> OpenAI rejected your saved sign-in, so reviews using your ChatGPT subscription
        cannot run.
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
  settingsMode,
  collapsed,
  commandOpen,
  onToggle,
  onOpenSearch,
  onNavigate,
  onMobileClose,
}: {
  viewer: ViewerResponse | null;
  authLoading: boolean;
  section: NavKey;
  settingsMode: boolean;
  collapsed: boolean;
  commandOpen: boolean;
  onToggle: () => void;
  onOpenSearch: () => void;
  onNavigate: () => void;
  onMobileClose: () => void;
}) {
  const { selected } = useTenant();
  const developerMode = useDeveloperMode();
  const primaryItems = PRIMARY_NAV_ITEMS.filter((item) => item.key !== "task-board" || developerMode.enabled);

  return (
    <aside className="sidebar" aria-label="Application sidebar">
      <div className="sidebar__top">
        <div className="sidebar__workspace" aria-hidden={collapsed}>
          <WorkspaceSwitcher />
        </div>
        {collapsed ? (
          <span className="sidebar__mark" aria-hidden="true">
            J
          </span>
        ) : null}
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

      {!settingsMode ? (
        <button
          type="button"
          className="nav__item sidebar__search"
          data-label="Search"
          aria-label="Search"
          onClick={onOpenSearch}
        >
          <SearchIcon />
          <span className="nav__label">Search</span>
          <kbd className="sidebar__shortcut">⌘ K</kbd>
        </button>
      ) : null}

      {settingsMode ? (
        <nav className="nav sidebar__pane sidebar__pane--settings" aria-label="Settings navigation">
          <SettingsNavGroup
            label="Personal"
            items={PERSONAL_SETTINGS_NAV_ITEMS}
            section={section}
            onNavigate={onNavigate}
          />
          <SettingsNavGroup
            label={`Organization · ${selected?.login ?? "Workspace"}`}
            items={ORGANIZATION_NAV_ITEMS}
            section={section}
            onNavigate={onNavigate}
          />
        </nav>
      ) : (
        <nav className="nav sidebar__pane" aria-label="Dashboard navigation">
          {primaryItems.map((item) => (
            <SidebarNavLink key={item.key} item={item} section={section} onNavigate={onNavigate} />
          ))}
        </nav>
      )}

      <div className="sidebar__spacer" />
      {settingsMode ? (
        <Link
          className="sidebar-settings__work-link"
          href="/reviews"
          onClick={onNavigate}
          aria-label="Back to work"
          data-label="Back to work"
        >
          <BackIcon />
          <span>Back to work</span>
        </Link>
      ) : null}
      <AccountMenu
        viewer={viewer}
        authLoading={authLoading}
        section={section}
        collapsed={collapsed}
        commandOpen={commandOpen}
        onExpand={onToggle}
        onNavigate={onNavigate}
      />
    </aside>
  );
}

function SettingsNavGroup({
  label,
  items,
  section,
  onNavigate,
}: {
  label: string;
  items: NavItem[];
  section: NavKey;
  onNavigate: () => void;
}) {
  return (
    <div className="sidebar-settings__group">
      <span className="sidebar-settings__group-label">{label}</span>
      {items.map((item) => (
        <SidebarNavLink key={item.key} item={item} section={section} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function SidebarNavLink({
  item,
  section,
  onNavigate,
}: {
  item: NavItem;
  section: NavKey;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      className={`nav__item${item.key === section ? " nav__item--active" : ""}`}
      href={item.href}
      onClick={onNavigate}
      data-label={item.label}
      aria-label={item.label}
      aria-current={item.key === section ? "page" : undefined}
    >
      <Icon />
      <span className="nav__label">{item.label}</span>
    </Link>
  );
}

function AccountMenu({
  viewer,
  authLoading,
  section,
  collapsed,
  commandOpen,
  onExpand,
  onNavigate,
}: {
  viewer: ViewerResponse | null;
  authLoading: boolean;
  section: NavKey;
  collapsed: boolean;
  commandOpen: boolean;
  onExpand: () => void;
  onNavigate: () => void;
}) {
  const account = useAppAccount();
  const developerMode = useDeveloperMode();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const accountLabel = account.displayName || viewer?.user?.login || "Account";

  useEffect(() => {
    if (commandOpen) setOpen(false);
  }, [commandOpen]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={rootRef}>
      {open ? (
        <div className="user-menu__popover" role="menu" aria-label="Account menu">
          <div className="user-menu__identity">
            <strong>{account.email ?? accountLabel}</strong>
          </div>
          <div className="user-menu__section">
            <Link
              className={`user-menu__action${section === "organization-settings" ? " user-menu__action--active" : ""}`}
              href="/organization/settings"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              <SettingsIcon />
              <span>Org Settings</span>
            </Link>
            <Link
              className={`user-menu__action${section === "settings" ? " user-menu__action--active" : ""}`}
              href="/settings"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              <AccountIcon />
              <span>User Settings</span>
            </Link>
          </div>
          {developerMode.enabled ? (
            <div className="user-menu__section">
              {DEVELOPER_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.key}
                    className={`user-menu__action${item.key === section ? " user-menu__action--active" : ""}`}
                    href={item.href}
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onNavigate();
                    }}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ) : null}
          <div className="user-menu__section">
            <a className="user-menu__action" href={DOCS_URL} target="_blank" rel="noreferrer" role="menuitem">
              <JinaGuideIcon />
              <span>Developer docs</span>
            </a>
          </div>
          <div className="user-menu__section">
            <button type="button" className="user-menu__action" role="menuitem" onClick={() => void account.signOut()}>
              <LogoutIcon />
              <span>Log out</span>
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className="user"
        data-label={accountLabel}
        aria-label={`Open account menu for ${accountLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (collapsed) {
            onExpand();
            setOpen(true);
            return;
          }
          setOpen((value) => !value);
        }}
      >
        <AccountAvatar label={accountLabel} />
        <span className="user__copy">
          <strong className="user__name">{accountLabel}</strong>
          <small>{authLoading || !account.ready ? "Loading…" : account.email ?? "Personal account"}</small>
        </span>
        <ChevronIcon />
      </button>
    </div>
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
        <WorkspaceAvatar label={selected?.login ?? "Jina"} compact />
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
              <span className="workspace-switcher__mark" aria-hidden="true">
                {tenant.login.slice(0, 1).toUpperCase()}
              </span>
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

function WorkspaceAvatar({ label, compact = false }: { label: string; compact?: boolean }) {
  const account = useAppAccount();
  const { selected } = useTenant();
  const { organization } = useSelectedClerkOrganization();
  const imageUrl = organization?.imageUrl ?? (selected?.type === "User" ? account.imageUrl : undefined);
  const className = compact ? "workspace-switcher__mark" : "user__avatar";

  return (
    <span className={className} aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" /> : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function AccountAvatar({ label }: { label: string }) {
  const account = useAppAccount();
  return (
    <span className="user__avatar" aria-hidden="true">
      {account.imageUrl ? <img src={account.imageUrl} alt="" /> : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function CommandPalette({
  section,
  developerMode,
  onClose,
}: {
  section: NavKey;
  developerMode: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(
    () => [
      ...PRIMARY_NAV_ITEMS.filter((item) => item.key !== "task-board" || developerMode),
      ...ORGANIZATION_NAV_ITEMS,
      ...(developerMode ? DEVELOPER_NAV_ITEMS : []),
      { key: "settings" as const, label: "User Settings", href: "/settings", icon: AccountIcon },
    ],
    [developerMode],
  );
  const visible = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="command" role="presentation" onMouseDown={onClose}>
      <section
        className="command__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search Jina"
        onMouseDown={(event) => event.stopPropagation()}
      >
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
          {visible.length ? (
            visible.map((item) => {
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
            })
          ) : (
            <div className="command__empty">No results</div>
          )}
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
        d="M2.25 3.25h11.5v8.25H7L3.75 14v-2.5h-1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m5.25 7.4 1.55 1.5 3.7-3.65"
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
      <path d="M8 1.9 14.25 13H1.75z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 5.25v3.5M8 11.25v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TaskBoardIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.25" width="12" height="11.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.35 2.25v11.5M2 6.6h5.35M7.35 9.35H14" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="2.75" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.25" cy="12.25" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.75" cy="12.25" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="m7.25 4.1-3.2 6.8m4.7-6.8 3.2 6.8M4.75 12.25h6.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ContextIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 3.35c2.15-.7 4.25-.35 6.25 1.05v9.15c-2-1.4-4.1-1.75-6.25-1.05zM14.25 3.35C12.1 2.65 10 3 8 4.4v9.15c2-1.4 4.1-1.75 6.25-1.05z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ModelsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m8 1.75 5.5 3v6.5l-5.5 3-5.5-3v-6.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="m2.5 4.75 5.5 3 5.5-3M8 7.75v6.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function IntegrationsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.25 2v3.25m5.5-3.25v3.25M4 5.25h8V7a4 4 0 0 1-8 0zM8 11v3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OrganizationIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="5" r="2.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6" r="1.65" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M1.5 13.5c.35-2.65 1.7-3.95 4-3.95s3.65 1.3 4 3.95m.05-3.45c.55-.45 1.25-.7 2.05-.7 1.7 0 2.65.95 2.9 2.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function JinaGuideIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 1.75h6.5L13 5.25v9H3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path
        d="M9.5 1.75v3.5H13M5.5 8h5M5.5 10.5h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
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
      <path
        d="M2 13.5h12M3 11l3-3 2.45 2.1 4.35-5.35"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function AccountIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5.25" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.25 13c.45-2.55 2.05-3.8 4.75-3.8s4.3 1.25 4.75 3.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v1.2M8 12.8V14M2 8h1.2M12.8 8H14M3.75 3.75l.85.85m6.8 6.8.85.85m0-8.5-.85.85m-6.8 6.8-.85.85"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m9.75 3.5-4.5 4.5 4.5 4.5M5.5 8h7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.25 2.25H3.5A1.25 1.25 0 0 0 2.25 3.5v9A1.25 1.25 0 0 0 3.5 13.75h2.75M9.5 5l3 3-3 3M12.5 8H5.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
      <path
        d="m3.5 8.4 2.8 2.8 6.2-6.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
      <path
        d="M3 2v3.5h3.5M8 4.75v3.5l2.25 1.25"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg className="nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m2 4.3 1.25 1.25L5.5 3.3M7.25 4.5H14M2 9.8l1.25 1.25L5.5 8.8M7.25 10H14"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
