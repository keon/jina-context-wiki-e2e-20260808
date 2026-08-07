"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  Badge,
  BackLink,
  DetailHeader,
  EmptyState,
  ErrorState,
  List,
  Panel,
  PanelCount,
  Row,
  Stat,
  StatRow,
  ToneDot,
  Tooltip,
  Unmeasured,
  type Tone
} from "@jina/ui";
import { statusTone } from "../../lib/status-tone";
import styles from "./gallery.module.css";

/**
 * Every shared primitive, every tone, every variant, and the four states a data
 * section can be in — rendered by a real browser against the real stylesheets.
 *
 * Two things this is for, in order:
 *
 *   1. A page with no auth that a browser can drive, so there is somewhere for
 *      end-to-end assertions about *rendering* to point. The node harness renders
 *      the same components, but happy-dom resolves no cascade, applies no media
 *      query and lays nothing out, so it cannot tell whether the error state and
 *      the empty state actually look different — only that their class lists
 *      differ. Here `getComputedStyle` answers that question.
 *   2. The catalog this repo has never had. `packages/ui/src/index.ts` explains
 *      what the primitives are for; this shows what they look like.
 *
 * A specimen's stage is a fixed, addressable box (`[data-specimen-stage]` inside
 * `[data-specimen="…"]`) so a screenshot is scoped to one component rather than
 * to the page. A layout change three specimens away then cannot invalidate a
 * baseline that has nothing to do with it.
 *
 * Selectors are `data-*`, never a class: the CSS Modules class names are hashed
 * by the bundler, and this file's own `styles.*` lookups are gallery furniture
 * that nothing outside it should be matching on.
 */

const TONES = ["ok", "warn", "bad", "info"] as const satisfies readonly Tone[];

/** Every status `statusTone()` maps, plus two it deliberately does not. */
const STATUSES = [
  "complete",
  "completed",
  "published",
  "healthy",
  "ready",
  "current",
  "succeeded",
  "active",
  "running",
  "in_progress",
  "building",
  "queued",
  "pending",
  "partial",
  "degraded",
  "stale",
  "superseded",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "unknown",
  "quarantined"
] as const;

export function Gallery() {
  return (
    <main className="admin-main" id="gallery">
      <header className="admin-page-heading">
        <div>
          <span className="admin-eyebrow">Shared primitives</span>
          <h1>Component gallery</h1>
          <p>
            Every <code>@jina/ui</code> primitive and each of its tones and variants, drawn by the stylesheets that
            ship: the theme tokens, this app&rsquo;s rules, and each component&rsquo;s own module. Development only —
            this route is a 404 in any production build.
          </p>
        </div>
        <span className="admin-scope-badge">Not deployed</span>
      </header>

      <div className={styles.gallery}>
        <Group title="States a section can be in">
          <SectionStates />
        </Group>

        <Group title="Status and tone">
          <Specimen
            name="badge-tones"
            title="Badge"
            note="Four status tones, plus the untoned badge that states a fact rather than a status."
          >
            <div className={styles.inline}>
              {TONES.map((tone) => (
                <Badge key={tone} tone={tone}>
                  {tone}
                </Badge>
              ))}
              <Badge>Organization</Badge>
              <Badge tone="">unrecognised</Badge>
            </div>
          </Specimen>

          <Specimen
            name="tone-dot"
            title="ToneDot"
            note="A bare indicator for a table cell too narrow for a badge. Hover shows its label."
          >
            <div className={styles.inline}>
              {TONES.map((tone) => (
                <ToneDot key={tone} tone={tone} label={`Status: ${tone}`} />
              ))}
              <ToneDot label="Status: not reported" />
            </div>
          </Specimen>

          <Specimen
            name="tooltip"
            title="Tooltip"
            note="Fixed-positioned so it escapes the overflow clip every panel sets on itself, and mounted on hover so there is no native title delay."
          >
            <div className={styles.inline}>
              <Tooltip label="Sampled for up to 12 active builds">
                <button type="button">Checkpoint sampling</button>
              </Tooltip>
            </div>
          </Specimen>

          <Specimen
            name="status-tones"
            title="statusTone()"
            note="Admin's status→tone map, stamped onto the cell as data-tone because CSS cannot match on text. The last two rows are values the map does not recognise: on an operations page an unknown status stays neutral rather than being coloured healthy."
            wide
          >
            <div className="table-scroll" role="region" aria-labelledby="gallery-status-caption" tabIndex={0}>
              <table className="context-table">
                <caption id="gallery-status-caption" className="sr-only">
                  Every status the admin console colours, and the tone it resolves to.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Rendered cell</th>
                    <th scope="col">Tone</th>
                  </tr>
                </thead>
                <tbody>
                  {STATUSES.map((status) => {
                    const tone = statusTone(status);
                    return (
                      <tr key={status}>
                        <td>
                          <code>{status}</code>
                        </td>
                        <td data-tone={tone}>{status}</td>
                        <td>{tone ?? "neutral"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Specimen>
        </Group>

        <Group title="Figures">
          <Specimen
            name="stat-row"
            title="Stat / StatRow"
            note="An unmeasured figure renders the sentinel and never 0 — a zero on an operations page is a measurement, and reads as evidence that nothing is wrong."
            wide
          >
            <StatRow>
              <Stat label="Wiki releases" value={1234567} />
              <Stat label="Active builds" value={0} />
              <Stat label="Projection backlog" value={undefined} />
              <Stat label="Hierarchy nodes" value={42} />
            </StatRow>
          </Specimen>

          <Specimen
            name="unmeasured"
            title="Unmeasured"
            note="The em dash is decorative; the accessible name carries the meaning."
          >
            <div className={styles.inline}>
              <Unmeasured title="No backlog was reported for this projection, so its lag is unknown" />
            </div>
          </Specimen>

          <Specimen
            name="relative-time"
            title="Relative timestamp"
            note="The churn probe. Rendered from the browser clock, so it reads a different string every run unless a test freezes time. Client-only: a server-rendered clock would not match the one that hydrates it."
            wide
          >
            <List>
              <RelativeTime />
            </List>
          </Specimen>
        </Group>

        <Group title="Structure">
          <Specimen name="panel" title="Panel" note="With a count, without one, and with an action in its head.">
            <Panel title="Members" count={3}>
              <List>
                <Row title="ada@example.com" meta="Owner" />
              </List>
            </Panel>
            <Panel title="Members">
              <EmptyState compact>No members yet.</EmptyState>
            </Panel>
            <Panel title="Members" count={3} actions={<Badge tone="info">syncing</Badge>}>
              <EmptyState compact>Nothing to show.</EmptyState>
            </Panel>
          </Specimen>

          <Specimen
            name="panel-count"
            title="PanelCount"
            note="The panel's count chip, for a heading a caller assembles itself."
          >
            <div className={styles.inline}>
              <span>Scenarios</span>
              <PanelCount>12</PanelCount>
            </div>
          </Specimen>

          <Specimen
            name="list-rows"
            title="List / Row"
            note="Each lane is omitted when it is not given: a row with no meta emits no empty lane. The linked row navigates through the app's own Link; the clickable one is a keyboard-reachable button."
            wide
          >
            <Panel title="Repositories" count={5}>
              <List>
                <Row title="Only a title" />
                <Row title="acme/payments" meta="updated 12 minutes ago" />
                <Row
                  leading={<ToneDot tone="ok" label="Status: complete" />}
                  title="acme/payments — release 41"
                  meta="refs/heads/main · 0123456789"
                  trailing={<Badge tone="ok">complete</Badge>}
                />
                <Row
                  href="/gallery#list-rows"
                  linkComponent={Link}
                  title="A routed row"
                  meta="navigates through next/link"
                  trailing={<Badge tone="info">link</Badge>}
                />
                <Row
                  onClick={() => undefined}
                  title="A clickable row"
                  meta="role=button, in the tab order"
                  trailing={<Badge>button</Badge>}
                />
              </List>
            </Panel>
          </Specimen>

          <Specimen name="detail-header" title="DetailHeader" note="Full, and reduced to a title alone." wide>
            <DetailHeader
              kicker="acme/payments"
              title="Review run 4c1f9a"
              badges={
                <>
                  <Badge tone="ok">passed</Badge>
                  <Badge tone="info">codex</Badge>
                  <Badge>main</Badge>
                </>
              }
              actions={<Badge tone="warn">re-running</Badge>}
            />
            <DetailHeader title="Untitled" />
          </Specimen>

          <Specimen name="back-link" title="BackLink" note="The affordance sits in front of the label.">
            <div className={styles.inline}>
              <BackLink href="/gallery#back-link">All reviews</BackLink>
              <BackLink href="/gallery#back-link" linkComponent={Link}>
                Routed back link
              </BackLink>
            </div>
          </Specimen>
        </Group>

        <Group title="Empty and degraded">
          <Specimen
            name="empty-state"
            title="EmptyState"
            note="A read that succeeded and found nothing. Calm, centred, and announcing nothing — an empty result is a fact about the data. The compact variant is for inside a card."
          >
            <EmptyState>
              <p>No context releases have been published.</p>
              <p>
                Verified pages remain private, resumable checkpoints until the complete catalog passes its gates and
                publishes atomically.
              </p>
            </EmptyState>
            <EmptyState compact>Nothing yet.</EmptyState>
            <EmptyState role="status">Loading published releases…</EmptyState>
          </Specimen>

          <Specimen
            name="error-state"
            title="ErrorState"
            note="A read that failed, or was never attempted. Deliberately not the empty state's geometry: left-aligned, tinted, and carrying a marker glyph."
          >
            <ErrorState role="alert" title="2 sections are not reporting">
              <ul>
                <li>Published releases — the Jina API request failed.</li>
                <li>Agent-derived context — not attempted because Published releases could not be loaded.</li>
              </ul>
              <p>Counts shown as “—” were never measured and are not zero.</p>
            </ErrorState>
            <Panel title="Published releases">
              <ErrorState flush title="Published releases is unavailable">
                <p>The Jina API request for this section failed. This is not an empty result.</p>
              </ErrorState>
            </Panel>
          </Specimen>
        </Group>
      </div>
    </main>
  );
}

/**
 * The same section, four times.
 *
 * This repo has repeatedly shipped a failure dressed as confident empty copy —
 * "No context releases have been published" rendered over an API that never
 * answered. The four renders sit side by side so the difference is a thing you
 * can look at, and so a browser test can assert that they resolve to genuinely
 * different styles rather than merely to different class names.
 */
function SectionStates() {
  return (
    <>
      <Specimen name="section-loading" title="Loading" note="The read is in flight. Announced, so it is not silent.">
        <Panel title="Published releases">
          <EmptyState role="status">Loading published releases…</EmptyState>
        </Panel>
      </Specimen>

      <Specimen name="section-empty" title="Empty" note="The read succeeded and found nothing. This is a measurement.">
        <Panel title="Published releases" count={0}>
          <EmptyState>
            <p>No context releases have been published.</p>
          </EmptyState>
        </Panel>
      </Specimen>

      <Specimen
        name="section-error"
        title="Error"
        note="The read failed. Nothing below it reflects current state, and it must not be mistaken for the render above."
      >
        <Panel title="Published releases">
          <ErrorState flush title="Published releases is unavailable">
            <p>The Jina API request for this section failed. This is not an empty result.</p>
          </ErrorState>
        </Panel>
      </Specimen>

      <Specimen name="section-ready" title="Ready" note="The read succeeded and found rows.">
        <Panel title="Published releases" count={3}>
          <List>
            <Row
              leading={<ToneDot tone="ok" label="Status: complete" />}
              title="acme/payments"
              meta="main · published 2026-03-01 11:04 UTC"
              trailing={<Badge tone="ok">complete</Badge>}
            />
            <Row
              leading={<ToneDot tone="warn" label="Status: partial" />}
              title="acme/ledger"
              meta="main · published 2026-03-01 09:41 UTC"
              trailing={<Badge tone="warn">partial</Badge>}
            />
            <Row
              leading={<ToneDot label="Status: not reported" />}
              title="acme/search"
              meta="main · published 2026-02-28 22:15 UTC"
              trailing={<Badge>unknown</Badge>}
            />
          </List>
        </Panel>
      </Specimen>
    </>
  );
}

/**
 * The instant the probe below measures from. Fixed rather than "now" so a test
 * that freezes the clock gets a string it can assert on exactly.
 */
const RELATIVE_TIME_ORIGIN = Date.parse("2026-03-01T12:00:00.000Z");

function RelativeTime() {
  // Rendered after mount, never on the server: a timestamp formatted twice
  // against two different clocks is a hydration mismatch, and hiding one with
  // `suppressHydrationWarning` would hide real ones too.
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => setLabel(relativeTime(RELATIVE_TIME_ORIGIN, Date.now())), []);

  return (
    <Row
      title="acme/payments"
      meta={label === null ? "—" : `updated ${label}`}
      trailing={<Badge tone="info">live clock</Badge>}
    />
  );
}

function relativeTime(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="context-admin-section admin-data-section" data-gallery-group={title}>
      <h2>{title}</h2>
      <div className={styles.grid}>{children}</div>
    </section>
  );
}

/**
 * One addressable specimen. `data-specimen` names it; `data-specimen-stage` is
 * the box a screenshot is scoped to.
 */
function Specimen({
  name,
  title,
  note,
  wide = false,
  children
}: {
  readonly name: string;
  readonly title: string;
  readonly note?: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={wide ? `${styles.specimen} ${styles.wide}` : styles.specimen}
      data-specimen={name}
      id={`specimen-${name}`}
    >
      <h3 className={styles.caption}>
        {title} <code>{name}</code>
      </h3>
      {note ? <p className={styles.note}>{note}</p> : null}
      <div className={styles.stage} data-specimen-stage="">
        {children}
      </div>
    </section>
  );
}
