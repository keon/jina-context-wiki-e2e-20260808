const MAX_CONTEXT_ARTIFACT_NAME_LENGTH = 180;

function artifactNameSegment(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

/**
 * Give every immutable page-stage output its own stable identity. Collapsed
 * page tasks can write, audit, and repair the same logical page in one Board
 * attempt, so the stage must be part of the object name.
 */
export function contextPageArtifactName(documentPath: string, stage: string): string {
  const stageSegment = artifactNameSegment(stage, "stage").slice(0, 64);
  const suffix = `.${stageSegment}.json`;
  const page = artifactNameSegment(documentPath, "page");
  return `${page.slice(0, MAX_CONTEXT_ARTIFACT_NAME_LENGTH - suffix.length)}${suffix}`;
}
