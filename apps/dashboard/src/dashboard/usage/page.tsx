"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import { loadBilling, type Billing } from "../lib/billing";
import { formatDate } from "../lib/presentation";
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
  type UsageRecentRun,
} from "../lib/usage";
import { type SelectedTenant } from "../lib/tenants";
import { useTenant, useTenantFence } from "../providers";

function tenantScopedUrl(selected: SelectedTenant | null, suffix: string, params?: URLSearchParams): string {
  const path = selected
    ? `/dashboard/tenants/${encodeURIComponent(selected.tenantId)}${suffix}`
    : `/dashboard${suffix}`;
  return apiUrl(path, params);
}

export default function UsagePage() {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const [days, setDays] = useState<number>(DEFAULT_USAGE_PERIOD);
  const [usage, setUsage] = useState<Usage | undefined>(undefined);
  const [billing, setBilling] = useState<Billing | undefined>(undefined);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    setUsage(undefined);
    void loadUsage(() =>
      fetch(tenantScopedUrl(selected, "/usage", usageParams(days)), {
        credentials: "include",
        cache: "no-store",
      }),
    ).then((next) => {
      if (isCurrentTenant(requestTenantId)) setUsage(next);
    });
  }, [selected, days, requestVersion, isCurrentTenant]);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    setBilling(undefined);
    void loadBilling(() =>
      fetch(tenantScopedUrl(selected, "/billing"), { credentials: "include", cache: "no-store" }),
    ).then((next) => {
      if (isCurrentTenant(requestTenantId)) setBilling(next);
    });
  }, [selected, requestVersion, isCurrentTenant]);

  const readyUsage = usage?.status === "ok" ? usage : null;
  const unavailable = usage?.status === "unavailable";

  return (
    <div className="usage-v2">
      {unavailable ? (
        <div className="usage-alert" role="status">
          <span>Usage data is temporarily unavailable. Your records have not been changed.</span>
          <button type="button" onClick={() => setRequestVersion((version) => version + 1)}>Retry</button>
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

      <UsageOverview usage={readyUsage} billing={billing} loading={usage === undefined} days={days} />

      <section className="usage-breakdown">
        <div className="usage-breakdown__tabs" role="tablist" aria-label="Usage breakdown">
          <button type="button" className="usage-breakdown__tab usage-breakdown__tab--active" role="tab" aria-selected="true">
            Review usage
          </button>
          <Link href="/billing" className="usage-breakdown__tab" role="tab" aria-selected="false">
            Billing and limits
          </Link>
        </div>
        <div className="usage-capabilities">
          <CapabilityCard
            title="Model usage"
            primary={formatCredits(readyUsage?.totals.ai_credits ?? 0)}
            primaryLabel="AI credits"
            secondary={creditsToUsd(readyUsage?.totals.model_cost_usd ? readyUsage.totals.model_cost_usd * 100 : 0)}
            secondaryLabel="estimated model cost"
            values={readyUsage?.daily.map((day) => day.credits) ?? []}
          />
          <CapabilityCard
            title="Review infrastructure"
            primary={formatCredits(readyUsage?.totals.infra_credits ?? 0)}
            primaryLabel="infra credits"
            secondary={String(readyUsage?.totals.runs ?? 0)}
            secondaryLabel="review runs"
            values={readyUsage?.daily.map((day) => day.runs) ?? []}
          />
        </div>
      </section>

      <RecentRuns runs={readyUsage?.recent_runs ?? []} />
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
  days,
}: {
  usage: Usage | null;
  billing: Billing | undefined;
  loading: boolean;
  days: number;
}) {
  const cycle = billing?.status === "ok" ? billing.cycle : null;
  const meter = computeMeter({
    used: usage?.cycle_credits_used ?? usage?.totals.total_credits ?? cycle?.used ?? null,
    granted: cycle?.granted ?? null,
    extra: billing?.status === "ok" ? billing.credits_balance : null,
  });
  const totalCredits = usage?.totals.total_credits ?? 0;

  return (
    <section className="usage-overview">
      <div className="usage-chart-panel">
        <div className="usage-chart-panel__head">
          <div>
            <span>Total usage</span>
            <strong>{loading ? "—" : formatCredits(totalCredits)}</strong>
            <small>{loading ? "Loading activity…" : `${creditsToUsd(totalCredits)} · last ${days} days`}</small>
          </div>
          <span className="usage-chart-panel__group">Grouped daily</span>
        </div>
        <UsageTrend values={usage?.daily.map((day) => day.credits) ?? []} days={days} />
      </div>

      <aside className="usage-side-rail" aria-label="Usage summary">
        <SummaryMetric label="Credits" value={formatCredits(totalCredits)} detail={`${formatCredits(meter.remaining)} remaining`}>
          <div className="usage-rail-progress" role="progressbar" aria-valuenow={Math.round(meter.usedPct)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${meter.hasIncluded ? meter.usedPct : 0}%` }} />
          </div>
        </SummaryMetric>
        <SummaryMetric
          label="Review runs"
          value={String(usage?.totals.runs ?? 0)}
          detail={`${usage?.totals.completed_runs ?? 0} completed`}
        />
        <SummaryMetric
          label="Key sources"
          value={String((usage?.totals.byok_runs ?? 0) + (usage?.totals.harness_runs ?? 0))}
          detail={`${usage?.totals.byok_runs ?? 0} BYOK · ${usage?.totals.harness_runs ?? 0} Codex`}
        />
      </aside>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  children,
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

function UsageTrend({ values, days }: { values: number[]; days: number }) {
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
      {!hasData ? <span className="usage-trend__empty">No usage recorded in this period.</span> : null}
      <div className="usage-trend__labels"><span>{days} days ago</span><span>Today</span></div>
    </div>
  );
}

function CapabilityCard({
  title,
  primary,
  primaryLabel,
  secondary,
  secondaryLabel,
  values,
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
        <span>›</span>
      </div>
      <div className="usage-capability-card__legend">
        <span><i /> {primary} {primaryLabel}</span>
        <span><i /> {secondary} {secondaryLabel}</span>
      </div>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="21" x2="100" y2="21" />
        <polyline points={points} />
      </svg>
      <div className="usage-capability-card__labels"><span>Start</span><span>Today</span></div>
    </article>
  );
}

function RecentRuns({ runs }: { runs: UsageRecentRun[] }) {
  return (
    <section className="usage-recent">
      <div className="usage-recent__head">
        <div><h2>Recent reviews</h2><p>Latest credit-bearing activity in this period.</p></div>
        {runs.length > 0 ? <span>{runs.length}</span> : null}
      </div>
      {runs.length === 0 ? (
        <div className="usage-recent__empty">There is no review usage for this period and workspace.</div>
      ) : (
        <div className="usage-recent__table">
          <div className="usage-recent__row usage-recent__row--head">
            <span>Repository</span><span>Status</span><span>Source</span><span>Credits</span><span>Date</span>
          </div>
          {runs.map((run, index) => <RunRow key={run.review_run_id ?? `run-${index}`} run={run} />)}
        </div>
      )}
    </section>
  );
}

function RunRow({ run }: { run: UsageRecentRun }) {
  const credits = (run.infra_credits ?? 0) + (run.ai_credits ?? 0);
  const repo = run.repo_full_name
    ? `${run.repo_full_name}${run.pr_number !== null ? ` #${run.pr_number}` : ""}`
    : "—";
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
