"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CODEX_CLIENT_ID,
  CODEX_SECURITY_SETTINGS_URL,
  CODEX_VERIFY_URL,
  DEVICE_ENDPOINTS,
  assembleAuthJson,
  boundedInterval,
  classifyPollStatus,
  decodeAccountId,
  parseCodeSuccess,
  parseOAuthTokens,
  parseUsercodeResponse,
  validCodexAuthJson,
  type UsercodeResponse
} from "../../lib/codex-device-flow.ts";
import {
  disconnectedExecutionSettings,
  executionFallback,
  normalizeExecutionSettings,
  type ExecutionProvider,
  type ExecutionSettings
} from "../../lib/context-graph-execution.ts";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ModelsPage() {
  const [settings, setSettings] = useState<ExecutionSettings>(disconnectedExecutionSettings());
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/context-graph/execution-settings", { cache: "no-store" });
      if (!response.ok) throw new Error(`Settings unavailable (${response.status})`);
      setSettings(normalizeExecutionSettings(await response.json()));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Settings unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaveState("saving");
      setError(null);
      try {
        const response = await fetch("/api/context-graph/execution-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: settings.revision, ...patch })
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : `Save failed (${response.status})`);
        }
        setSettings(normalizeExecutionSettings(body));
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1_800);
        return true;
      } catch (saveError) {
        setSaveState("error");
        setError(saveError instanceof Error ? saveError.message : "Save failed");
        return false;
      }
    },
    [settings.revision]
  );

  const fallback = executionFallback(settings);
  return (
    <section className="models-page">
      <header className="page-heading">
        <div>
          <h1>Models</h1>
          <p>Tenant administrators choose where the assertion agent runs and which model it uses.</p>
        </div>
        <span className={`settings-status settings-status--${saveState}`}>
          {loading ? "Loading…" : saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
        </span>
      </header>

      {error ? <div className="settings-notice settings-notice--error">{error}</div> : null}

      <SettingsPanel
        title="Provider"
        subtitle="Where semantic assertion and causal-analysis sessions run. Jina managed until you select."
      >
        <div className="provider-options" role="radiogroup" aria-label="Assertion provider">
          <ProviderCard
            provider="codex"
            title="Codex"
            description="A tenant administrator's ChatGPT subscription, using the Codex harness."
            selected={settings.provider === "codex"}
            disabled={loading || saveState === "saving"}
            onSelect={() => void save({ provider: "codex" })}
          >
            <CodexIntegration
              configured={settings.integrations.codex.configured}
              disabled={saveState === "saving"}
              onSave={save}
            />
          </ProviderCard>
          <ProviderCard
            provider="byok"
            title="BYOK"
            description="Your OpenRouter or OpenAI API key."
            selected={settings.provider === "byok"}
            disabled={loading || saveState === "saving"}
            onSelect={() => void save({ provider: "byok" })}
          >
            <ByokIntegration
              openrouterConfigured={settings.integrations.openrouter.configured}
              openaiConfigured={settings.integrations.openai.configured}
              disabled={saveState === "saving"}
              onSave={save}
            />
          </ProviderCard>
          <ProviderCard
            provider="managed"
            title="Jina managed"
            description="Jina's configured model gateway."
            selected={settings.provider === "managed"}
            disabled={loading || saveState === "saving"}
            onSelect={() => void save({ provider: "managed" })}
          />
        </div>
        {fallback ? <p className="settings-fallback">{fallback}</p> : null}
      </SettingsPanel>

      <SettingsPanel
        title="Assertion defaults"
        subtitle="Planning and investigation stay inside this one Codex session; ingest and project remain deterministic."
      >
        <div className="model-setting-row">
          <div>
            <strong>Assertion agent model</strong>
            <span>Builds and updates semantic assertion changesets, including causal claims.</span>
          </div>
          <select
            aria-label="Assertion agent model"
            value={settings.assertionModel}
            disabled={loading || saveState === "saving"}
            onChange={(event) => void save({ assertionModel: event.target.value })}
          >
            {settings.models.length === 0 ? (
              <option value={settings.assertionModel}>{settings.assertionModel}</option>
            ) : (
              settings.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))
            )}
          </select>
        </div>
        <p className="settings-fallback">
          The provider and model are snapshotted when a build starts. Credentials are resolved only after the assertion
          task is leased and never enter task metadata.
        </p>
      </SettingsPanel>
    </section>
  );
}

function SettingsPanel({
  title,
  subtitle,
  children
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="settings-panel">
      <header>
        <span>{title}</span>
        <p>{subtitle}</p>
      </header>
      <div className="settings-panel__body">{children}</div>
    </section>
  );
}

function ProviderCard({
  provider,
  title,
  description,
  selected,
  disabled,
  onSelect,
  children
}: {
  readonly provider: ExecutionProvider;
  readonly title: string;
  readonly description: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className={selected ? "provider-card provider-card--selected" : "provider-card"}>
      <label className="provider-card__choice">
        <input
          type="radio"
          name="execution-provider"
          value={provider}
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
        />
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
      </label>
      {children ? <div className="provider-card__integration">{children}</div> : null}
    </div>
  );
}

function ByokIntegration({
  openrouterConfigured,
  openaiConfigured,
  disabled,
  onSave
}: {
  readonly openrouterConfigured: boolean;
  readonly openaiConfigured: boolean;
  readonly disabled: boolean;
  readonly onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <div className="integration-grid">
      <SecretIntegration
        label="OpenRouter"
        field="openrouterApiKey"
        configured={openrouterConfigured}
        placeholder="sk-or-v1-…"
        disabled={disabled}
        onSave={onSave}
      />
      <SecretIntegration
        label="OpenAI"
        field="openaiApiKey"
        configured={openaiConfigured}
        placeholder="sk-proj-…"
        disabled={disabled}
        onSave={onSave}
      />
    </div>
  );
}

function SecretIntegration({
  label,
  field,
  configured,
  placeholder,
  disabled,
  onSave
}: {
  readonly label: string;
  readonly field: "openrouterApiKey" | "openaiApiKey";
  readonly configured: boolean;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  if (configured) {
    return (
      <div className="integration-line">
        <span>
          {label} <b>Connected</b>
        </span>
        <button type="button" disabled={disabled} onClick={() => void onSave({ [field]: "" })}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="integration-line integration-line--connect">
      <label>
        <span>{label} API key</span>
        <input
          type="password"
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={disabled || !value.trim()}
        onClick={() => {
          void onSave({ [field]: value.trim() }).then((saved) => {
            if (saved) setValue("");
          });
        }}
      >
        Connect
      </button>
    </div>
  );
}

function CodexIntegration({
  configured,
  disabled,
  onSave
}: {
  readonly configured: boolean;
  readonly disabled: boolean;
  readonly onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const handleConnected = useCallback(
    async (authJson: string) => {
      const saved = await onSave({ codexHarnessAuth: authJson });
      if (saved) setOpen(false);
      return saved;
    },
    [onSave]
  );
  if (configured) {
    return (
      <div className="integration-line">
        <span>
          Harness <b>Connected</b>
        </span>
        <button type="button" disabled={disabled} onClick={() => void onSave({ codexHarnessAuth: "" })}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="integration-line">
        <span>Connect a ChatGPT subscription for trusted private repositories.</span>
        <button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)}>
          {open ? "Cancel" : "Connect Codex"}
        </button>
      </div>
      {open ? <CodexConnect onConnected={handleConnected} /> : null}
    </>
  );
}

type DeviceState =
  | { readonly phase: "starting" }
  | { readonly phase: "waiting"; readonly value: UsercodeResponse }
  | { readonly phase: "error"; readonly message: string };

function CodexConnect({ onConnected }: { readonly onConnected: (authJson: string) => Promise<boolean> }) {
  const [state, setState] = useState<DeviceState>({ phase: "starting" });
  const [manual, setManual] = useState("");
  const active = useRef(true);

  const start = useCallback(async () => {
    setState({ phase: "starting" });
    try {
      const response = await openAiJson(DEVICE_ENDPOINTS.usercode, { client_id: CODEX_CLIENT_ID });
      const value = response.ok ? parseUsercodeResponse(await response.json()) : null;
      if (!value) throw new Error("Could not start Codex device authorization.");
      if (active.current) setState({ phase: "waiting", value });
    } catch {
      if (active.current) {
        setState({
          phase: "error",
          message: "Could not reach OpenAI device authorization. You can paste auth.json below."
        });
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void start();
    return () => {
      active.current = false;
    };
  }, [start]);

  useEffect(() => {
    if (state.phase !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 15 * 60 * 1000;
    const { deviceAuthId, userCode, intervalSeconds } = state.value;
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setState({ phase: "error", message: "The device code expired. Generate a new code." });
        return;
      }
      try {
        const response = await openAiJson(DEVICE_ENDPOINTS.token, {
          device_auth_id: deviceAuthId,
          user_code: userCode
        });
        const status = classifyPollStatus(response.status);
        if (status === "success") {
          const code = parseCodeSuccess(await response.json());
          if (!code) throw new Error("Invalid device response");
          const form = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CODEX_CLIENT_ID,
            code: code.authorizationCode,
            code_verifier: code.codeVerifier,
            redirect_uri: DEVICE_ENDPOINTS.redirectUri
          });
          const tokenResponse = await fetch(DEVICE_ENDPOINTS.oauthToken, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form.toString()
          });
          const tokens = tokenResponse.ok ? parseOAuthTokens(await tokenResponse.json()) : null;
          if (!tokens) throw new Error("Could not exchange the Codex device code.");
          const saved = await onConnected(assembleAuthJson({ ...tokens, accountId: decodeAccountId(tokens.idToken) }));
          if (!saved && !cancelled) {
            setState({ phase: "error", message: "Codex signed in, but the encrypted save failed." });
          }
          return;
        }
        if (status === "error") throw new Error("OpenAI declined the device authorization.");
      } catch (pollError) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: pollError instanceof Error ? pollError.message : "Codex authorization failed."
          });
        }
        return;
      }
      timer = setTimeout(() => void poll(), boundedInterval(intervalSeconds) * 1000);
    };
    timer = setTimeout(() => void poll(), boundedInterval(intervalSeconds) * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state, onConnected]);

  return (
    <div className="codex-connect">
      {state.phase === "starting" ? <p>Starting secure sign-in…</p> : null}
      {state.phase === "waiting" ? (
        <>
          <ol>
            <li>
              Enable device authorization in{" "}
              <a href={CODEX_SECURITY_SETTINGS_URL} target="_blank" rel="noreferrer">
                ChatGPT security settings ↗
              </a>
            </li>
            <li>
              Copy code <code>{state.value.userCode}</code>.
            </li>
            <li>
              Open the{" "}
              <a href={CODEX_VERIFY_URL} target="_blank" rel="noreferrer">
                verification page ↗
              </a>{" "}
              and enter it.
            </li>
          </ol>
          <p>Use only the code shown here. Never enter a device code sent by someone else.</p>
          <p>Waiting for authentication…</p>
        </>
      ) : null}
      {state.phase === "error" ? (
        <p className="settings-notice settings-notice--error">
          {state.message}{" "}
          <button type="button" onClick={() => void start()}>
            Try again
          </button>
        </p>
      ) : null}
      <details>
        <summary>Paste auth.json manually</summary>
        <p>
          Run <code>codex login</code>, then paste <code>~/.codex/auth.json</code>. It is encrypted and never returned
          by the API.
        </p>
        <textarea
          rows={5}
          spellCheck={false}
          value={manual}
          placeholder={'{ "tokens": { "refresh_token": "…" } }'}
          onChange={(event) => setManual(event.target.value)}
        />
        <button type="button" disabled={!validCodexAuthJson(manual)} onClick={() => void onConnected(manual.trim())}>
          Connect
        </button>
      </details>
    </div>
  );
}

function openAiJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
