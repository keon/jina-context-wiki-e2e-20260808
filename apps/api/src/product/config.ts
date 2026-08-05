export type AppConfig = {
  port: number;
  githubWebhookSecret: string;
  githubAppInstallUrl?: string;
  internalApiToken: string;
  dashboardAllowedOrigins: DashboardAllowedOrigins;
  dashboardUrl: string;
  apiBaseUrl?: string;
  auth: AuthConfig;
  billing: BillingConfig;
  graph?: GraphConfig;
  schedulerOidc?: SchedulerOidcConfig;
};

/**
 * When set, Cloud Scheduler authenticates with a Google-signed OIDC identity
 * token instead of a copy of the internal API token stored in the job resource.
 */
type SchedulerOidcConfig = {
  audience: string;
  email: string;
};

export type GraphConfig = {
  apiUrl: string;
  accessToken: string;
  timeoutMs: number;
  /**
   * The graph service's internal credential, used only to mint a short-lived
   * per-tenant token. Optional: without it the client falls back to the static
   * `accessToken`, which is what lets this ship in either order relative to the
   * graph service that issues tokens.
   */
  internalToken?: string;
  delegatedTokenTtlMinutes?: number;
};

export type DashboardAllowedOrigins = "*" | string[];

export type BillingEnforcement = "off" | "shadow" | "on";

export type BillingConfig = {
  // When unset, Autumn billing is entirely disabled and every billing path degrades
  // gracefully (no customer creation, no check/track, dashboard reports configured:false).
  autumnSecretKey?: string;
  autumnApiUrl: string;
  creditsFeatureId: string;
  managedAiFeatureId: string;
  // "off"    -> skip Autumn entirely (default).
  // "shadow" -> evaluate/compute + persist, but never block and never call Autumn track.
  // "on"     -> block on the gate and call Autumn track.
  enforce: BillingEnforcement;
  // Where Stripe/Autumn checkouts return the user after success. Without this,
  // Autumn redirects completed checkouts to its own site (production bug).
  checkoutSuccessUrl?: string;
};

type AuthConfig = {
  mode: "disabled" | "github" | "clerk";
  githubClientId?: string;
  githubClientSecret?: string;
  githubScopes: string;
  sessionCookieName: string;
  oauthStateCookieName: string;
  cookieSecure: boolean;
  cookieSameSite: "Lax" | "Strict" | "None";
  sessionTtlSeconds: number;
  clerkPublishableKey?: string;
  clerkSecretKey?: string;
};

export function loadConfig(env = process.env): AppConfig {
  const dashboardUrl = dashboardUrlFromEnv(env);
  const dashboardAllowedOrigins = parseDashboardAllowedOrigins(env.DASHBOARD_ORIGIN, dashboardUrl);
  // Context and review workers rotate independently even though one API serves both.
  const internalApiToken = optionalEnv(env, "JINA_PRODUCT_INTERNAL_API_TOKEN") ?? requiredEnv(env, "INTERNAL_API_TOKEN");
  validateSecretsEncryptionKey(env);
  return {
    port: parsePort(env.PORT),
    githubWebhookSecret: requiredEnv(env, "GITHUB_WEBHOOK_SECRET"),
    githubAppInstallUrl: githubAppInstallUrl(env),
    internalApiToken,
    dashboardAllowedOrigins,
    dashboardUrl,
    apiBaseUrl: normalizeBaseUrl(env.API_BASE_URL),
    auth: parseAuthConfig(env),
    billing: parseBillingConfig(env, dashboardUrl),
    graph: parseGraphConfig(env),
    ...(parseSchedulerOidcConfig(env) ? { schedulerOidc: parseSchedulerOidcConfig(env) } : {}),
  };
}

function parseSchedulerOidcConfig(env: NodeJS.ProcessEnv): SchedulerOidcConfig | undefined {
  const audience = optionalEnv(env, "JINA_SCHEDULER_OIDC_AUDIENCE");
  const email = optionalEnv(env, "JINA_SCHEDULER_OIDC_EMAIL");
  if (!audience && !email) return undefined;
  if (!audience || !email) {
    throw new Error("JINA_SCHEDULER_OIDC_AUDIENCE and JINA_SCHEDULER_OIDC_EMAIL must be configured together");
  }
  return { audience, email };
}

function parseGraphConfig(env: NodeJS.ProcessEnv): GraphConfig | undefined {
  const apiUrl = normalizeBaseUrl(env.JINA_GRAPH_API_URL);
  const accessToken = optionalEnv(env, "JINA_GRAPH_API_TOKEN");
  if (!apiUrl && !accessToken) return undefined;
  if (!apiUrl || !accessToken) {
    throw new Error("JINA_GRAPH_API_URL and JINA_GRAPH_API_TOKEN must be configured together");
  }
  const internalToken = optionalEnv(env, "JINA_GRAPH_INTERNAL_TOKEN");
  return {
    apiUrl,
    accessToken,
    timeoutMs: parsePositiveInteger(env.JINA_GRAPH_REQUEST_TIMEOUT_MS, 20_000),
    ...(internalToken ? { internalToken } : {}),
    // Short enough that a leak is bounded without revocation, long enough that
    // renewal is rare. The graph service bounds this at 5 minutes minimum.
    delegatedTokenTtlMinutes: Math.max(
      5,
      parsePositiveInteger(env.JINA_GRAPH_DELEGATED_TOKEN_TTL_MINUTES, 15),
    ),
  };
}

function parseBillingConfig(env: NodeJS.ProcessEnv, dashboardUrl: string): BillingConfig {
  return {
    autumnSecretKey: optionalEnv(env, "AUTUMN_SECRET_KEY"),
    autumnApiUrl: normalizeBaseUrl(env.AUTUMN_API_URL) ?? "https://api.useautumn.com/v1",
    creditsFeatureId: optionalEnv(env, "AUTUMN_CREDITS_FEATURE_ID") ?? "jina_credits",
    managedAiFeatureId: optionalEnv(env, "AUTUMN_MANAGED_AI_FEATURE_ID") ?? "managed_ai_access",
    enforce: parseBillingEnforcement(env.JINA_BILLING_ENFORCE),
    // Return the user to the dashboard billing page after a Stripe checkout,
    // rather than Autumn's default landing site.
    checkoutSuccessUrl: `${dashboardUrl.replace(/\/$/, "")}/billing?checkout=success`,
  };
}

function parseBillingEnforcement(value: string | undefined): BillingEnforcement {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow" || normalized === "on") {
    return normalized;
  }
  return "off";
}

/**
 * FINDING 4a: SECRETS_ENCRYPTION_KEY must not fail open in production. Unset, provider API keys and
 * GitHub tokens are stored as plaintext and the OpenRouter PKCE binding cookie is forgeable (see
 * crypto.ts / openrouter-oauth.ts). In production a missing/invalid key is a hard startup error;
 * development keeps crypto.ts's warn-and-store-plaintext fallback so local setup stays frictionless.
 */
function validateSecretsEncryptionKey(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const raw = env.SECRETS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is required when NODE_ENV=production; set it to a base64-encoded 32-byte (256-bit) key so provider secrets and OAuth PKCE cookies are encrypted at rest.",
    );
  }
  if (Buffer.from(raw, "base64").length !== 32) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY must be a base64-encoded 32 bytes (256 bits); the configured value does not decode to 32 bytes.",
    );
  }
}

export function dashboardOriginAllowed(allowedOrigins: DashboardAllowedOrigins, origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }
  if (allowedOrigins === "*") {
    return true;
  }

  return allowedOrigins.includes(origin);
}

function parseAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const explicitMode = optionalEnv(env, "DASHBOARD_AUTH_MODE");
  const hasGithubOAuth = Boolean(optionalEnv(env, "GITHUB_OAUTH_CLIENT_ID") && optionalEnv(env, "GITHUB_OAUTH_CLIENT_SECRET"));
  const hasClerk = Boolean(optionalEnv(env, "CLERK_PUBLISHABLE_KEY") && optionalEnv(env, "CLERK_SECRET_KEY"));
  const mode = explicitMode === "clerk" || (!explicitMode && hasClerk)
    ? "clerk"
    : explicitMode === "github" || (!explicitMode && hasGithubOAuth)
      ? "github"
      : "disabled";
  const dashboardUrl = dashboardUrlFromEnv(env);

  return {
    mode,
    githubClientId: mode === "github" ? requiredEnv(env, "GITHUB_OAUTH_CLIENT_ID") : optionalEnv(env, "GITHUB_OAUTH_CLIENT_ID"),
    githubClientSecret:
      mode === "github" ? requiredEnv(env, "GITHUB_OAUTH_CLIENT_SECRET") : optionalEnv(env, "GITHUB_OAUTH_CLIENT_SECRET"),
    githubScopes: env.GITHUB_OAUTH_SCOPES?.trim() || "read:user read:org repo",
    sessionCookieName: env.DASHBOARD_SESSION_COOKIE?.trim() || "jina_dashboard_session",
    oauthStateCookieName: env.DASHBOARD_OAUTH_STATE_COOKIE?.trim() || "jina_github_oauth_state",
    cookieSecure: parseBoolean(env.DASHBOARD_COOKIE_SECURE, dashboardUrl.startsWith("https://")),
    cookieSameSite: parseSameSite(env.DASHBOARD_COOKIE_SAMESITE, dashboardUrl.startsWith("https://") ? "None" : "Lax"),
    sessionTtlSeconds: parsePositiveInteger(env.DASHBOARD_SESSION_TTL_SECONDS, 60 * 60 * 24 * 7),
    clerkPublishableKey:
      mode === "clerk" ? requiredEnv(env, "CLERK_PUBLISHABLE_KEY") : optionalEnv(env, "CLERK_PUBLISHABLE_KEY"),
    clerkSecretKey: mode === "clerk" ? requiredEnv(env, "CLERK_SECRET_KEY") : optionalEnv(env, "CLERK_SECRET_KEY"),
  };
}

function dashboardUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return env.DASHBOARD_URL?.trim() || firstDashboardOrigin(parseDashboardAllowedOrigins(env.DASHBOARD_ORIGIN)) || "http://localhost:3000";
}

function parseDashboardAllowedOrigins(value: string | undefined, dashboardUrl?: string): DashboardAllowedOrigins {
  const rawOrigins = value
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (rawOrigins?.includes("*")) {
    throw new Error("DASHBOARD_ORIGIN cannot include *; configure explicit dashboard origins");
  }

  const origins = rawOrigins?.map(normalizeOrigin).filter((origin): origin is string => Boolean(origin)) ?? [];
  const dashboardOrigin = dashboardUrl ? normalizeOrigin(dashboardUrl) : undefined;
  const combined = [...origins, ...(dashboardOrigin ? [dashboardOrigin] : [])];
  return Array.from(new Set(combined));
}

function firstDashboardOrigin(allowedOrigins: DashboardAllowedOrigins): string | undefined {
  return allowedOrigins === "*" ? undefined : allowedOrigins[0];
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/$/, "");
}

function githubAppInstallUrl(env: NodeJS.ProcessEnv): string | undefined {
  const explicitUrl = optionalEnv(env, "GITHUB_APP_INSTALL_URL");
  if (explicitUrl) {
    return explicitUrl;
  }

  const slug = optionalEnv(env, "GITHUB_APP_SLUG");
  return slug ? `https://github.com/apps/${slug}/installations/new` : undefined;
}

function normalizeOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported dashboard URL protocol: ${parsed.protocol}`);
    }
    return parsed.origin;
  } catch {
    throw new Error(`Invalid DASHBOARD_URL or DASHBOARD_ORIGIN value: ${value}`);
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  return fallback;
}

function parseSameSite(value: string | undefined, fallback: AuthConfig["cookieSameSite"]): AuthConfig["cookieSameSite"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "lax") {
    return "Lax";
  }
  if (normalized === "strict") {
    return "Strict";
  }
  if (normalized === "none") {
    return "None";
  }

  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 8080;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return port;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}
