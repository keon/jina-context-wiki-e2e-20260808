import assert from "node:assert/strict";
import { test } from "node:test";

import { type CatalogModel } from "./openrouter";
import {
  formatContextLength,
  formatPer1mPrice,
  modelConnectionNotice,
  modelPriceLabel,
  normalizeStageDefaults,
  paginateCatalog,
  pillLabel,
  providerFromSlug,
  shortModelName,
  shouldFlipHoverCard,
  truncateCatalog,
} from "./models";

const CATALOG: CatalogModel[] = [
  { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5" },
  { id: "openai/gpt-5.4-mini", name: "OpenAI: GPT-5.4 Mini" },
  { id: "anthropic/claude-opus", name: "Anthropic: Claude Opus" },
  { id: "meta/llama-3", name: "Llama 3" },
];

test("model connection notices use only current connection health", () => {
  const base = {
    provider: "codex" as const,
    providerLoaded: true,
    harnessLoaded: true,
    harnessConfigured: true,
    harnessReconnectRequired: false,
    byokLoaded: true,
    openrouterConfigured: false,
    openaiConfigured: false,
  };
  assert.equal(modelConnectionNotice(base), null);
  assert.deepEqual(modelConnectionNotice({ ...base, harnessReconnectRequired: true }), {
    title: "Codex connection needs attention",
    message: "The saved Codex sign-in is no longer valid. Reconnect Codex to resume using it.",
  });
  assert.deepEqual(modelConnectionNotice({ ...base, harnessConfigured: false }), {
    title: "Codex is not connected",
    message: "Connect Codex for pull requests you author, or select another provider.",
  });
  assert.equal(modelConnectionNotice({ ...base, providerLoaded: false, harnessConfigured: false }), null);
  assert.deepEqual(modelConnectionNotice({ ...base, provider: "byok", harnessConfigured: false }), {
    title: "BYOK is not connected",
    message: "Connect an OpenRouter or OpenAI key, or select another provider.",
  });
  assert.equal(modelConnectionNotice({ ...base, provider: "managed" }), null);
});

test("providerFromSlug returns the lowercased prefix before the slash", () => {
  assert.equal(providerFromSlug("openai/gpt-5.5"), "openai");
  assert.equal(providerFromSlug("Anthropic/Claude"), "anthropic");
  assert.equal(providerFromSlug("bare-slug"), "");
  assert.equal(providerFromSlug("/leading"), "");
  assert.equal(providerFromSlug(null), "");
  assert.equal(providerFromSlug(undefined), "");
});

test("shortModelName keeps the tail after the first colon, else the whole name", () => {
  assert.equal(shortModelName({ id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5" }), "GPT-5.5");
  assert.equal(shortModelName({ id: "meta/llama-3", name: "Llama 3" }), "Llama 3");
  // Falls back to id when the name is blank.
  assert.equal(shortModelName({ id: "x/y", name: "" }), "x/y");
  assert.equal(shortModelName({ id: "x/y", name: "   " }), "x/y");
  // A trailing-empty tail falls back to the full name.
  assert.equal(shortModelName({ id: "x/y", name: "Solo: " }), "Solo:");
});

test("pillLabel maps slugs to short names; null degrades to a placeholder", () => {
  assert.equal(pillLabel(null, CATALOG), "Select model");
  assert.equal(pillLabel("openai/gpt-5.5", CATALOG), "GPT-5.5");
  // Unknown slug (not in catalog) renders verbatim.
  assert.equal(pillLabel("openai/unknown", CATALOG), "openai/unknown");
  assert.equal(pillLabel("openai/gpt-5.5", null), "openai/gpt-5.5");
});

test("truncateCatalog filters, caps, and reports the remainder", () => {
  const gpt = truncateCatalog(CATALOG, "gpt");
  assert.deepEqual(
    gpt.visible.map((m) => m.id),
    ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
  );
  assert.equal(gpt.remaining, 0);

  const capped = truncateCatalog(CATALOG, "", 2);
  assert.equal(capped.visible.length, 2);
  assert.equal(capped.remaining, 2);

  // A filtered query that overflows the cap reports the hidden remainder too.
  const cappedQuery = truncateCatalog(CATALOG, "openai", 1);
  assert.equal(cappedQuery.visible.length, 1);
  assert.equal(cappedQuery.remaining, 1);
});

test("paginateCatalog filters first, returns 20 rows, and clamps page boundaries", () => {
  const models = Array.from({ length: 45 }, (_, index) => ({
    id: `${index % 2 === 0 ? "openai" : "anthropic"}/model-${index + 1}`,
    name: `Model ${index + 1}`,
  }));

  const first = paginateCatalog(models, "", 1);
  assert.equal(first.visible.length, 20);
  assert.equal(first.visible[0]?.id, "openai/model-1");
  assert.equal(first.page, 1);
  assert.equal(first.totalPages, 3);
  assert.equal(first.totalMatches, 45);

  const last = paginateCatalog(models, "", 3);
  assert.equal(last.visible.length, 5);
  assert.equal(last.visible[0]?.id, "openai/model-41");

  const clampedHigh = paginateCatalog(models, "", 99);
  assert.equal(clampedHigh.page, 3);
  assert.equal(clampedHigh.visible.length, 5);

  const clampedLow = paginateCatalog(models, "", 0);
  assert.equal(clampedLow.page, 1);

  const filtered = paginateCatalog(models, "openai", 2);
  assert.equal(filtered.totalMatches, 23);
  assert.equal(filtered.totalPages, 2);
  assert.equal(filtered.visible.length, 3);

  const empty = paginateCatalog(models, "no-match", 4);
  assert.deepEqual(empty, { visible: [], page: 1, totalPages: 0, totalMatches: 0 });
});

test("paginateCatalog handles exact pages and invalid page sizes", () => {
  const models = Array.from({ length: 20 }, (_, index) => ({
    id: `provider/model-${index + 1}`,
    name: `Model ${index + 1}`,
  }));

  assert.deepEqual(
    paginateCatalog(models, "", 1),
    { visible: models, page: 1, totalPages: 1, totalMatches: 20 },
  );
  assert.equal(paginateCatalog([...models, { id: "provider/model-21", name: "Model 21" }], "", 2).visible.length, 1);
  assert.equal(paginateCatalog(models, "", 1, 0).visible.length, 20);
});

test("formatPer1mPrice reshapes price strings without floating-point math", () => {
  // Whole numbers pad to two decimals.
  assert.equal(formatPer1mPrice("10"), "$10.00");
  assert.equal(formatPer1mPrice("10.00"), "$10.00");
  assert.equal(formatPer1mPrice("10.000000"), "$10.00");
  // Trailing zeros beyond two decimals are trimmed; two are always kept.
  assert.equal(formatPer1mPrice("0.150000"), "$0.15");
  assert.equal(formatPer1mPrice("0.15"), "$0.15");
  assert.equal(formatPer1mPrice("0.1"), "$0.10");
  // Genuine precision beyond two decimals is preserved.
  assert.equal(formatPer1mPrice("0.123456"), "$0.123456");
  // Tolerates surrounding whitespace and an existing "$".
  assert.equal(formatPer1mPrice("  30 "), "$30.00");
  assert.equal(formatPer1mPrice("$0.6"), "$0.60");
  // Junk / absent values yield null so callers can omit the figure.
  assert.equal(formatPer1mPrice(null), null);
  assert.equal(formatPer1mPrice(undefined), null);
  assert.equal(formatPer1mPrice(""), null);
  assert.equal(formatPer1mPrice("free"), null);
});

test("formatContextLength renders compact K/M sizes", () => {
  assert.equal(formatContextLength(400_000), "400K");
  assert.equal(formatContextLength(1_000_000), "1M");
  assert.equal(formatContextLength(128_000), "128K");
  assert.equal(formatContextLength(1_500_000), "1.5M");
  assert.equal(formatContextLength(900), "900");
  // Missing / invalid sizes yield null.
  assert.equal(formatContextLength(null), null);
  assert.equal(formatContextLength(undefined), null);
  assert.equal(formatContextLength(0), null);
  assert.equal(formatContextLength(-5), null);
  assert.equal(formatContextLength(Number.NaN), null);
});

test("modelPriceLabel builds an inline in/out label, or null when unpriced", () => {
  assert.equal(
    modelPriceLabel({ id: "a/b", name: "A", pricing: { prompt_per_1m: "0.15", completion_per_1m: "0.60" } }),
    "$0.15 / $0.60 per 1M",
  );
  // A missing side shows an em dash.
  assert.equal(
    modelPriceLabel({ id: "a/b", name: "A", pricing: { prompt_per_1m: "10", completion_per_1m: null } }),
    "$10.00 / — per 1M",
  );
  // No pricing at all → null (nothing rendered).
  assert.equal(modelPriceLabel({ id: "a/b", name: "A" }), null);
  assert.equal(
    modelPriceLabel({ id: "a/b", name: "A", pricing: { prompt_per_1m: null, completion_per_1m: null } }),
    null,
  );
});

test("normalizeStageDefaults trims slugs and returns null when absent", () => {
  assert.deepEqual(normalizeStageDefaults({ planner: "openai/gpt-5.5", investigation: "openai/gpt-5.4-mini", review: "anthropic/claude-opus" }), {
    planner: "openai/gpt-5.5",
    investigation: "openai/gpt-5.4-mini",
    review: "anthropic/claude-opus",
    context: null,
  });
  // Blank / missing individual fields become null but the object still returns.
  assert.deepEqual(normalizeStageDefaults({ planner: "  ", investigation: "x/y", review: "" }), {
    planner: null,
    investigation: "x/y",
    review: null,
    context: null,
  });
  // Wholly absent / empty → null so the UI keeps the plain label.
  assert.equal(normalizeStageDefaults(null), null);
  assert.equal(normalizeStageDefaults(undefined), null);
  assert.equal(normalizeStageDefaults({}), null);
  assert.equal(normalizeStageDefaults({ planner: "", investigation: null, review: "  " }), null);
  assert.equal(normalizeStageDefaults([]), null);
});

test("shouldFlipHoverCard flips only when a right-side card would overflow", () => {
  // Plenty of room to the right → no flip.
  assert.equal(shouldFlipHoverCard(600, 240, 1280), false);
  // Popover hugs the right edge → flip to the left.
  assert.equal(shouldFlipHoverCard(1200, 240, 1280), true);
  // Exactly fits (edge inclusive of the gap) → no flip.
  assert.equal(shouldFlipHoverCard(1028, 240, 1280, 12), false);
  assert.equal(shouldFlipHoverCard(1029, 240, 1280, 12), true);
});
