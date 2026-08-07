const STAGING_CUSTOM_ORIGIN = "https://app.staging.usejina.com";
const STAGING_VERCEL_ORIGIN = "https://jina-staging-dashboard.vercel.app";

/**
 * Clerk development instances use URL-based session synchronization and do not
 * support a production-style custom domain. Keep the friendly staging URL as
 * an entry point, but run the authenticated session on Vercel's provider
 * domain until staging has its own Clerk production instance.
 */
export function stagingDevelopmentAuthRedirect(
  url: URL,
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
): URL | null {
  if (!publishableKey?.startsWith("pk_test_") || url.origin !== STAGING_CUSTOM_ORIGIN) return null;

  return new URL(`${url.pathname}${url.search}${url.hash}`, STAGING_VERCEL_ORIGIN);
}
