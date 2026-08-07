export function dashboardProxyUsesClerk(mode = process.env.NEXT_PUBLIC_JINA_DASHBOARD_AUTH_MODE): boolean {
  return mode !== "github";
}
