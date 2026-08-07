"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
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
  type UsageRecentRun,
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
  const usageQuery = useQuery<Usage>({
    queryKey: tenantQueryKey("usage", scope, days),
    queryFn: () =>
      loadUsage(() => fetch(tenantScopedUrl(selected, "/usage", usageParams(days)), { credentials: "include" })),
    staleTime: CONFIG_STALE_TIME_MS,
    retry: false,
  });
  const billingQuery = useQuery<Billing>({
    queryKey: tenantQueryKey("billing", scope),
    queryFn: () => loadBilling(() => fetch(tenantScopedUrl(selected, "/billing"), { credentials: "include" })),
    staleTime: CONFIG_STALE_TIME_MS,
    retry: false,
  });

  const usage = usageQuery.data;
  const billing = billingQuery.data;
  const readyUsage = usage?.status === "ok" ? usage : null;
  const unavailable = usage?.status === "unavailable";
  const retry = () => {
    void usageQuery.refetch();
    void billingQuery.refetch();
  };

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

      <header className="usage-page__header">
        <h1>Usage</h1>
        <PeriodSelector days={days} onChange={setDays} />
      </header>

      <UsageAccountCard
        usage={readyUsage}
        billing={billing}
        loading={usage === undefined}
        unavailable={unavailable}
      />

      <UsageSummary usage={readyUsage} loading={usage === undefined} unavailable={unavailable} />
      <RecentRuns runs={readyUsage?.recent_runs ?? []} loading={usage === undefined} unavailable={unavailable} days={days} />
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

function UsageAccountCard({
  usage,
  billing,
  loading,
  unavailable,
}: {
  usage: Usage | null;
  billing: Billing | undefined;
  loading: boolean;
  unavailable: boolean;
}) {
  const unknown = loading || unavailable;
  const cycle = billing?.status === "ok" ? billing.cycle : null;
  const totalCredits = usage?.cycle_credits_used ?? usage?.totals.total_credits ?? cycle?.used ?? 0;
  const meter = computeMeter({
    used: unknown ? null : totalCredits,
    granted: cycle?.granted ?? null,
    extra: billing?.status === "ok" ? billing.credits_balance : null,
  });
  const includedCredits = meter.hasIncluded ? Math.min(totalCredits, meter.granted) : 0;
  const extraCredits = Math.max(0, totalCredits - includedCredits);

  return (
    <section className="usage-account-card" aria-label="Usage balance">
      <div className="usage-account-card__topline">
        <div className="usage-account-card__metric">
          <span>Included usage</span>
          <strong>{unknown ? "—" : creditsToUsd(includedCredits)}</strong>
        </div>
        <Link href="/billing" className="btn btn--sm">
          Go to billing
        </Link>
        <div className="usage-account-card__metric usage-account-card__metric--end">
          <span>Extra usage</span>
          <strong>{unknown ? "—" : creditsToUsd(extraCredits)}</strong>
        </div>
      </div>
      <div
        className="usage-account-card__progress"
        role="progressbar"
        aria-label="Included usage consumed"
        aria-valuenow={unknown ? undefined : Math.round(meter.usedPct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${unknown || !meter.hasIncluded ? 0 : meter.usedPct}%` }} />
      </div>
      <div className="usage-account-card__actions">
        <Link href="/billing" className="btn">
          Subscribe
        </Link>
        <Link href="/billing#add-balance" className="btn btn--primary">
          Add balance
        </Link>
      </div>
      <p>
        Want to automatically reload balance when it runs low? <Link href="/billing#add-balance">Manage billing settings</Link>
      </p>
    </section>
  );
}

function UsageSummary({
  usage,
  loading,
  unavailable,
}: {
  usage: Usage | null;
  loading: boolean;
  unavailable: boolean;
}) {
  const unknown = loading || unavailable;
  const totalCredits = usage?.totals.total_credits ?? 0;
  return (
    <section className="usage-summary">
      <h2>Summary</h2>
      <div className="usage-summary__card">
        <span>Charged usage</span>
        <strong>{unknown ? "—" : creditsToUsd(totalCredits)}</strong>
        <small>{unknown ? "Usage has not been measured" : "not charged to customer"}</small>
      </div>
    </section>
  );
}

function RecentRuns({
  runs,
  loading,
  unavailable,
  days,
}: {
  runs: UsageRecentRun[];
  loading: boolean;
  unavailable: boolean;
  days: number;
}) {
  return (
    <section className="usage-activity">
      <h2>Activity</h2>
      <div className="usage-activity__card">
        {loading ? (
          <div className="usage-activity__empty" aria-busy="true">
            Loading activity…
          </div>
        ) : unavailable ? (
          <div className="usage-activity__empty">Activity could not be loaded.</div>
        ) : runs.length === 0 ? (
          <div className="usage-activity__empty">No activity in the last {days} days</div>
        ) : (
          <div className="usage-activity__table">
            <div className="usage-activity__row usage-activity__row--head">
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
      </div>
    </section>
  );
}

function RunRow({ run }: { run: UsageRecentRun }) {
  const credits = (run.infra_credits ?? 0) + (run.ai_credits ?? 0);
  const repo = run.repo_full_name ? `${run.repo_full_name}${run.pr_number !== null ? ` #${run.pr_number}` : ""}` : "—";
  return (
    <div className="usage-activity__row">
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
