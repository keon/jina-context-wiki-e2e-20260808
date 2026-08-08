/**
 * Pure helpers for the billing page. The billing API reports a `status`:
 *   - "ok"            -> balances/plan are live.
 *   - "unavailable"   -> Autumn/upstream is down; account IS billed, balances are
 *                        temporarily unreadable (show a "temporarily unavailable" panel).
 *   - "not_configured"-> no plan attached yet.
 * Any malformed/absent payload or fetch failure is
 * treated as "not configured" rather than a broken page.
 *
 * The overview payload also carries several optional sub-objects the rebuilt page
 * relies on (members, cycle, limits, billing_activity). Every one is parsed
 * defensively — a missing/malformed sub-object degrades to an empty default so a
 * partial API response never blanks the page.
 */

// $1 = 100 Jina Credits (see docs/BILLING.md "Credit math").
const CREDITS_PER_USD = 100;

type BillingStatus = "ok" | "unavailable" | "not_configured";

/** Member counts for the org: total seats, and how many run their own harness. */
interface BillingMembers {
  total: number | null;
  with_harness: number | null;
}

/** The current billing cycle's included-credit accounting. */
interface BillingCycle {
  granted: number | null;
  remaining: number | null;
  used: number | null;
  next_reset_at: string | null;
}

/** The auto-review spend cap. `enabled: false` means automatic reviews never pause on spend. */
export interface BillingLimits {
  enabled: boolean;
  limit_credits: number | null;
}

/** One row of the billing-activity feed (a Stripe invoice / charge). */
interface BillingActivity {
  date: string | null;
  amount: number | null;
  status: string | null;
  url: string | null;
}

export interface Billing {
  status: BillingStatus;
  plan_id: string | null;
  credits_balance: number | null;
  managed_ai_access: boolean | null;
  members: BillingMembers;
  cycle: BillingCycle;
  limits: BillingLimits;
  billing_activity: BillingActivity[];
}

/** The selectable plans, in display order. Prices/credits mirror the API's plan catalog. */
export const BILLING_PLANS: { id: "startup" | "growth"; name: string; price_usd: number; credits: number }[] = [
  { id: "startup", name: "Startup", price_usd: 100, credits: 10_000 },
  { id: "growth", name: "Growth", price_usd: 500, credits: 50_000 },
];

const EMPTY_MEMBERS: BillingMembers = { total: null, with_harness: null };
const EMPTY_CYCLE: BillingCycle = { granted: null, remaining: null, used: null, next_reset_at: null };
const EMPTY_LIMITS: BillingLimits = { enabled: false, limit_credits: null };

export const NOT_CONFIGURED: Billing = {
  status: "not_configured",
  plan_id: null,
  credits_balance: null,
  managed_ai_access: null,
  members: EMPTY_MEMBERS,
  cycle: EMPTY_CYCLE,
  limits: EMPTY_LIMITS,
  billing_activity: [],
};

export const UNAVAILABLE: Billing = {
  status: "unavailable",
  plan_id: null,
  credits_balance: null,
  managed_ai_access: null,
  members: EMPTY_MEMBERS,
  cycle: EMPTY_CYCLE,
  limits: EMPTY_LIMITS,
  billing_activity: [],
};

/** A finite number, else null. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Human name for a plan id ("startup" -> "Startup"), falling back to the raw id. */
export function planName(planId: string | null): string | null {
  if (!planId) return null;
  const match = BILLING_PLANS.find((plan) => plan.id === planId);
  return match ? match.name : planId;
}

function normalizeMembers(raw: unknown): BillingMembers {
  const record = asRecord(raw);
  return { total: numberOrNull(record.total), with_harness: numberOrNull(record.with_harness) };
}

function normalizeCycle(raw: unknown): BillingCycle {
  const record = asRecord(raw);
  return {
    granted: numberOrNull(record.granted),
    remaining: numberOrNull(record.remaining),
    used: numberOrNull(record.used),
    next_reset_at: stringOrNull(record.next_reset_at),
  };
}

/** Coerce a raw limits payload into a well-formed BillingLimits (missing -> disabled/no cap). */
export function normalizeLimits(raw: unknown): BillingLimits {
  const record = asRecord(raw);
  return {
    enabled: record.enabled === true,
    limit_credits: numberOrNull(record.limit_credits),
  };
}

function normalizeActivity(raw: unknown): BillingActivity[] {
  if (!Array.isArray(raw)) return [];
  const rows: BillingActivity[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    rows.push({
      date: stringOrNull(record.date),
      amount: numberOrNull(record.amount),
      status: stringOrNull(record.status),
      url: stringOrNull(record.url),
    });
  }
  return rows;
}

/**
 * Coerce an arbitrary payload into a Billing shape.
 *   - status "ok"          -> parse plan/balance/sub-object fields.
 *   - status "unavailable" -> temporarily-unavailable state (no live balances).
 *   - anything else (status "not_configured", an unknown status, or a malformed value)
 *     -> not configured.
 */
export function normalizeBilling(raw: unknown): Billing {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NOT_CONFIGURED;
  }
  const record = raw as Record<string, unknown>;
  if (record.status === "unavailable") {
    return UNAVAILABLE;
  }
  if (record.status !== "ok") {
    return NOT_CONFIGURED;
  }
  return {
    status: "ok",
    plan_id: typeof record.plan_id === "string" ? record.plan_id : null,
    credits_balance: numberOrNull(record.credits_balance),
    managed_ai_access: typeof record.managed_ai_access === "boolean" ? record.managed_ai_access : null,
    members: normalizeMembers(record.members),
    cycle: normalizeCycle(record.cycle),
    limits: normalizeLimits(record.limits),
    billing_activity: normalizeActivity(record.billing_activity),
  };
}

/**
 * Resolve the billing page's state from a fetch of the billing endpoint.
 *
 * The API signals "no plan attached" with a 200 response whose body is
 * `status: "not_configured"`, so a *transport* failure must NOT be read as
 * "not configured": a network error, a non-OK HTTP status (e.g. a 5xx), or a
 * body that fails to parse all mean billing is temporarily unreadable while the
 * account is still billed -> UNAVAILABLE. Only a well-formed 200 payload is
 * handed to normalizeBilling, which then decides ok/unavailable/not_configured.
 *
 * `doFetch` is injected so callers supply the fully-formed request (and so this
 * logic stays unit-testable without a browser). It is invoked inside the
 * try/catch, so a throw from building the request also maps to UNAVAILABLE.
 */
export async function loadBilling(doFetch: () => Promise<Response>): Promise<Billing> {
  let response: Response;
  try {
    response = await doFetch();
  } catch {
    return UNAVAILABLE;
  }
  if (!response.ok) {
    return UNAVAILABLE;
  }
  try {
    return normalizeBilling(await response.json());
  } catch {
    return UNAVAILABLE;
  }
}

/** Whole-number credit balance with thousands separators (e.g. 12,500). */
export function formatCredits(credits: number | null): string {
  if (credits === null || !Number.isFinite(credits)) {
    return "—";
  }
  return Math.round(credits).toLocaleString("en-US");
}

/** Dollar-equivalent of a credit balance at $1 = 100 credits (e.g. $125.00). */
export function creditsToUsd(credits: number | null): string {
  if (credits === null || !Number.isFinite(credits)) {
    return "—";
  }
  const dollars = credits / CREDITS_PER_USD;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Preset top-up amounts (in USD) offered by the "Add balance" picker; $1 = 100 credits. */
export const TOPUP_PRESETS_USD = [10, 25, 50, 100, 250] as const;
/** Bounds on a custom top-up amount (USD), mirroring the API's MIN/MAX_TOPUP_CREDITS ($5..$10,000). */
export const MIN_TOPUP_USD = 5;
export const MAX_TOPUP_USD = 10_000;

/**
 * Turn a chosen dollar amount into the credit quantity to POST, or null if it isn't a usable amount
 * (non-finite, non-positive) so the caller can keep the button disabled. Clamps to the allowed USD range
 * and converts at $1 = 100 credits. Pure + exported for unit tests.
 */
export function topupCreditsForUsd(usd: number): number | null {
  if (!Number.isFinite(usd) || usd <= 0) {
    return null;
  }
  const clamped = Math.min(Math.max(usd, MIN_TOPUP_USD), MAX_TOPUP_USD);
  return Math.round(clamped * CREDITS_PER_USD);
}

/** Format a raw USD amount (e.g. a Stripe invoice total) as "$X.XX"; null -> "—". */
export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) {
    return "—";
  }
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
