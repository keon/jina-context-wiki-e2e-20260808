/**
 * Pure helpers for the dedicated Models page (per-stage defaults + catalog list).
 * Kept free of React/DOM so they can be unit-tested with `node --test`.
 */

import { filterModels, type CatalogModel } from "./openrouter";

export type ModelConnectionNotice = {
  title: string;
  message: string;
};

/**
 * Current connection health for the selected provider. Historical review or
 * Context failures deliberately do not participate: those belong to the run
 * that failed and would leave a stale Models-page banner after the connection
 * was repaired.
 */
export function modelConnectionNotice(input: {
  provider: "codex" | "byok" | "managed" | undefined;
  providerLoaded: boolean;
  harnessLoaded: boolean;
  harnessConfigured: boolean;
  harnessReconnectRequired: boolean;
  byokLoaded: boolean;
  openrouterConfigured: boolean;
  openaiConfigured: boolean;
}): ModelConnectionNotice | null {
  if (!input.providerLoaded) return null;
  if (input.provider === "codex") {
    if (!input.harnessLoaded) return null;
    if (input.harnessReconnectRequired) {
      return {
        title: "Codex connection needs attention",
        message: "The saved Codex sign-in is no longer valid. Reconnect Codex to resume using it.",
      };
    }
    if (!input.harnessConfigured) {
      return {
        title: "Codex is not connected",
        message: "Connect Codex for pull requests you author, or select another provider.",
      };
    }
  }
  if (input.provider === "byok" && input.byokLoaded && !input.openrouterConfigured && !input.openaiConfigured) {
    return {
      title: "BYOK is not connected",
      message: "Connect an OpenRouter or OpenAI key, or select another provider.",
    };
  }
  return null;
}

/**
 * Lowercased provider prefix of a model slug — the segment before the first
 * "/". Used to key the small inline provider icons. Returns "" when the slug
 * carries no prefix.
 */
export function providerFromSlug(slug: string | null | undefined): string {
  if (typeof slug !== "string") return "";
  const trimmed = slug.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return "";
  return trimmed.slice(0, slash).toLowerCase();
}

/**
 * Short, human display name for a catalog model. Catalog names are typically
 * "Provider: Model" (e.g. "OpenAI: GPT-5.5"); we keep only the part after the
 * first ": ". Falls back to the id when the name is missing/blank.
 */
export function shortModelName(model: CatalogModel): string {
  const name = typeof model.name === "string" ? model.name.trim() : "";
  if (name.length === 0) return model.id;
  const sep = name.indexOf(": ");
  if (sep >= 0) {
    const tail = name.slice(sep + 2).trim();
    if (tail.length > 0) return tail;
  }
  return name;
}

/**
 * Text for the compact dropdown pill: the platform-default label for a null
 * slug, otherwise the short name of the matching catalog model, or the raw
 * slug when the catalog doesn't (yet) know it.
 */
export function pillLabel(slug: string | null, catalog: CatalogModel[] | null | undefined): string {
  if (!slug) return "Select model";
  const match = catalog?.find((model) => model.id === slug);
  return match ? shortModelName(match) : slug;
}

/**
 * Glue for the "Available models" list: filter by query, then cap to `limit`
 * rows while reporting how many further matches were hidden so the UI can show
 * a "N more — refine your search" line.
 */
export function truncateCatalog(
  models: CatalogModel[],
  query: string,
  limit = 50,
): { visible: CatalogModel[]; remaining: number } {
  const all = filterModels(models, query, Number.MAX_SAFE_INTEGER);
  const visible = all.slice(0, limit);
  return { visible, remaining: Math.max(0, all.length - visible.length) };
}

export type CatalogPage = {
  visible: CatalogModel[];
  page: number;
  totalPages: number;
  totalMatches: number;
};

/** Filter the model catalog, then return one clamped, one-based page. */
export function paginateCatalog(
  models: CatalogModel[],
  query: string,
  requestedPage: number,
  pageSize = 20,
): CatalogPage {
  const all = filterModels(models, query, Number.MAX_SAFE_INTEGER);
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20;
  const totalPages = all.length === 0 ? 0 : Math.ceil(all.length / safePageSize);
  const normalizedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = totalPages === 0 ? 1 : Math.min(Math.max(normalizedPage, 1), totalPages);
  const start = (page - 1) * safePageSize;
  return {
    visible: all.slice(start, start + safePageSize),
    page,
    totalPages,
    totalMatches: all.length,
  };
}

/* ============================================================ *
 *  Pricing + context-length display formatting                 *
 * ============================================================ */

/**
 * Format a per-1M-token price for display. The API delivers prices as STRINGS
 * (e.g. "10", "10.000000", "0.150000"); we never parse them to floats for math,
 * only reshape the digits for the eye:
 *
 * - Accepts a plain decimal (optionally already "$"-prefixed); anything else
 *   (blank, null, non-numeric) yields null so callers can omit it.
 * - Trailing zeros beyond two decimals are trimmed, but at least two decimals
 *   are always shown: "10" → "$10.00", "0.150000" → "$0.15", "0.123456" →
 *   "$0.123456".
 */
export function formatPer1mPrice(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const match = /^\s*\$?\s*(\d+)(?:\.(\d+))?\s*$/.exec(raw);
  if (!match) return null;
  const intPart = match[1];
  let frac = (match[2] ?? "").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `$${intPart}.${frac}`;
}

/**
 * Format a context-length token count in compact "400K" / "1M" style. Rounds to
 * one decimal and trims a trailing ".0" (400000 → "400K", 1000000 → "1M",
 * 128000 → "128K"). Non-positive / non-finite / missing values yield null.
 */
export function formatContextLength(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const compact = (n: number, suffix: string) => {
    const rounded = Math.round(n * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${text}${suffix}`;
  };
  if (value >= 1_000_000) return compact(value / 1_000_000, "M");
  if (value >= 1_000) return compact(value / 1_000, "K");
  return String(Math.round(value));
}

/**
 * Inline "$in / $out per 1M" price label for a catalog row. Returns null when a
 * model carries no usable pricing at all; a missing side is shown as "—".
 */
export function modelPriceLabel(model: CatalogModel): string | null {
  const input = formatPer1mPrice(model.pricing?.prompt_per_1m);
  const output = formatPer1mPrice(model.pricing?.completion_per_1m);
  if (!input && !output) return null;
  return `${input ?? "—"} / ${output ?? "—"} per 1M`;
}

/* ============================================================ *
 *  Concrete per-stage runtime defaults                         *
 * ============================================================ */

/** True platform-default slugs per review stage, as returned by the API. */
export type StageDefaults = {
  planner: string | null;
  investigation: string | null;
  review: string | null;
  context: string | null;
};

/** Concrete code fallbacks used by the review runtime when an API build does
 * not return its environment-derived defaults. The picker must always name the
 * model that will run; a vague product label is not a model configuration. */
export const FALLBACK_STAGE_DEFAULTS: Readonly<Record<keyof StageDefaults, string>> = {
  planner: "openai/gpt-5.6-sol",
  investigation: "openai/gpt-5.6-luna",
  review: "openai/gpt-5.6-luna",
  context: "openai/gpt-5.6-terra",
};

/**
 * Coerce the API's `defaults` object into StageDefaults, or null when it's
 * absent/empty (old API builds) so the UI can fall back to the runtime's
 * concrete code defaults.
 */
export function normalizeStageDefaults(raw: unknown): StageDefaults | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const pick = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  const planner = pick(record.planner);
  const investigation = pick(record.investigation);
  const review = pick(record.review);
  const context = pick(record.context);
  if (planner === null && investigation === null && review === null && context === null) return null;
  return { planner, investigation, review, context };
}

/* ============================================================ *
 *  Hover-card placement                                        *
 * ============================================================ */

/**
 * Whether the pricing hover-card should flip to the LEFT of the popover instead
 * of its default placement on the right. It flips when a right-side card of
 * `cardWidth` (plus a `gap`) would overflow the viewport's right edge.
 */
export function shouldFlipHoverCard(
  anchorRight: number,
  cardWidth: number,
  viewportWidth: number,
  gap = 12,
): boolean {
  return anchorRight + gap + cardWidth > viewportWidth;
}
