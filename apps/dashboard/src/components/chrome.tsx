"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useConnection } from "../lib/connection.ts";

const PAGES = [
  { href: "/board", page: "board", label: "Board" },
  { href: "/history", page: "history", label: "History" },
  { href: "/tasks", page: "task-types", label: "Task types" },
  { href: "/operations/context", page: "context-operations", label: "Context ops" },
  { href: "/reviews", page: "reviews", label: "Product" }
] as const;

function activePage(pathname: string): string {
  if (pathname === "/history") return "history";
  if (pathname === "/tasks") return "task-types";
  if (pathname === "/operations/context" || pathname.startsWith("/operations/context/")) return "context-operations";
  if (pathname === "/reviews" || pathname.startsWith("/reviews/")) return "reviews";
  return "board";
}

export function PageNav() {
  const pathname = usePathname();
  const current = activePage(pathname);
  // Several stylesheet rules key off body[data-page] exactly like the
  // previous dashboard did.
  useEffect(() => {
    document.body.dataset.page = current;
  }, [current]);
  return (
    <nav className="page-nav" aria-label="Dashboard pages">
      {PAGES.map(({ href, page, label }) => (
        <Link key={page} href={href} data-page={page} className={current === page ? "active" : ""}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function ConnectionIndicator({ apiLabel }: { readonly apiLabel: string }) {
  const online = useConnection();
  return (
    <div id="connection">
      <span className={online === false ? "pulse offline" : "pulse"} id="connection-dot" />
      <span id="connection-text">
        {online === undefined ? "Connecting…" : online ? `Live · ${apiLabel}` : `Cannot reach ${apiLabel}`}
      </span>
    </div>
  );
}
