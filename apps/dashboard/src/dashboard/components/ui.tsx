"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import {
  BackLink as UiBackLink,
  Row as UiRow,
  ToneDot as UiToneDot,
  type LinkComponent
} from "@jina/ui";
import { useDashboard } from "../providers";
import { safeHref } from "../lib/api";
import { statusTone } from "../lib/presentation";

/**
 * The dashboard's view of the shared primitives.
 *
 * Most of what this file used to define now lives in `@jina/ui`, with its styles
 * beside it as CSS Modules — see that package's `index.ts` for why. Three kinds
 * of thing are left here:
 *
 *   - Re-exports, so the pages that import from this module did not have to
 *     change: `Badge`, `EmptyState`, `List`, `Panel`.
 *   - Thin bindings that supply the coupling the package deliberately does not
 *     import — `next/link` for `Row` and `BackLink`, this app's `statusTone` for
 *     `StatusDot`.
 *   - Components that are genuinely this app's: `Toolbar` reads the dashboard
 *     provider, `ExternalLink` validates through this app's `safeHref`, and
 *     `Section` is entangled with the `:has()` opt-outs the
 *     reviews pages rely on.
 */

export { Badge, EmptyState, List, Panel, PanelCount } from "@jina/ui";

/* ---------- Routed primitives ---------- */

// `next/link` accepts everything the package asks of a link and more, so the
// app's real router component goes straight in.
const routerLink = Link as LinkComponent;

/** `Row`, wired to the app router so a list row still navigates client-side. */
export function Row(props: Omit<ComponentProps<typeof UiRow>, "linkComponent">) {
  return <UiRow {...props} linkComponent={routerLink} />;
}

export function BackLink(props: Omit<ComponentProps<typeof UiBackLink>, "linkComponent">) {
  return <UiBackLink {...props} linkComponent={routerLink} />;
}

/* ---------- External links ---------- */

/**
 * Anchor for URLs sourced from API data. Validates the protocol via `safeHref`
 * (drops `javascript:`/`data:` URLs) and always sets `rel="noopener noreferrer"`.
 * Renders a disabled-looking span when the href is missing or unsafe.
 *
 * Stays in the app: `safeHref` is this app's, and a shared component that
 * carried its own copy of a URL allowlist would be a second thing to keep right.
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

/* ---------- Status ---------- */

export { ToneDot } from "@jina/ui";

/**
 * A status string, dotted in this app's reading of it.
 *
 * The mapping stays here rather than in the package because the two apps
 * disagree about it: the dashboard reads substrings, while admin matches an
 * exact allowlist and leaves anything it has not seen uncoloured.
 */
export function StatusDot({ status }: { status: string }) {
  return <UiToneDot tone={statusTone(status)} label={status} />;
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

/**
 * `Section` stays in the app. Its appearance is not
 * self-contained: `styles.css` reflows a `.section` that has no `.section__body`
 * child, and `.review-detail-surface` opts back out of that — rules that reach
 * across the reviews pages' own markup. Moving the markup without those rules
 * would be the stylesheet/markup desync this extraction exists to prevent.
 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section__title">{title}</div>
      <div className="section__body">{children}</div>
    </section>
  );
}
