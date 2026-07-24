export const contextGraphExecutionProviders = ["managed", "codex", "byok"] as const;
export type ContextGraphExecutionProvider = (typeof contextGraphExecutionProviders)[number];

export const contextGraphAssertionModels = [
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "openai/gpt-5.5", label: "GPT-5.5" },
  { id: "openai/gpt-5.4", label: "GPT-5.4" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" }
] as const;

export const DEFAULT_CONTEXT_GRAPH_ASSERTION_MODEL = "openai/gpt-5.6-luna";

export interface ContextGraphExecutionSettingsRecord {
  readonly tenantId: string;
  readonly provider: ContextGraphExecutionProvider;
  readonly assertionModel: string;
  /** Encrypted envelopes. These values must never be returned by a public API. */
  readonly openrouterApiKey?: string;
  readonly openaiApiKey?: string;
  readonly codexHarnessAuth?: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ContextGraphExecutionSettingsStatus {
  readonly provider: ContextGraphExecutionProvider;
  readonly assertionModel: string;
  readonly revision: number;
  readonly updatedAt?: string;
  readonly integrations: {
    readonly codex: { readonly configured: boolean };
    readonly openrouter: { readonly configured: boolean };
    readonly openai: { readonly configured: boolean };
  };
}

export interface ContextGraphExecutionRoute {
  readonly selectedProvider: ContextGraphExecutionProvider;
  readonly source: "managed" | "codex" | "byok";
  readonly provider: "openrouter" | "openai" | "codex";
  readonly model: string;
  readonly fallbackReason?: "codex_not_connected" | "byok_not_configured" | "model_not_supported";
  readonly apiKey?: string;
  readonly codexHarnessAuth?: string;
}

export interface DecryptedContextGraphExecutionSettings {
  readonly provider: ContextGraphExecutionProvider;
  readonly assertionModel: string;
  readonly openrouterApiKey?: string;
  readonly openaiApiKey?: string;
  readonly codexHarnessAuth?: string;
}

export function normalizeContextGraphExecutionProvider(value: unknown): ContextGraphExecutionProvider {
  return value === "codex" || value === "byok" ? value : "managed";
}

export function normalizeContextGraphAssertionModel(value: unknown, fallback = DEFAULT_CONTEXT_GRAPH_ASSERTION_MODEL) {
  if (typeof value !== "string") return fallback;
  const model = value.trim();
  if (!model || model.length > 200 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)) return fallback;
  return model;
}

export function publicContextGraphExecutionSettings(
  record: ContextGraphExecutionSettingsRecord | undefined,
  defaultModel = DEFAULT_CONTEXT_GRAPH_ASSERTION_MODEL
): ContextGraphExecutionSettingsStatus {
  return {
    provider: normalizeContextGraphExecutionProvider(record?.provider),
    assertionModel: normalizeContextGraphAssertionModel(record?.assertionModel, defaultModel),
    revision: record?.revision ?? 0,
    ...(record?.updatedAt ? { updatedAt: record.updatedAt } : {}),
    integrations: {
      codex: { configured: Boolean(record?.codexHarnessAuth) },
      openrouter: { configured: Boolean(record?.openrouterApiKey) },
      openai: { configured: Boolean(record?.openaiApiKey) }
    }
  };
}

/**
 * Resolve one whole assertion run. Explicitly selected Codex uses the
 * connected harness, otherwise it falls through BYOK and then managed;
 * explicitly selected BYOK falls through to managed when no connected key
 * can run the chosen model.
 */
export function resolveContextGraphExecutionRoute(
  settings: DecryptedContextGraphExecutionSettings
): ContextGraphExecutionRoute {
  const selectedProvider = normalizeContextGraphExecutionProvider(settings.provider);
  const model = normalizeContextGraphAssertionModel(settings.assertionModel);
  if (selectedProvider === "managed") {
    return { selectedProvider, source: "managed", provider: "openrouter", model };
  }

  if (selectedProvider === "codex" && settings.codexHarnessAuth?.trim()) {
    if (isOpenAiModel(model)) {
      return {
        selectedProvider,
        source: "codex",
        provider: "codex",
        model: nativeOpenAiModel(model),
        codexHarnessAuth: settings.codexHarnessAuth
      };
    }
  }

  const fallbackReason =
    selectedProvider === "codex"
      ? settings.codexHarnessAuth?.trim()
        ? ("model_not_supported" as const)
        : ("codex_not_connected" as const)
      : undefined;
  if (settings.openrouterApiKey?.trim()) {
    return {
      selectedProvider,
      source: "byok",
      provider: "openrouter",
      model,
      apiKey: settings.openrouterApiKey,
      ...(fallbackReason ? { fallbackReason } : {})
    };
  }
  if (settings.openaiApiKey?.trim() && isOpenAiModel(model)) {
    return {
      selectedProvider,
      source: "byok",
      provider: "openai",
      model: nativeOpenAiModel(model),
      apiKey: settings.openaiApiKey,
      ...(fallbackReason ? { fallbackReason } : {})
    };
  }
  return {
    selectedProvider,
    source: "managed",
    provider: "openrouter",
    model,
    fallbackReason: fallbackReason ?? (settings.openaiApiKey?.trim() ? "model_not_supported" : "byok_not_configured")
  };
}

export function nativeOpenAiModel(model: string): string {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

/**
 * Provider/model changes must invalidate the expensive assertion cache without
 * conflating credentials or their automatic refresh revision with evidence.
 */
export function scopedContextGraphGeneratorVersion(
  baseVersion: string,
  provider: ContextGraphExecutionProvider,
  model: string
): string {
  const scope = createHash("sha256")
    .update(`${normalizeContextGraphExecutionProvider(provider)}\0${normalizeContextGraphAssertionModel(model)}`)
    .digest("hex")
    .slice(0, 12);
  return `${baseVersion}-execution-${scope}`;
}

function isOpenAiModel(model: string): boolean {
  return model.startsWith("openai/");
}
import { createHash } from "node:crypto";
