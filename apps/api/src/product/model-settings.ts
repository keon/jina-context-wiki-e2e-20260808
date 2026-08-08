import type { Context } from "hono";

import { HARNESS_MODELS } from "./codex-harness.js";
import { multiplyDecimalStringByPowerOfTen } from "./billing-math.js";
import { ApiError } from "./errors.js";
import {
  normalizeFallbackPolicy,
  normalizeReasoningEffort,
  platformModelDefaults,
  type ModelSettings,
} from "./store.js";

/**
 * A catalog model with the per-million-token pricing and context window the dashboard shows. `pricing`
 * fields are decimal STRINGS (USD per 1,000,000 tokens), computed exactly from OpenRouter's per-token
 * price strings (×1,000,000, never float); null when OpenRouter omits the price. context_length is null
 * when absent.
 */
export interface CatalogModel {
  id: string;
  name: string;
  context_length: number | null;
  pricing: { prompt_per_1m: string | null; completion_per_1m: string | null };
  /**
   * Raw OpenRouter PER-TOKEN price strings (verbatim off the wire, never rescaled), retained so the
   * native-OpenAI cost path can price by token: input=prompt, output=completion, cached=cached (or
   * cached_input). null per field when OpenRouter omits it. The dashboard picker ignores this and shows
   * the per-1M `pricing` fields; it exists only to feed openAiModelPricing().
   */
  native_pricing?: { input: string | null; output: string | null; cached: string | null };
}

/**
 * Per-token OpenAI pricing (exact decimal strings) for one `openai/<model>` slug. Mirrors the trigger
 * proxy's OpenaiModelPrice; the API returns a map of these from /internal/integrations/resolve so the
 * capture proxy can compute native-route cost (api.openai.com returns tokens but no cost).
 */
export interface OpenAiModelPrice {
  input_per_token: string;
  output_per_token: string;
  cached_per_token: string;
}

// platformModelDefaults lives in store.ts (the routing coverage decision needs it, and store.ts cannot
// import this module without creating a cycle). Re-exported for existing callers.
export { platformModelDefaults } from "./store.js";

/** Tokens-per-million multiplier: OpenRouter prices are USD per token; the UI shows USD per 1M tokens. */
const PER_MILLION_POWER = 6;

/**
 * Compute a per-1,000,000-token price string from OpenRouter's per-token price string, EXACTLY (×10^6 by
 * shifting the decimal point, never float). null-safe: absent/blank/malformed -> null.
 */
export function pricePerMillion(perToken: unknown): string | null {
  if (typeof perToken !== "string" || perToken.trim().length === 0) {
    return null;
  }
  return multiplyDecimalStringByPowerOfTen(perToken, PER_MILLION_POWER) ?? null;
}

/** Keep a raw per-token OpenRouter price string verbatim (trimmed); null for absent/blank/non-string. */
function perTokenString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const OPENAI_CATALOG_PREFIX = "openai/";

/**
 * Build the native-OpenAI per-token pricing map (keyed by the `openai/<model>` slug) from the OpenRouter
 * catalog's EXACT per-token price strings: prompt→input, completion→output, and cached (or cached_input)
 * →cached, with cached defaulting to input when the catalog omits it. Only `openai/*` ids are included; a
 * model missing an input or output price is skipped (it cannot be priced). The strings are passed through
 * verbatim so downstream BigInt money math stays exact.
 */
export function openAiModelPricing(catalog: CatalogModel[]): Record<string, OpenAiModelPrice> {
  const out: Record<string, OpenAiModelPrice> = {};
  for (const model of catalog) {
    if (!model.id.startsWith(OPENAI_CATALOG_PREFIX)) {
      continue;
    }
    const input = model.native_pricing?.input ?? null;
    const output = model.native_pricing?.output ?? null;
    if (input === null || output === null) {
      continue;
    }
    out[model.id] = {
      input_per_token: input,
      output_per_token: output,
      cached_per_token: model.native_pricing?.cached ?? input,
    };
  }
  return out;
}

/**
 * Native-OpenAI pricing map from the cached OpenRouter catalog. Returns {} when the catalog is
 * unavailable (fetch failure), so a catalog outage records native cost as missing rather than throwing
 * and failing key resolution. `loadCatalog` is injectable for testing.
 */
export async function getOpenAiModelPricing(
  loadCatalog: () => Promise<CatalogModel[]> = getOpenRouterCatalog,
): Promise<Record<string, OpenAiModelPrice>> {
  try {
    return openAiModelPricing(await loadCatalog());
  } catch {
    return {};
  }
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

let catalogCache: { models: CatalogModel[]; fetchedAt: number } | undefined;

/** Fetch OpenRouter's public model catalog, cached in memory for one hour. */
export async function getOpenRouterCatalog(): Promise<CatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  const response = await fetch(CATALOG_URL);
  if (!response.ok) {
    throw new Error(`openrouter models fetch failed: ${response.status}`);
  }
  const data = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
  const models = Array.isArray(data?.data)
    ? data.data.flatMap((entry): CatalogModel[] => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== "string" || record.id.length === 0) {
          return [];
        }
        const pricingRaw =
          record.pricing && typeof record.pricing === "object" && !Array.isArray(record.pricing)
            ? (record.pricing as Record<string, unknown>)
            : {};
        return [
          {
            id: record.id,
            name: typeof record.name === "string" ? record.name : record.id,
            context_length:
              typeof record.context_length === "number" && Number.isFinite(record.context_length)
                ? record.context_length
                : null,
            // OpenRouter pricing is USD PER TOKEN as decimal strings; convert to USD per 1M tokens exactly.
            pricing: {
              prompt_per_1m: pricePerMillion(pricingRaw.prompt),
              completion_per_1m: pricePerMillion(pricingRaw.completion),
            },
            // Keep the raw per-token strings verbatim for the native-OpenAI cost path (exact decimals,
            // never rescaled). cached prefers `cached`, then the alternate `cached_input` spelling.
            native_pricing: {
              input: perTokenString(pricingRaw.prompt),
              output: perTokenString(pricingRaw.completion),
              cached: perTokenString(pricingRaw.cached) ?? perTokenString(pricingRaw.cached_input),
            },
          },
        ];
      })
    : [];
  // FINDING 7: a 2xx whose body is malformed JSON or carries no usable models is a FETCH FAILURE,
  // not "the catalog is empty". Caching [] here would reject every valid model save for an hour and
  // make validation reject-all. Throw instead so nothing is cached — validation then fails open
  // (accept + warn) and the models endpoint returns 503, exactly like an unreachable catalog.
  if (models.length === 0) {
    throw new Error("openrouter models response was empty or malformed");
  }
  catalogCache = { models, fetchedAt: Date.now() };
  return models;
}

/** Test-only: reset the in-memory catalog cache. */
export function resetCatalogCache(): void {
  catalogCache = undefined;
}

/** Normalize the model-settings request body: empty string / non-string -> null (platform default). */
export function parseModelSettingsBody(body: unknown): ModelSettings {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return {
    planner_model: normalizeSlug(record.planner_model),
    investigation_model: normalizeSlug(record.investigation_model),
    review_model: normalizeSlug(record.review_model),
    context_model: normalizeSlug(record.context_model),
    planner_effort: normalizeReasoningEffort(record.planner_effort),
    investigation_effort: normalizeReasoningEffort(record.investigation_effort),
    review_effort: normalizeReasoningEffort(record.review_effort),
    context_effort: normalizeReasoningEffort(record.context_effort),
    review_fallback_policy: normalizeFallbackPolicy(record.review_fallback_policy),
    context_fallback_policy: normalizeFallbackPolicy(record.context_fallback_policy),
  };
}

function normalizeSlug(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * FINDING 6: shape of an OpenRouter model slug — `provider/model`. Each segment starts with an
 * alphanumeric; the provider allows [a-z0-9_.-] and the model additionally allows ':' (tags/variants).
 * Matches real slugs like `openai/gpt-5.5`, `z-ai/glm-4.7`, `anthropic/claude-3.5:beta`.
 */
const OPENROUTER_SLUG_SHAPE = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.:-]*$/i;

/**
 * Validate each provided (non-null) slug against the OpenRouter catalog. Fails OPEN on a catalog
 * outage: the slug is accepted with a warning so a vendor outage never blocks saves — BUT even on the
 * fail-open path the slug must still match the OpenRouter slug SHAPE (FINDING 6), so a catalog outage
 * can never let an arbitrary non-empty string be persisted into runtime env. `loadCatalog` is
 * injectable for testing.
 */
/** Stage-model ids that are valid WITHOUT being in the OpenRouter catalog: the Codex subscription models
 *  (openai/ + HARNESS_MODELS). A Codex-provider tenant picks these for harness runs; the public catalog
 *  may lack them (e.g. GPT-5.6 codenames), so catalog membership must not reject them. */
const CODEX_STAGE_MODEL_IDS = new Set(HARNESS_MODELS.map((model) => `openai/${model}`));

export async function validateModelSettingsSlugs(
  input: ModelSettings,
  loadCatalog: () => Promise<CatalogModel[]> = getOpenRouterCatalog,
): Promise<void> {
  const slugs = [input.planner_model, input.investigation_model, input.review_model, input.context_model].filter(
    (slug): slug is string => typeof slug === "string" && slug.length > 0,
  );
  if (slugs.length === 0) {
    return;
  }
  let ids: Set<string>;
  try {
    ids = new Set((await loadCatalog()).map((model) => model.id));
  } catch (error) {
    console.warn("openrouter_catalog_validation_skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail open — but a shape violation is a client error, not a vendor outage: reject it even here.
    for (const slug of slugs) {
      if (!OPENROUTER_SLUG_SHAPE.test(slug)) {
        throw new ApiError(400, `invalid model slug: ${slug}`);
      }
    }
    return;
  }
  for (const slug of slugs) {
    if (!ids.has(slug) && !CODEX_STAGE_MODEL_IDS.has(slug)) {
      throw new ApiError(400, `unknown model slug: ${slug}`);
    }
  }
}

export async function getModels(c: Context): Promise<Response> {
  // The true platform defaults are env-derived and always available, even if the OpenRouter catalog
  // fetch fails — but the dashboard needs both together, so a catalog outage still 503s (the picker has
  // no models to show). Defaults ride alongside the catalog on success.
  try {
    const models = await getOpenRouterCatalog();
    return c.json({ models, defaults: platformModelDefaults() });
  } catch (error) {
    console.warn("openrouter_catalog_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(503, "openrouter model catalog is unavailable");
  }
}
