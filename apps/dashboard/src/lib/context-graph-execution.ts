export type ExecutionProvider = "managed" | "codex" | "byok";

interface ExecutionModel {
  readonly id: string;
  readonly label: string;
}

export interface ExecutionSettings {
  readonly provider: ExecutionProvider;
  readonly assertionModel: string;
  readonly revision: number;
  readonly updatedAt?: string;
  readonly integrations: {
    readonly codex: { readonly configured: boolean };
    readonly openrouter: { readonly configured: boolean };
    readonly openai: { readonly configured: boolean };
  };
  readonly models: readonly ExecutionModel[];
}

const EMPTY_INTEGRATIONS = {
  codex: { configured: false },
  openrouter: { configured: false },
  openai: { configured: false }
} as const;

export function normalizeExecutionSettings(value: unknown): ExecutionSettings {
  const record = isRecord(value) ? value : {};
  const integrations = isRecord(record.integrations) ? record.integrations : {};
  const configured = (key: string) => isRecord(integrations[key]) && integrations[key].configured === true;
  const models = Array.isArray(record.models)
    ? record.models.flatMap((model) => {
        if (!isRecord(model) || typeof model.id !== "string" || typeof model.label !== "string") return [];
        return [{ id: model.id, label: model.label }];
      })
    : [];
  return {
    provider: record.provider === "codex" || record.provider === "byok" ? record.provider : "managed",
    assertionModel:
      typeof record.assertionModel === "string" && record.assertionModel.trim()
        ? record.assertionModel.trim()
        : "openai/gpt-5.6-luna",
    revision:
      typeof record.revision === "number" && Number.isSafeInteger(record.revision) && record.revision >= 0
        ? record.revision
        : 0,
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    integrations: {
      codex: { configured: configured("codex") },
      openrouter: { configured: configured("openrouter") },
      openai: { configured: configured("openai") }
    },
    models
  };
}

export function executionFallback(settings: ExecutionSettings): string | null {
  if (settings.provider === "managed") return null;
  if (settings.provider === "codex" && settings.integrations.codex.configured) return null;
  if (settings.integrations.openrouter.configured) return null;
  if (settings.integrations.openai.configured && settings.assertionModel.startsWith("openai/")) return null;
  return settings.provider === "codex"
    ? "Codex is not connected, so assertion runs fall back to BYOK and then Jina managed."
    : "No compatible BYOK key is connected, so assertion runs fall back to Jina managed.";
}

export function disconnectedExecutionSettings(): ExecutionSettings {
  return {
    provider: "managed",
    assertionModel: "openai/gpt-5.6-luna",
    revision: 0,
    integrations: EMPTY_INTEGRATIONS,
    models: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
