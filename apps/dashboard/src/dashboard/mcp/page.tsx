"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "../components/ui";
import { apiUrl } from "../lib/api";
import { CONFIG_STALE_TIME_MS, DashboardRequestError } from "../lib/query-client";
import { tenantQueryKey } from "../lib/query-keys";
import type { SelectedTenant } from "../lib/tenants";
import { useTenant, useTenantQueryScope } from "../providers";

type LoadState = "loading" | "loaded" | "unavailable";

interface TokensResponse {
  tokens: { id: string; revokedAt?: string }[];
  mcp_endpoint: string | null;
}

const MCP_TOOLS: { name: string; mark: string; title: string; description: string; scope: string }[] = [
  {
    name: "search_context",
    mark: "SE",
    title: "Search context",
    description:
      "Deterministically select relevant wiki nodes with lexical scoring and return excerpts with immutable citations.",
    scope: "context:query",
  },
  {
    name: "list_context",
    mark: "LI",
    title: "List context",
    description: "List derived wiki documents and their deterministic PageIndex-style hierarchy.",
    scope: "context:read",
  },
  {
    name: "read_context",
    mark: "RE",
    title: "Read context",
    description: "Read one complete derived wiki document with its immutable source citations.",
    scope: "context:read",
  },
  {
    name: "diff_context",
    mark: "DI",
    title: "Diff context",
    description: "Compare two immutable wiki releases without using a model.",
    scope: "context:read",
  },
];

const TOKEN_PLACEHOLDER = "<your-api-token>";

function tokensUrl(selected: SelectedTenant): string {
  return apiUrl(`/dashboard/tenants/${encodeURIComponent(selected.tenantId)}/tokens`);
}

function claudeCodeSnippet(endpoint: string): string {
  return `claude mcp add --transport http jina ${endpoint} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
}

function jsonClientSnippet(endpoint: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        jina: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

function codexSnippet(endpoint: string): string {
  return [
    "[mcp_servers.jina_context]",
    `url = "${endpoint}"`,
    'bearer_token_env_var = "JINA_ACCESS_TOKEN"',
    'enabled_tools = ["search_context", "list_context", "read_context", "diff_context"]',
  ].join("\n");
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function Snippet({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="settings-field">
      <span>{label}</span>
      <pre className="code-block code-block--sm">{value}</pre>
      <div className="settings-form__actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          aria-label={copied ? "Copied" : `Copy ${label}`}
          onClick={() => {
            void copyText(value).then((ok) => setCopied(ok));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function McpPage() {
  const { selected } = useTenant();
  const scope = useTenantQueryScope();

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
  const endpoint = tokensQuery.data?.mcp_endpoint ?? null;
  const hasActiveToken = (tokensQuery.data?.tokens ?? []).some((token) => !token.revokedAt);

  return (
    <div className="settings-page">
      <header className="route-intro">
        <div>
          <h1>MCP</h1>
          <p>
            Use Jina from any MCP client: the wiki is exposed as four read-only tools, and the same
            token reaches the causal graph over HTTP.{" "}
            {hasActiveToken ? (
              <>
                Manage tokens on the <Link href="/tokens">API tokens page</Link>.
              </>
            ) : (
              <>
                Create a token on the <Link href="/tokens">API tokens page</Link> first.
              </>
            )}
          </p>
        </div>
      </header>

      {state === "loading" ? (
        <section className="settings-card" aria-label="MCP status">
          <p className="settings-card__empty">Loading MCP details…</p>
        </section>
      ) : state === "unavailable" ? (
        <section className="settings-card" aria-label="MCP status">
          <p className="settings-card__empty">MCP details are unavailable right now.</p>
        </section>
      ) : !endpoint ? (
        <section className="settings-card" aria-label="MCP status">
          <p className="settings-card__empty">MCP is not configured for this environment.</p>
        </section>
      ) : (
        <>
          <section className="settings-card" aria-label="Endpoint">
            <div className="settings-card__head">
              <div>
                <h2>Endpoint</h2>
                <p>
                  Streamable HTTP, stateless. Send a bearer token with <code>context:query</code> or{" "}
                  <code>context:read</code> scope.
                </p>
              </div>
            </div>
            <div className="settings-form">
              <Snippet label="MCP endpoint" value={endpoint} />
            </div>
          </section>

          <section className="settings-card" aria-label="Connect a client">
            <div className="settings-card__head">
              <div>
                <h2>Connect a client</h2>
                <p>Paste one of these into your client, then substitute your token.</p>
              </div>
            </div>
            <div className="settings-form">
              <Snippet label="Claude Code" value={claudeCodeSnippet(endpoint)} />
              <Snippet label="Claude Desktop / Cursor (JSON)" value={jsonClientSnippet(endpoint)} />
              <Snippet label="Codex (TOML)" value={codexSnippet(endpoint)} />
            </div>
          </section>

          <section className="integration-group" aria-label="Tools">
            <div className="integration-group__head">
              <h2>Wiki tools</h2>
            </div>
            <div className="integration-rows">
              {MCP_TOOLS.map((tool) => (
                <div key={tool.name} className="integration-row">
                  <span className="integration-mark">{tool.mark}</span>
                  <div className="integration-row__main">
                    <div className="integration-row__titleline">
                      <strong>{tool.title}</strong>
                      <code>{tool.name}</code>
                      <Badge>{tool.scope}</Badge>
                    </div>
                    <p className="integration-row__metadata">
                      <span>{tool.description}</span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-card" aria-label="Beyond MCP">
            <div className="settings-card__head">
              <div>
                <h2>Causal graph and reviews</h2>
              </div>
            </div>
            <p className="settings-card__note">
              The causal graph is served over HTTP with the same token:{" "}
              <code>GET {endpoint.replace(/\/mcp$/, "")}/causal-graph</code> and{" "}
              <code>…/causal-graph/issues</code> (scope <code>context:read</code>). Review runs are
              managed in this dashboard and are not exposed through MCP yet.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
