export interface ReleaseStage {
  readonly name: string;
  readonly passed: boolean;
}

export interface ReleaseCandidate {
  readonly version: string;
  readonly stages: readonly ReleaseStage[];
}

export interface ReleaseDecision {
  readonly version: string;
  readonly status: "ready" | "blocked";
  readonly failedStages: readonly string[];
}

export function evaluateRelease(candidate: ReleaseCandidate): ReleaseDecision {
  if (!candidate.version.trim()) throw new Error("version is required");
  if (candidate.stages.length === 0) throw new Error("at least one stage is required");

  const names = new Set<string>();
  for (const stage of candidate.stages) {
    const name = stage.name.trim();
    if (!name) throw new Error("stage name is required");
    if (names.has(name)) throw new Error(`duplicate stage: ${name}`);
    names.add(name);
  }

  const failedStages = candidate.stages.filter((stage) => !stage.passed).map((stage) => stage.name.trim());
  return {
    version: candidate.version.trim(),
    status: failedStages.length === 0 ? "ready" : "blocked",
    failedStages
  };
}

export function releaseDecisionSummary(decision: ReleaseDecision): string {
  if (decision.status === "ready") return `${decision.version}: ready`;
  return `${decision.version}: blocked by ${decision.failedStages.join(", ")}`;
}
