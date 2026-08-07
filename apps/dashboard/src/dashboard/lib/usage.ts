/**
 * Pure helpers for the usage page, kept DOM-free so the meter math, period
 * handling, bar scaling, and credit/$ formatting stay unit-testable with
 * `node --test`.
 *
 * Unlike billing, usage is two-state (ok / unavailable). Usage is a fact about
 * what ran rather than a billing feature, so there is no "no plan attached"
 * state to report: the endpoint (GET .../usage?days=N) returns
 * period/totals/daily/recent_runs, and a body carrying totals is the success
 * signal. A transport failure or malformed body is UNAVAILABLE — the account is
 * billed, but usage is momentarily unreadable.
 */

import { creditsToUsd, formatCredits, numberOrNull } from "./billing";

export { creditsToUsd, formatCredits };

type UsageStatus = "ok" | "unavailable";

/** Selectable look-back windows for the period selector. */
export const USAGE_PERIODS = [7, 30, 90] as const;
export const DEFAULT_USAGE_PERIOD = 30;

interface UsageTotals {
  runs: number | null;
  completed_runs: number | null;
  infra_credits: number | null;
  ai_credits: number | null;
  total_credits: number | null;
  model_cost_usd: number | null;
  byok_runs: number | null;
  harness_runs: number | null;
}

interface UsageDaily {
  date: string | null;
  credits: number;
  runs: number;
}

export interface UsageRecentRun {
  review_run_id: string | null;
  repo_full_name: string | null;
  pr_number: number | null;
  status: string | null;
  key_source: string | null;
  rate_mode: string | null;
  infra_credits: number | null;
  ai_credits: number | null;
  // Number of review_runs rolled up into this PR row (a PR reviewed on every push has one per commit).
  review_count: number | null;
  created_at: string | null;
}

export interface Usage {
  status: UsageStatus;
  configured: boolean;
  period: { days: number };
  totals: UsageTotals;
  // Our-data credits consumed this monthly cycle (from review_run_billing), for the meter.
  cycle_credits_used: number | null;
  daily: UsageDaily[];
  recent_runs: UsageRecentRun[];
}

const EMPTY_TOTALS: UsageTotals = {
  runs: null,
  completed_runs: null,
  infra_credits: null,
  ai_credits: null,
  total_credits: null,
  model_cost_usd: null,
  byok_runs: null,
  harness_runs: null,
};

export const USAGE_UNAVAILABLE: Usage = {
  status: "unavailable",
  configured: false,
  period: { days: DEFAULT_USAGE_PERIOD },
  totals: EMPTY_TOTALS,
  cycle_credits_used: null,
  daily: [],
  recent_runs: [],
};

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A finite number floored to a sane, non-negative count (for bar/metric display); else 0. */
function nonNegativeNumber(value: unknown): number {
  const num = numberOrNull(value);
  return num !== null && num >= 0 ? num : 0;
}

/**
 * Clamp an arbitrary requested period to one of the allowed windows. Anything
 * unknown (or non-numeric) falls back to the default so the selector and the
 * request param can never desync onto an unsupported value.
 */
export function normalizeUsagePeriod(raw: unknown): number {
  const num = typeof raw === "string" ? Number(raw) : raw;
  if (typeof num === "number" && Number.isFinite(num)) {
    const match = USAGE_PERIODS.find((period) => period === num);
    if (match) return match;
  }
  return DEFAULT_USAGE_PERIOD;
}

/** Query params for the usage fetch (?days=N), with N normalized to an allowed window. */
export function usageParams(days: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("days", String(normalizeUsagePeriod(days)));
  return params;
}

function normalizeTotals(raw: unknown): UsageTotals {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    runs: numberOrNull(record.runs),
    completed_runs: numberOrNull(record.completed_runs),
    infra_credits: numberOrNull(record.infra_credits),
    ai_credits: numberOrNull(record.ai_credits),
    total_credits: numberOrNull(record.total_credits),
    model_cost_usd: numberOrNull(record.model_cost_usd),
    byok_runs: numberOrNull(record.byok_runs),
    harness_runs: numberOrNull(record.harness_runs),
  };
}

function normalizeDaily(raw: unknown): UsageDaily[] {
  if (!Array.isArray(raw)) return [];
  const rows: UsageDaily[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    rows.push({
      date: stringOrNull(record.date),
      credits: nonNegativeNumber(record.credits),
      runs: nonNegativeNumber(record.runs),
    });
  }
  return rows;
}

function normalizeRecentRuns(raw: unknown): UsageRecentRun[] {
  if (!Array.isArray(raw)) return [];
  const rows: UsageRecentRun[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    rows.push({
      review_run_id: stringOrNull(record.review_run_id),
      repo_full_name: stringOrNull(record.repo_full_name),
      pr_number: numberOrNull(record.pr_number),
      status: stringOrNull(record.status),
      key_source: stringOrNull(record.key_source),
      rate_mode: stringOrNull(record.rate_mode),
      infra_credits: numberOrNull(record.infra_credits),
      ai_credits: numberOrNull(record.ai_credits),
      review_count: numberOrNull(record.review_count),
      created_at: stringOrNull(record.created_at),
    });
  }
  return rows;
}

/**
 * Coerce an arbitrary usage payload into a Usage shape.
 *   - status "unavailable", or a body with no totals object -> unavailable.
 *   - anything else -> ok, parsing period/totals/daily/recent_runs.
 */
export function normalizeUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return USAGE_UNAVAILABLE;
  }
  const record = raw as Record<string, unknown>;
  if (record.status === "unavailable") {
    return USAGE_UNAVAILABLE;
  }
  // PRODUCT RULING + contract fix: usage is a fact about what ran, not a billing
  // feature — it renders even with no plan attached. The API returns the raw
  // summary with NO status field (the original "ok" requirement was a contract
  // mismatch that made every successful response look unconfigured); a body
  // carrying a totals object IS the success signal.
  if (!record.totals || typeof record.totals !== "object") {
    return USAGE_UNAVAILABLE;
  }
  const periodRecord =
    record.period && typeof record.period === "object" && !Array.isArray(record.period)
      ? (record.period as Record<string, unknown>)
      : {};
  return {
    status: "ok",
    configured: true,
    period: { days: normalizeUsagePeriod(periodRecord.days) },
    totals: normalizeTotals(record.totals),
    cycle_credits_used: numberOrNull(record.cycle_credits_used),
    daily: normalizeDaily(record.daily),
    recent_runs: normalizeRecentRuns(record.recent_runs),
  };
}

/**
 * Resolve the usage page's state from a fetch, mirroring loadBilling: a network
 * error, a non-OK status, or an unparseable body all map to UNAVAILABLE; only a
 * well-formed 200 body is routed through normalizeUsage.
 */
export async function loadUsage(doFetch: () => Promise<Response>): Promise<Usage> {
  let response: Response;
  try {
    response = await doFetch();
  } catch {
    return USAGE_UNAVAILABLE;
  }
  if (!response.ok) {
    return USAGE_UNAVAILABLE;
  }
  try {
    return normalizeUsage(await response.json());
  } catch {
    return USAGE_UNAVAILABLE;
  }
}

/**
 * The included-usage meter: how much of the cycle's granted credits have been
 * used, plus the "extra" (purchased/overage) balance shown alongside it.
 *   - usedPct is clamped to 0..100 (used can exceed granted at cycle edges).
 *   - remaining never goes negative.
 *   - `overShoot` flags the case where used > granted (all included credits gone).
 * When `granted` is null/0 there is no included allotment, so usedPct is 0 and
 * hasIncluded is false — the component then leans on the raw counts instead.
 */
export function computeMeter(input: {
  used: number | null;
  granted: number | null;
  extra: number | null;
}): {
  used: number;
  granted: number;
  remaining: number;
  usedPct: number;
  extra: number;
  hasIncluded: boolean;
  overShoot: boolean;
} {
  const used = input.used !== null && input.used >= 0 ? input.used : 0;
  const granted = input.granted !== null && input.granted > 0 ? input.granted : 0;
  const extra = input.extra !== null && input.extra >= 0 ? input.extra : 0;
  const hasIncluded = granted > 0;
  const remaining = Math.max(granted - used, 0);
  const usedPct = hasIncluded ? Math.min(Math.max((used / granted) * 100, 0), 100) : 0;
  return {
    used,
    granted,
    remaining,
    usedPct: Math.round(usedPct * 10) / 10,
    extra,
    hasIncluded,
    overShoot: hasIncluded && used > granted,
  };
}

/**
 * Scale a series of daily values to bar heights (0..100) relative to the series
 * max, for the dependency-free CSS bar chart. A non-zero value never scales below
 * `floor` so a tiny day still shows a visible sliver; an all-zero (or empty)
 * series returns all-zero heights (the chart renders as a flat baseline).
 */
export function scaleBars(values: number[], floor = 4): number[] {
  const max = values.reduce((acc, value) => (value > acc ? value : acc), 0);
  if (max <= 0) {
    return values.map(() => 0);
  }
  return values.map((value) => {
    if (value <= 0) return 0;
    const pct = (value / max) * 100;
    return Math.max(Math.round(pct), floor);
  });
}
