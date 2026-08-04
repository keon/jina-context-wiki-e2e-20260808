"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiUrl } from "../lib/api";
import { ExternalLink, Badge } from "../components/ui";
import { useDashboard, useTenant, useTenantFence } from "../providers";
import { formatDate } from "../lib/presentation";
import { openRouterSourceLabel, parseOpenRouterCallbackParam } from "../lib/openrouter";
import { isTenantWritable, type SelectedTenant } from "../lib/tenants";
import {
  githubInstallationUrl,
  normalizeGithubConnections,
  parseGithubInstallationCallback,
  type GithubConnection,
} from "../lib/github-installation";

type KeyInfo = { configured: boolean; last4?: string; connected_at?: string };
type OpenRouterInfo = KeyInfo & { source?: string; label?: string };
type Integrations = {
  openrouter: OpenRouterInfo;
  openai: KeyInfo;
  anthropic: KeyInfo;
};

const EMPTY_INTEGRATIONS: Integrations = {
  openrouter: { configured: false },
  openai: { configured: false },
  anthropic: { configured: false },
};

/** Merge a raw API payload onto the empty baseline, tolerating missing fields. */
function mergeIntegrations(data: unknown): Integrations {
  const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    openrouter: { ...EMPTY_INTEGRATIONS.openrouter, ...((record.openrouter as OpenRouterInfo) ?? {}) },
    openai: { ...EMPTY_INTEGRATIONS.openai, ...((record.openai as KeyInfo) ?? {}) },
    anthropic: { ...EMPTY_INTEGRATIONS.anthropic, ...((record.anthropic as KeyInfo) ?? {}) },
  };
}

/** Integrations endpoint for the active tenant, or the legacy viewer-scoped route. */
function integrationsUrl(selected: SelectedTenant | null): string {
  return selected
    ? apiUrl(`/v1/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/integrations`)
    : apiUrl("/v1/dashboard/integrations");
}

function githubConnectionsUrl(selected: SelectedTenant): string {
  return apiUrl(`/v1/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/github/installations`);
}

async function connectGithubInstallation(tenantId: string, installationId: number): Promise<Response> {
  const url = apiUrl(`/v1/dashboard/tenants/${encodeURIComponent(tenantId)}/github/installations`);
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
  const installUrl =
    selected && isTenantWritable(selected)
      ? githubInstallationUrl(viewer?.github_app?.install_url, selected)
      : undefined;
  const [status, setStatus] = useState<Integrations>(EMPTY_INTEGRATIONS);
  const [githubConnections, setGithubConnections] = useState<GithubConnection[]>([]);
  const [githubConnectionsVersion, setGithubConnectionsVersion] = useState(0);
  const [installationMessage, setInstallationMessage] = useState<string | null>(null);
  const completingInstallation = useRef<string | null>(null);

  useEffect(() => {
    if (!viewer || typeof window === "undefined") return;
    const callback = parseGithubInstallationCallback(window.location.search);
    if (!callback) return;
    const target = tenants.find((tenant) => tenant.tenant_id === callback.tenantId);
    if (!target || target.role !== "admin") return;
    const completionKey = `${callback.tenantId}:${callback.installationId}`;
    if (completingInstallation.current === completionKey) return;
    completingInstallation.current = completionKey;
    setInstallationMessage("Connecting GitHub repositories…");
    connectGithubInstallation(callback.tenantId, callback.installationId)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Could not connect the GitHub installation");
        }
        const body = (await response.json()) as { repositories?: number };
        selectTenant(callback.tenantId);
        setInstallationMessage(
          `GitHub connected${typeof body.repositories === "number" ? ` · ${body.repositories} repositories` : ""}.`,
        );
        setGithubConnectionsVersion((version) => version + 1);
      })
      .catch((error: unknown) => {
        setInstallationMessage(error instanceof Error ? error.message : "Could not connect the GitHub installation");
      })
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("installation_id");
        url.searchParams.delete("setup_action");
        url.searchParams.delete("state");
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      });
  }, [viewer, tenants, selectTenant]);

  useEffect(() => {
    if (!selected) {
      setGithubConnections([]);
      return;
    }
    const requestTenantId = selected.tenantId;
    const controller = new AbortController();
    fetch(githubConnectionsUrl(selected), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub installations returned ${response.status}`);
        return normalizeGithubConnections(await response.json());
      })
      .then((connections) => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setGithubConnections(connections);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && isCurrentTenant(requestTenantId)) {
          setGithubConnections([]);
        }
      });
    return () => controller.abort();
  }, [selected, githubConnectionsVersion, isCurrentTenant]);

  // Re-load whenever the selected tenant changes (each tenant has its own key).
  useEffect(() => {
    const requestTenantId = selected?.tenantId ?? null;
    let cancelled = false;
    setStatus(EMPTY_INTEGRATIONS);
    fetch(integrationsUrl(selected), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && !cancelled && isCurrentTenant(requestTenantId) && setStatus(mergeIntegrations(data)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, isCurrentTenant]);

  return (
    <>
      {selected ? (
        <GithubOrganizationsCard
          selected={selected}
          connections={githubConnections}
          installUrl={installUrl}
          message={installationMessage}
        />
      ) : null}
      <OpenRouterCard info={status.openrouter} selected={selected} onChanged={setStatus} />
      <ProviderKeyCard
        title="OpenAI"
        fieldName="openai_api_key"
        placeholder="sk-…"
        info={status.openai}
        selected={selected}
        onChanged={setStatus}
        lead={
          <>
            Run OpenAI models on your own key. Billed infra-only.
          </>
        }
      />
      <ProviderKeyCard
        title="Anthropic (Claude)"
        fieldName="anthropic_api_key"
        placeholder="sk-ant-…"
        info={status.anthropic}
        selected={selected}
        onChanged={setStatus}
        lead={
          <>
            Stored for Claude models.
          </>
        }
      />
    </>
  );
}

/* ---------- OpenRouter (primary) ---------- */

function OpenRouterCard({
  info,
  selected,
  onChanged,
}: {
  info: OpenRouterInfo;
  selected: SelectedTenant | null;
  onChanged: (next: Integrations) => void;
}) {
  const [callback, setCallback] = useState<"connected" | "error" | null>(null);
  const [manualKey, setManualKey] = useState("");
  const [busy, setBusy] = useState<"connect" | "save" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isCurrentTenant = useTenantFence();

  const writable = isTenantWritable(selected);
  const isOrg = selected?.type === "Organization";

  useEffect(() => {
    setCallback(null);
    setManualKey("");
    setBusy(null);
    setConfirmDisconnect(false);
    setMessage(null);
  }, [selected?.tenantId, isCurrentTenant]);

  // Read the OAuth callback result on mount, then strip it from the URL so it
  // doesn't linger (or re-fire on refresh) via history.replaceState.
  useEffect(() => {
    const result = parseOpenRouterCallbackParam(window.location.search);
    if (!result) return;
    setCallback(result);
    const url = new URL(window.location.href);
    url.searchParams.delete("openrouter");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, []);

  const connect = async () => {
    const requestTenantId = selected?.tenantId ?? null;
    setBusy("connect");
    setMessage(null);
    try {
      // The OAuth start route is global but accepts a target tenant_id (the API
      // re-checks the viewer is an admin of it before returning the redirect).
      const startUrl = selected
        ? apiUrl(
            "/v1/dashboard/integrations/openrouter/oauth/start",
            new URLSearchParams({ tenant_id: selected.tenantId }),
          )
        : apiUrl("/v1/dashboard/integrations/openrouter/oauth/start");
      const response = await fetch(startUrl, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 403) throw new Error("Organization admins manage OpenRouter for this account.");
      if (!response.ok) throw new Error(`Could not start OAuth (${response.status})`);
      const data = (await response.json()) as { url?: string };
      if (!isCurrentTenant(requestTenantId)) return;
      if (!data.url) throw new Error("OAuth start returned no URL");
      window.location.href = data.url;
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setMessage(error instanceof Error ? error.message : "Could not start OAuth");
      setBusy(null);
    }
  };

  const postKey = async (key: string, mode: "save" | "disconnect") => {
    // Capture the tenant this write targets so its response is dropped if the viewer switches tenants
    // before it resolves — otherwise tenant A's key status would land on tenant B's view (FINDING 3).
    const requestTenantId = selected?.tenantId ?? null;
    setBusy(mode);
    setMessage(null);
    try {
      const response = await fetch(integrationsUrl(selected), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ openrouter_api_key: key }),
      });
      if (response.status === 403) throw new Error("Organization admins manage OpenRouter for this account.");
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const merged = mergeIntegrations(await response.json());
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(merged);
      setManualKey("");
      setConfirmDisconnect(false);
      setCallback(null);
      setMessage(mode === "disconnect" ? "Disconnected" : "Saved");
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  const sourceLabel = openRouterSourceLabel(info.source);

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">OpenRouter</span>
        <span className="panel__actions">
          {info.configured ? <Badge tone="ok">Connected</Badge> : <Badge>Not connected</Badge>}
        </span>
      </div>
      <div className="form">
        <p className="form__lead">
          {isOrg ? (
            <>
              Run reviews on <strong>{selected?.login}</strong>&rsquo;s own OpenRouter credits. Billed infra-only.
            </>
          ) : (
            <>
              Run reviews on your own OpenRouter credits. Billed infra-only.
            </>
          )}
        </p>

        {!writable ? (
          <p className="tenant-gate-note">Managed by org admins.</p>
        ) : null}

        {callback === "connected" ? (
          <div className="notice notice--ok">
            <strong>OpenRouter connected</strong>
          </div>
        ) : null}
        {callback === "error" ? (
          <div className="notice notice--bad">Connecting OpenRouter failed. Please try again.</div>
        ) : null}

        {info.configured ? (
          <div className="integration-status">
            <span className="cell-mono">••••{info.last4 ?? ""}</span>
            {sourceLabel ? <Badge tone="info">{sourceLabel}</Badge> : null}
            {info.connected_at ? (
              <span className="cell-meta">Connected {formatDate(info.connected_at)}</span>
            ) : null}
          </div>
        ) : null}

        <div className="review-stage__actions">
          <button type="button" className="btn btn--primary" onClick={connect} disabled={busy !== null || !writable}>
            {busy === "connect" ? "Redirecting…" : info.configured ? "Reconnect OpenRouter" : "Connect OpenRouter"}
          </button>
          {info.configured ? (
            confirmDisconnect ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void postKey("", "disconnect")}
                  disabled={busy !== null || !writable}
                >
                  {busy === "disconnect" ? "Disconnecting…" : "Are you sure?"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmDisconnect(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy !== null || !writable}
              >
                Disconnect
              </button>
            )
          ) : null}
        </div>

        <details className="more-context">
          <summary className="more-context__summary">
            <span className="more-context__title">Paste an API key instead</span>
            <span className="more-context__hint">Advanced — use a manually created OpenRouter key</span>
          </summary>
          <div className="more-context__body">
            <label className="form-field">
              <span className="form-field__label">OpenRouter API key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-or-…"
                value={manualKey}
                onChange={(event) => setManualKey(event.target.value)}
              />
            </label>
            <div className="form__foot">
              <span className="cell-meta" />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void postKey(manualKey.trim(), "save")}
                disabled={busy !== null || manualKey.trim().length === 0 || !writable}
              >
                {busy === "save" ? "Saving…" : "Save key"}
              </button>
            </div>
          </div>
        </details>

        {message ? <span className="cell-meta">{message}</span> : null}
      </div>
    </section>
  );
}

/* ---------- BYOK native provider keys (OpenAI / Anthropic) ---------- */

/**
 * A generic paste-your-own-key card for a native BYOK provider. Manual entry only (no OAuth): the key is
 * POSTed under `fieldName` to the same tenant-scoped integrations endpoint the OpenRouter card uses, an
 * empty string disconnects, and the full response (openrouter + openai + anthropic) refreshes the page.
 */
function ProviderKeyCard({
  title,
  fieldName,
  placeholder,
  lead,
  info,
  selected,
  onChanged,
}: {
  title: string;
  fieldName: "openai_api_key" | "anthropic_api_key";
  placeholder: string;
  lead: ReactNode;
  info: KeyInfo;
  selected: SelectedTenant | null;
  onChanged: (next: Integrations) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isCurrentTenant = useTenantFence();
  const writable = isTenantWritable(selected);

  useEffect(() => {
    setDraft("");
    setBusy(null);
    setConfirmDisconnect(false);
    setMessage(null);
  }, [selected?.tenantId, isCurrentTenant]);

  const postKey = async (key: string, mode: "save" | "disconnect") => {
    // Fence the response to the tenant this write targeted (see OpenRouterCard/FINDING 3).
    const requestTenantId = selected?.tenantId ?? null;
    setBusy(mode);
    setMessage(null);
    try {
      const response = await fetch(integrationsUrl(selected), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [fieldName]: key }),
      });
      if (response.status === 403) throw new Error(`Organization admins manage ${title} for this account.`);
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      const merged = mergeIntegrations(await response.json());
      if (!isCurrentTenant(requestTenantId)) return;
      onChanged(merged);
      setDraft("");
      setConfirmDisconnect(false);
      setMessage(mode === "disconnect" ? "Disconnected" : "Saved");
    } catch (error) {
      if (!isCurrentTenant(requestTenantId)) return;
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      if (isCurrentTenant(requestTenantId)) setBusy(null);
    }
  };

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">{title}</span>
        <span className="panel__actions">
          {info.configured ? <Badge tone="ok">Connected</Badge> : <Badge>Not connected</Badge>}
        </span>
      </div>
      <div className="form">
        <p className="form__lead">{lead}</p>

        {!writable ? (
          <p className="tenant-gate-note">Managed by org admins.</p>
        ) : null}

        {info.configured ? (
          <div className="integration-status">
            <span className="cell-mono">••••{info.last4 ?? ""}</span>
            {info.connected_at ? <span className="cell-meta">Connected {formatDate(info.connected_at)}</span> : null}
          </div>
        ) : null}

        <label className="form-field">
          <span className="form-field__label">{title} API key</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!writable}
          />
        </label>

        <div className="review-stage__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void postKey(draft.trim(), "save")}
            disabled={busy !== null || draft.trim().length === 0 || !writable}
          >
            {busy === "save" ? "Saving…" : info.configured ? "Replace key" : "Save key"}
          </button>
          {info.configured ? (
            confirmDisconnect ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void postKey("", "disconnect")}
                  disabled={busy !== null || !writable}
                >
                  {busy === "disconnect" ? "Disconnecting…" : "Are you sure?"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmDisconnect(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy !== null || !writable}
              >
                Disconnect
              </button>
            )
          ) : null}
        </div>

        {message ? <span className="cell-meta">{message}</span> : null}
      </div>
    </section>
  );
}

function GithubOrganizationsCard({
  selected,
  connections,
  installUrl,
  message,
}: {
  selected: SelectedTenant;
  connections: GithubConnection[];
  installUrl: string | undefined;
  message: string | null;
}) {
  const writable = isTenantWritable(selected);
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">GitHub organizations</span>
        <span className="panel__count">{connections.length}</span>
        <span className="panel__actions">
          {installUrl ? (
            <ExternalLink className="btn btn--primary btn--sm" href={installUrl}>
              Add GitHub organization
            </ExternalLink>
          ) : null}
        </span>
      </div>
      {connections.length > 0 ? (
        <div className="list">
          {connections.map((connection) => (
            <div className="row" key={connection.installationId}>
              <div className="row__main">
                <span className="row__title">{connection.login}</span>
                <span className="row__meta">
                  Installation {connection.installationId} · {connection.repositoryCount.toLocaleString("en-US")}{" "}
                  {connection.repositoryCount === 1 ? "repository" : "repositories"}
                </span>
              </div>
              <div className="row__badges">
                <Badge tone={connection.status === "active" ? "ok" : connection.status === "suspended" ? "warn" : "bad"}>
                  {connection.status === "active"
                    ? "Connected"
                    : connection.status === "suspended"
                      ? "Suspended"
                      : "Removed"}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty empty--compact">No GitHub organizations connected yet.</div>
      )}
      <div className="form">
        <p className="form__lead">
          Add another GitHub organization to <strong>{selected.login}</strong>. Its repositories, projects,
          artifacts, and billing stay owned by this Jina organization.
        </p>
        {!writable ? <p className="tenant-gate-note">Only organization admins can add GitHub connections.</p> : null}
        {message ? <span className="cell-meta">{message}</span> : null}
      </div>
    </section>
  );
}
