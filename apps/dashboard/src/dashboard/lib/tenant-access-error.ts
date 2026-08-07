const DEFAULT_WORKSPACE_ACCESS_ERROR =
  "Jina could not verify workspace access for this signed-in account.";

export const WORKSPACE_DISCOVERY_ERROR_MESSAGE =
  "Jina could not load your workspaces right now. Your workspace data is still protected; try again, or sign out and back in if the problem continues.";

export const WORKSPACE_SESSION_ERROR_MESSAGE =
  "Your Clerk sign-in is active, but Jina could not validate the matching API session. Your workspace data is still protected; try again, or sign out and back in to refresh the session.";

export function tenantAuthorizationErrorMessage(
  status: number,
  authMode: "disabled" | "github" | "hybrid" | "clerk",
  payload?: unknown,
): string | null {
  if (status === 403) return tenantAccessErrorMessage(payload);
  if (status === 401 && (authMode === "clerk" || authMode === "hybrid")) {
    return WORKSPACE_SESSION_ERROR_MESSAGE;
  }
  return null;
}

/**
 * Preserve the API's actionable Clerk/identity explanation while adding the
 * recovery step that was previously missing from the blank-dashboard state.
 */
export function tenantAccessErrorMessage(payload: unknown): string {
  const providerMessage =
    payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error.trim()
      : "";
  const explanation = providerMessage || DEFAULT_WORKSPACE_ACCESS_ERROR;
  return `${explanation} Sign out and back in to refresh your Clerk identity and workspace memberships. If this persists, ask a workspace admin to verify that your Clerk email and connected GitHub account belong to the existing Jina user.`;
}
