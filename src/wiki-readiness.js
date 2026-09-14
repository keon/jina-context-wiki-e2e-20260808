export function wikiReadiness({ assigned, available, activeBuild, releaseId }) {
  if (!assigned) return Object.freeze({ state: "unassigned", canGenerate: false });
  if (!available) return Object.freeze({ state: "access-unavailable", canGenerate: false });
  // Canonical identifiers are normalized before being exposed to readers.
  const canonicalReleaseId = typeof releaseId === "string" ? releaseId.trim() : "";
  if (activeBuild) {
    // A refresh does not remove the previously published canonical release.
    return Object.freeze({
      state: "generating",
      canGenerate: false,
      ...(canonicalReleaseId ? { releaseId: canonicalReleaseId } : {}),
    });
  }
  if (canonicalReleaseId) {
    return Object.freeze({ state: "ready", canGenerate: true, releaseId: canonicalReleaseId });
  }
  return Object.freeze({ state: "awaiting-first-wiki", canGenerate: true });
}
