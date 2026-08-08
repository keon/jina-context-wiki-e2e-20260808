export const STAGING_CUSTOM_ORIGIN = "https://app.staging.usejina.com";
export const STAGING_VERCEL_ORIGIN = "https://jina-staging-dashboard.vercel.app";

const STAGING_CUSTOM_HOST = new URL(STAGING_CUSTOM_ORIGIN).hostname;
const STAGING_VERCEL_HOST = new URL(STAGING_VERCEL_ORIGIN).hostname;

export interface StagingClerkAuthOptions {
  readonly allowedRedirectOrigins: string[];
  readonly isSatellite?: true;
  readonly domain?: string;
  readonly signInUrl?: string;
  readonly signUpUrl?: string;
  readonly satelliteAutoSync?: true;
}

/**
 * Configure staging's friendly custom host as a Clerk satellite instead of
 * moving the entire application onto Vercel's provider domain. Clerk's
 * development instances still perform their auth handshake on the primary
 * application, then synchronize the session back to the satellite host.
 */
export function stagingClerkAuthOptions(
  hostname: string,
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
): StagingClerkAuthOptions | null {
  if (!publishableKey?.startsWith("pk_test_")) return null;

  const normalizedHostname = normalizeHostname(hostname);
  if (normalizedHostname !== STAGING_CUSTOM_HOST && normalizedHostname !== STAGING_VERCEL_HOST) return null;

  const allowedRedirectOrigins = [STAGING_CUSTOM_ORIGIN, STAGING_VERCEL_ORIGIN];
  if (normalizedHostname === STAGING_VERCEL_HOST) return { allowedRedirectOrigins };

  return {
    allowedRedirectOrigins,
    isSatellite: true,
    domain: STAGING_CUSTOM_HOST,
    signInUrl: `${STAGING_VERCEL_ORIGIN}/signin`,
    signUpUrl: `${STAGING_VERCEL_ORIGIN}/signin`,
    satelliteAutoSync: true
  };
}

export function requestHostname(forwardedHost: string | null, host: string | null): string {
  return normalizeHostname(forwardedHost?.split(",")[0] ?? host ?? "");
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  return trimmed.split(":")[0] ?? "";
}
