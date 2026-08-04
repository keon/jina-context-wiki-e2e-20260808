"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from "react";
import { useDashboard } from "../providers";
import type { Tone } from "../lib/types";
import { safeHref } from "../lib/api";
import { statusTone } from "../lib/presentation";

/* ---------- External links ---------- */

/**
 * Anchor for URLs sourced from API data. Validates the protocol via `safeHref`
 * (drops `javascript:`/`data:` URLs) and always sets `rel="noopener noreferrer"`.
 * Renders a disabled-looking span when the href is missing or unsafe.
 */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string | undefined | null;
  className?: string;
  children: ReactNode;
}) {
  const safe = safeHref(href);
  if (!safe) {
    return <span className={className}>{children}</span>;
  }
  return (
    <a className={className} href={safe} rel="noopener noreferrer">
      {children}
    </a>
  );
}

/* ---------- Tooltip ---------- */

/**
 * Instant, fixed-positioned tooltip. We position with `fixed` so it escapes
 * any ancestor `overflow: hidden` (panels/sections clip their children), and
 * we mount on hover so there is none of the browser's native title delay.
 */
function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPos({ x: rect.left + rect.width / 2, y: rect.top });
  };
  const hide = () => setPos(null);

  return (
    <span
      ref={ref}
      className="tt"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos ? (
        <span className="tt__bubble" role="tooltip" style={{ left: pos.x, top: pos.y }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

/* ---------- Status + labels ---------- */

/** A bare status indicator: just a tone-colored dot; the label shows on hover. */
export function ToneDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Tooltip label={label}>
      <span className={`status-dot${tone ? ` status-dot--${tone}` : ""}`} aria-label={label} role="img" />
    </Tooltip>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <ToneDot tone={statusTone(status)} label={status} />;
}

export function Badge({ tone = "", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge${tone ? ` badge--${tone}` : ""}`}>{children}</span>;
}

/* ---------- List primitives ---------- */

export function Panel({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">{title}</span>
        {count !== undefined ? <span className="panel__count">{count}</span> : null}
        {actions ? <span className="panel__actions">{actions}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function List({ children }: { children: ReactNode }) {
  return <div className="list">{children}</div>;
}

/**
 * The one canonical list row, shared by every list in the app:
 * [leading]  title / meta …                          trailing
 */
export function Row({
  href,
  onClick,
  leading,
  title,
  meta,
  trailing,
}: {
  href?: string;
  onClick?: MouseEventHandler;
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
}) {
  const interactive = Boolean(href || onClick);
  const className = `row${interactive ? " row--link" : ""}`;
  const inner = (
    <>
      {leading !== undefined ? <span className="row__lead">{leading}</span> : null}
      <span className="row__main">
        <span className="row__title">{title}</span>
        {meta !== undefined ? <span className="row__meta">{meta}</span> : null}
      </span>
      {trailing !== undefined ? <span className="row__trail">{trailing}</span> : null}
    </>
  );

  if (href) {
    return (
      <Link className={className} href={href}>
        {inner}
      </Link>
    );
  }
  const onKeyDown: KeyboardEventHandler | undefined = onClick
    ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick(event as unknown as Parameters<MouseEventHandler>[0]);
        }
      }
    : undefined;
  return (
    <div
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onKeyDown}
    >
      {inner}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/* ---------- Filter toolbar (shared across list pages) ---------- */

export function Toolbar() {
  const { data, viewer, filters, setFilters } = useDashboard();
  const projects = data?.projects ?? viewer?.projects ?? [];
  const teams = data?.teams ?? viewer?.teams ?? [];
  const hasFilters = Boolean(filters.project || filters.team);

  return (
    <div className="toolbar">
      <select
        className="select select--inline"
        value={filters.project}
        onChange={(event) => setFilters({ ...filters, project: event.target.value })}
        aria-label="Filter by project"
      >
        <option value="">All projects</option>
        {projects.map((project) => (
          <option key={project.full_name} value={project.full_name}>
            {project.full_name}
          </option>
        ))}
      </select>

      <select
        className="select select--inline"
        value={filters.team}
        onChange={(event) => setFilters({ ...filters, team: event.target.value })}
        aria-label="Filter by team"
      >
        <option value="">All teams</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.organization.login}/{team.name}
          </option>
        ))}
      </select>

      {hasFilters ? (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setFilters({ project: "", team: "" })}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

/* ---------- Detail-page primitives ---------- */

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="back-link" href={href}>
      ← {children}
    </Link>
  );
}

export function DetailHeader({
  kicker,
  title,
  badges,
  actions,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="detail__header">
      <div className="detail__heading">
        {kicker !== undefined ? <div className="detail__kicker">{kicker}</div> : null}
        <h1 className="detail__title">{title}</h1>
        {badges !== undefined ? <div className="detail__badges">{badges}</div> : null}
      </div>
      {actions !== undefined ? <div className="detail__actions">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section__title">{title}</div>
      <div className="section__body">{children}</div>
    </section>
  );
}

/** Section whose body is a flush list/table with no padding. */
export function SectionFlush({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section__title section__title--row">
        <span>{title}</span>
        {count !== undefined ? <span className="panel__count">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}
