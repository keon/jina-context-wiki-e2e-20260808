"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/api";
import { Badge } from "../components/ui";
import { formatDate } from "../lib/presentation";
import { loadBilling, type Billing } from "../lib/billing";
import {
  computeMeter,
  creditsToUsd,
  formatCredits,
  loadUsage,
  normalizeUsagePeriod,
  scaleBars,
  usageParams,
  USAGE_PERIODS,
  DEFAULT_USAGE_PERIOD,
  type Usage,
  type UsageRecentRun,
} from "../lib/usage";
import { useTenant, useTenantFence } from "../providers";
import { type SelectedTenant } from "../lib/tenants";

function tenantScopedUrl(selected: SelectedTenant | null, suffix: string, params?: URLSearchParams): string {
  const path = selected
    ? `/v1/dashboard/tenants/${encodeURIComponent(selected.tenantId)}${suffix}`
    : `/v1/dashboard${suffix}`;
  return apiUrl(path, params);
}

export default function UsagePage() {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const [days, setDays] = useState<number>(DEFAULT_USAGE_PERIOD);
  // undefined = loading; otherwise a normalized Usage.
  const [usage, setUsage] = useState<Usage | undefined>(undefined);
  // The billing overview supplies the meter's cycle + balance. undefined = loading.
  const [billing, setBilling] = useState<Billing | undefined>(undefined);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    setUsage(undefined);
    loadUsage(() =>
      fetch(tenantScopedUrl(selected, "/usage", usageParams(days)), { credentials: "include", cache: "no-store" }),
    ).then((next) => {
      if (isCurrentTenant(requestTenantId)) setUsage(next);
    });
  }, [selected, days, isCurrentTenant]);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    setBilling(undefined);
    loadBilling(() =>
      fetch(tenantScopedUrl(selected, "/billing"), { credentials: "include", cache: "no-store" }),
    ).then((next) => {
      if (isCurrentTenant(requestTenantId)) setBilling(next);
    });
  }, [selected, isCurrentTenant]);

  if (usage === undefined) {
    return (
      <section className="panel">
        <div className="form">
          <p className="cell-meta">Loading usage…</p>
        </div>
      </section>
    );
  }

  // Usage always renders (product ruling): what ran is a fact independent of any
  // plan — a no-plan account simply shows zeros and an unconstrained meter.
  if (usage.status === "unavailable") {
    return (
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Usage</span>
        </div>
        <div className="notice notice--bad">Usage is temporarily unavailable &mdash; it will reappear shortly.</div>
      </section>
    );
  }

  return (
    <div className="usage-page">
      <MeterCard usage={usage} billing={billing} />
      <SummaryCard usage={usage} days={days} onDaysChange={setDays} />
      <ActivityCard usage={usage} />
    </div>
  );
}

/* -------------------------------------------------------------- Meter card --- */

function MeterCard({
  usage,
  billing,
}: {
  usage: Usage;
  billing: Billing | undefined;
}) {
  const cycle = billing?.status === "ok" ? billing.cycle : null;
  const meter = computeMeter({
    // Consumption comes from OUR tracked data (review_run_billing), not Autumn's
    // ledger; the plan grant (entitlement) still comes from the billing cycle.
    used: usage.cycle_credits_used ?? usage.totals.total_credits ?? cycle?.used ?? null,
    granted: cycle?.granted ?? null,
    extra: billing?.status === "ok" ? billing.credits_balance : null,
  });

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Credits</span>
      </div>
      <div className="meter-grid">
        <div className="meter">
          <div className="meter__head">
            <span className="meter__label">Included usage</span>
            <span className="meter__value">
              {meter.hasIncluded ? (
                <>
                  {formatCredits(meter.used)} <span className="meter__of">of {formatCredits(meter.granted)}</span>
                </>
              ) : (
                "No plan"
              )}
            </span>
          </div>
          <div className="meter__bar" role="progressbar" aria-valuenow={Math.round(meter.usedPct)} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`meter__fill${meter.overShoot ? " meter__fill--full" : ""}`}
              style={{ width: `${meter.hasIncluded ? meter.usedPct : 0}%` }}
            />
          </div>
          <span className="meter__foot">
            {meter.hasIncluded
              ? meter.overShoot
                ? "Included credits used up this cycle"
                : `${formatCredits(meter.remaining)} credits remaining this cycle`
              : "Subscribe to a plan to unlock included credits"}
          </span>
        </div>

        <div className="meter meter--extra">
          <div className="meter__head">
            <span className="meter__label">Extra usage</span>
            <span className="meter__value">{formatCredits(meter.extra)}</span>
          </div>
          <span className="meter__foot">{creditsToUsd(meter.extra)} purchased balance available for overage</span>
        </div>
      </div>

      <div className="meter-actions">
        <Link className="btn btn--sm" href="/billing">
          Subscribe
        </Link>
        {/* Amount selection lives on the billing page's top-up chooser, so "Add balance" links there
            rather than starting a fixed-amount checkout. */}
        <Link className="btn btn--primary btn--sm" href="/billing">
          Add balance
        </Link>
        <Link className="meter-actions__link" href="/billing">
          Manage auto-reload settings
        </Link>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ Summary card --- */

function SummaryCard({
  usage,
  days,
  onDaysChange,
}: {
  usage: Usage;
  days: number;
  onDaysChange: (days: number) => void;
}) {
  const total = usage.totals.total_credits;
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Summary</span>
        <span className="panel__actions">
          <PeriodSelector days={days} onChange={onDaysChange} />
        </span>
      </div>
      <div className="summary-bar">
        <div className="metric">
          <span className="metric__label">Your usage</span>
          <span className="metric__value">
            {formatCredits(total)}
            <span className="metric__sub">credits</span>
          </span>
          <span className="metric__sub">
            {creditsToUsd(total)} over the last {usage.period.days} days
          </span>
        </div>
        <div className="metric">
          <span className="metric__label">Runs</span>
          <span className="metric__value">{usage.totals.runs ?? "—"}</span>
          {usage.totals.completed_runs !== null ? (
            <span className="metric__sub">{usage.totals.completed_runs} completed</span>
          ) : null}
        </div>
        <div className="metric">
          <span className="metric__label">Infra / AI credits</span>
          <span className="metric__value">
            {formatCredits(usage.totals.infra_credits)}
            <span className="metric__sub">/ {formatCredits(usage.totals.ai_credits)}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

function PeriodSelector({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <div className="period-selector" role="group" aria-label="Usage period">
      {USAGE_PERIODS.map((period) => (
        <button
          type="button"
          key={period}
          className={`period-selector__btn${normalizeUsagePeriod(days) === period ? " period-selector__btn--active" : ""}`}
          aria-pressed={normalizeUsagePeriod(days) === period}
          onClick={() => onChange(period)}
        >
          {period}d
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- Activity card --- */

function ActivityCard({ usage }: { usage: Usage }) {
  const heights = useMemo(() => scaleBars(usage.daily.map((day) => day.credits)), [usage.daily]);

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Activity</span>
      </div>

      {usage.daily.length === 0 ? (
        <div className="empty empty--compact">No usage recorded in this period yet.</div>
      ) : (
        <div className="bar-chart" aria-hidden="true">
          {usage.daily.map((day, index) => (
            <div className="bar-chart__col" key={`${day.date ?? "d"}-${index}`}>
              <div className="bar-chart__track">
                <div
                  className="bar-chart__bar"
                  style={{ height: `${heights[index]}%` }}
                  title={`${day.date ? formatDate(day.date) : ""} · ${formatCredits(day.credits)} credits · ${day.runs} runs`}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section__title section__title--row activity__subhead">
        <span>Recent runs</span>
        {usage.recent_runs.length > 0 ? <span className="panel__count">{usage.recent_runs.length}</span> : null}
      </div>
      {usage.recent_runs.length === 0 ? (
        <div className="empty empty--compact">No recent runs in this period.</div>
      ) : (
        <div className="runs-table">
          <div className="runs-table__head">
            <span>Repository</span>
            <span>Status</span>
            <span>Key source</span>
            <span className="runs-table__num">Credits</span>
            <span>Date</span>
          </div>
          {usage.recent_runs.map((run, index) => (
            <RunRow key={run.review_run_id ?? `run-${index}`} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunRow({ run }: { run: UsageRecentRun }) {
  // Credits are summed across all of this PR's review runs (one per commit); the row aggregates per PR.
  const credits = (run.infra_credits ?? 0) + (run.ai_credits ?? 0);
  const reviewCount = run.review_count ?? 1;
  const repoLabel = run.repo_full_name
    ? run.pr_number !== null
      ? `${run.repo_full_name} #${run.pr_number}`
      : run.repo_full_name
    : "—";
  return (
    <div className="runs-table__row">
      <span className="runs-table__repo" title={repoLabel}>
        {repoLabel}
        {reviewCount > 1 ? <span className="runs-table__reviews">{reviewCount} reviews</span> : null}
      </span>
      <span>{run.status ? <Badge tone={statusToneFor(run.status)}>{run.status}</Badge> : "—"}</span>
      <span className="cell-meta">{run.key_source ?? "—"}</span>
      <span className="runs-table__num">{formatCredits(credits)}</span>
      <span className="cell-meta">{run.created_at ? formatDate(run.created_at) : "—"}</span>
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
