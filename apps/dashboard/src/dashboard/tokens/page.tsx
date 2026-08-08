"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import { formatDate } from "../lib/presentation";
import { CONFIG_STALE_TIME_MS, DashboardRequestError } from "../lib/query-client";
import { tenantQueryKey } from "../lib/query-keys";
import { isTenantWritable, type SelectedTenant } from "../lib/tenants";
import { useTenant, useTenantFence, useTenantQueryScope } from "../providers";

type LoadState = "loading" | "loaded" | "unavailable";

interface ApiToken {
  id: string;
  name: string;
  principal_id?: string;
  principalId?: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface TokensResponse {
  tokens: ApiToken[];
  mcp_endpoint: string | null;
}

const SCOPE_OPTIONS: { scope: string; label: string; description: string }[] = [
  { scope: "context:query", label: "Query", description: "Search the wiki and call MCP tools" },
  { scope: "context:read", label: "Read", description: "Read wiki documents, releases, and the causal graph" },
  { scope: "context:build", label: "Build", description: "Start wiki and causal graph builds" },
];

const EXPIRY_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 10_080, label: "7 days" },
  { minutes: 43_200, label: "30 days" },
  { minutes: 129_600, label: "90 days" },
  { minutes: 525_600, label: "1 year" },
];

const DEFAULT_SCOPES = ["context:query", "context:read"];

function tokensUrl(selected: SelectedTenant): string {
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/tokens`);
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export default function TokensPage() {
  const { selected } = useTenant();
  const scope = useTenantQueryScope();
  const isCurrentTenant = useTenantFence();
  const writable = isTenantWritable(selected);

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [expiresInMinutes, setExpiresInMinutes] = useState(EXPIRY_OPTIONS[1]!.minutes);
  const [minting, setMinting] = useState(false);
  const [mintedSecret, setMintedSecret] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  // A workspace switch must never leak another workspace's one-time secret.
  useEffect(() => {
    setMintedSecret(null);
    setMessage(null);
    setConfirmRevoke(null);
    setCopied(false);
  }, [selected?.tenantId]);

  const tokensQuery = useQuery<TokensResponse>({
    queryKey: tenantQueryKey("tokens", scope),
    queryFn: async ({ signal }) => {
      const response = await fetch(tokensUrl(selected!), { credentials: "include", signal });
      if (!response.ok) {
        throw new DashboardRequestError(response.status, `Tokens returned ${response.status}`);
      }
      return (await response.json()) as TokensResponse;
    },
    enabled: Boolean(selected),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const state: LoadState = !selected
    ? "loaded"
    : tokensQuery.isError
      ? "unavailable"
      : tokensQuery.data === undefined
        ? "loading"
        : "loaded";
  const tokens = tokensQuery.data?.tokens ?? [];
  const refetch = tokensQuery.refetch;

  const toggleScope = (scopeName: string) => {
    setScopes((current) =>
      current.includes(scopeName) ? current.filter((s) => s !== scopeName) : [...current, scopeName],
    );
  };

  const mint = async () => {
    if (!selected || minting) return;
    const requestTenantId = selected.tenantId;
    setMinting(true);
    setMessage(null);
    setMintedSecret(null);
    setCopied(false);
    try {
      const response = await fetch(tokensUrl(selected), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes, expiresInMinutes }),
      });
      if (!isCurrentTenant(requestTenantId)) return;
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(
          response.status === 403
            ? "Only workspace admins can create tokens."
            : (body.error ?? `Token creation returned ${response.status}.`),
        );
        return;
      }
      const created = (await response.json()) as { secret: string; token: ApiToken };
      if (!isCurrentTenant(requestTenantId)) return;
      setMintedSecret({ name: created.token.name, secret: created.secret });
      setName("");
      void refetch();
    } catch {
      if (isCurrentTenant(requestTenantId)) setMessage("Token creation failed. Try again.");
    } finally {
      if (isCurrentTenant(requestTenantId)) setMinting(false);
    }
  };

  const revoke = async (tokenId: string) => {
    if (!selected || revoking) return;
    const requestTenantId = selected.tenantId;
    setRevoking(tokenId);
    setMessage(null);
    try {
      const response = await fetch(`${tokensUrl(selected)}/${encodeURIComponent(tokenId)}/revoke`, {
        method: "POST",
        credentials: "include",
      });
      if (!isCurrentTenant(requestTenantId)) return;
      if (!response.ok) {
        setMessage(
          response.status === 403
            ? "Only workspace admins can revoke tokens."
            : `Revoke returned ${response.status}.`,
        );
        return;
      }
      void refetch();
    } catch {
      if (isCurrentTenant(requestTenantId)) setMessage("Revoke failed. Try again.");
    } finally {
      if (isCurrentTenant(requestTenantId)) {
        setRevoking(null);
        setConfirmRevoke(null);
      }
    }
  };

  const active = tokens.filter((token) => !token.revokedAt);

  return (
    <div>
      <header className="route-intro">
        <h1>API tokens</h1>
        <p className="route-intro__scope">
          Tokens authenticate external access to this workspace — MCP clients, the wiki API, and the
          causal graph. The secret is shown once at creation and stored only as a hash. Connect a
          client on the <Link href="/mcp">MCP page</Link>.
        </p>
      </header>

      {message ? (
        <p className="inline-status" role="status">
          {message}{" "}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setMessage(null)}>
            Dismiss
          </button>
        </p>
      ) : null}

      {mintedSecret ? (
        <section className="integration-group" aria-label="New token secret">
          <h2>“{mintedSecret.name}” created</h2>
          <p>Copy the secret now — it cannot be shown again.</p>
          <pre className="code-block code-block--sm">{mintedSecret.secret}</pre>
          <div className="integration-row__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-label={copied ? "Copied" : "Copy secret"}
              onClick={() => {
                void copyText(mintedSecret.secret).then((ok) => setCopied(ok));
              }}
            >
              {copied ? "Copied" : "Copy secret"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setMintedSecret(null)}
            >
              Done
            </button>
          </div>
        </section>
      ) : null}

      {writable ? (
        <section className="integration-group" aria-label="Create token">
          <h2>Create token</h2>
          <div className="settings-field">
            <label htmlFor="token-name">Name</label>
            <input
              id="token-name"
              className="input"
              value={name}
              maxLength={200}
              placeholder="e.g. Claude Code on my laptop"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <fieldset className="settings-field">
            <legend>Scopes</legend>
            {SCOPE_OPTIONS.map((option) => (
              <label key={option.scope} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={scopes.includes(option.scope)}
                  onChange={() => toggleScope(option.scope)}
                />{" "}
                {option.label} <span className="checkbox-row__hint">— {option.description}</span>
              </label>
            ))}
          </fieldset>
          <div className="settings-field">
            <label htmlFor="token-expiry">Expires</label>
            <select
              id="token-expiry"
              className="input"
              value={expiresInMinutes}
              onChange={(event) => setExpiresInMinutes(Number(event.target.value))}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={minting || !name.trim() || scopes.length === 0}
            onClick={() => void mint()}
          >
            {minting ? "Creating…" : "Create token"}
          </button>
        </section>
      ) : null}

      <section className="integration-group" aria-label="Tokens">
        <h2>Active tokens</h2>
        {state === "loading" ? (
          <p>Loading tokens…</p>
        ) : state === "unavailable" ? (
          <p>Tokens are unavailable right now.</p>
        ) : active.length === 0 ? (
          <p>No API tokens yet.</p>
        ) : (
          active.map((token) => (
            <div key={token.id} className="integration-row">
              <div>
                <strong>{token.name}</strong>{" "}
                {token.scopes.map((tokenScope) => (
                  <Badge key={tokenScope}>{tokenScope}</Badge>
                ))}
                <p className="integration-row__metadata">
                  Created {formatDate(token.createdAt)} · Expires {formatDate(token.expiresAt)}
                  {token.lastUsedAt ? ` · Last used ${formatDate(token.lastUsedAt)}` : " · Never used"}
                </p>
              </div>
              {writable ? (
                <div className="integration-row__actions">
                  {confirmRevoke === token.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={revoking === token.id}
                        onClick={() => void revoke(token.id)}
                      >
                        {revoking === token.id ? "Revoking…" : "Confirm revoke"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => setConfirmRevoke(null)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => setConfirmRevoke(token.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
