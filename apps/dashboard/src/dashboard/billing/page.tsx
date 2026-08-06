"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiUrl, safeHref } from "../lib/api";
import { Badge, EmptyState, PanelCount } from "../components/ui";
import { formatDate } from "../lib/presentation";
import {
  BILLING_PLANS,
  creditsToUsd,
  formatCredits,
  formatUsd,
  loadBilling,
  planName,
  TOPUP_PRESETS_USD,
  topupCreditsForUsd,
  MIN_TOPUP_USD,
  MAX_TOPUP_USD,
  type Billing,
} from "../lib/billing";
import { CONFIG_STALE_TIME_MS } from "../lib/query-client";
import { tenantQueryKey } from "../lib/query-keys";
import { useTenant, useTenantFence, useTenantQueryScope } from "../providers";
import { isTenantWritable, type SelectedTenant } from "../lib/tenants";

/** Billing endpoints for the active tenant, or the legacy viewer-scoped routes. */
function billingUrl(selected: SelectedTenant | null, suffix = ""): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/billing${suffix}`)
    : apiUrl(`/dashboard/billing${suffix}`);
}

export default function BillingPage() {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const scope = useTenantQueryScope();
  const isOrg = selected?.type === "Organization";
  const writable = isTenantWritable(selected);

  // Keyed by tenant (each has its own balance), so a switch reads a different
  // entry rather than blanking this one. A network error / non-OK response maps
  // to UNAVAILABLE (not "not configured"); the API signals unconfigured with a
  // 200 body of status:"not_configured", so this never rejects and never retries.
  const { data: billing, refetch } = useQuery<Billing>({
    queryKey: tenantQueryKey("billing", scope),
    queryFn: () => loadBilling(() => fetch(billingUrl(selected), { credentials: "include" })),
    staleTime: CONFIG_STALE_TIME_MS,
    retry: false,
  });
  const reload = useCallback(() => void refetch(), [refetch]);

  // undefined = loading; otherwise a normalized Billing (not_configured on any failure/absence).
  if (billing === undefined) {
    return (
      <BillingFrame selected={selected}>
        <BillingState title="Loading billing" detail="Checking your plan, balances, and spending controls." />
      </BillingFrame>
    );
  }

  if (billing.status === "not_configured") {
    return (
      <BillingFrame selected={selected}>
        <BillingState
          title="Billing is not configured"
          detail="Contact Jina to activate billing for this workspace. Nothing has been charged."
        />
      </BillingFrame>
    );
  }

  if (billing.status === "unavailable") {
    return (
      <BillingFrame selected={selected}>
        <BillingState
          title="Billing is temporarily unavailable"
          detail="Your plan and balances have not changed. Retry when the billing service is reachable."
          action={<button type="button" className="btn btn--sm" onClick={reload}>Retry</button>}
        />
      </BillingFrame>
    );
  }

  return (
    <BillingFrame selected={selected}>
      <PlanHero billing={billing} selected={selected} writable={writable} isCurrentTenant={isCurrentTenant} />
      <BillingDetails billing={billing} selected={selected} isOrg={isOrg} />
      <AutoReviewLimit
        billing={billing}
        selected={selected}
        writable={writable}
        isCurrentTenant={isCurrentTenant}
        onSaved={reload}
      />
      <AutoReload selected={selected} writable={writable} isCurrentTenant={isCurrentTenant} />
      <BillingActivity billing={billing} />
    </BillingFrame>
  );
}

function BillingFrame({ selected, children }: { selected: SelectedTenant | null; children: ReactNode }) {
  return (
    <div className="billing-v2">
      <header className="route-intro">
        <div>
          <h1>Billing</h1>
          <p>Manage your plan, credit balance, and automatic review spending.</p>
        </div>
        {selected ? <span className="route-intro__scope">{selected.login}</span> : null}
      </header>
      <nav className="billing-v2__tabs" aria-label="Usage and billing">
        <Link href="/usage">Review usage</Link>
        <span aria-current="page">Billing and limits</span>
      </nav>
      {children}
    </div>
  );
}

function BillingState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <section className="billing-v2__state" role="status">
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {action}
    </section>
  );
}

/* -------------------------------------------------------------- Plan hero --- */

function PlanHero({
  billing,
  selected,
  writable,
  isCurrentTenant,
}: {
  billing: Billing;
  selected: SelectedTenant | null;
  writable: boolean;
  isCurrentTenant: (requestTenantId: string | null) => boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentPlan = planName(billing.plan_id);

  const subscribe = async (planId: "startup" | "growth") => {
    // Capture the tenant this checkout is for; drop the redirect if the viewer switched tenants
    // before it resolved so tenant A's checkout never lands under tenant B.
    const requestTenantId = selected?.tenantId ?? null;
    setBusyPlan(planId);
    setError(null);
    try {
      const response = await fetch(billingUrl(selected, "/subscribe"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      if (response.status === 403) throw new Error("Organization admins manage plans for this account.");
      if (!response.ok) throw new Error(`Could not start checkout (${response.status})`);
      const data = (await response.json()) as { url?: string };
      if (!data.url) throw new Error("Checkout returned no URL");
      if (!isCurrentTenant(requestTenantId)) {
        setBusyPlan(null);
        return;
      }
      window.location.href = data.url;
    } catch (subscribeError) {
      setBusyPlan(null);
      if (!isCurrentTenant(requestTenantId)) return;
      setError(subscribeError instanceof Error ? subscribeError.message : "Could not start checkout");
    }
  };

  return (
    <section className="billing-v2__plan">
      <div className="billing-v2__plan-head">
        <div className="plan-hero__lead">
          <span className="plan-hero__kicker">Current plan</span>
          {currentPlan ? (
            <span className="plan-hero__name">
              {currentPlan}
              <Badge tone="info">Active</Badge>
            </span>
          ) : (
            <span className="plan-hero__name">
              No active plan
              <Badge>No plan</Badge>
            </span>
          )}
          <p className="plan-hero__sub">
            {currentPlan
              ? "Included credits refresh each billing cycle."
              : "Choose a plan to unlock included credits each cycle."}
          </p>
        </div>
        {writable ? (
          <button type="button" className="btn btn--sm" onClick={() => setChoosing((prev) => !prev)}>
            {choosing ? "Cancel" : currentPlan ? "Change plan" : "Choose a plan"}
          </button>
        ) : null}
      </div>

      {!writable ? (
        <p className="tenant-gate-note">Managed by org admins.</p>
      ) : choosing ? (
        <div className="billing-v2__plans">
          {BILLING_PLANS.map((plan) => {
            const isCurrent = billing.plan_id === plan.id;
            return (
              <div className={`billing-v2__plan-option${isCurrent ? " billing-v2__plan-option--current" : ""}`} key={plan.id}>
                <div className="plan-card__head">
                  <span className="plan-card__name">{plan.name}</span>
                  {isCurrent ? <Badge tone="ok">Current</Badge> : null}
                </div>
                <div className="plan-card__price">
                  ${plan.price_usd}
                  <span className="plan-card__per">/mo</span>
                </div>
                <div className="plan-card__credits">{formatCredits(plan.credits)} credits included</div>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void subscribe(plan.id)}
                  disabled={busyPlan !== null || isCurrent}
                >
                  {isCurrent ? "Current plan" : busyPlan === plan.id ? "Redirecting…" : `Subscribe to ${plan.name}`}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {error ? <p className="error-text plan-hero__error">{error}</p> : null}
    </section>
  );
}

/* ---------------------------------------------------------- Billing details --- */

function BillingDetails({
  billing,
  selected,
  isOrg,
}: {
  billing: Billing;
  selected: SelectedTenant | null;
  isOrg: boolean;
}) {
  const { cycle, members } = billing;
  // Cycle accounting supersedes the flat balance where present.
  const includedValue =
    cycle.remaining !== null && cycle.granted !== null
      ? `${formatCredits(cycle.remaining)} / ${formatCredits(cycle.granted)}`
      : "—";

  return (
    <section className="billing-v2__section">
      <div className="billing-v2__section-head">
        <div>
          <h2>Balance</h2>
          <p>Credits available to this workspace.</p>
        </div>
        {selected ? (
          <span className="cell-meta">
            Account: {selected.login} · {selected.type === "Organization" ? "Organization" : "Personal"}
          </span>
        ) : null}
      </div>
      <div className="billing-v2__metrics">
        <div className="billing-v2__metric">
          <span className="metric__label">Included credits left</span>
          <span className="metric__value">{includedValue}</span>
          {cycle.next_reset_at ? (
            <span className="metric__sub">Resets {formatDate(cycle.next_reset_at)}</span>
          ) : (
            <span className="metric__sub">this cycle</span>
          )}
        </div>
        <div className="billing-v2__metric">
          <span className="metric__label">Extra balance</span>
          <span className="metric__value">{formatCredits(billing.credits_balance)}</span>
          <span className="metric__sub">{creditsToUsd(billing.credits_balance)} at $1 = 100 credits</span>
        </div>
        {isOrg ? (
          <div className="billing-v2__metric">
            <span className="metric__label">Members</span>
            <span className="metric__value">
              {members.total ?? "—"}
              {members.with_harness !== null ? (
                <span className="metric__sub">· {members.with_harness} with own harness</span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      {isOrg ? (
        <p className="billing-v2__note">
          Balances shown are for {selected?.login}.
        </p>
      ) : (
        <p className="billing-v2__note">Personal account.</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------- Auto-review limit --- */

/** Parse a credits input string into a non-negative integer, or null (no cap / empty). */
function parseCreditsInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

function AutoReviewLimit({
  billing,
  selected,
  writable,
  isCurrentTenant,
  onSaved,
}: {
  billing: Billing;
  selected: SelectedTenant | null;
  writable: boolean;
  isCurrentTenant: (requestTenantId: string | null) => boolean;
  onSaved: () => void;
}) {
  const { limits, cycle } = billing;
  const [enabled, setEnabled] = useState(limits.enabled);
  const [draft, setDraft] = useState(limits.limit_credits !== null ? String(limits.limit_credits) : "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "saved" } | { kind: "error"; message: string } | null>(null);

  // Re-sync local controls when the persisted limits change (tenant switch, reload after save).
  useEffect(() => {
    setEnabled(limits.enabled);
    setDraft(limits.limit_credits !== null ? String(limits.limit_credits) : "");
    setStatus(null);
  }, [limits.enabled, limits.limit_credits]);

  const parsed = parseCreditsInput(draft);
  const dirty = enabled !== limits.enabled || parsed !== limits.limit_credits;

  const save = async () => {
    const requestTenantId = selected?.tenantId ?? null;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(billingUrl(selected, "/limits"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, limit_credits: enabled ? parsed : null }),
      });
      if (response.status === 403) throw new Error("Organization admins manage this setting.");
      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Invalid limit");
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      if (!isCurrentTenant(requestTenantId)) return;
      setStatus({ kind: "saved" });
      onSaved();
    } catch (saveError) {
      if (!isCurrentTenant(requestTenantId)) return;
      setStatus({ kind: "error", message: saveError instanceof Error ? saveError.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  };

  const limitForDisplay = enabled ? parsed : limits.enabled ? limits.limit_credits : null;
  const usedLabel =
    cycle.used !== null && limitForDisplay !== null
      ? `Used ${formatCredits(cycle.used)} of ${formatCredits(limitForDisplay)} credits this cycle`
      : cycle.used !== null
        ? `Used ${formatCredits(cycle.used)} credits this cycle`
        : null;

  return (
    <section className="billing-v2__section">
      <div className="billing-v2__section-head">
        <div>
          <h2>Auto-review limit</h2>
          <p>Pause automatic reviews after a credit threshold. Manual reviews are unaffected.</p>
        </div>
      </div>
      <div className="billing-v2__setting">
        {!writable ? (
          <p className="tenant-gate-note">Managed by org admins.</p>
        ) : null}

        <label className="toggle-row">
          <input
            type="checkbox"
            className="toggle-row__input"
            checked={enabled}
            disabled={!writable || busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span className="toggle-row__label">Pause automatic reviews at a spend limit</span>
        </label>

        {enabled ? (
          <label className="form-field limit-field">
            <span className="form-field__label">Limit (credits)</span>
            <div className="limit-field__control">
              <input
                className="input limit-field__input"
                type="number"
                min="0"
                step="100"
                inputMode="numeric"
                placeholder="e.g. 10000"
                value={draft}
                disabled={!writable || busy}
                onChange={(event) => setDraft(event.target.value)}
              />
              <span className="limit-field__usd">{parsed !== null ? `${creditsToUsd(parsed)} equivalent` : "No cap set"}</span>
            </div>
          </label>
        ) : null}

        {usedLabel ? <p className="cell-meta">{usedLabel}</p> : null}

        <div className="billing-v2__actions">
          <span className={status?.kind === "error" ? "error-text" : "cell-meta"}>
            {status?.kind === "error" ? status.message : status?.kind === "saved" ? "Saved" : ""}
          </span>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={!writable || busy || !dirty}
          >
            {busy ? "Saving…" : "Save limit"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Auto-reload --- */

function AutoReload({
  selected,
  writable,
  isCurrentTenant,
}: {
  selected: SelectedTenant | null;
  writable: boolean;
  isCurrentTenant: (requestTenantId: string | null) => boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // "10" | "25" | … | "custom" — the selected preset, or custom mode. Default to the $100 pack.
  const [choice, setChoice] = useState<string>("100");
  const [customUsd, setCustomUsd] = useState<string>("");

  // The dollar amount the user picked: the preset, or the parsed custom field.
  const usd = choice === "custom" ? Number(customUsd) : Number(choice);
  const credits = topupCreditsForUsd(usd);

  const topup = async () => {
    // Manual top-up (overage credits) for the chosen amount. Fenced so a redirect started under tenant A
    // never lands on B. `credits` is null only when the button is disabled, so it is always valid here.
    if (credits === null) return;
    const requestTenantId = selected?.tenantId ?? null;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(billingUrl(selected, "/topup"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credits }),
      });
      if (response.status === 403) throw new Error("Organization admins manage billing for this account.");
      if (response.status === 409) throw new Error("Overage credits aren't available for this account.");
      if (!response.ok) throw new Error(`Could not start checkout (${response.status})`);
      const data = (await response.json()) as { url?: string };
      if (!data.url) throw new Error("Checkout returned no URL");
      if (!isCurrentTenant(requestTenantId)) {
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch (topupError) {
      setBusy(false);
      if (!isCurrentTenant(requestTenantId)) return;
      setMessage(topupError instanceof Error ? topupError.message : "Could not start checkout");
    }
  };

  return (
    <section className="billing-v2__section">
      <div className="billing-v2__section-head">
        <div>
          <h2>Add balance</h2>
          <p>Purchase additional credits for reviews beyond the included plan balance.</p>
        </div>
      </div>
      <div className="billing-v2__setting">
        <div className="topup">
          <label className="form-field topup__amount">
            <span className="form-field__label">Top-up amount</span>
            <select
              className="input"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              disabled={busy || !writable}
            >
              {TOPUP_PRESETS_USD.map((amount) => (
                <option key={amount} value={String(amount)}>
                  ${amount} — {(amount * 100).toLocaleString("en-US")} credits
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>
          {choice === "custom" ? (
            <label className="form-field topup__custom">
              <span className="form-field__label">Custom amount (USD)</span>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min={MIN_TOPUP_USD}
                max={MAX_TOPUP_USD}
                step={1}
                placeholder={`${MIN_TOPUP_USD}–${MAX_TOPUP_USD}`}
                value={customUsd}
                onChange={(event) => setCustomUsd(event.target.value)}
                disabled={busy || !writable}
              />
            </label>
          ) : null}
        </div>

        <div className="billing-v2__actions">
          <span className={message ? "error-text" : "cell-meta"}>
            {message ?? (credits !== null ? `You'll be charged ${creditsToUsd(credits)} for ${formatCredits(credits)} credits.` : "")}
          </span>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void topup()}
            disabled={busy || !writable || credits === null}
          >
            {busy ? "Redirecting…" : "Add balance"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- Billing activity --- */

function BillingActivity({ billing }: { billing: Billing }) {
  const rows = billing.billing_activity;
  return (
    <section className="billing-v2__section">
      <div className="billing-v2__section-head">
        <div>
          <h2>Billing activity</h2>
          <p>Recent invoices and account balance changes.</p>
        </div>
        {rows.length > 0 ? <PanelCount>{rows.length}</PanelCount> : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState compact className="billing-v2__empty">
          No billing activity yet &mdash; Stripe invoices may take up to 24 hours to appear.
        </EmptyState>
      ) : (
        <div className="activity-list">
          {rows.map((row, index) => {
            const href = safeHref(row.url);
            return (
              <div className="activity-row" key={`${row.date ?? "row"}-${index}`}>
                <span className="activity-row__date">{row.date ? formatDate(row.date) : "—"}</span>
                <span className="activity-row__amount">{formatUsd(row.amount)}</span>
                {row.status ? <StatusBadge status={row.status} /> : <span />}
                {href ? (
                  <a className="activity-row__link" href={href} rel="noopener noreferrer">
                    Invoice
                  </a>
                ) : (
                  <span className="activity-row__link activity-row__link--none">—</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const lower = status.toLowerCase();
  const tone = lower.includes("paid") || lower.includes("succe") ? "ok" : lower.includes("fail") ? "bad" : "info";
  return <Badge tone={tone}>{status}</Badge>;
}
