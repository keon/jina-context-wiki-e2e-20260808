/**
 * Pure helpers for the OpenRouter integration + per-stage model settings UI.
 * Kept free of React/DOM so they can be unit-tested with `node --test`.
 */

/**
 * Per-1M-token pricing for a catalog model. Both figures arrive as STRINGS from
 * the API (e.g. "0.15", "10.000000") and must be formatted for display rather
 * than parsed to floats for math. Either field may be null when unpriced.
 */
type ModelPricing = {
  prompt_per_1m: string | null;
  completion_per_1m: string | null;
};

/**
 * A model in the platform catalog. `context_length` and `pricing` are optional
 * because they were added by a later API revision (PR #145) — older API builds
 * omit them, so every consumer must degrade gracefully when they're absent.
 */
export type CatalogModel = {
  id: string;
  name: string;
  context_length?: number | null;
  pricing?: ModelPricing | null;
};

export type ModelSettings = {
  planner_model: string | null;
  investigation_model: string | null;
  review_model: string | null;
  context_model: string | null;
  planner_effort: ReasoningEffort | null;
  investigation_effort: ReasoningEffort | null;
  review_effort: ReasoningEffort | null;
  context_effort: ReasoningEffort | null;
  review_fallback_policy: FallbackPolicy;
  context_fallback_policy: FallbackPolicy;
};

export type ReasoningEffort = "low" | "medium" | "high";
export type FallbackPolicy = "fail_notify" | "managed";

export type OpenRouterCallback = "connected" | "error";

/** Read the `?openrouter=connected|error` param the API callback redirects back with. */
export function parseOpenRouterCallbackParam(search: string): OpenRouterCallback | null {
  const value = new URLSearchParams(search).get("openrouter");
  if (value === "connected" || value === "error") {
    return value;
  }
  return null;
}

/** Human label for the stored key source badge; unknown/empty sources render nothing. */
export function openRouterSourceLabel(source: string | null | undefined): string | null {
  if (source === "oauth") return "OAuth";
  if (source === "manual") return "Manual";
  return null;
}

/**
 * Filter-as-you-type over the OpenRouter catalog. Matches the query (case- and
 * whitespace-insensitive) against both the slug and the display name. An empty
 * query returns the whole list; results are capped to keep the dropdown light.
 */
export function filterModels(models: CatalogModel[], query: string, limit = 50): CatalogModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return models.slice(0, limit);
  }
  const matches: CatalogModel[] = [];
  for (const model of models) {
    if (model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)) {
      matches.push(model);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/** Coerce an arbitrary API payload into a well-formed ModelSettings (nulls = platform default). */
export function normalizeModelSettings(raw: unknown): ModelSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    planner_model: slugOrNull(record.planner_model),
    investigation_model: slugOrNull(record.investigation_model),
    review_model: slugOrNull(record.review_model),
    context_model: slugOrNull(record.context_model),
    planner_effort: effortOrNull(record.planner_effort),
    investigation_effort: effortOrNull(record.investigation_effort),
    review_effort: effortOrNull(record.review_effort),
    context_effort: effortOrNull(record.context_effort),
    review_fallback_policy: fallbackPolicy(record.review_fallback_policy),
    context_fallback_policy: fallbackPolicy(record.context_fallback_policy),
  };
}

function effortOrNull(value: unknown): ReasoningEffort | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function fallbackPolicy(value: unknown): FallbackPolicy {
  return value === "managed" ? "managed" : "fail_notify";
}

function slugOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
