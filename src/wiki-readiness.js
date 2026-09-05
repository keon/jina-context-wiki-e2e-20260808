export function wikiReadiness({ assigned, available, activeBuild, releaseId, generationAllowed = true }) {
  if (!assigned) return Object.freeze({ state: "unassigned", canGenerate: false });
  if (!available) return Object.freeze({ state: "access-unavailable", canGenerate: false });
  if (activeBuild) {
    // A refresh does not remove the previously published canonical release.
    return Object.freeze({
      state: "generating",
      canGenerate: false,
      ...(typeof releaseId === "string" && releaseId.trim() ? { releaseId } : {}),
    });
  }
  if (typeof releaseId === "string" && releaseId.trim()) {
    return Object.freeze({ state: "ready", canGenerate: Boolean(generationAllowed), releaseId });
  }
  if (!generationAllowed) return Object.freeze({ state: "generation-unavailable", canGenerate: false });
  return Object.freeze({ state: "awaiting-first-wiki", canGenerate: true });
}
