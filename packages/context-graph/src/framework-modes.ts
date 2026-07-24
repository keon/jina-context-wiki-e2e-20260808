export const assertionExecutionModes = ["legacy", "host_shadow", "model_shadow", "changeset"] as const;
export type AssertionExecutionMode = (typeof assertionExecutionModes)[number];

export const admissionExecutionModes = ["legacy_proposed", "shadow", "enforce"] as const;
export type AdmissionExecutionMode = (typeof admissionExecutionModes)[number];

export const causalExecutionModes = ["legacy", "mechanism_shadow", "mechanism"] as const;
export type CausalExecutionMode = (typeof causalExecutionModes)[number];

export interface ContextFrameworkModes {
  readonly assertion: AssertionExecutionMode;
  readonly admission: AdmissionExecutionMode;
  readonly causal: CausalExecutionMode;
  readonly modelShadowSampleBps: number;
}

export const DEFAULT_CONTEXT_FRAMEWORK_MODES: ContextFrameworkModes = {
  assertion: "legacy",
  admission: "legacy_proposed",
  causal: "legacy",
  modelShadowSampleBps: 0
};

export function parseContextFrameworkModes(
  environment: Readonly<Record<string, string | undefined>>
): ContextFrameworkModes {
  return {
    assertion: parseMode(
      environment.CONTEXT_GRAPH_ASSERTION_MODE,
      assertionExecutionModes,
      DEFAULT_CONTEXT_FRAMEWORK_MODES.assertion,
      "CONTEXT_GRAPH_ASSERTION_MODE"
    ),
    admission: parseMode(
      environment.CONTEXT_GRAPH_ADMISSION_MODE,
      admissionExecutionModes,
      DEFAULT_CONTEXT_FRAMEWORK_MODES.admission,
      "CONTEXT_GRAPH_ADMISSION_MODE"
    ),
    causal: parseMode(
      environment.CONTEXT_GRAPH_CAUSAL_MODE,
      causalExecutionModes,
      DEFAULT_CONTEXT_FRAMEWORK_MODES.causal,
      "CONTEXT_GRAPH_CAUSAL_MODE"
    ),
    modelShadowSampleBps: parseBasisPoints(
      environment.CONTEXT_GRAPH_CHANGESET_SHADOW_SAMPLE_BPS,
      DEFAULT_CONTEXT_FRAMEWORK_MODES.modelShadowSampleBps
    )
  };
}

function parseMode<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  variable: string
): T {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!allowed.includes(normalized as T)) {
    throw new Error(`${variable} must be one of ${allowed.join(", ")}`);
  }
  return normalized as T;
}

function parseBasisPoints(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) {
    throw new Error("CONTEXT_GRAPH_CHANGESET_SHADOW_SAMPLE_BPS must be an integer between 0 and 10000");
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("CONTEXT_GRAPH_CHANGESET_SHADOW_SAMPLE_BPS must be an integer between 0 and 10000");
  }
  return parsed;
}
