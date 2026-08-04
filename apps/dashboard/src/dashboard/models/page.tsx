"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiUrl, safeHref } from "../lib/api";
import { Badge } from "../components/ui";
import { formatDate } from "../lib/presentation";
import {
  normalizeModelSettings,
  type CatalogModel,
  type FallbackPolicy,
  type ModelSettings,
  type ReasoningEffort,
} from "../lib/openrouter";
import {
  CODEX_CLIENT_ID,
  CODEX_SECURITY_SETTINGS_URL,
  CODEX_VERIFY_URL,
  DEVICE_ENDPOINTS,
  assembleAuthJson,
  boundedInterval,
  classifyPollStatus,
  decodeAccountId,
  handshakeErrorMessage,
  parseCodeSuccess,
  parseOAuthTokens,
  parseUsercodeResponse,
  type StoredCodexDeviceFlow,
  type UsercodeResponse,
} from "../lib/codex-device-flow";
import {
  clearCodexDeviceFlow,
  createCodexFlowId,
  loadCodexDeviceFlow,
  reportCodexConnectEvent,
  saveCodexDeviceFlow,
} from "../lib/codex-connect-session";
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
  type StageDefaults,
} from "../lib/models";
import { normalizeCodexHarnessInfo, precheckCodexAuth, type CodexHarnessInfo } from "../lib/codex-harness";
import {
  COPY_CONFIRM_MS,
  codexConnectionAccepted,
  codexModalCanDismiss,
  connectedLabel,
  handshakeErrorAction,
} from "../lib/codex-connect";
import { useTenant, useTenantFence } from "../providers";
import {
  HARNESS_MODEL_OPTIONS,
  isTenantWritable,
  type SelectedTenant,
} from "../lib/tenants";

/* ============================================================ *
 *  Provider icons — small, self-contained, currentColor SVGs.  *
 * ============================================================ */

function OpenAIIcon() {
  return (
    <svg className="provider-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 13.2 4.6v6L8 13.6 2.8 10.6v-6L8 1.6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="7.6" r="2.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function AnthropicIcon() {
  return (
    <svg className="provider-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.1 3.4 2.7 12.6h1.9l.72-2.06h3.36l.72 2.06h1.9L7.9 3.4H6.1Zm-.13 5.5L7 5.9l1.03 3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function GenericIcon() {
  return (
    <svg className="provider-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="2.4" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Icon for a resolved provider id (the segment before a slug's first "/"). */
function ProviderGlyph({ provider }: { provider: string }) {
  if (provider === "openai") return <OpenAIIcon />;
  if (provider === "anthropic") return <AnthropicIcon />;
  return <GenericIcon />;
}

function ProviderIcon({ slug }: { slug: string | null }) {
  return <ProviderGlyph provider={providerFromSlug(slug)} />;
}

function ChevronIcon() {
  return (
    <svg className="model-pill__chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6.5 8 10l4-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg className="model-search__glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg className="model-pop__check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg className="codex-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CopyGlyph() {
  return (
    <svg className="codex-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckSmallGlyph() {
  return (
    <svg className="codex-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ============================================================ *
 *  Page                                                        *
 * ============================================================ */

export default function ModelsPage() {
  return (
    <div className="models-page">
      <h1 className="models-page__title">Models</h1>
      <RoutingStateProvider>
        <ModelConnectionNoticeBanner />
        <RoutingSection />
        <ReviewDefaultsSection />
        <ReviewTriggersSection />
        <AvailableModelsSection />
      </RoutingStateProvider>
    </div>
  );
}

function ModelConnectionNoticeBanner() {
  const { provider, providerStatus, byok, byokStatus, harness, harnessStatus } = useContext(RoutingStateContext);
  const notice = modelConnectionNotice({
    provider,
    providerLoaded: providerStatus === "loaded",
    harnessLoaded: harnessStatus === "loaded",
    harnessConfigured: harness.configured,
    harnessReconnectRequired: harness.reconnect_required === true,
    byokLoaded: byokStatus === "loaded",
    openrouterConfigured: byok.openrouter,
    openaiConfigured: byok.openai,
  });

  if (!notice) return null;
  return (
    <div className="model-connection-notices" aria-label="Model connection health">
      <div className="notice notice--bad" role="status">
        <strong>{notice.title}</strong>
        <span>{notice.message}</span>
        {provider === "codex" ? (
          <a href="#codex-provider" className="router-link">Manage Codex connection</a>
        ) : (
          <a href="/integrations" className="router-link">Manage integrations</a>
        )}
      </div>
    </div>
  );
}

/* ---------- Provider selection (Codex / BYOK / Jina managed; model choices key off it) ---------- */

type ModelProvider = "codex" | "byok" | "managed";

function modelProviderUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/model-provider`)
    : apiUrl("/dashboard/model-provider");
}

function normalizeProvider(raw: unknown): ModelProvider {
  if (raw === "codex" || raw === "byok" || raw === "managed") return raw;
  // Legacy single-key forces collapse to the BYOK tier (matches the API's normalizeModelProvider).
  if (raw === "openai" || raw === "openrouter") return "byok";
  // No selection (or the retired 'auto') -> Jina managed until the user selects.
  return "managed";
}

function routerIntegrationsUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/integrations`)
    : apiUrl("/dashboard/integrations");
}

// Only the keys the worker actually ROUTES to are BYOK credentials: the OpenRouter key (any vendor) and
// the native OpenAI key (openai/*). A stored Anthropic key rides the OpenRouter key, so it isn't one.
type ByokKeys = { openrouter: boolean; openai: boolean };
const EMPTY_BYOK: ByokKeys = { openrouter: false, openai: false };

type RoutingState = {
  /** The tenant's selection ('managed' until they select); undefined while loading. */
  provider: ModelProvider | undefined;
  providerStatus: "loading" | "loaded" | "unavailable";
  retryProvider: () => void;
  byok: ByokKeys;
  byokStatus: "loading" | "loaded" | "unavailable";
  harness: CodexHarnessInfo;
  harnessStatus: "loading" | "loaded" | "unavailable";
  retryHarness: () => void;
  setHarness: (next: CodexHarnessInfo) => void;
  save: (next: ModelProvider) => Promise<void>;
  status: RowStatus;
  writable: boolean;
};

const RoutingStateContext = createContext<RoutingState>({
  provider: undefined,
  providerStatus: "loading",
  retryProvider: () => {},
  byok: EMPTY_BYOK,
  byokStatus: "loading",
  harness: { configured: false },
  harnessStatus: "loading",
  retryHarness: () => {},
  setHarness: () => {},
  save: async () => {},
  status: null,
  writable: false,
});

/** Owns the routing state (selection + connected credentials) for the whole page, so the provider cards
 *  AND the model picker read one consistent view — the picker restricts to what the selection can run. */
function RoutingStateProvider({ children }: { children: ReactNode }) {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const writable = isTenantWritable(selected);

  const [provider, setProvider] = useState<ModelProvider | undefined>(undefined);
  const [providerStatus, setProviderStatus] = useState<"loading" | "loaded" | "unavailable">("loading");
  const [providerReload, setProviderReload] = useState(0);
  const persisted = useRef<ModelProvider>("managed");
  const [byok, setByok] = useState<ByokKeys>(EMPTY_BYOK);
  const [byokStatus, setByokStatus] = useState<"loading" | "loaded" | "unavailable">("loading");
  const [harness, setHarness] = useState<CodexHarnessInfo>({ configured: false });
  const [harnessStatus, setHarnessStatus] = useState<"loading" | "loaded" | "unavailable">("loading");
  const [harnessReload, setHarnessReload] = useState(0);
  const [status, setStatus] = useState<RowStatus>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic save sequence: only the LATEST save's response may apply. Without it, two quick clicks can
  // resolve out of order and the older response wins, resetting provider/persisted to the older choice.
  const saveSeq = useRef(0);

  useEffect(() => {
    const reqTenant = selected?.tenantId ?? null;
    setProvider(undefined);
    setProviderStatus("loading");
    setStatus(null);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    persisted.current = "managed";
    // Take a seq slot for this load and thereby INVALIDATE any in-flight save (e.g. from an A→B→A tenant
    // round-trip): a stale PUT response can no longer beat this GET and mark itself 'Saved' over it.
    const seq = ++saveSeq.current;
    fetch(modelProviderUrl(selected), { credentials: "include", cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`Provider load failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (seq !== saveSeq.current || !isCurrentTenant(reqTenant)) return;
        const next = normalizeProvider(data?.provider);
        persisted.current = next;
        setProvider(next);
        setProviderStatus("loaded");
      })
      .catch(() => {
        if (seq === saveSeq.current && isCurrentTenant(reqTenant)) {
          setProvider(undefined);
          setProviderStatus("unavailable");
        }
      });
  }, [selected, isCurrentTenant, providerReload]);

  useEffect(() => {
    const reqTenant = selected?.tenantId ?? null;
    setByok(EMPTY_BYOK);
    setByokStatus("loading");
    // BYOK company keys are TENANT-scoped.
    const cfg = (v: unknown) => Boolean((v as { configured?: boolean } | undefined)?.configured);
    fetch(routerIntegrationsUrl(selected), { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (!isCurrentTenant(reqTenant)) return;
        if (!data) {
          setByokStatus("unavailable");
          return;
        }
        setByok({ openrouter: cfg(data.openrouter), openai: cfg(data.openai) });
        setByokStatus("loaded");
      })
      .catch(() => {
        if (isCurrentTenant(reqTenant)) setByokStatus("unavailable");
      });
  }, [selected, isCurrentTenant]);

  useEffect(() => {
    const reqTenant = selected?.tenantId ?? null;
    setHarness({ configured: false });
    setHarnessStatus("loading");
    // The Codex harness is PERSONAL — it is NOT tenant-scoped, so it rides the viewer's own (legacy)
    // integrations payload regardless of the selected tenant. The tenant-scoped route above does not
    // return codex_harness, so reading it there always showed "Not connected".
    fetch(apiUrl("/dashboard/integrations"), { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (!isCurrentTenant(reqTenant)) return;
        if (!data) {
          setHarnessStatus("unavailable");
          return;
        }
        setHarness(normalizeCodexHarnessInfo(data.codex_harness));
        setHarnessStatus("loaded");
      })
      .catch(() => {
        if (isCurrentTenant(reqTenant)) setHarnessStatus("unavailable");
      });
  }, [selected, isCurrentTenant, harnessReload]);

  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);

  const save = async (next: ModelProvider) => {
    const reqTenant = selected?.tenantId ?? null;
    setProvider(next);
    setStatus({ state: "saving" });
    if (clearTimer.current) clearTimeout(clearTimer.current);
    const seq = ++saveSeq.current;
    try {
      const response = await fetch(modelProviderUrl(selected), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      if (response.status === 403) throw new Error("Organization admins manage this setting.");
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const data = (await response.json()) as { provider?: string };
      // Drop stale responses: a newer save started after this one; its response is authoritative.
      if (seq !== saveSeq.current || !isCurrentTenant(reqTenant)) return;
      const saved = normalizeProvider(data.provider);
      persisted.current = saved;
      setProvider(saved);
      setProviderStatus("loaded");
      setStatus({ state: "saved" });
      clearTimer.current = setTimeout(() => setStatus(null), 2000);
    } catch (error) {
      if (seq !== saveSeq.current || !isCurrentTenant(reqTenant)) return;
      setStatus({ state: "error", message: error instanceof Error ? error.message : "Save failed" });
      // Re-fetch the server truth instead of blind-rolling-back to persisted.current: an EARLIER save may
      // have committed after our snapshot of persisted (its response was dropped as stale), so the local
      // rollback target can be wrong. Fall back to the local value only if this fetch also fails.
      try {
        const r = await fetch(modelProviderUrl(selected), { credentials: "include", cache: "no-store" });
        const data = r.ok ? ((await r.json()) as { provider?: string }) : undefined;
        if (seq !== saveSeq.current || !isCurrentTenant(reqTenant)) return;
        const actual = data ? normalizeProvider(data.provider) : persisted.current;
        persisted.current = actual;
        setProvider(actual);
      } catch {
        if (seq === saveSeq.current && isCurrentTenant(reqTenant)) setProvider(persisted.current);
      }
    }
  };

  // What a run resolves to: the explicit selection, or the automatic priority Codex > BYOK > managed.
  const value = useMemo<RoutingState>(
    () => ({
      provider,
      providerStatus,
      retryProvider: () => setProviderReload((value) => value + 1),
      byok,
      byokStatus,
      harness,
      harnessStatus,
      retryHarness: () => setHarnessReload((value) => value + 1),
      setHarness,
      save,
      status,
      writable,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save is recreated per render but only closes over refs/state above
    [provider, providerStatus, byok, byokStatus, harness, harnessStatus, status, writable],
  );

  return <RoutingStateContext.Provider value={value}>{children}</RoutingStateContext.Provider>;
}

const PROVIDER_CARDS: Array<{ value: ModelProvider; title: string; desc: string }> = [
  {
    value: "codex",
    title: "Codex",
    desc: "Your ChatGPT subscription. Applies to PRs you author.",
  },
  {
    value: "byok",
    title: "BYOK",
    desc: "Your API keys. Billed infra-only.",
  },
  {
    value: "managed",
    title: "Jina managed",
    desc: "Jina's models, metered as credits.",
  },
];

/** Provider selector: three cards (Codex / BYOK / Jina managed), each connectable in place. Runs route
 *  by the selection, and the BYOK card reports which keys are present so an unusable selection is
 *  visible before it is chosen. */
function RoutingSection() {
  const {
    provider,
    providerStatus,
    retryProvider,
    byok,
    byokStatus,
    harness,
    harnessStatus,
    retryHarness,
    setHarness,
    save,
    status,
    writable,
  } = useContext(RoutingStateContext);

  return (
    <ModelsSection
      label="Provider"
      subtitle="Where reviews run. Jina managed until you select."
    >
      {!writable ? (
        <p className="tenant-gate-note">Managed by org admins.</p>
      ) : null}
      {providerStatus === "unavailable" ? (
        <div className="notice notice--bad" role="status">
          Could not load the saved provider, so routing has not been assumed.{" "}
          <button
            type="button"
            className="routing-opt__connect routing-opt__retry"
            onClick={retryProvider}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div className="routing-options" role="radiogroup" aria-label="Provider">
        {PROVIDER_CARDS.map((opt) => {
          const active = provider === opt.value;
          return (
            <div
              key={opt.value}
              id={opt.value === "codex" ? "codex-provider" : undefined}
              className={`routing-opt${active ? " routing-opt--active" : ""}`}
            >
              {/* Only the radio row is a label — connect buttons/links below must NOT activate the radio
                  (connecting a credential is not selecting the provider). */}
              <label className="routing-opt__main">
                <input
                  type="radio"
                  name="routing-provider"
                  className="routing-opt__radio"
                  checked={active}
                  disabled={provider === undefined || !writable}
                  onChange={() => void save(opt.value)}
                />
                <span className="routing-opt__body">
                  <span className="routing-opt__title">
                    {opt.title}
                    {opt.value === "codex" && harness.configured ? (
                      harness.reconnect_required ? (
                        <span className="routing-opt__warning">Reconnect required</span>
                      ) : (
                        <span className="routing-opt__ok">Connected</span>
                      )
                    ) : null}
                  </span>
                  <span className="routing-opt__desc">{opt.desc}</span>
                </span>
              </label>
              {opt.value === "codex" ? (
                <div className="routing-opt__extra">
                  {harnessStatus === "loaded" ? (
                    <CodexCard info={harness} onChanged={setHarness} />
                  ) : harnessStatus === "unavailable" ? (
                    <span className="routing-opt__loading">
                      Could not check the Codex connection.{" "}
                      <button
                        type="button"
                        className="routing-opt__connect routing-opt__retry"
                        onClick={retryHarness}
                      >
                        Retry
                      </button>
                    </span>
                  ) : (
                    <span className="routing-opt__loading">Checking Codex connection…</span>
                  )}
                </div>
              ) : null}
              {opt.value === "byok" ? (
                <div className="routing-opt__extra routing-opt__keys">
                  {byokStatus === "loading" ? (
                    <span className="routing-opt__loading">Checking provider keys…</span>
                  ) : byokStatus === "unavailable" ? (
                    <span className="routing-opt__loading">
                      Could not check provider keys.{" "}
                      <a href="/integrations">Manage integrations</a>
                    </span>
                  ) : (
                    <>
                      <span className="routing-opt__key">
                        OpenRouter{" "}
                        {byok.openrouter ? (
                          <span className="routing-opt__ok">Connected</span>
                        ) : (
                          <a href="/integrations" className="routing-opt__connect">
                            Connect →
                          </a>
                        )}
                      </span>
                      <span className="routing-opt__key">
                        OpenAI{" "}
                        {byok.openai ? (
                          <span className="routing-opt__ok">Connected</span>
                        ) : (
                          <a href="/integrations" className="routing-opt__connect">
                            Connect →
                          </a>
                        )}
                      </span>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <RowStatusText status={status} />
    </ModelsSection>
  );
}

/* ---------- Review triggers (per-tenant: automatic or @usejina-only) ---------- */

type ReviewTriggerMode = "every_commit" | "first_commit" | "manual_only";

function normalizeReviewTriggerMode(value: unknown): ReviewTriggerMode {
  return value === "first_commit" || value === "manual_only" ? value : "every_commit";
}

/** Review-trigger endpoint for the active tenant, or the legacy viewer-scoped route. */
function reviewTriggerUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/review-trigger`)
    : apiUrl("/dashboard/review-trigger");
}

const TRIGGER_OPTIONS: Array<{ value: ReviewTriggerMode; title: string; desc: string }> = [
  {
    value: "every_commit",
    title: "Every update",
    desc: "Review on open and on every push.",
  },
  {
    value: "first_commit",
    title: "First commit only",
    desc: "Review on open. Pushes don't re-trigger.",
  },
  {
    value: "manual_only",
    title: "Manual trigger only",
    desc: "Review only when @usejina is mentioned in a PR comment.",
  },
];

function ReviewTriggersSection() {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const writable = isTenantWritable(selected);
  // undefined = loading; otherwise the persisted mode.
  const [mode, setMode] = useState<ReviewTriggerMode | undefined>(undefined);
  const [status, setStatus] = useState<RowStatus>(null);
  // Last server-confirmed mode — the rollback target for a failed save.
  const persisted = useRef<ReviewTriggerMode>("every_commit");
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    setMode(undefined);
    setStatus(null);
    persisted.current = "every_commit";
    if (clearTimer.current) clearTimeout(clearTimer.current);
    fetch(reviewTriggerUrl(selected), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!isCurrentTenant(requestTenantId)) return;
        const next = normalizeReviewTriggerMode(data?.mode);
        persisted.current = next;
        setMode(next);
      })
      .catch(() => {
        if (isCurrentTenant(requestTenantId)) setMode("every_commit");
      });
  }, [selected, isCurrentTenant]);

  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  const save = async (next: ReviewTriggerMode) => {
    const requestTenantId = selected?.tenantId ?? null;
    setMode(next);
    setStatus({ state: "saving" });
    if (clearTimer.current) clearTimeout(clearTimer.current);
    try {
      const response = await fetch(reviewTriggerUrl(selected), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (response.status === 403) throw new Error("Organization admins manage this setting.");
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const data = (await response.json()) as { mode?: string };
      if (!isCurrentTenant(requestTenantId)) return;
      const saved = normalizeReviewTriggerMode(data.mode);
      persisted.current = saved;
      setMode(saved);
      setStatus({ state: "saved" });
      clearTimer.current = setTimeout(() => setStatus(null), 2000);
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setMode(persisted.current);
      setStatus({ state: "error", message: error instanceof Error ? error.message : "Save failed" });
    }
  };

  return (
    <ModelsSection
      label="Review triggers"
      subtitle="When Jina reviews a pull request."
    >
      {!writable ? (
        <p className="tenant-gate-note">Managed by org admins.</p>
      ) : null}
      <div className="trigger-options" role="radiogroup" aria-label="Review trigger mode">
        {TRIGGER_OPTIONS.map((option) => {
          const active = mode === option.value;
          return (
            <label
              key={option.value}
              className={`trigger-option${active ? " trigger-option--active" : ""}`}
            >
              <input
                type="radio"
                name="review-trigger-mode"
                className="trigger-option__radio"
                checked={active}
                disabled={mode === undefined || !writable}
                onChange={() => void save(option.value)}
              />
              <span className="trigger-option__body">
                <span className="trigger-option__title">{option.title}</span>
                <span className="trigger-option__desc">{option.desc}</span>
              </span>
            </label>
          );
        })}
      </div>
      <RowStatusText status={status} />
    </ModelsSection>
  );
}

/** A labelled section card matching the app's `.section` shell. */
function ModelsSection({ id, label, subtitle, children }: { id?: string; label: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <section className="section" id={id}>
      <div className="section__title">{label}</div>
      {subtitle ? <p className="models-section__subtitle">{subtitle}</p> : null}
      {children}
    </section>
  );
}

/* ---------- 1. Review defaults ---------- */

const STAGES: Array<{
  key: "planner_model" | "investigation_model" | "review_model" | "context_model";
  effortKey: "planner_effort" | "investigation_effort" | "review_effort" | "context_effort";
  defaultKey: keyof StageDefaults;
  defaultEffort: ReasoningEffort;
  title: string;
  description: string;
}> = [
  {
    key: "planner_model",
    effortKey: "planner_effort",
    defaultKey: "planner",
    defaultEffort: "medium",
    title: "Planner model",
    description: "Plans investigation areas.",
  },
  {
    key: "investigation_model",
    effortKey: "investigation_effort",
    defaultKey: "investigation",
    defaultEffort: "medium",
    title: "Investigation model",
    description: "Runs the investigation agents.",
  },
  {
    key: "review_model",
    effortKey: "review_effort",
    defaultKey: "review",
    defaultEffort: "medium",
    title: "Review model",
    description: "Writes the published review.",
  },
  {
    key: "context_model",
    effortKey: "context_effort",
    defaultKey: "context",
    defaultEffort: "low",
    title: "Context generation model",
    description: "Builds and updates grounded repository context.",
  },
];

type RowStatus = { state: "saving" } | { state: "saved" } | { state: "error"; message: string } | null;

/** Model-settings endpoint for the active tenant, or the legacy viewer-scoped route. */
function modelSettingsUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/model-settings`)
    : apiUrl("/dashboard/model-settings");
}

/** The models a Codex harness can run, as catalog ids (openai/ + the subscription model names). Derived
 *  from HARNESS_MODEL_OPTIONS so the list can't drift from the harness support set. */
const CODEX_MODEL_IDS: Array<{ id: string; label: string }> = HARNESS_MODEL_OPTIONS.filter(
  (option): option is { value: string; label: string } => option.value !== null,
).map((option) => ({ id: `openai/${option.value}`, label: option.label }));

/** Restrict the catalog to what the EFFECTIVE provider can run:
 *   - codex   -> only the Codex subscription models (stubs are synthesized for ids the public catalog
 *                lacks, e.g. GPT-5.6 codenames, so they stay pickable).
 *   - byok with only an OpenAI key -> only openai/* models.
 *   - anything else (OpenRouter key, managed, loading) -> the full catalog.
 */
function restrictCatalog(
  catalog: CatalogModel[] | null | undefined,
  provider: ModelProvider | undefined,
  byok: ByokKeys,
): CatalogModel[] | null | undefined {
  if (!catalog || provider === undefined) {
    return catalog;
  }
  if (provider === "codex") {
    return CODEX_MODEL_IDS.map(({ id, label }) => {
      const entry = catalog.find((model) => model.id === id);
      return entry ?? { id, name: label, context_length: null, pricing: { prompt_per_1m: null, completion_per_1m: null } };
    });
  }
  if (provider === "byok" && byok.openai && !byok.openrouter) {
    return catalog.filter((model) => model.id.startsWith("openai/"));
  }
  return catalog;
}

function ReviewDefaultsSection() {
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();
  const writable = isTenantWritable(selected);
  const { provider, providerStatus, byok } = useContext(RoutingStateContext);
  const [settings, setSettings] = useState<ModelSettings | undefined>(undefined);
  // undefined = still loading; null = catalog unavailable (degrade to text input).
  const [catalog, setCatalog] = useState<CatalogModel[] | null | undefined>(undefined);
  // True platform-default slugs per stage; null when the API omits them (old build).
  const [defaults, setDefaults] = useState<StageDefaults | null>(null);
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Last settings the server confirmed — the rollback target for a failed save.
  const persisted = useRef<ModelSettings>({
    planner_model: null,
    investigation_model: null,
    review_model: null,
    context_model: null,
    planner_effort: null,
    investigation_effort: null,
    review_effort: null,
    context_effort: null,
    review_fallback_policy: "fail_notify",
    context_fallback_policy: "fail_notify",
  });

  // Re-load the per-stage settings whenever the selected tenant changes. Capture the target tenant so a
  // load initiated under tenant A is dropped if the viewer switches before it resolves (FINDING 3).
  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    setSettings(undefined);
    setStatus({});
    persisted.current = {
      planner_model: null,
      investigation_model: null,
      review_model: null,
      context_model: null,
      planner_effort: null,
      investigation_effort: null,
      review_effort: null,
      context_effort: null,
      review_fallback_policy: "fail_notify",
      context_fallback_policy: "fail_notify",
    };
    for (const timer of Object.values(clearTimers.current)) clearTimeout(timer);
    clearTimers.current = {};
    fetch(modelSettingsUrl(selected), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || !isCurrentTenant(requestTenantId)) return;
        const normalized = normalizeModelSettings(data);
        persisted.current = normalized;
        setSettings(normalized);
      })
      .catch(() => {});
  }, [selected, isCurrentTenant]);

  // The model catalog is global (not tenant-scoped) — load it once.
  useEffect(() => {
    fetch(apiUrl("/dashboard/models"), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const models =
          data && Array.isArray((data as { models?: unknown }).models)
            ? (data as { models: CatalogModel[] }).models
            : null;
        setCatalog(models);
        setDefaults(normalizeStageDefaults((data as { defaults?: unknown } | null)?.defaults));
      })
      .catch(() => setCatalog(null));

    const timers = clearTimers.current;
    return () => {
      for (const timer of Object.values(timers)) clearTimeout(timer);
    };
  }, []);

  const setRowStatus = (key: string, next: RowStatus) => setStatus((prev) => ({ ...prev, [key]: next }));

  // Selecting a value saves immediately, sending the complete settings record atomically.
  const save = async (key: keyof ModelSettings, value: string | null) => {
    if (!settings) return;
    // Capture the tenant this PUT targets so its response is dropped if the viewer switches tenants
    // before it resolves — otherwise tenant A's saved settings would land on tenant B's view (FINDING 3).
    const requestTenantId = selected?.tenantId ?? null;
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (clearTimers.current[key]) clearTimeout(clearTimers.current[key]);
    setRowStatus(key, { state: "saving" });
    try {
      const response = await fetch(modelSettingsUrl(selected), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Invalid model selection");
      }
      if (response.status === 403) throw new Error("Organization admins manage this setting.");
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const saved = normalizeModelSettings(await response.json());
      if (!isCurrentTenant(requestTenantId)) return;
      persisted.current = saved;
      setSettings(saved);
      setRowStatus(key, { state: "saved" });
      clearTimers.current[key] = setTimeout(() => setRowStatus(key, null), 2000);
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      // Roll the optimistic value back to the last server-confirmed settings; the
      // error message stays so the user knows the change didn't stick.
      setSettings(persisted.current);
      setRowStatus(key, { state: "error", message: error instanceof Error ? error.message : "Save failed" });
    }
  };

  // The picker follows the provider selection above: Codex -> subscription models; BYOK with only an
  // OpenAI key -> openai/*; OpenRouter key or Jina managed -> the full catalog.
  const visibleCatalog = restrictCatalog(catalog, provider, byok);
  const routingReady = providerStatus === "loaded";

  return (
    <ModelsSection label="Model defaults">
      {!writable ? (
        <p className="tenant-gate-note">Managed by org admins.</p>
      ) : null}
      {provider === "codex" ? (
        <p className="model-defaults__hint">Showing Codex models.</p>
      ) : provider === "byok" && byok.openai && !byok.openrouter ? (
        <p className="model-defaults__hint">
          Showing <span className="router-mono">openai/*</span> models.{" "}
          <a href="/integrations" className="router-link">Add an OpenRouter key</a> for more.
        </p>
      ) : null}
      <div className="model-defaults">
        {STAGES.map((stage) => (
          <div className="model-default" key={stage.key}>
            <div className="model-default__info">
              <div className="model-default__title">{stage.title}</div>
              <div className="model-default__desc">{stage.description}</div>
            </div>
            <div className="model-default__control">
              <div className="model-default__control-stack">
                <DefaultControl
                  value={settings?.[stage.key] ?? null}
                  catalog={settings === undefined ? undefined : visibleCatalog}
                  defaultSlug={defaults ? defaults[stage.defaultKey] : null}
                  readOnly={!writable || !routingReady}
                  onChange={(value) => void save(stage.key, value)}
                />
                <EffortControl
                  value={settings?.[stage.effortKey] ?? stage.defaultEffort}
                  readOnly={!writable || !routingReady || settings === undefined}
                  onChange={(value) => void save(stage.effortKey, value)}
                />
              </div>
              <RowStatusText status={status[stage.key] ?? status[stage.effortKey] ?? null} />
            </div>
          </div>
        ))}
        <FallbackRow
          title="PR review fallback"
          description="What to do when the selected provider cannot complete a review."
          value={settings?.review_fallback_policy ?? "fail_notify"}
          readOnly={!writable || !routingReady || settings === undefined}
          status={status.review_fallback_policy ?? null}
          onChange={(value) => void save("review_fallback_policy", value)}
        />
        <FallbackRow
          title="Context generation fallback"
          description="What to do when the selected provider cannot build repository context."
          value={settings?.context_fallback_policy ?? "fail_notify"}
          readOnly={!writable || !routingReady || settings === undefined}
          status={status.context_fallback_policy ?? null}
          onChange={(value) => void save("context_fallback_policy", value)}
        />
      </div>
      <p className="model-defaults__hint">
        Managed fallback is used only when explicitly selected and consumes organization credits.
      </p>
    </ModelsSection>
  );
}

const EFFORTS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function EffortControl({
  value,
  readOnly,
  onChange,
}: {
  value: ReasoningEffort;
  readOnly: boolean;
  onChange: (value: ReasoningEffort) => void;
}) {
  return (
    <div className="effort-control" role="group" aria-label="Reasoning effort">
      <span className="effort-control__label">Effort</span>
      {EFFORTS.map((option) => (
        <button
          type="button"
          key={option.label}
          className={`effort-control__option${value === option.value ? " effort-control__option--active" : ""}`}
          disabled={readOnly}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function FallbackRow({
  title,
  description,
  value,
  readOnly,
  status,
  onChange,
}: {
  title: string;
  description: string;
  value: FallbackPolicy;
  readOnly: boolean;
  status: RowStatus;
  onChange: (value: FallbackPolicy) => void;
}) {
  return (
    <div className="model-default">
      <div className="model-default__info">
        <div className="model-default__title">{title}</div>
        <div className="model-default__desc">{description}</div>
      </div>
      <div className="model-default__control">
        <RowStatusText status={status} />
        <select
          className="input fallback-select"
          value={value}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value as FallbackPolicy)}
        >
          <option value="fail_notify">Fail and notify</option>
          <option value="managed">Fall back to Jina managed</option>
        </select>
      </div>
    </div>
  );
}

function RowStatusText({ status }: { status: RowStatus }) {
  if (!status) return null;
  if (status.state === "saving") return <span className="model-default__status cell-meta">Saving…</span>;
  if (status.state === "saved") return <span className="model-default__status cell-meta">Saved</span>;
  return <span className="model-default__status error-text">{status.message}</span>;
}

/** Chooses between loading text, the degraded slug input, and the pill dropdown. */
function DefaultControl({
  value,
  catalog,
  defaultSlug,
  readOnly = false,
  onChange,
}: {
  value: string | null;
  catalog: CatalogModel[] | null | undefined;
  defaultSlug: string | null;
  readOnly?: boolean;
  onChange: (value: string | null) => void;
}) {
  if (catalog === undefined) {
    return <span className="cell-meta">Loading…</span>;
  }
  // Catalog outage: fall back to the free-text slug input.
  if (catalog === null) {
    return <SlugFallbackInput value={value} readOnly={readOnly} onChange={onChange} />;
  }
  return <ModelDropdown value={value} catalog={catalog} defaultSlug={defaultSlug} readOnly={readOnly} onChange={onChange} />;
}

/**
 * Degraded free-text slug entry used when the catalog can't be loaded. Saves
 * only on Enter or blur (never per keystroke) so half-typed prefixes like
 * "openai/" don't spam the API with 400s. The value is trimmed and an unchanged
 * value is a no-op.
 */
function SlugFallbackInput({
  value,
  readOnly = false,
  onChange,
}: {
  value: string | null;
  readOnly?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");

  // Keep the field in sync when the persisted value changes (e.g. a save that
  // normalized the slug, or a rollback after a failed save).
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    setDraft(trimmed);
    if (next !== value) onChange(next);
  };

  return (
    <div className="model-slug-fallback">
      <input
        className="input model-slug-fallback__input"
        type="text"
        spellCheck={false}
        placeholder="openai/gpt-5.5"
        value={draft}
        disabled={readOnly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={readOnly ? undefined : commit}
        onKeyDown={(event) => {
          if (readOnly) return;
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <span className="model-slug-fallback__hint">Catalog unavailable — enter a slug (e.g. openai/gpt-5.5).</span>
    </div>
  );
}

/* ---------- Compact dropdown pill + popover ---------- */

/** Approximate rendered width of the pricing hover-card; used for the flip test. */
const HOVERCARD_WIDTH = 240;

/** Which step of the two-step picker is showing. */

/** A navigable row in whichever level is on show. */
/** ONE flat, searchable model list — no provider drill-down, no "Jina default" row. An unset stage
 *  displays the platform default's MODEL as its selection; picking any row saves that model. Each stage's
 *  selector is independent — only the Provider selection above restricts the shared catalog. */
function ModelDropdown({
  value,
  catalog,
  defaultSlug,
  readOnly = false,
  onChange,
}: {
  value: string | null;
  catalog: CatalogModel[];
  defaultSlug: string | null;
  readOnly?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [flip, setFlip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const { visible, remaining } = useMemo(() => truncateCatalog(catalog, query), [catalog, query]);
  const highlightedModel = visible[highlight] ?? null;
  // What this stage runs right now: the explicit pick, or the platform default's model.
  const displaySlug = value ?? defaultSlug;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  // Decide which side the hover-card sits on: flip it left when a right-side
  // card would spill past the viewport's right edge.
  useLayoutEffect(() => {
    if (!open || !popRef.current) return;
    const rect = popRef.current.getBoundingClientRect();
    setFlip(shouldFlipHoverCard(rect.right, HOVERCARD_WIDTH, window.innerWidth));
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  const pick = (model: CatalogModel) => {
    onChange(model.id);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((prev) => Math.min(prev + 1, visible.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = visible[highlight];
      if (model) pick(model);
    }
  };

  return (
    <div className="model-pill-wrap" ref={containerRef}>
      <button
        type="button"
        className="model-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={readOnly}
        onClick={() => {
          if (readOnly) return;
          if (open) close();
          else setOpen(true);
        }}
      >
        <ProviderIcon slug={displaySlug} />
        <span className="model-pill__name">{displaySlug ? pillLabel(displaySlug, catalog) : "Select model"}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="model-pop" role="listbox" ref={popRef}>
          <input
            ref={searchRef}
            className="input model-pop__search"
            type="text"
            autoFocus
            spellCheck={false}
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="model-pop__list">
            {visible.map((model, index) => {
              const active = model.id === displaySlug;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`model-pop__opt${index === highlight ? " model-pop__opt--hl" : ""}${active ? " model-pop__opt--active" : ""}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(model)}
                >
                  <ProviderIcon slug={model.id} />
                  <span className="model-pop__opt-name">{shortModelName(model)}</span>
                  {active ? <CheckGlyph /> : null}
                  <span className="model-pop__opt-id">{model.id}</span>
                </button>
              );
            })}
            {visible.length === 0 ? <div className="model-pop__empty">No matching models</div> : null}
            {remaining > 0 ? <div className="model-pop__more">{remaining} more — refine your search</div> : null}
          </div>

          {highlightedModel ? <ModelHoverCard model={highlightedModel} flip={flip} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pricing side-panel shown beside a highlighted dropdown option: provider icon +
 * display name, formatted context length, and per-1M input/output prices. Any of
 * these may be missing (older API without pricing/context) — the card shows what
 * it has, or "Pricing unavailable" when it has neither. `flip` moves it to the
 * left of the popover when a right-side placement would overflow the viewport.
 */
function ModelHoverCard({ model, flip }: { model: CatalogModel; flip: boolean }) {
  const context = formatContextLength(model.context_length);
  const input = formatPer1mPrice(model.pricing?.prompt_per_1m);
  const output = formatPer1mPrice(model.pricing?.completion_per_1m);
  const hasPricing = Boolean(input || output);

  return (
    <div className={`model-hovercard${flip ? " model-hovercard--left" : ""}`} role="tooltip" aria-hidden="true">
      <div className="model-hovercard__head">
        <ProviderIcon slug={model.id} />
        <span className="model-hovercard__name">{shortModelName(model)}</span>
      </div>
      {context ? (
        <div className="model-hovercard__row">
          <span className="model-hovercard__label">Context length</span>
          <span className="model-hovercard__value">{context}</span>
        </div>
      ) : null}
      {hasPricing ? (
        <div className="model-hovercard__prices">
          <div className="model-hovercard__prices-label">Cost (per 1M tokens)</div>
          <div className="model-hovercard__row">
            <span className="model-hovercard__label">Input</span>
            <span className="model-hovercard__value">{input ?? "—"}</span>
          </div>
          <div className="model-hovercard__row">
            <span className="model-hovercard__label">Output</span>
            <span className="model-hovercard__value">{output ?? "—"}</span>
          </div>
        </div>
      ) : null}
      {!context && !hasPricing ? <div className="model-hovercard__empty">Pricing unavailable</div> : null}
    </div>
  );
}

/* ---------- Codex harness connect control (rendered inside the router ★ rung) ---------- */

function CodexCard({
  info,
  onChanged,
}: {
  info: CodexHarnessInfo;
  onChanged: (next: CodexHarnessInfo) => void;
}) {
  // The connect experience lives in a centered modal (capy-style). The card only opens it.
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [freshReconnect, setFreshReconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { selected } = useTenant();
  const isCurrentTenant = useTenantFence();

  // Only an actual tenant change invalidates a pending credential action. `useTenantFence` changes
  // identity during harmless viewer/session refreshes (including returning from another browser
  // tab), so depending on it here used to make the modal disappear mid-sign-in.
  const previousTenantId = useRef(selected?.tenantId ?? null);
  useEffect(() => {
    const nextTenantId = selected?.tenantId ?? null;
    if (previousTenantId.current === nextTenantId) return;
    previousTenantId.current = nextTenantId;
    setModalOpen(false);
    setBusy(null);
    setConfirmDisconnect(false);
    setFreshReconnect(false);
    setError(null);
    setMessage(null);
  }, [selected?.tenantId]);

  const cancelDeviceSignIn = () => {
    const tenantId = selected?.tenantId;
    const flow = tenantId ? loadCodexDeviceFlow(tenantId) : null;
    if (flow) {
      reportCodexConnectEvent({
        event: "flow_cancelled",
        flow_id: flow.flowId,
        stage: "ui",
        reason: "user_cancelled",
        elapsed_ms: Math.max(0, Date.now() - flow.startedAtMs),
      });
      clearCodexDeviceFlow(flow.flowId);
    }
    setModalOpen(false);
    setFreshReconnect(false);
    setError(null);
  };

  // Success handler for either connect path (device or manual): mark connected. The modal
  // stays open and flips to its in-place connected state (capy transitions in place); the
  // card underneath is now connected too, so closing the modal reveals the connected card.
  const markConnected = useCallback((next: CodexHarnessInfo) => {
    onChanged(next);
    setFreshReconnect(false);
    setError(null);
    setMessage("Connected");
  }, [onChanged]);

  /**
   * A reconnect is a clean replacement, not an update layered over the rejected credential. This
   * deliberately mirrors the manual disconnect + connect sequence that proved reliable in
   * production, while keeping it behind one user action.
   */
  const beginReconnect = async () => {
    const requestTenantId = selected?.tenantId ?? null;
    setBusy("connect");
    setError(null);
    setMessage("Preparing a fresh Codex sign-in…");
    const existing = selected?.tenantId ? loadCodexDeviceFlow(selected.tenantId) : null;
    if (existing) clearCodexDeviceFlow(existing.flowId);
    try {
      const response = await fetch(apiUrl("/dashboard/integrations"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codex_harness_auth: "" }),
      });
      if (!response.ok) throw new Error(`Reset failed (${response.status})`);
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(normalizeCodexHarnessInfo(data.codex_harness));
      setFreshReconnect(true);
      setMessage(null);
      setModalOpen(true);
    } catch (resetError) {
      if (!isCurrentTenant(requestTenantId)) return;
      setMessage(resetError instanceof Error ? resetError.message : "Could not reset the Codex connection");
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  const post = async (value: string, mode: "connect" | "disconnect") => {
    const requestTenantId = selected?.tenantId ?? null;
    // Give instant, local feedback before the API roundtrip on connect.
    if (mode === "connect") {
      const check = precheckCodexAuth(value);
      if (!check.ok) {
        setError(check.reason);
        setMessage(null);
        return;
      }
    }
    setBusy(mode);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(apiUrl("/dashboard/integrations"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codex_harness_auth: value }),
      });
      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "That auth.json wasn't accepted.");
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(normalizeCodexHarnessInfo(data.codex_harness));
      setConfirmDisconnect(false);
      setMessage(mode === "disconnect" ? "Disconnected" : "Connected");
      // Disconnecting empties the connection — leave the modal (nothing left to show there).
      if (mode === "disconnect") setModalOpen(false);
    } catch (postError) {
      if (!isCurrentTenant(requestTenantId)) return;
      setError(postError instanceof Error ? postError.message : "Save failed");
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  return (
    <div className="harness-connect">
      <div className="harness-connect__row">
        {info.configured ? (
          <>
            {info.reconnect_required ? (
              <>
                <Badge tone="bad">Reconnect required</Badge>
                <span className="cell-meta">OpenAI rejected the saved sign-in.</span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void beginReconnect()}
                  disabled={busy !== null}
                >
                  {busy === "connect" ? "Preparing…" : "Reconnect"}
                </button>
              </>
            ) : (
              <>
                <Badge tone="ok">Connected</Badge>
                <span className="cell-meta">
                  {info.connected_at ? `Connected ${formatDate(info.connected_at)}` : "Connected"}
                </span>
              </>
            )}
            {confirmDisconnect ? (
              <span className="sub-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => void post("", "disconnect")} disabled={busy !== null}>
                  {busy === "disconnect" ? "Disconnecting…" : "Are you sure?"}
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDisconnect(false)} disabled={busy !== null}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy !== null}>
                Disconnect
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              setModalOpen(true);
              setError(null);
              setMessage(null);
            }}
          >
            Connect
          </button>
        )}
        {message && !modalOpen ? <span className="cell-meta">{message}</span> : null}
      </div>

      {modalOpen ? (
        <CodexConnectModal
          info={info}
          busy={busy}
          error={error}
          freshReconnect={freshReconnect}
          onConnected={markConnected}
          onManualConnect={(value) => void post(value, "connect")}
          onDisconnect={() => void post("", "disconnect")}
          onCancel={cancelDeviceSignIn}
          onClose={() => {
            setModalOpen(false);
            setFreshReconnect(false);
            setError(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Centered modal (capy "Connect Codex" replica) that hosts the device-code handshake. A dimmed
 * backdrop covers the page; the dialog is centered. An active sign-in is intentionally not
 * dismissible by backdrop click or Escape — cancellation is an explicit action. The
 * body is either the numbered device-code steps + manual fallback (not yet connected) or an
 * in-place connected success state — the transition happens without leaving the modal.
 */
function CodexConnectModal({
  info,
  busy,
  error,
  freshReconnect,
  onConnected,
  onManualConnect,
  onDisconnect,
  onCancel,
  onClose,
}: {
  info: CodexHarnessInfo;
  busy: "connect" | "disconnect" | null;
  error: string | null;
  freshReconnect: boolean;
  onConnected: (info: CodexHarnessInfo) => void;
  onManualConnect: (auth: string) => void;
  onDisconnect: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const reconnecting = freshReconnect || (info.configured && info.reconnect_required);
  const connected = codexModalCanDismiss(info.configured, info.reconnect_required === true);

  return (
    <div className="codex-modal" role="dialog" aria-modal="true" aria-labelledby="codex-modal-title">
      <div className="codex-modal__backdrop" aria-hidden="true" />
      <div className="codex-modal__dialog">
        {connected ? (
          <button type="button" className="codex-modal__close" aria-label="Close" onClick={onClose}>
            <CloseGlyph />
          </button>
        ) : null}
        <div className="codex-modal__head">
          <h2 id="codex-modal-title" className="codex-modal__title">
            {reconnecting ? "Reconnect Codex" : "Connect Codex"}
          </h2>
          <p className="codex-modal__subtitle">Route OpenAI models through your ChatGPT subscription</p>
        </div>
        <div className="codex-modal__body">
          {connected ? (
            <CodexConnectedPanel info={info} busy={busy} onDisconnect={onDisconnect} />
          ) : (
            <>
              {reconnecting ? (
                <div className="notice notice--bad">
                  Your saved Codex sign-in expired. Sign in again to resume reviews on your ChatGPT subscription.
                </div>
              ) : null}
              {/* Primary path: integrated device-code flow — no local `codex login` needed. */}
              <CodexDeviceFlow onConnected={onConnected} />

              {/* Fallback for users whose org blocks device auth, or who prefer to paste credentials. */}
              <CodexManualFallback busy={busy} error={error} onConnect={onManualConnect} />

              <p className="codex-modal__note cell-meta">
                Connecting uses your ChatGPT subscription for reviews of PRs you author. This is an unofficial
                integration and may stop working if OpenAI changes their auth.
              </p>
              <div className="codex-modal__footer">
                <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
                  Cancel sign-in
                </button>
                <span className="cell-meta">You can safely switch tabs while this stays open.</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** In-place connected success state shown inside the modal after a successful handshake. */
function CodexConnectedPanel({
  info,
  busy,
  onDisconnect,
}: {
  info: CodexHarnessInfo;
  busy: "connect" | "disconnect" | null;
  onDisconnect: () => void;
}) {
  const label = connectedLabel(info.connected_at ? formatDate(info.connected_at) : null);
  return (
    <div className="codex-connected">
      <span className="codex-connected__check" aria-hidden="true">
        <CheckSmallGlyph />
      </span>
      <div className="codex-connected__label">{label}</div>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={onDisconnect}
        disabled={busy !== null}
      >
        {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
      </button>
    </div>
  );
}

/** Collapsed, secondary "paste credentials manually" fallback shown under the device steps. */
function CodexManualFallback({
  busy,
  error,
  onConnect,
}: {
  busy: "connect" | "disconnect" | null;
  error: string | null;
  onConnect: (auth: string) => void;
}) {
  const [showManual, setShowManual] = useState(false);
  const [auth, setAuth] = useState("");
  const precheck = precheckCodexAuth(auth);

  return (
    <div className="codex-fallback">
      <button
        type="button"
        className="codex-fallback__toggle"
        aria-expanded={showManual}
        onClick={() => setShowManual((prev) => !prev)}
      >
        {showManual ? "Hide manual credentials" : "Paste credentials manually instead"}
      </button>
      {showManual ? (
        <div className="codex-fallback__body">
          <p className="sub-card__hint">
            Run <code>codex login</code> on your machine and sign in with ChatGPT, then paste the contents of{" "}
            <code>~/.codex/auth.json</code> below.
          </p>
          <label className="form-field form-field--wide">
            <span className="form-field__label">auth.json contents</span>
            <textarea
              className="textarea"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              rows={6}
              placeholder={'{ "tokens": { … } }'}
              value={auth}
              onChange={(event) => setAuth(event.target.value)}
            />
          </label>
          <p className="cell-meta">
            This content contains sign-in tokens for your ChatGPT account. It is stored encrypted and never shown
            again.
          </p>
          {error ? <span className="error-text">{error}</span> : null}
          <div className="sub-card__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => onConnect(auth.trim())}
              disabled={busy !== null || !precheck.ok}
            >
              {busy === "connect" ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Browser-side Codex device-code connect flow.
 *
 * The ENTIRE OpenAI device handshake runs here in the user's browser: auth.openai.com answers our
 * cross-origin requests with `access-control-allow-origin: *`, whereas our server's POSTs are blocked
 * by Cloudflare's TLS-fingerprint challenge. On mount it fetches a user_code directly from OpenAI,
 * shows the numbered steps + a copy button, polls the token endpoint at the returned interval, then
 * (on approval) exchanges the code for tokens, assembles auth.json, and POSTs ONLY that blob to our
 * existing encrypted /dashboard/integrations endpoint. No token material touches our server until
 * the final assembled auth.json.
 */
type DeviceFlowState =
  | { phase: "starting" }
  | { phase: "waiting"; flow: StoredCodexDeviceFlow }
  | { phase: "error"; reason: string; message: string };

/** Build the error phase from a handshake reason, resolving its user-facing message once. */
function deviceError(reason: string): DeviceFlowState {
  return { phase: "error", reason, message: handshakeErrorMessage(reason) };
}

// OpenAI caps the whole device login at 15 minutes.
const CODEX_FLOW_TTL_MS = 15 * 60 * 1000;

// How long an unbroken run of "not approved yet" is allowed before the likely cause is named.
// Long enough to cover reading the steps, switching tab, and signing in; far short of the expiry,
// which is the only other feedback the flow would otherwise ever give.
const CODEX_STALL_HINT_MS = 90 * 1000;

/** POST form-urlencoded to OpenAI. Body triggers a CORS preflight which OpenAI answers. */
async function openaiJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function CodexDeviceFlow({ onConnected }: { onConnected: (info: CodexHarnessInfo) => void }) {
  const [state, setState] = useState<DeviceFlowState>({ phase: "starting" });
  const [stalled, setStalled] = useState(false);
  const [copied, setCopied] = useState(false);
  const activeRef = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { selected } = useTenant();
  const currentFence = useTenantFence();
  const currentFenceRef = useRef(currentFence);
  currentFenceRef.current = currentFence;
  const requestTenantId = useRef<string | null>(null);
  const selectedTenantId = selected?.tenantId ?? null;

  const report = useCallback((flow: Pick<StoredCodexDeviceFlow, "flowId" | "startedAtMs">, event: Omit<Parameters<typeof reportCodexConnectEvent>[0], "flow_id" | "elapsed_ms">) => {
    reportCodexConnectEvent({
      ...event,
      flow_id: flow.flowId,
      elapsed_ms: Math.max(0, Date.now() - flow.startedAtMs),
    });
  }, []);

  const fail = useCallback((
    flow: Pick<StoredCodexDeviceFlow, "flowId" | "startedAtMs">,
    reason: string,
    stage: "ui" | "start" | "poll" | "exchange" | "save",
    details: { http_status?: number; attempt?: number } = {},
  ) => {
    clearCodexDeviceFlow(flow.flowId);
    report(flow, { event: "flow_failed", stage, reason, ...details });
    if (activeRef.current) setState(deviceError(reason));
  }, [report]);

  const start = useCallback(async () => {
    if (!selectedTenantId) {
      setState(deviceError("no_tenant"));
      return;
    }
    const existing = loadCodexDeviceFlow(selectedTenantId);
    if (existing) clearCodexDeviceFlow(existing.flowId);
    const pendingFlow = { flowId: createCodexFlowId(), startedAtMs: Date.now() };
    requestTenantId.current = selectedTenantId;
    setStalled(false);
    setState({ phase: "starting" });
    report(pendingFlow, { event: "flow_started", stage: "start" });
    try {
      const response = await openaiJson(DEVICE_ENDPOINTS.usercode, { client_id: CODEX_CLIENT_ID });
      if (!response.ok) {
        fail(pendingFlow, "start_http_error", "start", { http_status: response.status });
        return;
      }
      const parsed = parseUsercodeResponse(await response.json().catch(() => null));
      if (!parsed) {
        fail(pendingFlow, "start_invalid_response", "start");
        return;
      }
      if (!activeRef.current) return;
      const flow: StoredCodexDeviceFlow = {
        version: 1,
        flowId: pendingFlow.flowId,
        tenantId: selectedTenantId,
        startedAtMs: pendingFlow.startedAtMs,
        start: parsed,
      };
      saveCodexDeviceFlow(flow);
      report(flow, { event: "user_code_received", stage: "start", http_status: response.status });
      setState({ phase: "waiting", flow });
    } catch {
      fail(pendingFlow, "openai_unreachable", "start");
    }
  }, [fail, report, selectedTenantId]);

  // Resume a still-valid device flow after an explicit close/reopen or same-tab navigation. This
  // avoids minting a different code while the user is approving the one already on screen.
  useEffect(() => {
    activeRef.current = true;
    if (!selectedTenantId) {
      setState(deviceError("no_tenant"));
    } else {
      requestTenantId.current = selectedTenantId;
      const stored = loadCodexDeviceFlow(selectedTenantId);
      if (stored) {
        report(stored, { event: "flow_resumed", stage: "ui" });
        setState({ phase: "waiting", flow: stored });
      } else {
        void start();
      }
    }
    return () => {
      activeRef.current = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [report, selectedTenantId, start]);

  // Poll OpenAI while waiting for the user to approve the code. A single self-scheduling chain
  // (setTimeout at the server interval); 403/404 = pending (keep polling), 200 = run the exchange +
  // persist, other statuses end the chain with an error. Times out at the 15-minute TTL.
  useEffect(() => {
    if (state.phase !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Consecutive fetch THROWS (TypeError = CORS/network/Cloudflare challenge, distinct from an
    // app-level 403 "pending" which resolves normally). A run of these means the browser genuinely
    // can't reach OpenAI's approval service — surface it instead of spinning as fake-pending forever.
    let hardFailures = 0;
    const MAX_HARD_FAILURES = 6;
    const { flow } = state;
    const { deviceAuthId, userCode, intervalSeconds, expiresAtMs } = flow.start;
    const delayMs = boundedInterval(intervalSeconds) * 1000;
    const deadline = Math.min(flow.startedAtMs + CODEX_FLOW_TTL_MS, expiresAtMs ?? Number.POSITIVE_INFINITY);
    let attempt = 0;

    const onVisibilityChange = () => {
      report(flow, {
        event: "visibility_changed",
        stage: "ui",
        visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
      });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Approved: exchange the authorization code for tokens, assemble auth.json, persist it.
    const finish = async (code: { authorizationCode: string; codeVerifier: string }) => {
      let authJson: string;
      try {
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_CLIENT_ID,
          code: code.authorizationCode,
          code_verifier: code.codeVerifier,
          redirect_uri: DEVICE_ENDPOINTS.redirectUri,
        });
        const tokenResponse = await fetch(DEVICE_ENDPOINTS.oauthToken, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        if (!tokenResponse.ok) {
          fail(flow, "exchange_http_error", "exchange", { http_status: tokenResponse.status, attempt });
          return;
        }
        const tokens = parseOAuthTokens(await tokenResponse.json().catch(() => null));
        if (!tokens) {
          fail(flow, "exchange_invalid_response", "exchange", { attempt });
          return;
        }
        const accountId = decodeAccountId(tokens.idToken);
        authJson = assembleAuthJson({ ...tokens, accountId });
        report(flow, { event: "token_exchange_succeeded", stage: "exchange", http_status: tokenResponse.status, attempt });
      } catch {
        if (!cancelled) fail(flow, "exchange_unreachable", "exchange", { attempt });
        return;
      }
      // Persist via our EXISTING encrypted harness endpoint — the only server touchpoint.
      // A fence rejection here means OpenAI accepted the sign-in but the tenant it was for is no
      // longer the selected one, so the credential is deliberately not written. Say so: silently
      // dropping a completed authorization leaves the spinner running with nothing to explain it.
      try {
        if (cancelled) return;
        if (!currentFenceRef.current(requestTenantId.current)) {
          fail(flow, "tenant_changed", "save", { attempt });
          return;
        }
        report(flow, { event: "credential_save_started", stage: "save", attempt });
        const saved = await fetch(apiUrl("/dashboard/integrations"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ codex_harness_auth: authJson, codex_harness_flow_id: flow.flowId }),
        });
        if (!saved.ok) {
          fail(flow, "save_http_error", "save", { http_status: saved.status, attempt });
          return;
        }
        const savedBody = (await saved.json().catch(() => null)) as Record<string, unknown> | null;
        const savedInfo = normalizeCodexHarnessInfo(savedBody?.codex_harness);
        if (!codexConnectionAccepted(savedInfo.configured, savedInfo.reconnect_required === true)) {
          fail(flow, "save_not_effective", "save", { http_status: saved.status, attempt });
          return;
        }
        clearCodexDeviceFlow(flow.flowId);
        report(flow, { event: "credential_save_succeeded", stage: "save", http_status: saved.status, attempt });
        if (!cancelled && currentFenceRef.current(requestTenantId.current)) onConnected(savedInfo);
      } catch {
        if (!cancelled) fail(flow, "save_unreachable", "save", { attempt });
      }
    };

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        fail(flow, "expired", "poll", { attempt });
        return;
      }
      attempt += 1;
      let status: "success" | "pending" | "error" = "pending";
      let code: { authorizationCode: string; codeVerifier: string } | null = null;
      let httpStatus: number | undefined;
      try {
        const response = await openaiJson(DEVICE_ENDPOINTS.token, {
          device_auth_id: deviceAuthId,
          user_code: userCode,
        });
        httpStatus = response.status;
        status = classifyPollStatus(response.status);
        hardFailures = 0; // a real HTTP response (even a 403-pending) means we CAN reach OpenAI
        if (status === "success") {
          code = parseCodeSuccess(await response.json().catch(() => null));
          if (!code) status = "error";
        }
      } catch {
        // A THROW is CORS/network/Cloudflare-challenge, not app-level pending. Tolerate a few
        // (transient), but a sustained run means the browser can't reach auth.openai.com at all.
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          if (!cancelled) fail(flow, "openai_unreachable", "poll", { attempt });
          return;
        }
        status = "pending";
      }
      if (cancelled) return;
      if (status === "success" && code) {
        report(flow, { event: "authorization_approved", stage: "poll", attempt });
        await finish(code);
        return;
      }
      if (status === "error") {
        fail(flow, "poll_http_error", "poll", { attempt, ...(httpStatus ? { http_status: httpStatus } : {}) });
        return;
      }
      timer = setTimeout(() => void poll(), delayMs);
    };

    timer = setTimeout(() => void poll(), delayMs);
    const stallTimer = setTimeout(() => setStalled(true), CODEX_STALL_HINT_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
      clearTimeout(stallTimer);
    };
  }, [fail, onConnected, report, state]);

  const copyCode = (code: string) => {
    const done = () => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(done);
    } else {
      done();
    }
  };

  if (state.phase === "error") {
    // Expired codes can't be retried as-is — the button reads "Generate a new code"; every other
    // failure is a plain "Try again". Both simply restart the handshake.
    const action = handshakeErrorAction(state.reason);
    return (
      <div className="codex-device">
        <p className="notice notice--bad">{state.message}</p>
        <div className="sub-card__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void start()}>
            {action.label}
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "starting") {
    return (
      <div className="codex-device">
        <span className="codex-device__waiting">
          <span className="codex-spinner" aria-hidden="true" />
          Starting secure sign-in…
        </span>
      </div>
    );
  }

  const { flow } = state;
  const info = flow.start;
  const settingsHref = safeHref(CODEX_SECURITY_SETTINGS_URL);
  const verifyHref = safeHref(CODEX_VERIFY_URL);

  return (
    <div className="codex-device">
      <ol className="codex-steps">
        <li className="codex-step">
          <div className="codex-step__body">
            <span className="codex-step__text">Enable device code authorization in your security settings:</span>
            {settingsHref ? (
              <a className="btn btn--sm btn--ghost codex-step__action" href={settingsHref} target="_blank" rel="noreferrer">
                Security settings ↗
              </a>
            ) : null}
          </div>
        </li>
        <li className="codex-step">
          <div className="codex-step__body">
            <span className="codex-step__text">Copy this code:</span>
            <div className="codex-code-box">
              <code className="codex-code-box__value">{info.userCode}</code>
              <button
                type="button"
                className="codex-copy"
                aria-label={copied ? "Copied" : "Copy code"}
                onClick={() => copyCode(info.userCode)}
              >
                {copied ? <CheckSmallGlyph /> : <CopyGlyph />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </li>
        <li className="codex-step">
          <div className="codex-step__body">
            <span className="codex-step__text">Open the verification page and paste the code:</span>
            {verifyHref ? (
              <a
                className="btn btn--sm btn--ghost codex-step__action"
                href={verifyHref}
                target="_blank"
                rel="noreferrer"
                onClick={() => report(flow, { event: "verification_opened", stage: "ui" })}
              >
                Verification page ↗
              </a>
            ) : null}
          </div>
        </li>
      </ol>
      <div className="codex-device__waiting">
        <span className="codex-spinner" aria-hidden="true" />
        Waiting for authentication…
      </div>
      {/* OpenAI returns the same "not yet" response whether approval is pending or can never
          arrive, so a long silence is the only signal that the account setting is off. Say so
          rather than spinning to the 15-minute expiry with nothing to act on. Signing in still
          appears to succeed in that case: the ChatGPT session is created, only the device
          approval is not. */}
      {stalled ? (
        <div className="notice notice--bad codex-device__stalled" role="status">
          No approval seen yet. If you already entered the code and ChatGPT said you were signed
          in, <strong>Device code authorization for Codex</strong> is probably off — the session
          signs in but the approval never reaches us.
          {settingsHref ? (
            <>
              {" "}
              Turn it on in{" "}
              <a href={settingsHref} target="_blank" rel="noreferrer">
                ChatGPT security settings
              </a>
              , then start over. On a managed workspace an admin has to enable it for you.
            </>
          ) : null}
        </div>
      ) : null}
      <p className="codex-device__note cell-meta">
        Still spinning? Enable <strong>Device code authorization for Codex</strong> in your ChatGPT
        security settings <em>first</em> (step 1), then enter the code on the verification page —
        approval silently fails if that setting is off.
      </p>
    </div>
  );
}

/* ---------- 3. Available models ---------- */

function AvailableModelsSection() {
  const [catalog, setCatalog] = useState<CatalogModel[] | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(apiUrl("/dashboard/models"), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const models =
          data && Array.isArray((data as { models?: unknown }).models)
            ? (data as { models: CatalogModel[] }).models
            : null;
        setCatalog(models);
      })
      .catch(() => setCatalog(null));

    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const copySlug = (slug: string) => {
    const done = () => {
      setCopied(slug);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(slug).then(done).catch(done);
    } else {
      done();
    }
  };

  const pagination = useMemo(
    () => (catalog ? paginateCatalog(catalog, query, page) : { visible: [], page: 1, totalPages: 0, totalMatches: 0 }),
    [catalog, query, page],
  );

  useEffect(() => {
    if (page !== pagination.page) setPage(pagination.page);
  }, [page, pagination.page]);

  return (
    <ModelsSection label="Available models">
      <div className="model-search">
        <SearchGlyph />
        <input
          className="model-search__input"
          type="text"
          spellCheck={false}
          placeholder="Search models…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          disabled={catalog === undefined || catalog === null}
        />
      </div>

      {catalog === undefined ? (
        <div className="empty empty--compact">Loading models…</div>
      ) : catalog === null ? (
        <div className="empty empty--compact">The model catalog is unavailable right now.</div>
      ) : pagination.visible.length === 0 ? (
        <div className="empty empty--compact">No matching models</div>
      ) : (
        <div className="model-catalog">
          {pagination.visible.map((model) => (
            <div className="model-catalog__row" key={model.id}>
              <ProviderIcon slug={model.id} />
              <span className="model-catalog__name">{shortModelName(model)}</span>
              {modelPriceLabel(model) ? (
                <span className="model-catalog__price">{modelPriceLabel(model)}</span>
              ) : null}
              <button
                type="button"
                className="model-catalog__id"
                onClick={() => copySlug(model.id)}
                title="Copy model id"
              >
                <span className="model-catalog__id-text">{model.id}</span>
                <span className="model-catalog__copy">{copied === model.id ? "Copied" : "Copy"}</span>
              </button>
            </div>
          ))}
          <nav className="model-pagination" aria-label="Available models pages">
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-label="Previous models page"
              disabled={pagination.page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <span className="model-pagination__status" aria-live="polite">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-label="Next models page"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))}
            >
              Next
            </button>
          </nav>
        </div>
      )}
    </ModelsSection>
  );
}
