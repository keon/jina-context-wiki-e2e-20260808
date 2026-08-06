import { postInternal } from "./api.js";

export type ContextGraphMcpAccess = {
  mcpUrl: string;
  accessToken: string;
  expiresAt: string;
};

export type ContextGraphMcpAccessInput = {
  repository: string;
  githubRepositoryId: number;
  installationId: number;
  pullRequestNumber: number;
  reviewRunId: string;
  headSha: string;
  headRef?: string;
  baseRef: string;
};

type ContextGraphMcpAccessResponse = {
  available?: unknown;
  mcp_url?: unknown;
  access_token?: unknown;
  token_type?: unknown;
  expires_at?: unknown;
};

type ContextGraphMcpAccessRequester = <TResponse>(path: string, body: unknown) => Promise<TResponse>;

/**
 * Request one short-lived, repository-scoped Context MCP credential through
 * the review API. The API checks release availability; Context returns the
 * direct MCP URL and a narrow token. Context is enabled by default;
 * the environment variable is retained only as an explicit emergency kill
 * switch. Local CodeGraph indexing is a separate facility and is unaffected.
 */
export async function createContextGraphMcpAccess(
  input: ContextGraphMcpAccessInput,
  env: NodeJS.ProcessEnv = process.env,
  request: ContextGraphMcpAccessRequester = postInternal,
): Promise<ContextGraphMcpAccess | undefined> {
  if (!contextGraphMcpEnabled(env)) return undefined;
  const result = await request<ContextGraphMcpAccessResponse>("/internal/context/mcp-access", {
    installation_id: input.installationId,
    github_repository_id: input.githubRepositoryId,
    repository: input.repository,
    pull_request_number: input.pullRequestNumber,
    review_run_id: input.reviewRunId,
  });
  if (result.available !== true) return undefined;

  const mcpUrl = requiredUrl(result.mcp_url, "mcp_url");
  const accessToken = requiredString(result.access_token, "access_token");
  const tokenType = result.token_type === undefined ? "bearer" : String(result.token_type).toLowerCase();
  if (tokenType !== "bearer") throw new Error("context graph MCP access returned an unsupported token type");
  const expiresAt = requiredString(result.expires_at, "expires_at");
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("context graph MCP access returned an expired token");
  }
  return { mcpUrl, accessToken, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function contextGraphMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "no", "off"].includes(env.JINA_GRAPH_MCP_ENABLED?.trim().toLowerCase() ?? "");
}

function requiredString(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`context graph MCP access returned no ${name}`);
  return normalized;
}

function requiredUrl(value: unknown, name: string): string {
  const normalized = requiredString(value, name);
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`context graph MCP ${name} must use https outside localhost`);
  }
  return parsed.toString().replace(/\/$/, "");
}
