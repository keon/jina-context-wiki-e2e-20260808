"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import {
  connectGithubInstallation,
  githubInstallationUrl,
  normalizeGithubConnections,
  parseGithubInstallationCallback,
  type GithubConnection,
} from "../lib/github-installation";
import { openRouterSourceLabel, parseOpenRouterCallbackParam } from "../lib/openrouter";
import { formatDate } from "../lib/presentation";
import { CONFIG_STALE_TIME_MS, DashboardRequestError } from "../lib/query-client";
import { tenantQueryKey, type TenantQueryKey } from "../lib/query-keys";
import { isTenantWritable, type SelectedTenant } from "../lib/tenants";
import { useDashboard, useTenant, useTenantFence, useTenantQueryScope } from "../providers";

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

const NO_CONNECTIONS: GithubConnection[] = [];

const PROVIDERS: {
  id: keyof Integrations;
  name: string;
  mark: string;
  field: ProviderField;
  placeholder: string;
  oauth?: boolean;
}[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    mark: "OR",
    field: "openrouter_api_key",
    placeholder: "sk-or-…",
    oauth: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    mark: "AI",
    field: "openai_api_key",
    placeholder: "sk-…",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    mark: "AN",
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

function integrationsUrl(selected: SelectedTenant): string {
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/integrations`);
}

function githubConnectionsUrl(selected: SelectedTenant): string {
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/github/installations`);
}

export default function IntegrationsPage() {
  const { viewer } = useDashboard();
  const { selected, tenants, selectTenant, ready: tenantsReady } = useTenant();
  const scope = useTenantQueryScope();
  const queryClient = useQueryClient();
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const completingInstallation = useRef<string | null>(null);

  const writable = isTenantWritable(selected);
  const installUrl =
    selected && writable ? githubInstallationUrl(viewer?.github_app?.install_url, selected) : undefined;

  // Keyed by scope, so a workspace switch reads a different entry instead of
  // resetting this one to EMPTY_INTEGRATIONS — that reset ran on every re-render
  // of this component and blanked the provider rows before any answer arrived.
  const providersKey: TenantQueryKey = tenantQueryKey("integrations", scope);
  const providersQuery = useQuery<Integrations>({
    queryKey: providersKey,
    queryFn: async ({ signal }) => {
      const response = await fetch(integrationsUrl(selected!), { credentials: "include", signal });
      if (!response.ok) {
        throw new DashboardRequestError(response.status, `Integrations returned ${response.status}`);
      }
      return mergeIntegrations(await response.json());
    },
    enabled: Boolean(selected),
    staleTime: CONFIG_STALE_TIME_MS,
  });
  const providers = providersQuery.data ?? EMPTY_INTEGRATIONS;
  const providerState: LoadState = !selected
    ? "loaded"
    : providersQuery.isError
    ? "unavailable"
    : providersQuery.data === undefined
      ? "loading"
      : "loaded";
  // Bound to the observer, so this stays stable across renders — the OpenRouter
  // callback effect below keys on it.
  const refetchProviders = providersQuery.refetch;
  const reloadProviders = useCallback(() => void refetchProviders(), [refetchProviders]);

  const connectionsQuery = useQuery<GithubConnection[]>({
    queryKey: tenantQueryKey("github-installations", scope),
    queryFn: async ({ signal }) => {
      // `enabled` keeps this from running without a tenant; the URL needs one.
      const tenant = selected!;
      const response = await fetch(githubConnectionsUrl(tenant), { credentials: "include", signal });
      if (!response.ok) {
        throw new DashboardRequestError(response.status, `GitHub installations returned ${response.status}`);
      }
      return normalizeGithubConnections(await response.json());
    },
    enabled: Boolean(selected),
    staleTime: CONFIG_STALE_TIME_MS,
  });
  // Without a workspace there is nothing to install into: a settled empty answer, not a pending read.
  // A failed read drops the rows rather than showing connections that could not be confirmed.
  const connections = connectionsQuery.isError ? NO_CONNECTIONS : (connectionsQuery.data ?? NO_CONNECTIONS);
  const connectionState: LoadState = !selected
    ? "loaded"
    : connectionsQuery.isError
      ? "unavailable"
      : connectionsQuery.data === undefined
        ? "loading"
        : "loaded";

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
    if (!tenantsReady) return;
    const target = tenants.find((tenant) => tenant.tenant_id === callback.tenantId);
    if (!target || target.role !== "admin") {
      setPageMessage("That GitHub installation could not be assigned to an administrable workspace.");
      stripGithubCallbackParams();
      return;
    }
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
        // Invalidate by resource rather than refetching this render's key: the
        // selection above moves the page to the tenant that was just connected.
        void queryClient.invalidateQueries({ queryKey: ["github-installations"] });
        if (callback.returnTo === "onboarding") {
          window.location.assign("/onboarding?github=connected");
        }
      })
      .catch((error: unknown) => {
        setPageMessage(error instanceof Error ? error.message : "Could not connect the GitHub installation");
      })
      .finally(() => {
        stripGithubCallbackParams();
      });
  }, [viewer, tenants, tenantsReady, selectTenant, queryClient]);

  return (
    <div className="integrations-v2">
      <header className="route-intro">
        <h1>Integrations</h1>
        {selected ? <span className="route-intro__scope">{selected.login}</span> : null}
      </header>

      {pageMessage ? (
        <div className="inline-status" role="status">
          <span>{pageMessage}</span>
          <button type="button" onClick={() => setPageMessage(null)} aria-label="Dismiss message">×</button>
        </div>
      ) : null}

      <IntegrationGroup title="Source control">
        <GitHubRow
          state={connectionState}
          connections={connections}
          installUrl={installUrl}
          writable={writable}
        />
      </IntegrationGroup>

      <IntegrationGroup title="Model providers">
        {!selected ? (
          <CompactState title="Select a workspace to manage model providers" />
        ) : providerState === "loading" ? (
          <CompactState title="Loading providers" />
        ) : providerState === "unavailable" ? (
          <CompactState
            title="Provider connections are unavailable"
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
                // A write answers with the authoritative connection state; adopt it
                // as the cached read so no follow-up request is needed.
                onChanged={(next) => queryClient.setQueryData<Integrations>(providersKey, next)}
              />
            ))}
          </div>
        )}
      </IntegrationGroup>
    </div>
  );
}

function stripGithubCallbackParams(): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("installation_id");
  nextUrl.searchParams.delete("setup_action");
  nextUrl.searchParams.delete("state");
  window.history.replaceState({}, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
}

function IntegrationGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="integration-group">
      <div className="integration-group__head">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function CompactState({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="integration-state" role="status">
      <span className="integration-mark integration-mark--muted">•••</span>
      <div>
        <strong>{title}</strong>
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
    if (!selected) return;
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
    if (!selected) return;
    const requestTenantId = selected?.tenantId ?? null;
    setBusy("oauth");
    setMessage(null);
    try {
      const startUrl = apiUrl(
        "/dashboard/integrations/openrouter/oauth/start",
        new URLSearchParams({ tenant_id: selected.tenantId }),
      );
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
