"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

const NAV_ITEMS = [
  { label: "Overview", href: "#overview", icon: OverviewIcon },
  { label: "Context releases", href: "#releases", icon: ReleasesIcon },
  { label: "Build state", href: "#builds", icon: BuildsIcon },
  { label: "Index health", href: "#health", icon: HealthIcon },
  { label: "Derived context", href: "#documents", icon: DocumentsIcon }
];

export function AdminShell({ children }: { readonly children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem("jina-admin-sidebar-collapsed") === "true") setCollapsed(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem("jina-admin-sidebar-collapsed", String(next));
      return next;
    });
  };

  const navigate = () => setMobileOpen(false);

  return (
    <div
      className={`admin-app${collapsed ? " admin-app--collapsed" : ""}${mobileOpen ? " admin-app--mobile-open" : ""}`}
    >
      <aside className="admin-sidebar" aria-label="Admin navigation">
        <div className="admin-sidebar__top">
          <Link className="admin-project" href="#overview" onClick={navigate}>
            <span className="admin-project__mark">J</span>
            <span className="admin-project__copy">
              <strong>Jina Admin</strong>
              <small>All context</small>
            </span>
          </Link>
          <button
            className="admin-icon-button admin-sidebar__collapse"
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
          <button
            className="admin-icon-button admin-sidebar__close"
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <CloseIcon />
          </button>
        </div>

        <button
          type="button"
          className="admin-nav__item admin-search"
          data-label="Search"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon />
          <span className="admin-nav__label">Search</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav className="admin-nav" aria-label="Context administration">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                className="admin-nav__item"
                href={item.href}
                data-label={item.label}
                onClick={navigate}
              >
                <Icon />
                <span className="admin-nav__label">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="admin-sidebar__spacer" />
        <div className="admin-sidebar__footer">
          <div className="admin-account" data-label="System administrator">
            <span className="admin-account__avatar">A</span>
            <span className="admin-nav__label">System administrator</span>
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="admin-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <div className="admin-content">
        <header className="admin-header">
          <div className="admin-header__leading">
            <button
              type="button"
              className="admin-icon-button admin-header__menu"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <MenuIcon />
            </button>
            <span>Context administration</span>
          </div>
          <span className="admin-live">
            <i /> Tenant-admin view
          </span>
        </header>
        {children}
      </div>

      {searchOpen ? <AdminSearch onClose={() => setSearchOpen(false)} /> : null}
    </div>
  );
}

function AdminSearch({ onClose }: { readonly onClose: () => void }) {
  const [query, setQuery] = useState("");
  const visible = NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="admin-command" onMouseDown={onClose}>
      <section
        className="admin-command__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search admin"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="admin-command__input">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search admin sections"
            aria-label="Search admin sections"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="admin-command__results">
          <small>Navigate</small>
          {visible.length ? (
            visible.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} onClick={onClose}>
                  <Icon />
                  <span>{item.label}</span>
                  <em>Open</em>
                </Link>
              );
            })
          ) : (
            <p>No results</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg className="admin-nav__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

function OverviewIcon() {
  return (
    <Icon>
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </Icon>
  );
}

function ReleasesIcon() {
  return (
    <Icon>
      <path
        d="M2.25 4.25 8 1.75l5.75 2.5L8 6.75zM2.25 4.25v7.25L8 14.25l5.75-2.75V4.25M8 6.75v7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

function BuildsIcon() {
  return (
    <Icon>
      <path
        d="M3 2.25h10v3.5H3zM3 10.25h10v3.5H3zM5 5.75v4.5M11 5.75v4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

function HealthIcon() {
  return (
    <Icon>
      <path
        d="M1.75 8h3l1.75-4 3 8 1.5-4h3.25"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

function DocumentsIcon() {
  return (
    <Icon>
      <path
        d="M3 1.75h6.5L13 5.25v9H3zM9.5 1.75v3.5H13M5.5 8h5M5.5 10.5h5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

function SearchIcon() {
  return (
    <Icon>
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.25 10.25 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  );
}

function MenuIcon() {
  return (
    <Icon>
      <path d="M2.5 4.25h11M2.5 8h11M2.5 11.75h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  );
}

function CloseIcon() {
  return (
    <Icon>
      <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  );
}

function CollapseIcon({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <Icon>
      <rect x="1.75" y="2" width="12.5" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.25 2v12" stroke="currentColor" strokeWidth="1.2" />
      <path
        d={collapsed ? "m8 6 2 2-2 2" : "m10 6-2 2 2 2"}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Icon>
  );
}
