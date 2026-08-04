import { postInternal } from "../shared/api.js";
import type { ProviderKeys } from "../daytona/review-session.js";
import type { OpenaiModelPrice } from "../daytona/openrouter-proxy.js";

// Resolve per-user provider keys from the API. review_run_id binds resolution to
// the current run (the API hardens /internal/integrations/resolve to validate it).
//
// FAIL-CLOSED (see docs/BILLING.md "Credential routing"): a successful response
// with an openrouter key means a BYOH/"user"
// run; absent/null means a "managed" run that falls back to the env
// OPENROUTER_API_KEY. A request FAILURE must THROW -- never silently fall back to
// the managed key, or a BYOH tenant hitting a transient error would be mischarged
// managed-AI credits.
//
// PRECEDENCE: codex harness (BYOH-native) > tenant openrouter key (BYOK) >
// tenant native OpenAI key (BYOK) > managed env key. `codex_harness_auth` is
// present only when the PR author has connected their ChatGPT-subscription Codex
// credentials; the review then runs Codex natively on their subscription (no
// OpenRouter, no capture proxy) and the tenant is billed infra-only. A tenant
// `openai_api_key` (no harness, no openrouter) routes openai/* NATIVELY to
// api.openai.com under the tenant's own key via the capture proxy; it is a BYOK
// "user" run, likewise billed infra-only (no AI credits).
export async function resolveProviderKeys(
  installationId: number,
  reviewRunId: string,
): Promise<ProviderKeys> {
  const response = await postInternal<{
    openrouter_api_key?: string | null;
    openai_api_key?: string | null;
    codex_harness_auth?: string | null;
    codex_harness_connected_at_ms?: number | null;
    harness_owner_login?: string | null;
    // Per-model OpenAI pricing (exact decimal per-token strings) keyed by the
    // `openai/<model>` slug. Drives the capture proxy's native-route cost on managed
    // runs; null/absent means native pricing is unknown (cost recorded as missing).
    openai_model_pricing?: Record<string, OpenaiModelPrice> | null;
    provider_unavailable_reason?: string | null;
  }>("/internal/integrations/resolve", {
    github_installation_id: installationId,
    review_run_id: reviewRunId,
  });
  if (response.provider_unavailable_reason) {
    throw new ProviderConfigurationError(response.provider_unavailable_reason);
  }

  if (response.codex_harness_auth) {
    const connectedAtMs = response.codex_harness_connected_at_ms;
    return {
      codexHarnessAuth: response.codex_harness_auth,
      ...(typeof connectedAtMs === "number" && Number.isSafeInteger(connectedAtMs) && connectedAtMs >= 0
        ? { codexHarnessConnectedAtMs: connectedAtMs }
        : {}),
      source: "harness",
    };
  }
  // BYOK: carry EVERY company key the API returned so a run can use both at once — the capture proxy
  // sends openai/* natively under the OpenAI key and everything else under the OpenRouter key. A "user"
  // run whichever key(s) are present: usage rows persist not_billable, so it is billed infra-only.
  if (response.openrouter_api_key || response.openai_api_key) {
    return {
      ...(response.openrouter_api_key ? { openrouter: response.openrouter_api_key } : {}),
      ...(response.openai_api_key ? { openaiApiKey: response.openai_api_key } : {}),
      source: "user",
    };
  }
  // Managed run: the only run that wires the managed OPENAI_API_KEY, so the native
  // pricing map is carried here for the proxy to compute native-route cost.
  return {
    source: "managed",
    ...(response.openai_model_pricing ? { openaiModelPricing: response.openai_model_pricing } : {}),
  };
}

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}
