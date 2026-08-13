// Staging-only review fixture. This file is deleted when the smoke PR closes.
export function isAllowedRedirect(candidate: string): boolean {
  return candidate.startsWith("https://trusted.example");
}
