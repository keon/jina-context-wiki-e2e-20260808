import { parseResearchStagePlan, type ResearchStagePlan } from "@jina/daytona";
import { parsePlanWithSingleRepair, type BoundedPlanRepairRequest } from "./board-plan-repair.js";

export type ResearchPlanRepairRequest = BoundedPlanRepairRequest;

interface ResearchPlanRepositoryFile {
  readonly path: string;
  readonly contentAvailable: boolean;
}

export interface ResearchPlanValidationOptions {
  readonly repositoryFiles: readonly ResearchPlanRepositoryFile[];
  readonly repositoryAreas: readonly string[];
}

/**
 * Applies schema and deterministic repository-semantic checks to a research
 * plan. Every focus path must be a canonical checkpoint-relative file or
 * directory with readable evidence, and the assignments must account for each
 * readable deterministic repository area.
 */
function parseBoardResearchPlan(candidate: unknown, options: ResearchPlanValidationOptions): ResearchStagePlan {
  const plan = parseResearchStagePlan(candidate);
  const readablePaths = options.repositoryFiles.filter((file) => file.contentAvailable).map((file) => file.path);
  if (readablePaths.length === 0) {
    throw new Error("research plan cannot be validated because the repository snapshot has no readable files");
  }

  const normalizedQuestions = new Map<string, string>();
  const focusPaths: string[] = [];
  for (const assignment of plan.assignments) {
    const assignmentFocusPaths = new Set<string>();
    for (const focusPath of assignment.focusPaths) {
      validateFocusPath(focusPath, assignment.id, readablePaths);
      if (assignmentFocusPaths.has(focusPath)) {
        throw new Error(`research assignment ${assignment.id} duplicates focus path ${focusPath}`);
      }
      assignmentFocusPaths.add(focusPath);
      focusPaths.push(focusPath);
    }
    for (const question of assignment.questions) {
      const normalized = question.trim().replace(/\s+/g, " ").toLowerCase();
      const priorAssignment = normalizedQuestions.get(normalized);
      if (priorAssignment) {
        throw new Error(
          `research assignments ${priorAssignment} and ${assignment.id} duplicate maintenance question: ${question}`
        );
      }
      normalizedQuestions.set(normalized, assignment.id);
    }
  }

  const readableAreas = options.repositoryAreas.filter((area) =>
    readablePaths.some((path) => pathBelongsToArea(path, area))
  );
  const uncoveredAreas = readableAreas.filter(
    (area) => !focusPaths.some((focusPath) => focusIntersectsArea(focusPath, area))
  );
  if (uncoveredAreas.length > 0) {
    throw new Error(`research plan does not cover repository areas: ${uncoveredAreas.join(", ")}`);
  }
  return plan;
}

/**
 * Gives a schema-valid but semantically rejected research plan one bounded
 * correction pass. Both candidates pass through the exact same host parser.
 */
export async function parseResearchPlanWithRepair(input: {
  readonly candidate: unknown;
  readonly options: ResearchPlanValidationOptions;
  readonly repair: (request: ResearchPlanRepairRequest) => Promise<unknown>;
}): Promise<ResearchStagePlan> {
  return parsePlanWithSingleRepair({
    candidate: input.candidate,
    parse: (candidate) => parseBoardResearchPlan(candidate, input.options),
    repair: input.repair
  });
}

function validateFocusPath(focusPath: string, assignmentId: string, readablePaths: readonly string[]): void {
  if (focusPath === "." && readablePaths.some((path) => path.includes("/"))) {
    throw new Error(
      `research assignment ${assignmentId} uses the repository root for a non-flat checkpoint; name concrete focus paths`
    );
  }
  if (
    focusPath !== "." &&
    (focusPath.startsWith("/") ||
      focusPath.endsWith("/") ||
      focusPath.includes("\\") ||
      focusPath.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  ) {
    throw new Error(
      `research assignment ${assignmentId} focus path is not a canonical repository-relative path: ${focusPath}`
    );
  }
  if (focusPath !== "." && !readablePaths.some((path) => path === focusPath || path.startsWith(`${focusPath}/`))) {
    throw new Error(
      `research assignment ${assignmentId} focus path does not resolve to readable checkpoint evidence: ${focusPath}`
    );
  }
}

function pathBelongsToArea(path: string, area: string): boolean {
  return area === "root" ? !path.includes("/") : path === area || path.startsWith(`${area}/`);
}

function focusIntersectsArea(focusPath: string, area: string): boolean {
  if (focusPath === ".") return true;
  if (area === "root") return !focusPath.includes("/");
  return focusPath === area || focusPath.startsWith(`${area}/`) || area.startsWith(`${focusPath}/`);
}
