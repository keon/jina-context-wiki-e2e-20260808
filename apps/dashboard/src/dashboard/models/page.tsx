"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CodexConnection } from "../components/codex-connection";
import { Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import { normalizeCodexHarnessInfo, type CodexHarnessInfo } from "../lib/codex-harness";
import {
  FALLBACK_STAGE_DEFAULTS,
  formatContextLength,
  modelPriceLabel,
  normalizeStageDefaults,
  shortModelName,
  type StageDefaults,
} from "../lib/models";
import {
  filterModels,
  normalizeModelSettings,
  type CatalogModel,
  type FallbackPolicy,
  type ModelSettings,
  type ReasoningEffort,
} from "../lib/openrouter";
import { isTenantWritable, type SelectedTenant } from "../lib/tenants";
import { useTenant, useTenantFence } from "../providers";

type ModelProvider = "codex" | "byok" | "managed";
type ReviewTriggerMode = "every_commit" | "first_commit" | "manual_only";
type PageState = "loading" | "ready" | "unavailable";
type SaveState = { kind: "idle" | "saving" | "saved" | "error"; message?: string };

const PROVIDERS: Array<{ value: ModelProvider; title: string; description: string; mark: string }> = [
  { value: "codex", title: "Codex", description: "Use your ChatGPT subscription for reviews you author.", mark: "CX" },
  { value: "byok", title: "Your API keys", description: "Route through credentials configured in Integrations.", mark: "BY" },
  { value: "managed", title: "Jina managed", description: "Use managed models billed as workspace credits.", mark: "JM" },
];

const STAGES: Array<{
  modelKey: "planner_model" | "investigation_model" | "review_model" | "context_model";
  defaultKey: keyof StageDefaults;
  effortKey: "planner_effort" | "investigation_effort" | "review_effort" | "context_effort";
  title: string;
  description: string;
  defaultEffort: ReasoningEffort;
}> = [
  { modelKey: "planner_model", defaultKey: "planner", effortKey: "planner_effort", title: "Planning", description: "Maps the review into focused investigation areas.", defaultEffort: "medium" },
  { modelKey: "investigation_model", defaultKey: "investigation", effortKey: "investigation_effort", title: "Investigation", description: "Runs the agents that inspect code and evidence.", defaultEffort: "medium" },
  { modelKey: "review_model", defaultKey: "review", effortKey: "review_effort", title: "Final review", description: "Writes the published review and inline findings.", defaultEffort: "medium" },
  { modelKey: "context_model", defaultKey: "context", effortKey: "context_effort", title: "Context generation", description: "Builds and refreshes repository context.", defaultEffort: "low" },
];

const TRIGGERS: Array<{ value: ReviewTriggerMode; title: string; description: string }> = [
  { value: "every_commit", title: "Every update", description: "Review when a pull request opens and after every push." },
  { value: "first_commit", title: "First commit only", description: "Review when a pull request opens, without push reruns." },
  { value: "manual_only", title: "Manual only", description: "Review only when @usejina is mentioned in a comment." },
];

function modelProviderUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/model-provider`)
    : apiUrl("/dashboard/model-provider");
}

function modelSettingsUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/model-settings`)
    : apiUrl("/dashboard/model-settings");
}

function reviewTriggerUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/review-trigger`)
    : apiUrl("/dashboard/review-trigger");
}

function normalizeProvider(value: unknown): ModelProvider {
  if (value === "codex" || value === "byok" || value === "managed") return value;
  if (value === "openai" || value === "openrouter") return "byok";
  return "managed";
}

function normalizeTrigger(value: unknown): ReviewTriggerMode {
  return value === "first_commit" || value === "manual_only" ? value : "every_commit";
}

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export default function ModelsPage() {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const writable = isTenantWritable(selected);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [provider, setProvider] = useState<ModelProvider>("managed");
  const [settings, setSettings] = useState<ModelSettings>(() => normalizeModelSettings(null));
  const [trigger, setTrigger] = useState<ReviewTriggerMode>("every_commit");
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [defaults, setDefaults] = useState<StageDefaults>({ ...FALLBACK_STAGE_DEFAULTS });
  const [harness, setHarness] = useState<CodexHarnessInfo>({ configured: false });
  const [codexOpenRequest, setCodexOpenRequest] = useState(0);
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const clearStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    const controller = new AbortController();
    setPageState("loading");
    setSaveState({ kind: "idle" });
    void Promise.all([
      readJson(modelProviderUrl(selected), controller.signal),
      readJson(modelSettingsUrl(selected), controller.signal),
      readJson(apiUrl("/dashboard/models"), controller.signal),
      readJson(reviewTriggerUrl(selected), controller.signal),
    ])
      .then(([providerData, settingsData, catalogData, triggerData]) => {
        if (controller.signal.aborted || !isCurrentTenant(requestTenantId)) return;
        const providerRecord = providerData as { provider?: unknown };
        const catalogRecord = catalogData as { models?: unknown; defaults?: unknown };
        const triggerRecord = triggerData as { mode?: unknown };
        setProvider(normalizeProvider(providerRecord?.provider));
        setSettings(normalizeModelSettings(settingsData));
        setCatalog(Array.isArray(catalogRecord?.models) ? (catalogRecord.models as CatalogModel[]) : []);
        setDefaults(normalizeStageDefaults(catalogRecord?.defaults) ?? { ...FALLBACK_STAGE_DEFAULTS });
        setTrigger(normalizeTrigger(triggerRecord?.mode));
        setPageState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) setPageState("unavailable");
      });
    return () => controller.abort();
  }, [selected, reloadVersion, isCurrentTenant]);

  useEffect(() => () => {
    if (clearStatusTimer.current) clearTimeout(clearStatusTimer.current);
  }, []);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    const controller = new AbortController();
    fetch(apiUrl("/dashboard/integrations"), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: Record<string, unknown> | undefined) => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setHarness(normalizeCodexHarnessInfo(data?.codex_harness));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setHarness({ configured: false });
        }
      });
    return () => controller.abort();
  }, [selected, isCurrentTenant]);

  const markSaving = () => {
    if (clearStatusTimer.current) clearTimeout(clearStatusTimer.current);
    setSaveState({ kind: "saving" });
  };

  const markSaved = () => {
    setSaveState({ kind: "saved" });
    clearStatusTimer.current = setTimeout(() => setSaveState({ kind: "idle" }), 1800);
  };

  const markError = (message: string) => setSaveState({ kind: "error", message });

  const saveProvider = async (next: ModelProvider) => {
    if (!writable || saveState.kind === "saving") return;
    const previous = provider;
    const requestTenantId = selected?.tenantId ?? null;
    setProvider(next);
    markSaving();
    try {
      const response = await fetch(modelProviderUrl(selected), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      if (response.status === 403) throw new Error("Only workspace admins can change model routing.");
      if (!response.ok) throw new Error("Provider could not be saved.");
      const body = (await response.json()) as { provider?: unknown };
      if (!isCurrentTenant(requestTenantId)) return;
      setProvider(normalizeProvider(body.provider));
      markSaved();
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setProvider(previous);
      markError(error instanceof Error ? error.message : "Provider could not be saved.");
    }
  };

  const saveSettings = async (next: ModelSettings) => {
    if (!writable || saveState.kind === "saving") return;
    const previous = settings;
    const requestTenantId = selected?.tenantId ?? null;
    setSettings(next);
    markSaving();
    try {
      const response = await fetch(modelSettingsUrl(selected), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (response.status === 403) throw new Error("Only workspace admins can change model defaults.");
      if (!response.ok) throw new Error("Model defaults could not be saved.");
      const saved = normalizeModelSettings(await response.json());
      if (!isCurrentTenant(requestTenantId)) return;
      setSettings(saved);
      markSaved();
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setSettings(previous);
      markError(error instanceof Error ? error.message : "Model defaults could not be saved.");
    }
  };

  const saveTrigger = async (next: ReviewTriggerMode) => {
    if (!writable || saveState.kind === "saving") return;
    const previous = trigger;
    const requestTenantId = selected?.tenantId ?? null;
    setTrigger(next);
    markSaving();
    try {
      const response = await fetch(reviewTriggerUrl(selected), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (response.status === 403) throw new Error("Only workspace admins can change review behavior.");
      if (!response.ok) throw new Error("Review behavior could not be saved.");
      const body = (await response.json()) as { mode?: unknown };
      if (!isCurrentTenant(requestTenantId)) return;
      setTrigger(normalizeTrigger(body.mode));
      markSaved();
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setTrigger(previous);
      markError(error instanceof Error ? error.message : "Review behavior could not be saved.");
    }
  };

  const visibleModels = useMemo(() => filterModels(catalog, query, 24), [catalog, query]);
  const saving = saveState.kind === "saving";

  const selectProvider = (next: ModelProvider) => {
    if (next === "codex") setCodexOpenRequest((request) => request + 1);
    void saveProvider(next);
  };

  return (
    <div className="models-v2">
      <header className="route-intro">
        <div><h1>Models</h1><p>Choose where reviews run and which models handle each stage.</p></div>
        <div className="models-v2__header-actions">
          {selected ? <span className="route-intro__scope">{selected.login}</span> : null}
          <SaveIndicator state={saveState} />
        </div>
      </header>

      {pageState === "loading" ? (
        <ModelsState title="Loading model configuration" detail="Checking routing, defaults, and available models." />
      ) : pageState === "unavailable" ? (
        <ModelsState
          title="Models are temporarily unavailable"
          detail="Your saved routing has not been changed. Retry when the dashboard service is reachable."
          action={<button type="button" className="btn btn--primary" onClick={() => setReloadVersion((version) => version + 1)}>Retry</button>}
        />
      ) : (
        <>
          <section className="model-v2-panel">
            <PanelHeading title="Provider" description="Where Jina runs model work for this workspace." />
            {!writable ? <p className="model-v2-panel__gate">Managed by workspace admins.</p> : null}
            <div className="model-provider-grid" role="radiogroup" aria-label="Model provider">
              {PROVIDERS.map((option) => (
                <label key={option.value} className={`model-provider-card${provider === option.value ? " model-provider-card--active" : ""}`}>
                  <input type="radio" name="model-provider" checked={provider === option.value} disabled={!writable || saving} onChange={() => selectProvider(option.value)} />
                  <span className="integration-mark">{option.mark}</span>
                  <span><strong>{option.title}</strong><small>{option.description}</small></span>
                </label>
              ))}
            </div>
            {provider === "codex" ? (
              <CodexConnection info={harness} onChanged={setHarness} openRequest={codexOpenRequest} />
            ) : null}
            {provider === "byok" ? <a className="model-v2-panel__link" href="/integrations">Manage provider keys →</a> : null}
          </section>

          <section className="model-v2-panel">
            <PanelHeading title="Review models" description="Set a model and reasoning effort for each stage." />
            <div className="model-setting-list">
              {STAGES.map((stage) => (
                <ModelSettingRow
                  key={stage.modelKey}
                  stage={stage}
                  catalog={catalog}
                  defaults={defaults}
                  settings={settings}
                  disabled={!writable || saving}
                  onChange={(next) => void saveSettings(next)}
                />
              ))}
            </div>
            <div className="model-fallbacks">
              <FallbackControl
                label="Review fallback"
                value={settings.review_fallback_policy}
                disabled={!writable || saving}
                onChange={(value) => void saveSettings({ ...settings, review_fallback_policy: value })}
              />
              <FallbackControl
                label="Context fallback"
                value={settings.context_fallback_policy}
                disabled={!writable || saving}
                onChange={(value) => void saveSettings({ ...settings, context_fallback_policy: value })}
              />
            </div>
          </section>

          <section className="model-v2-panel">
            <PanelHeading title="Review behavior" description="Choose when pull requests are reviewed." />
            <div className="model-trigger-grid" role="radiogroup" aria-label="Review behavior">
              {TRIGGERS.map((option) => (
                <label key={option.value} className={`model-trigger-card${trigger === option.value ? " model-trigger-card--active" : ""}`}>
                  <input type="radio" name="review-trigger" checked={trigger === option.value} disabled={!writable || saving} onChange={() => void saveTrigger(option.value)} />
                  <span><strong>{option.title}</strong><small>{option.description}</small></span>
                </label>
              ))}
            </div>
          </section>

          <section className="model-v2-panel">
            <PanelHeading title="Available models" description={`${catalog.length.toLocaleString("en-US")} models available to this workspace.`} />
            <label className="model-catalog-search">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" />
            </label>
            {visibleModels.length === 0 ? (
              <div className="model-v2-empty">No models match this search.</div>
            ) : (
              <div className="model-v2-catalog">
                {visibleModels.map((model) => (
                  <div className="model-v2-catalog__row" key={model.id}>
                    <span className="integration-mark">{model.id.split("/")[0]?.slice(0, 2).toUpperCase()}</span>
                    <span><strong>{shortModelName(model)}</strong><small>{model.id}</small></span>
                    <span>{formatContextLength(model.context_length)}</span>
                    <span>{modelPriceLabel(model) ?? "Pricing unavailable"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PanelHeading({ title, description }: { title: string; description: string }) {
  return <div className="model-v2-panel__head"><div><h2>{title}</h2><p>{description}</p></div></div>;
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "saving") return <span className="models-v2__save">Saving…</span>;
  if (state.kind === "saved") return <Badge tone="ok">Saved</Badge>;
  return <span className="models-v2__save models-v2__save--error">{state.message ?? "Could not save"}</span>;
}

function ModelsState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <section className="models-v2-state">
      <span className="models-v2-state__icon" aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </section>
  );
}

function ModelSettingRow({
  stage,
  catalog,
  defaults,
  settings,
  disabled,
  onChange,
}: {
  stage: (typeof STAGES)[number];
  catalog: CatalogModel[];
  defaults: StageDefaults;
  settings: ModelSettings;
  disabled: boolean;
  onChange: (next: ModelSettings) => void;
}) {
  const effort = settings[stage.effortKey] ?? stage.defaultEffort;
  const defaultSlug = defaults[stage.defaultKey] ?? FALLBACK_STAGE_DEFAULTS[stage.defaultKey];
  const defaultModel = catalog.find((model) => model.id === defaultSlug);
  const defaultLabel = defaultModel
    ? `Default — ${shortModelName(defaultModel)} · ${defaultSlug}`
    : `Default — ${defaultSlug}`;
  return (
    <div className="model-setting-row">
      <div><strong>{stage.title}</strong><small>{stage.description}</small></div>
      <select value={settings[stage.modelKey] ?? ""} disabled={disabled} onChange={(event) => onChange({ ...settings, [stage.modelKey]: event.target.value || null })}>
        <option value="">{defaultLabel}</option>
        {catalog.map((model) => <option value={model.id} key={model.id}>{shortModelName(model)} · {model.id}</option>)}
      </select>
      <div className="model-effort" role="group" aria-label={`${stage.title} reasoning effort`}>
        {(["low", "medium", "high"] as ReasoningEffort[]).map((value) => (
          <button type="button" key={value} className={effort === value ? "model-effort__active" : undefined} disabled={disabled} onClick={() => onChange({ ...settings, [stage.effortKey]: value })}>
            {value[0]?.toUpperCase()}{value.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function FallbackControl({ label, value, disabled, onChange }: { label: string; value: FallbackPolicy; disabled: boolean; onChange: (value: FallbackPolicy) => void }) {
  return (
    <label><span><strong>{label}</strong><small>When the selected provider cannot complete the work.</small></span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as FallbackPolicy)}>
        <option value="fail_notify">Fail and notify</option><option value="managed">Use Jina managed</option>
      </select>
    </label>
  );
}
