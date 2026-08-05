"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import {
  githubInstallationUrl,
  normalizeGithubConnections,
  parseGithubInstallationCallback,
  type GithubConnection,
} from "../lib/github-installation";
import { openRouterSourceLabel, parseOpenRouterCallbackParam } from "../lib/openrouter";
import { formatDate } from "../lib/presentation";
import { isTenantWritable, type SelectedTenant } from "../lib/tenants";
import { useDashboard, useTenant, useTenantFence } from "../providers";

type LoadState = "loading" | "loaded" | "unavailable";
interface KeyInfo { configured: boolean; last4?: string; connected_at?: string }
type OpenRouterInfo = KeyInfo & { source?: string };
interface Integrations {
  openrouter: OpenRouterInfo;
  openai: KeyInfo;
  anthropic: KeyInfo;
}
type ProviderField = "openrouter_api_key" | "openai_api_key" | "anthropic_api_key";

const EMPTY_INTEGRATIONS: Integrations = {
  openrouter: { configured: false },
  openai: { configured: false },
  anthropic: { configured: false },
};

const PROVIDERS: {
  id: keyof Integrations;
  name: string;
  mark: string;
  description: string;
  field: ProviderField;
  placeholder: string;
  oauth?: boolean;
}[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    mark: "OR",
    description: "Use one key for models from multiple providers.",
    field: "openrouter_api_key",
    placeholder: "sk-or-…",
    oauth: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    mark: "AI",
    description: "Run reviews with models billed to your OpenAI account.",
    field: "openai_api_key",
    placeholder: "sk-…",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    mark: "AN",
    description: "Use Claude models through your own provider key.",
    field: "anthropic_api_key",
    placeholder: "sk-ant-…",
  },
];

function mergeIntegrations(data: unknown): Integrations {
  const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    openrouter: { ...EMPTY_INTEGRATIONS.openrouter, ...((record.openrouter as OpenRouterInfo) ?? {}) },
    openai: { ...EMPTY_INTEGRATIONS.openai, ...((record.openai as KeyInfo) ?? {}) },
    anthropic: { ...EMPTY_INTEGRATIONS.anthropic, ...((record.anthropic as KeyInfo) ?? {}) },
  };
}

function integrationsUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/integrations`)
    : apiUrl("/dashboard/integrations");
}

function githubConnectionsUrl(selected: SelectedTenant): string {
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/github/installations`);
}

async function connectGithubInstallation(tenantId: string, installationId: number): Promise<Response> {
  const url = apiUrl(`/dashboard/tenants/${encodeURIComponent(tenantId)}/github/installations`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installation_id: installationId }),
    });
    if (response.status !== 409 || attempt === 3) return response;
    await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw new Error("Could not connect the GitHub installation");
}

export default function IntegrationsPage() {
  const { viewer } = useDashboard();
  const { selected, tenants, selectTenant } = useTenant();
  const isCurrentTenant = useTenantFence();
  const [providers, setProviders] = useState<Integrations>(EMPTY_INTEGRATIONS);
  const [providerState, setProviderState] = useState<LoadState>("loading");
  const [providerVersion, setProviderVersion] = useState(0);
  const [connections, setConnections] = useState<GithubConnection[]>([]);
  const [connectionState, setConnectionState] = useState<LoadState>("loading");
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const completingInstallation = useRef<string | null>(null);

  const writable = isTenantWritable(selected);
  const installUrl =
    selected && writable ? githubInstallationUrl(viewer?.github_app?.install_url, selected) : undefined;

  const reloadProviders = useCallback(() => setProviderVersion((version) => version + 1), []);

  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    const controller = new AbortController();
    setProviderState("loading");
    setProviders(EMPTY_INTEGRATIONS);
    fetch(integrationsUrl(selected), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Integrations returned ${response.status}`);
        return mergeIntegrations(await response.json());
      })
      .then((next) => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setProviders(next);
          setProviderState("loaded");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) setProviderState("unavailable");
      });
    return () => controller.abort();
  }, [selected, providerVersion, isCurrentTenant]);

  useEffect(() => {
    if (!selected) {
      setConnections([]);
      setConnectionState("loaded");
      return;
    }
    const requestTenantId = selected.tenantId;
    const controller = new AbortController();
    setConnectionState("loading");
    fetch(githubConnectionsUrl(selected), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub installations returned ${response.status}`);
        return normalizeGithubConnections(await response.json());
      })
      .then((next) => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setConnections(next);
          setConnectionState("loaded");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setConnections([]);
          setConnectionState("unavailable");
        }
      });
    return () => controller.abort();
  }, [selected, connectionVersion, isCurrentTenant]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const openRouterResult = parseOpenRouterCallbackParam(window.location.search);
    if (openRouterResult) {
      setPageMessage(
        openRouterResult === "connected"
          ? "OpenRouter connected."
          : "OpenRouter could not be connected. Try again.",
      );
      if (openRouterResult === "connected") reloadProviders();
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("openrouter");
      window.history.replaceState({}, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
    }
  }, [reloadProviders]);

  useEffect(() => {
    if (!viewer || typeof window === "undefined") return;
    const callback = parseGithubInstallationCallback(window.location.search);
    if (!callback) return;
    const target = tenants.find((tenant) => tenant.tenant_id === callback.tenantId);
    if (!target || target.role !== "admin") return;
    const completionKey = `${callback.tenantId}:${callback.installationId}`;
    if (completingInstallation.current === completionKey) return;
    completingInstallation.current = completionKey;
    setPageMessage("Connecting GitHub repositories…");
    void connectGithubInstallation(callback.tenantId, callback.installationId)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Could not connect the GitHub installation");
        }
        const body = (await response.json()) as { repositories?: number };
        selectTenant(callback.tenantId);
        setPageMessage(
          `GitHub connected${typeof body.repositories === "number" ? ` · ${body.repositories} repositories` : ""}.`,
        );
        setConnectionVersion((version) => version + 1);
      })
      .catch((error: unknown) => {
        setPageMessage(error instanceof Error ? error.message : "Could not connect the GitHub installation");
      })
      .finally(() => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete("installation_id");
        nextUrl.searchParams.delete("setup_action");
        nextUrl.searchParams.delete("state");
        window.history.replaceState({}, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
      });
  }, [viewer, tenants, selectTenant]);

  return (
    <div className="integrations-v2">
      <header className="route-intro">
        <div>
          <h1>Integrations</h1>
          <p>Connect source control and model providers to this workspace.</p>
        </div>
        {selected ? <span className="route-intro__scope">{selected.login}</span> : null}
      </header>

      {pageMessage ? (
        <div className="inline-status" role="status">
          <span>{pageMessage}</span>
          <button type="button" onClick={() => setPageMessage(null)} aria-label="Dismiss message">×</button>
        </div>
      ) : null}

      <IntegrationGroup title="Source control" description="Repositories and pull requests">
        <GitHubRow
          state={connectionState}
          connections={connections}
          installUrl={installUrl}
          writable={writable}
        />
      </IntegrationGroup>

      <IntegrationGroup title="Model providers" description="Credentials used to run reviews">
        {providerState === "loading" ? (
          <CompactState title="Loading providers" detail="Checking the connections for this workspace." />
        ) : providerState === "unavailable" ? (
          <CompactState
            title="Provider connections are unavailable"
            detail="Nothing has been disconnected or changed. Try again when the service is reachable."
            action={<button type="button" className="btn btn--sm" onClick={reloadProviders}>Retry</button>}
          />
        ) : (
          <div className="integration-rows">
            {PROVIDERS.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                info={providers[provider.id]}
                selected={selected}
                writable={writable}
                onChanged={(next) => {
                  setProviders(next);
                  setProviderState("loaded");
                }}
              />
            ))}
          </div>
        )}
      </IntegrationGroup>
    </div>
  );
}

function IntegrationGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="integration-group">
      <div className="integration-group__head">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function CompactState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="integration-state" role="status">
      <span className="integration-mark integration-mark--muted">•••</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {action ? <div className="integration-state__action">{action}</div> : null}
    </div>
  );
}

function GitHubRow({
  state,
  connections,
  installUrl,
  writable,
}: {
  state: LoadState;
  connections: GithubConnection[];
  installUrl: string | undefined;
  writable: boolean;
}) {
  const connected = connections.filter((connection) => connection.status === "active");
  const statusLabel =
    state === "loading"
      ? "Checking…"
      : state === "unavailable"
        ? "Unavailable"
        : connected.length > 0
          ? `${connected.length} connected`
          : "Not connected";

  return (
    <div className="integration-row integration-row--source">
      <span className="integration-mark">GH</span>
      <div className="integration-row__main">
        <div className="integration-row__titleline">
          <strong>GitHub</strong>
          <Badge tone={connected.length > 0 ? "ok" : undefined}>{statusLabel}</Badge>
        </div>
        <p>Sync organizations and repositories for pull-request reviews.</p>
        {connected.length > 0 ? (
          <div className="integration-row__connections">
            {connected.map((connection) => (
              <span key={connection.installationId}>
                {connection.login} · {connection.repositoryCount.toLocaleString("en-US")} repos
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="integration-row__actions">
        {installUrl ? (
          <ExternalLink className="btn btn--primary btn--sm" href={installUrl}>
            {connected.length > 0 ? "Add organization" : "Connect"}
          </ExternalLink>
        ) : (
          <button
            type="button"
            className="btn btn--sm"
            disabled
            title={
              !writable
                ? "Workspace administrators manage GitHub connections."
                : state !== "loaded"
                  ? "GitHub connection status is unavailable."
                  : "Select a workspace with GitHub installation enabled."
            }
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  info,
  selected,
  writable,
  onChanged,
}: {
  provider: (typeof PROVIDERS)[number];
  info: KeyInfo | OpenRouterInfo;
  selected: SelectedTenant | null;
  writable: boolean;
  onChanged: (next: Integrations) => void;
}) {
  const isCurrentTenant = useTenantFence();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"oauth" | "save" | "disconnect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft("");
    setBusy(null);
    setMessage(null);
    setConfirmDisconnect(false);
  }, [selected?.tenantId]);

  const saveKey = async (key: string, mode: "save" | "disconnect") => {
    const requestTenantId = selected?.tenantId ?? null;
    setBusy(mode);
    setMessage(null);
    try {
      const response = await fetch(integrationsUrl(selected), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [provider.field]: key }),
      });
      if (response.status === 403) throw new Error("Only workspace admins can change this connection.");
      if (!response.ok) throw new Error("Connection could not be saved.");
      const next = mergeIntegrations(await response.json());
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(next);
      setDraft("");
      setEditing(false);
      setConfirmDisconnect(false);
      setMessage(mode === "disconnect" ? "Disconnected." : "Connected.");
    } catch (error) {
      if (isCurrentTenant(requestTenantId)) {
        setMessage(error instanceof Error ? error.message : "Connection could not be saved.");
      }
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  const connectOAuth = async () => {
    const requestTenantId = selected?.tenantId ?? null;
    setBusy("oauth");
    setMessage(null);
    try {
      const startUrl = selected
        ? apiUrl(
            "/dashboard/integrations/openrouter/oauth/start",
            new URLSearchParams({ tenant_id: selected.tenantId }),
          )
        : apiUrl("/dashboard/integrations/openrouter/oauth/start");
      const response = await fetch(startUrl, { method: "POST", credentials: "include" });
      if (response.status === 403) throw new Error("Only workspace admins can change this connection.");
      if (!response.ok) throw new Error("OpenRouter could not be opened.");
      const data = (await response.json()) as { url?: string };
      if (!isCurrentTenant(requestTenantId)) return;
      if (!data.url) throw new Error("OpenRouter returned no connection URL.");
      window.location.href = data.url;
    } catch (error) {
      if (isCurrentTenant(requestTenantId)) {
        setMessage(error instanceof Error ? error.message : "OpenRouter could not be opened.");
        setBusy(null);
      }
    }
  };

  const source = provider.id === "openrouter" ? openRouterSourceLabel((info as OpenRouterInfo).source) : null;

  return (
    <div className={`integration-row${editing ? " integration-row--editing" : ""}`}>
      <span className="integration-mark">{provider.mark}</span>
      <div className="integration-row__main">
        <div className="integration-row__titleline">
          <strong>{provider.name}</strong>
          <Badge tone={info.configured ? "ok" : undefined}>{info.configured ? "Connected" : "Not connected"}</Badge>
        </div>
        <p>{provider.description}</p>
        {info.configured ? (
          <div className="integration-row__metadata">
            <span className="cell-mono">••••{info.last4 ?? ""}</span>
            {source ? <span>{source}</span> : null}
            {info.connected_at ? <span>Connected {formatDate(info.connected_at)}</span> : null}
          </div>
        ) : null}
        {message ? <span className="integration-row__message" role="status">{message}</span> : null}
      </div>
      <div className="integration-row__actions">
        {provider.oauth ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void connectOAuth()} disabled={!writable || busy !== null}>
            {busy === "oauth" ? "Opening…" : info.configured ? "Reconnect" : "Connect"}
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing((value) => !value)} disabled={!writable || busy !== null}>
            {info.configured ? "Replace key" : "Add key"}
          </button>
        )}
        {provider.oauth ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing((value) => !value)} disabled={!writable || busy !== null}>
            Use API key
          </button>
        ) : null}
        {info.configured ? (
          confirmDisconnect ? (
            <>
              <button type="button" className="btn btn--sm" onClick={() => void saveKey("", "disconnect")} disabled={busy !== null}>
                {busy === "disconnect" ? "Disconnecting…" : "Confirm"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDisconnect(false)} disabled={busy !== null}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDisconnect(true)} disabled={!writable || busy !== null}>Disconnect</button>
          )
        ) : null}
      </div>

      {editing ? (
        <div className="integration-row__editor">
          <label>
            <span>{provider.name} API key</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={provider.placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
            />
          </label>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveKey(draft.trim(), "save")} disabled={busy !== null || draft.trim().length === 0}>
            {busy === "save" ? "Saving…" : "Save key"}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => { setEditing(false); setDraft(""); }} disabled={busy !== null}>Cancel</button>
        </div>
      ) : null}
    </div>
  );
}
