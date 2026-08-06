"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import { loadBilling, type Billing } from "../lib/billing";
import { formatDate } from "../lib/presentation";
import { CONFIG_STALE_TIME_MS } from "../lib/query-client";
import { tenantQueryKey } from "../lib/query-keys";
import {
  computeMeter,
  creditsToUsd,
  DEFAULT_USAGE_PERIOD,
  formatCredits,
  loadUsage,
  normalizeUsagePeriod,
  usageParams,
  USAGE_PERIODS,
  type Usage,
  type UsageRecentRun
} from "../lib/usage";
import { type SelectedTenant } from "../lib/tenants";
import { useTenant, useTenantQueryScope } from "../providers";

function tenantScopedUrl(selected: SelectedTenant | null, suffix: string, params?: URLSearchParams): string {
  const path = selected
    ? `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}${suffix}`
    : `/dashboard${suffix}`;
  return apiUrl(path, params);
}

export default function UsagePage() {
  const { selected } = useTenant();
  const scope = useTenantQueryScope();
  const [days, setDays] = useState<number>(DEFAULT_USAGE_PERIOD);

  // Both reads resolve every failure to a rendered state (`unavailable` /
  // `not_configured`) rather than rejecting, so neither retries. Keyed by scope
  // and period: switching either addresses a different entry instead of blanking
  // this one, which is what used to wipe the selected period mid-flight.
  const usageQuery = useQuery<Usage>({
    queryKey: tenantQueryKey("usage", scope, days),
    queryFn: () =>
      loadUsage(() => fetch(tenantScopedUrl(selected, "/usage", usageParams(days)), { credentials: "include" })),
    staleTime: CONFIG_STALE_TIME_MS,
    retry: false
  });
  const billingQuery = useQuery<Billing>({
    queryKey: tenantQueryKey("billing", scope),
    queryFn: () => loadBilling(() => fetch(tenantScopedUrl(selected, "/billing"), { credentials: "include" })),
    staleTime: CONFIG_STALE_TIME_MS,
    retry: false
  });

  const usage = usageQuery.data;
  const billing = billingQuery.data;
  const retry = () => {
    void usageQuery.refetch();
    void billingQuery.refetch();
  };

  const readyUsage = usage?.status === "ok" ? usage : null;
  const unavailable = usage?.status === "unavailable";

  return (
    <div className="usage-v2">
      {unavailable ? (
        <div className="usage-alert" role="status">
          <span>Usage data is temporarily unavailable. Your records have not been changed.</span>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      <header className="usage-toolbar">
        <div>
          <h1>Usage</h1>
          <p>Review activity and credit consumption for this workspace.</p>
        </div>
        <div className="usage-toolbar__filters">
          {selected ? <span className="usage-filter-pill">{selected.login}</span> : null}
          <PeriodSelector days={days} onChange={setDays} />
        </div>
      </header>

      <UsageOverview
        usage={readyUsage}
        billing={billing}
        loading={usage === undefined}
        unavailable={unavailable}
        days={days}
      />

      <section className="usage-breakdown">
        <nav className="usage-breakdown__tabs" aria-label="Usage and billing">
          <span className="usage-breakdown__tab usage-breakdown__tab--active" aria-current="page">
            Review usage
          </span>
          <Link href="/billing" className="usage-breakdown__tab">
            Billing and limits
          </Link>
        </nav>
        <div className="usage-capabilities">
          <CapabilityCard
            title="Model usage"
            // `—` rather than a `?? 0` fallback: an unreachable service has no
            // measurement, and zero is a different claim from unknown.
            primary={unavailable ? "—" : formatCredits(readyUsage?.totals.ai_credits ?? 0)}
            primaryLabel="AI credits"
            secondary={
              unavailable
                ? "—"
                : creditsToUsd(readyUsage?.totals.model_cost_usd ? readyUsage.totals.model_cost_usd * 100 : 0)
            }
            secondaryLabel="estimated model cost"
            values={readyUsage?.daily.map((day) => day.credits) ?? []}
          />
          <CapabilityCard
            title="Review infrastructure"
            primary={unavailable ? "—" : formatCredits(readyUsage?.totals.infra_credits ?? 0)}
            primaryLabel="infra credits"
            secondary={unavailable ? "—" : String(readyUsage?.totals.runs ?? 0)}
            secondaryLabel="review runs"
            values={readyUsage?.daily.map((day) => day.runs) ?? []}
          />
        </div>
      </section>

      <RecentRuns runs={readyUsage?.recent_runs ?? []} loading={usage === undefined} unavailable={unavailable} />
    </div>
  );
}

function PeriodSelector({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div className="usage-period" role="group" aria-label="Usage period">
      {USAGE_PERIODS.map((period) => (
        <button
          type="button"
          key={period}
          className={normalizeUsagePeriod(days) === period ? "usage-period__active" : undefined}
          aria-pressed={normalizeUsagePeriod(days) === period}
          onClick={() => onChange(period)}
        >
          {period}d
        </button>
      ))}
    </div>
  );
}

function UsageOverview({
  usage,
  billing,
  loading,
  unavailable,
  days
}: {
  usage: Usage | null;
  billing: Billing | undefined;
  loading: boolean;
  unavailable: boolean;
  days: number;
}) {
  // A failed read has no total to report. Rendering the `?? 0` fallback here
  // printed "0 credits · $0.00" as though it had been measured, directly under
  // the banner saying the data could not be loaded.
  const unknown = loading || unavailable;
  const cycle = billing?.status === "ok" ? billing.cycle : null;
  const meter = computeMeter({
    used: usage?.cycle_credits_used ?? usage?.totals.total_credits ?? cycle?.used ?? null,
    granted: cycle?.granted ?? null,
    extra: billing?.status === "ok" ? billing.credits_balance : null
  });
  const totalCredits = usage?.totals.total_credits ?? 0;

  return (
    <section className="usage-overview">
      <div className="usage-chart-panel">
        <div className="usage-chart-panel__head">
          <div>
            <span>Total usage</span>
            <strong>{unknown ? "—" : formatCredits(totalCredits)}</strong>
            <small>
              {loading
                ? "Loading activity…"
                : unavailable
                  ? "Not measured — the usage service was unreachable."
                  : `${creditsToUsd(totalCredits)} · last ${days} days`}
            </small>
          </div>
          <span className="usage-chart-panel__group">Grouped daily</span>
        </div>
        <UsageTrend values={usage?.daily.map((day) => day.credits) ?? []} days={days} loading={unknown} />
      </div>

      <aside className="usage-side-rail" aria-label="Usage summary">
        <SummaryMetric
          label="Credits"
          value={unknown ? "—" : formatCredits(totalCredits)}
          // Without an included allotment there is no "remaining" to report —
          // saying "0 remaining" reads as exhausted even when the workspace has
          // a positive purchased balance.
          detail={
            unknown
              ? "Not measured"
              : meter.hasIncluded
                ? `${formatCredits(meter.remaining)} remaining`
                : "No included allotment"
          }
        >
          <div
            className="usage-rail-progress"
            role="progressbar"
            aria-valuenow={Math.round(meter.usedPct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${meter.hasIncluded ? meter.usedPct : 0}%` }} />
          </div>
        </SummaryMetric>
        <SummaryMetric
          label="Review runs"
          value={unknown ? "—" : String(usage?.totals.runs ?? 0)}
          detail={unknown ? "Not measured" : `${usage?.totals.completed_runs ?? 0} completed`}
        />
        <SummaryMetric
          label="Key sources"
          value={unknown ? "—" : String((usage?.totals.byok_runs ?? 0) + (usage?.totals.harness_runs ?? 0))}
          detail={
            unknown ? "Not measured" : `${usage?.totals.byok_runs ?? 0} BYOK · ${usage?.totals.harness_runs ?? 0} Codex`
          }
        />
      </aside>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  children
}: {
  label: string;
  value: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="usage-side-rail__metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      {children}
    </div>
  );
}

function chartPoints(values: number[], height = 32): string {
  const series = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const max = Math.max(1, ...series);
  return series
    .map((value, index) => {
      const x = (index / Math.max(1, series.length - 1)) * 100;
      const y = height - 3 - (Math.max(0, value) / max) * (height - 8);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function UsageTrend({ values, days, loading }: { values: number[]; days: number; loading: boolean }) {
  const points = useMemo(() => chartPoints(values), [values]);
  const hasData = values.some((value) => value > 0);
  return (
    <div className="usage-trend">
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="Daily credit usage">
        <defs>
          <linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="29" x2="100" y2="29" className="usage-trend__baseline" />
        {hasData ? <polyline points={`0,29 ${points} 100,29`} className="usage-trend__area" /> : null}
        <polyline points={points} className="usage-trend__line" />
      </svg>
      {/* While the request is in flight the flat line is "unknown", not "zero usage". */}
      {!hasData && !loading ? <span className="usage-trend__empty">No usage recorded in this period.</span> : null}
      <div className="usage-trend__labels">
        <span>{days} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function CapabilityCard({
  title,
  primary,
  primaryLabel,
  secondary,
  secondaryLabel,
  values
}: {
  title: string;
  primary: string;
  primaryLabel: string;
  secondary: string;
  secondaryLabel: string;
  values: number[];
}) {
  const points = useMemo(() => chartPoints(values, 24), [values]);
  return (
    <article className="usage-capability-card">
      <div className="usage-capability-card__head">
        <h2>{title}</h2>
      </div>
      <div className="usage-capability-card__legend">
        <span>
          <i /> {primary} {primaryLabel}
        </span>
        <span>
          <i /> {secondary} {secondaryLabel}
        </span>
      </div>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="21" x2="100" y2="21" />
        <polyline points={points} />
      </svg>
      <div className="usage-capability-card__labels">
        <span>Start</span>
        <span>Today</span>
      </div>
    </article>
  );
}

function RecentRuns({
  runs,
  loading,
  unavailable
}: {
  runs: UsageRecentRun[];
  loading: boolean;
  unavailable: boolean;
}) {
  return (
    <section className="usage-recent">
      <div className="usage-recent__head">
        <div>
          <h2>Recent reviews</h2>
          <p>Latest credit-bearing activity in this period.</p>
        </div>
        {runs.length > 0 ? <span>{runs.length}</span> : null}
      </div>
      {/* "Not loaded yet" and "the request failed" are never reported as "no usage". */}
      {loading ? (
        <div className="usage-recent__empty" aria-busy="true">
          Loading recent reviews…
        </div>
      ) : unavailable ? (
        <div className="usage-recent__empty">
          Recent reviews could not be loaded. Your records have not been changed.
        </div>
      ) : runs.length === 0 ? (
        <div className="usage-recent__empty">There is no review usage for this period and workspace.</div>
      ) : (
        <div className="usage-recent__table">
          <div className="usage-recent__row usage-recent__row--head">
            <span>Repository</span>
            <span>Status</span>
            <span>Source</span>
            <span>Credits</span>
            <span>Date</span>
          </div>
          {runs.map((run, index) => (
            <RunRow key={run.review_run_id ?? `run-${index}`} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunRow({ run }: { run: UsageRecentRun }) {
  const credits = (run.infra_credits ?? 0) + (run.ai_credits ?? 0);
  const repo = run.repo_full_name ? `${run.repo_full_name}${run.pr_number !== null ? ` #${run.pr_number}` : ""}` : "—";
  return (
    <div className="usage-recent__row">
      <span title={repo}>{repo}</span>
      <span>{run.status ? <Badge tone={statusToneFor(run.status)}>{run.status}</Badge> : "—"}</span>
      <span>{run.key_source ?? "—"}</span>
      <span>{formatCredits(credits)}</span>
      <span>{run.created_at ? formatDate(run.created_at) : "—"}</span>
    </div>
  );
}

function statusToneFor(status: string): "ok" | "bad" | "warn" | "info" {
  const lower = status.toLowerCase();
  if (lower.includes("complete") || lower.includes("pass") || lower.includes("publish")) return "ok";
  if (lower.includes("fail") || lower.includes("error")) return "bad";
  if (lower.includes("run") || lower.includes("queue") || lower.includes("pend")) return "warn";
  return "info";
}
