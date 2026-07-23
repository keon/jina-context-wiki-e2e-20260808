"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAVIGATION = [
  {
    href: "/",
    label: "Graphs",
    matches: (pathname: string) => pathname === "/" || pathname.startsWith("/graphs/") || pathname === "/build"
  },
  { href: "/history", label: "Generation history", matches: (pathname: string) => pathname.startsWith("/history") },
  {
    href: "/observability",
    label: "Observability",
    matches: (pathname: string) => pathname.startsWith("/observability")
  },
  { href: "/health", label: "Service health", matches: (pathname: string) => pathname.startsWith("/health") },
  { href: "/tenants", label: "Tenants", matches: (pathname: string) => pathname.startsWith("/tenants") },
  { href: "/access", label: "Access", matches: (pathname: string) => pathname.startsWith("/access") }
] as const;

export function AdminShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="admin-shell">
      <header className="topbar">
        <Link href="/" className="brand">
          Jina Admin
        </Link>
        <div className="topbar-actions">
          <span className="environment">Production</span>
          <Link href="/access" className="icon-button" aria-label="Access settings">
            <GearIcon />
          </Link>
          <span className="icon-button" aria-label="No unread alerts">
            <BellIcon />
          </span>
          <span className="avatar" aria-label="Current administrator">
            KA
          </span>
        </div>
      </header>
      <aside className="sidebar">
        <h2>Admin</h2>
        <nav aria-label="Admin navigation">
          {NAVIGATION.map((item) => (
            <Link key={item.href} href={item.href} className={item.matches(pathname) ? "active" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="page-content">{children}</div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25Z" />
      <path d="M19.5 12a7.5 7.5 0 0 0-.11-1.27l2-1.55-2-3.46-2.47 1a7.57 7.57 0 0 0-2.2-1.28L14.35 3h-4l-.37 2.44a7.57 7.57 0 0 0-2.2 1.28l-2.47-1-2 3.46 2 1.55A7.5 7.5 0 0 0 5.2 12a7.5 7.5 0 0 0 .11 1.27l-2 1.55 2 3.46 2.47-1a7.57 7.57 0 0 0 2.2 1.28l.37 2.44h4l.37-2.44a7.57 7.57 0 0 0 2.2-1.28l2.47 1 2-3.46-2-1.55A7.5 7.5 0 0 0 19.5 12Z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM9.75 20h4.5" />
    </svg>
  );
}
