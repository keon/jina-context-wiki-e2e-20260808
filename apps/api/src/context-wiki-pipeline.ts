import { normalizeRepository } from "@jina/context-engine";

const contextWikiPipelineModes = ["legacy-board", "trigger-allowlist", "trigger"] as const;

type ContextWikiPipelineMode = (typeof contextWikiPipelineModes)[number];

export interface ContextWikiPipelineRouting {
  readonly mode: ContextWikiPipelineMode;
  readonly allowlist: ReadonlySet<string>;
}

export function parseContextWikiPipelineRouting(environment: {
  readonly JINA_WIKI_PIPELINE_MODE?: string;
  readonly JINA_WIKI_TRIGGER_ALLOWLIST?: string;
}): ContextWikiPipelineRouting {
  const rawMode = environment.JINA_WIKI_PIPELINE_MODE?.trim() || "legacy-board";
  if (!contextWikiPipelineModes.includes(rawMode as ContextWikiPipelineMode)) {
    throw new Error(`JINA_WIKI_PIPELINE_MODE must be one of ${contextWikiPipelineModes.join(", ")}`);
  }
  const allowlist = new Set(
    (environment.JINA_WIKI_TRIGGER_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => normalizeAllowlistEntry(entry))
  );
  if (rawMode !== "trigger-allowlist" && allowlist.size > 0) {
    throw new Error("JINA_WIKI_TRIGGER_ALLOWLIST is accepted only in trigger-allowlist mode");
  }
  if (rawMode === "trigger-allowlist" && allowlist.size === 0) {
    throw new Error("trigger-allowlist mode requires at least one tenant/repository entry");
  }
  return { mode: rawMode as ContextWikiPipelineMode, allowlist };
}

export function contextWikiOrchestrator(
  routing: ContextWikiPipelineRouting,
  input: { readonly tenantId: string; readonly repository: string }
): "legacy-board" | "trigger" {
  if (routing.mode === "legacy-board") return "legacy-board";
  if (routing.mode === "trigger") return "trigger";
  const tenantId = normalizeTenantId(input.tenantId);
  const repository = normalizeRepository(input.repository);
  return routing.allowlist.has(`${tenantId}/${repository}`) ? "trigger" : "legacy-board";
}

function normalizeAllowlistEntry(value: string): string {
  const separator = value.indexOf("/");
  if (separator <= 0) {
    throw new Error("wiki Trigger allowlist entries must be tenant/owner/repository");
  }
  const tenantId = normalizeTenantId(value.slice(0, separator));
  const repository = normalizeRepository(value.slice(separator + 1));
  return `${tenantId}/${repository}`;
}

function normalizeTenantId(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || tenantId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(tenantId)) {
    throw new Error("wiki Trigger tenant ID is invalid");
  }
  return tenantId;
}
