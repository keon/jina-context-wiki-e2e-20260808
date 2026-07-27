import type { RetrievalCandidate, SourceConflict } from "../domain/query.js";

export function detectSourceConflicts(candidates: RetrievalCandidate[]): SourceConflict[] {
  const subjects = new Map<string, Map<string, RetrievalCandidate[]>>();
  for (const candidate of candidates) {
    const subject = candidate.metadata.claimSubject;
    const value = candidate.metadata.claimValue;
    if (typeof subject !== "string" || typeof value !== "string") continue;
    const values = subjects.get(subject) ?? new Map<string, RetrievalCandidate[]>();
    const sources = values.get(value) ?? [];
    sources.push(candidate);
    values.set(value, sources);
    subjects.set(subject, values);
  }
  const conflicts: SourceConflict[] = [];
  for (const [subject, values] of subjects) {
    if (values.size < 2) continue;
    const candidatesForSubject = [...values.values()].flat();
    conflicts.push({
      subject,
      description: `Sources disagree: ${[...values.keys()].join(" versus ")}`,
      citationIds: candidatesForSubject.map((candidate) => candidate.id),
      resolution: "unresolved"
    });
  }
  return conflicts;
}
